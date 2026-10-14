"""Резервная копия пространства (кластер v2).

Ключа S3 в пространстве нет: space-operator сам забирает снимок базы и сам кладёт его в хранилище под префиксом
пространства. Взломанный агент не может прочитать чужую копию и не может стереть историю своей.

  GET  /internal/backup        согласованный снимок SQLite (не файл с диска: идёт запись, есть WAL)
  GET  /internal/backup/state  пусто ли пространство (для решения о восстановлении)
  POST /internal/restore       принять снимок; только в пустое пространство — данные человека не затираются
  GET  /internal/backup/files  опись файлов (вложения, файлы агента, скилы): путь, размер, SHA-256
  GET  /internal/backup/file   один файл из описи
  PUT  /internal/restore/file  вернуть файл при восстановлении (до базы; только в пустое пространство)

Вызывающего опознаём по токену из файла, который в под кладёт space-operator (у каждого пространства свой).
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import os
import secrets
import sqlite3
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

SQLITE_MAGIC = b"SQLite format 3\x00"
MAX_SNAPSHOT = 1 << 30  # 1 ГиБ: том пространства — 2 ГиБ


def restore_file(db_path: Path) -> Path:
    return db_path.with_name(db_path.name + ".restore")


def apply_pending_restore(db_path: Path) -> bool:
    """Перед открытием базы: если принят снимок для восстановления — подменить им базу. True — подменили."""
    src = restore_file(db_path)
    if not src.exists():
        return False
    for suffix in ("-wal", "-shm"):  # журнал старой базы к новой не относится
        db_path.with_name(db_path.name + suffix).unlink(missing_ok=True)
    os.replace(src, db_path)
    return True


def snapshot(db_path: Path, dest: Path) -> str:
    """Снимок через механизм резервного копирования SQLite; возвращает SHA-256 файла."""
    src = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        dst = sqlite3.connect(dest)
        try:
            src.backup(dst)
            # Снимок не должен зависеть от режима журнала источника: один файл, без -wal рядом.
            dst.execute("PRAGMA journal_mode=DELETE")
            dst.commit()
        finally:
            dst.close()
    finally:
        src.close()
    h = hashlib.sha256()
    with open(dest, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def is_empty(db_path: Path) -> bool:
    """Пространством ещё не пользовались: ни одного чата и ни одного сообщения."""
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        n = con.execute("SELECT (SELECT count(*) FROM conversations) + (SELECT count(*) FROM messages)").fetchone()[0]
        return n == 0
    finally:
        con.close()


def check_snapshot(path: Path) -> None:
    with open(path, "rb") as f:
        if f.read(len(SQLITE_MAGIC)) != SQLITE_MAGIC:
            raise ValueError("это не база SQLite")
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        if con.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("база повреждена")
        con.execute("SELECT count(*) FROM conversations").fetchone()  # это база Fugu Deck, а не посторонняя
    except sqlite3.DatabaseError as e:
        raise ValueError(f"база не читается: {e}") from e
    finally:
        con.close()


# ------------------------------------------------------------------ файлы
FILE_ROOTS = ("attachments", "skills")  # относительно data_dir; база копируется снимком отдельно
MAX_FILE = 64 << 20
_sha_cache: dict[tuple[str, int, int], str] = {}


def _sha_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def manifest(data_dir: Path) -> list[dict]:
    """Опись файлов пространства. Хеш считается заново только у изменившихся файлов (путь, размер, время)."""
    out = []
    root = data_dir.resolve()
    for top in FILE_ROOTS:
        base = root / top
        if not base.is_dir():
            continue
        for p in sorted(base.rglob("*")):
            if p.is_symlink() or not p.is_file() or p.name.endswith(".part") or p.name.startswith(".state-"):
                continue
            st = p.stat()
            if st.st_size > MAX_FILE:
                continue
            rel = p.relative_to(root).as_posix()
            k = (rel, st.st_size, st.st_mtime_ns)
            if k not in _sha_cache:
                _sha_cache[k] = _sha_file(p)
            out.append({"path": rel, "size": st.st_size, "sha256": _sha_cache[k]})
    return out


def safe_rel(data_dir: Path, rel: str) -> Path:
    """Путь из описи → файл внутри data_dir/<attachments|skills>. Всё прочее (.., абсолютные пути) — отказ."""
    parts = Path(rel).parts
    if not rel or Path(rel).is_absolute() or ".." in parts or len(parts) < 2 or parts[0] not in FILE_ROOTS:
        raise ValueError("недопустимый путь")
    root = data_dir.resolve()
    p = (root / rel).resolve()
    if root not in p.parents:
        raise ValueError("недопустимый путь")
    return p


def router(settings, exit_process=lambda: os._exit(0)) -> APIRouter:
    r = APIRouter()

    def authorize(request: Request) -> None:
        if not settings.is_space or not settings.backup_token_file:
            raise HTTPException(404)
        try:
            want = Path(settings.backup_token_file).read_text().strip()  # читаем каждый раз: файл обновляет kubelet
        except OSError:
            raise HTTPException(503, "токен резервного копирования недоступен")
        got = request.headers.get("authorization", "")
        if not want or not hmac.compare_digest(got.encode(), f"Bearer {want}".encode()):
            raise HTTPException(401, "не опознан")

    @r.get("/internal/backup")
    async def backup(request: Request):
        authorize(request)
        dest = settings.db_path.with_name(f".snapshot-{secrets.token_hex(8)}")
        try:
            digest = await asyncio.to_thread(snapshot, settings.db_path, dest)
        except Exception:
            dest.unlink(missing_ok=True)
            raise
        return FileResponse(dest, media_type="application/vnd.sqlite3", headers={"X-Deck-Snapshot-Sha256": digest},
                            background=BackgroundTask(lambda: dest.unlink(missing_ok=True)))

    @r.get("/internal/backup/state")
    async def state(request: Request):
        authorize(request)
        return {"empty": await asyncio.to_thread(is_empty, settings.db_path)}

    @r.get("/internal/backup/files")
    async def files(request: Request):
        authorize(request)
        return {"files": await asyncio.to_thread(manifest, settings.data_dir)}

    @r.get("/internal/backup/file")
    async def one_file(path: str, request: Request):
        authorize(request)
        try:
            p = safe_rel(settings.data_dir, path)
        except ValueError as e:
            raise HTTPException(400, str(e))
        if p.is_symlink() or not p.is_file():
            raise HTTPException(404, "нет такого файла")
        return FileResponse(p, media_type="application/octet-stream")

    @r.put("/internal/restore/file")
    async def restore_one(path: str, sha256: str, request: Request):
        authorize(request)
        if not await asyncio.to_thread(is_empty, settings.db_path):
            raise HTTPException(409, "в пространстве уже есть данные — восстановление их затёрло бы")
        try:
            p = safe_rel(settings.data_dir, path)
        except ValueError as e:
            raise HTTPException(400, str(e))
        if p.exists():
            return {"ok": True, "skipped": True}  # уже на месте (повтор после обрыва)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(f".restore-{secrets.token_hex(8)}")
        h, size = hashlib.sha256(), 0
        try:
            with open(tmp, "wb") as f:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_FILE:
                        raise HTTPException(413, "файл слишком большой")
                    h.update(chunk)
                    f.write(chunk)
            if h.hexdigest() != sha256:
                raise HTTPException(400, "файл пришёл не целиком (хеш не совпал)")
            os.replace(tmp, p)
        finally:
            tmp.unlink(missing_ok=True)
        return {"ok": True, "bytes": size}

    @r.post("/internal/restore")
    async def restore(request: Request):
        authorize(request)
        if not await asyncio.to_thread(is_empty, settings.db_path):
            raise HTTPException(409, "в пространстве уже есть данные — восстановление их затёрло бы")
        tmp = settings.db_path.with_name(f".restore-{secrets.token_hex(8)}")
        size = 0
        try:
            with open(tmp, "wb") as f:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_SNAPSHOT:
                        raise HTTPException(413, "снимок слишком большой")
                    f.write(chunk)
            try:
                await asyncio.to_thread(check_snapshot, tmp)
            except ValueError as e:
                raise HTTPException(400, f"снимок не принят: {e}")
            os.replace(tmp, restore_file(settings.db_path))
        finally:
            tmp.unlink(missing_ok=True)
        # Базу подменит запуск: процесс завершается, kubelet поднимает контейнер заново (apply_pending_restore).
        asyncio.get_running_loop().call_later(0.5, exit_process)
        return {"ok": True, "bytes": size}

    return r
