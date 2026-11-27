"""Сверка заметок базы знаний с файлами-источниками (D67).

Агент, записывая факт из файла репозитория, прикладывает к заметке файл и версию его содержимого (read_file отдаёт
version — sha256 содержимого). Раз в сутки, пока пространство не спит, заметки сверяются с файлами: изменился или
исчез — «устарела» с причиной; агент перечитает файл и обновит заметку. Вернулся прежний текст — пометка снимается
(только поставленная здесь: «устарела» от человека остаётся). Ошибка доступа — повтор при следующей проверке.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time

from .tools.providers import ProviderError

log = logging.getLogger("fugu.deck")

CHECK_EVERY = 24 * 3600   # заметку сверяют не чаще раза в сутки
ROUND = 3600              # как часто искать, что пора сверить
BATCH = 100               # заметок за один проход — чтобы не тратить лимиты провайдера Git
VERSION = re.compile(r"^sha256:[0-9a-f]{16}$")


def version_of(raw: bytes) -> str:
    return "sha256:" + hashlib.sha256(raw).hexdigest()[:16]


def source_file(v: object) -> tuple[str, str] | None:
    """Поле source_file инструмента памяти → (JSON файла, версия); неверное — None."""
    if not isinstance(v, dict):
        return None
    prov, repo, path, ver = (str(v.get(k) or "").strip() for k in ("provider", "repo", "path", "version"))
    if prov not in ("github", "gitlab") or not repo or not path or len(repo) > 200 or len(path) > 500 or not VERSION.match(ver):
        return None
    return json.dumps({"provider": prov, "repo": repo, "path": path}, ensure_ascii=False), ver


async def verify_note(db, providers: dict, m: dict, now: float | None = None,
                      include_evidence: bool = False) -> dict:
    """Сверить одну заметку по требованию или из фонового прохода, не меняя её записанную ревизию."""
    from .kb import evidence

    if not m.get("src_file") or not m.get("src_version"):
        raise ValueError("у заметки нет машинно проверяемого файла-источника")
    now = now or time.time()
    f = json.loads(m["src_file"])
    source = f"{f['repo']}/{f['path']}"
    p = providers.get(f["provider"])
    stale: bool | None = None
    reason: str | None = None
    seen = False
    raw: bytes | None = None
    current: str | None = None
    if p:
        try:
            raw = await p.read_file(f["repo"], f["path"], None)
            seen, current = True, version_of(raw)
        except ProviderError as e:
            if re.search(r"\b404\b", str(e)):
                stale, reason, seen = True, f"файл-источник удалён или переименован: {source}", True
        if seen and stale is None:
            if current != m["src_version"]:
                stale, reason = True, f"файл-источник изменился: {source}"
            elif m["stale"] and m.get("stale_reason"):
                stale = False
            elif m["stale"]:
                stale, reason = True, m.get("stale_reason")
            else:
                stale = False
    await db.mark_source(m["id"], stale=stale, reason=reason, now=now)
    state = "stale" if stale else "fresh" if seen else "unavailable"
    out = {"id": m["id"], "state": state, "source": source, "revision": m["src_version"],
           "current_revision": current, "last_checked": now, "last_verified": now if state == "fresh" else None,
           "note": reason or ("" if seen else "источник недоступен — сведения не подтверждены")}
    if include_evidence and raw is not None:
        text = raw.decode("utf-8", "replace")
        query = f"{m.get('title') or ''} {m.get('content') or ''}"
        out["source_evidence"], out["source_truncated"] = evidence(text, query, 480)
    return out


async def check_once(db, providers: dict, now: float | None = None) -> dict[str, int]:
    """Один проход: сверить заметки, которые давно не сверяли. Возвращает счётчики (для журнала и тестов)."""
    now = now or time.time()
    n = {"fresh": 0, "stale": 0, "skipped": 0}
    for m in await db.notes_to_check(now - CHECK_EVERY, BATCH):
        result = await verify_note(db, providers, m, now)
        n["stale" if result["state"] == "stale" else "fresh" if result["state"] == "fresh" else "skipped"] += 1
    return n


async def loop(db, providers_fn) -> None:
    """Фоновая сверка, пока пространство работает: раз в ROUND — то, что пора сверить."""
    while True:
        try:
            n = await check_once(db, providers_fn())
            if n["stale"]:
                log.info("event=kb.sources stale=%d fresh=%d skipped=%d", n["stale"], n["fresh"], n["skipped"])
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("сверка заметок с источниками")
        await asyncio.sleep(ROUND)
