"""Резервная копия пространства: снимок, состояние, восстановление только в пустое пространство."""
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import backup

SCHEMA = """
CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT);
CREATE TABLE messages (id INTEGER PRIMARY KEY, conversation_id TEXT, body TEXT);
"""


def make_db(path: Path, chats: int = 0) -> None:
    con = sqlite3.connect(path)
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript(SCHEMA)
    for i in range(chats):
        con.execute("INSERT INTO conversations VALUES (?, ?)", (f"c{i}", f"чат {i}"))
        con.execute("INSERT INTO messages (conversation_id, body) VALUES (?, ?)", (f"c{i}", "привет"))
    con.commit()
    con.close()


@pytest.fixture
def stand(tmp_path):
    db = tmp_path / "fugu-deck.sqlite3"
    tok = tmp_path / "token"
    tok.write_text("backup-token-1\n")
    exits = []
    settings = SimpleNamespace(is_space=True, db_path=db, backup_token_file=str(tok))
    app = FastAPI()
    app.include_router(backup.router(settings, exit_process=lambda: exits.append(1)))
    return SimpleNamespace(db=db, tok=tok, exits=exits, settings=settings, client=TestClient(app),
                           auth={"Authorization": "Bearer backup-token-1"}, tmp=tmp_path)


def test_snapshot_is_consistent_copy(stand):
    make_db(stand.db, chats=3)
    live = sqlite3.connect(stand.db)  # база открыта и в ней незавершённая запись — как у работающего агента
    live.execute("INSERT INTO conversations VALUES ('pending', 'не сохранён')")
    r = stand.client.get("/internal/backup", headers=stand.auth)
    live.rollback()
    live.close()
    assert r.status_code == 200
    assert r.content.startswith(backup.SQLITE_MAGIC)
    out = stand.tmp / "copy.sqlite3"
    out.write_bytes(r.content)
    import hashlib
    assert r.headers["x-deck-snapshot-sha256"] == hashlib.sha256(r.content).hexdigest()
    con = sqlite3.connect(out)
    assert con.execute("SELECT count(*) FROM conversations").fetchone()[0] == 3
    assert con.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    con.close()
    assert not list(stand.tmp.glob(".snapshot-*")), "временный снимок убран"
    # те же данные — тот же снимок: оператор по хешу не загружает копию повторно
    assert stand.client.get("/internal/backup", headers=stand.auth).headers["x-deck-snapshot-sha256"] == r.headers["x-deck-snapshot-sha256"]


def test_requires_token(stand):
    make_db(stand.db, chats=1)
    for headers in ({}, {"Authorization": "Bearer wrong"}, {"Authorization": "backup-token-1"}, {"Authorization": "Bearer "}):
        for method, path in (("GET", "/internal/backup"), ("GET", "/internal/backup/state"), ("POST", "/internal/restore")):
            assert stand.client.request(method, path, headers=headers, content=b"x").status_code == 401, (headers, path)
    stand.tok.write_text("")  # пустой файл токена — не «пускать всех»
    assert stand.client.get("/internal/backup", headers={"Authorization": "Bearer "}).status_code == 401
    stand.tok.unlink()
    assert stand.client.get("/internal/backup", headers=stand.auth).status_code == 503
    stand.settings.backup_token_file = ""
    assert stand.client.get("/internal/backup", headers=stand.auth).status_code == 404
    stand.settings.backup_token_file, stand.settings.is_space = str(stand.tok), False
    assert stand.client.get("/internal/backup", headers=stand.auth).status_code == 404


def test_restore_only_into_empty_space(stand):
    saved = stand.tmp / "saved.sqlite3"
    make_db(saved, chats=5)
    snap = stand.tmp / "snap.sqlite3"
    backup.snapshot(saved, snap)

    make_db(stand.db, chats=1)  # в пространстве уже есть чат
    assert stand.client.get("/internal/backup/state", headers=stand.auth).json() == {"empty": False}
    r = stand.client.post("/internal/restore", headers=stand.auth, content=snap.read_bytes())
    assert r.status_code == 409 and not backup.restore_file(stand.db).exists() and not stand.exits

    stand.db.unlink()
    for s in ("-wal", "-shm"):
        stand.db.with_name(stand.db.name + s).unlink(missing_ok=True)
    make_db(stand.db)  # новое пустое пространство
    assert stand.client.get("/internal/backup/state", headers=stand.auth).json() == {"empty": True}
    for bad in (b"not a database", backup.SQLITE_MAGIC + b"\x00" * 200):
        r = stand.client.post("/internal/restore", headers=stand.auth, content=bad)
        assert r.status_code == 400 and not backup.restore_file(stand.db).exists()
    other = stand.tmp / "other.sqlite3"  # целая база, но не Fugu Deck
    con = sqlite3.connect(other); con.execute("CREATE TABLE t (x)"); con.commit(); con.close()
    assert stand.client.post("/internal/restore", headers=stand.auth, content=other.read_bytes()).status_code == 400
    assert not stand.exits and not list(stand.tmp.glob(".restore-*"))

    r = stand.client.post("/internal/restore", headers=stand.auth, content=snap.read_bytes())
    assert r.status_code == 200 and backup.restore_file(stand.db).exists()
    # до перезапуска работает прежняя (пустая) база; запуск подменяет её снимком
    assert backup.apply_pending_restore(stand.db) is True
    assert backup.apply_pending_restore(stand.db) is False
    con = sqlite3.connect(stand.db)
    assert con.execute("SELECT count(*) FROM conversations").fetchone()[0] == 5
    con.close()
