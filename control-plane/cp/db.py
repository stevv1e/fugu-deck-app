"""Хранилище control-plane. Здесь НЕТ ключей API, паролей, чатов и памяти —
только учётные записи (ник + публичный ключ passkey), пространства, участники и приглашения."""
from __future__ import annotations

import json
import secrets
import time
from typing import Any

import aiosqlite

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    nick TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL,
    last_seen REAL,
    warned_at REAL,
    purged_at REAL
);
CREATE TABLE IF NOT EXISTS credentials (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key BLOB NOT NULL,
    sign_count INTEGER NOT NULL DEFAULT 0,
    transports TEXT,
    created_at REAL NOT NULL,
    last_used REAL
);
CREATE TABLE IF NOT EXISTS invite_codes (
    code TEXT PRIMARY KEY,
    created_by TEXT,
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL,
    used_by TEXT,
    used_at REAL
);
CREATE TABLE IF NOT EXISTS spaces (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    owner_id TEXT,
    created_at REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT
);
CREATE TABLE IF NOT EXISTS memberships (
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    joined_at REAL NOT NULL,
    PRIMARY KEY (space_id, user_id)
);
CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    from_user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at REAL NOT NULL,
    read INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    user_id TEXT,
    action TEXT NOT NULL,
    detail TEXT
);
"""

ROLES = {"viewer": 1, "editor": 2, "owner": 3}


def new_id(n: int = 10) -> str:
    return secrets.token_hex(n // 2 + 1)[:n]


class DB:
    def __init__(self, path: str):
        self.path = path
        self.conn: aiosqlite.Connection | None = None

    async def connect(self):
        self.conn = await aiosqlite.connect(self.path)
        self.conn.row_factory = aiosqlite.Row
        await self.conn.execute("PRAGMA journal_mode=WAL")
        await self.conn.execute("PRAGMA foreign_keys=ON")
        await self.conn.executescript(SCHEMA)
        await self.conn.commit()

    async def close(self):
        if self.conn:
            await self.conn.close()

    async def all(self, sql: str, args: tuple = ()) -> list[dict[str, Any]]:
        return [dict(r) for r in await (await self.conn.execute(sql, args)).fetchall()]

    async def one(self, sql: str, args: tuple = ()) -> dict[str, Any] | None:
        r = await (await self.conn.execute(sql, args)).fetchone()
        return dict(r) if r else None

    async def exec(self, sql: str, args: tuple = ()) -> int:
        cur = await self.conn.execute(sql, args)
        await self.conn.commit()
        return cur.lastrowid or 0

    # ---------------------------------------------------------------- пользователи
    async def user(self, uid: str) -> dict | None:
        return await self.one("SELECT * FROM users WHERE id=?", (uid,))

    async def user_by_nick(self, nick: str) -> dict | None:
        return await self.one("SELECT * FROM users WHERE nick=?", (nick,))

    async def count_users(self) -> int:
        return (await self.one("SELECT COUNT(*) AS n FROM users"))["n"]

    async def create_user(self, uid: str, nick: str, display_name: str, is_admin: bool) -> dict:
        now = time.time()
        await self.exec("INSERT INTO users (id,nick,display_name,is_admin,created_at,last_seen) VALUES (?,?,?,?,?,?)",
                        (uid, nick, display_name, int(is_admin), now, now))
        return await self.user(uid)

    async def touch(self, uid: str) -> None:
        await self.exec("UPDATE users SET last_seen=?, warned_at=NULL, purged_at=NULL WHERE id=?", (time.time(), uid))

    async def search_users(self, q: str, exclude: str, limit: int = 5) -> list[dict]:
        like = q.replace("%", "").replace("_", "") + "%"
        return await self.all("SELECT id,nick,display_name FROM users WHERE nick LIKE ? AND id!=? ORDER BY nick LIMIT ?",
                              (like, exclude, limit))

    # ---------------------------------------------------------------- passkeys
    async def add_credential(self, cid: str, uid: str, public_key: bytes, sign_count: int, transports: list | None):
        await self.exec("INSERT INTO credentials (id,user_id,public_key,sign_count,transports,created_at) VALUES (?,?,?,?,?,?)",
                        (cid, uid, public_key, sign_count, json.dumps(transports or []), time.time()))

    async def credential(self, cid: str) -> dict | None:
        return await self.one("SELECT * FROM credentials WHERE id=?", (cid,))

    async def credentials_of(self, uid: str) -> list[dict]:
        return await self.all("SELECT id,transports,created_at,last_used FROM credentials WHERE user_id=?", (uid,))

    async def bump_credential(self, cid: str, sign_count: int):
        await self.exec("UPDATE credentials SET sign_count=?, last_used=? WHERE id=?", (sign_count, time.time(), cid))

    # ---------------------------------------------------------------- коды приглашения в сервис
    async def create_code(self, by: str | None, hours: float = 72) -> str:
        code = "-".join(secrets.token_hex(2).upper() for _ in range(3))
        now = time.time()
        await self.exec("INSERT INTO invite_codes (code,created_by,created_at,expires_at) VALUES (?,?,?,?)",
                        (code, by, now, now + hours * 3600))
        return code

    async def use_code(self, code: str, uid: str) -> bool:
        now = time.time()
        cur = await self.conn.execute(
            "UPDATE invite_codes SET used_by=?, used_at=? WHERE code=? AND used_by IS NULL AND expires_at>?",
            (uid, now, code.strip().upper(), now))
        await self.conn.commit()
        return cur.rowcount == 1

    async def code_valid(self, code: str) -> bool:
        return bool(await self.one("SELECT 1 FROM invite_codes WHERE code=? AND used_by IS NULL AND expires_at>?",
                                   (code.strip().upper(), time.time())))

    async def list_codes(self) -> list[dict]:
        return await self.all("SELECT c.*, u.nick AS used_by_nick FROM invite_codes c LEFT JOIN users u ON u.id=c.used_by "
                              "ORDER BY c.created_at DESC LIMIT 50")

    # ---------------------------------------------------------------- пространства
    async def create_space(self, kind: str, name: str, owner_id: str) -> dict:
        sid = ("u-" if kind == "personal" else "t-") + new_id(10)
        now = time.time()
        await self.exec("INSERT INTO spaces (id,kind,name,owner_id,created_at) VALUES (?,?,?,?,?)",
                        (sid, kind, name, owner_id, now))
        await self.exec("INSERT INTO memberships (space_id,user_id,role,joined_at) VALUES (?,?,?,?)",
                        (sid, owner_id, "owner", now))
        return await self.space(sid)

    async def space(self, sid: str) -> dict | None:
        return await self.one("SELECT * FROM spaces WHERE id=?", (sid,))

    async def all_spaces(self) -> list[dict]:
        return await self.all("SELECT * FROM spaces")

    async def set_space_status(self, sid: str, status: str, error: str | None = None):
        await self.exec("UPDATE spaces SET status=?, error=? WHERE id=?", (status, error, sid))

    async def rename_space(self, sid: str, name: str):
        await self.exec("UPDATE spaces SET name=? WHERE id=?", (name, sid))

    async def delete_space(self, sid: str):
        await self.exec("DELETE FROM spaces WHERE id=?", (sid,))

    async def personal_space(self, uid: str) -> dict | None:
        return await self.one("SELECT * FROM spaces WHERE kind='personal' AND owner_id=?", (uid,))

    async def spaces_of(self, uid: str) -> list[dict]:
        return await self.all(
            "SELECT s.*, m.role, (SELECT COUNT(*) FROM memberships x WHERE x.space_id=s.id) AS members "
            "FROM spaces s JOIN memberships m ON m.space_id=s.id AND m.user_id=? "
            "ORDER BY s.kind DESC, s.created_at", (uid,))

    async def role(self, sid: str, uid: str) -> str | None:
        r = await self.one("SELECT role FROM memberships WHERE space_id=? AND user_id=?", (sid, uid))
        return r["role"] if r else None

    async def members(self, sid: str) -> list[dict]:
        return await self.all(
            "SELECT u.id,u.nick,u.display_name,m.role,m.joined_at,u.last_seen FROM memberships m "
            "JOIN users u ON u.id=m.user_id WHERE m.space_id=? ORDER BY m.joined_at", (sid,))

    async def set_role(self, sid: str, uid: str, role: str):
        await self.exec("UPDATE memberships SET role=? WHERE space_id=? AND user_id=?", (role, sid, uid))

    async def add_member(self, sid: str, uid: str, role: str):
        await self.exec("INSERT OR REPLACE INTO memberships (space_id,user_id,role,joined_at) VALUES (?,?,?,?)",
                        (sid, uid, role, time.time()))

    async def remove_member(self, sid: str, uid: str):
        await self.exec("DELETE FROM memberships WHERE space_id=? AND user_id=?", (sid, uid))

    # ---------------------------------------------------------------- приглашения в общий проект
    async def create_invite(self, sid: str, from_user: str, to_user: str, role: str) -> dict:
        await self.exec("DELETE FROM invites WHERE space_id=? AND to_user=? AND status='pending'", (sid, to_user))
        iid = new_id(12)
        await self.exec("INSERT INTO invites (id,space_id,from_user,to_user,role,created_at) VALUES (?,?,?,?,?,?)",
                        (iid, sid, from_user, to_user, role, time.time()))
        return await self.invite(iid)

    async def invite(self, iid: str) -> dict | None:
        return await self.one("SELECT * FROM invites WHERE id=?", (iid,))

    async def invites_for(self, uid: str) -> list[dict]:
        return await self.all(
            "SELECT i.*, s.name AS space_name, u.nick AS from_nick, u.display_name AS from_name FROM invites i "
            "JOIN spaces s ON s.id=i.space_id JOIN users u ON u.id=i.from_user "
            "WHERE i.to_user=? AND i.status='pending' ORDER BY i.created_at DESC", (uid,))

    async def pending_invites(self, sid: str) -> list[dict]:
        return await self.all(
            "SELECT i.id,i.role,i.created_at,u.nick,u.display_name FROM invites i JOIN users u ON u.id=i.to_user "
            "WHERE i.space_id=? AND i.status='pending'", (sid,))

    async def set_invite(self, iid: str, status: str):
        await self.exec("UPDATE invites SET status=? WHERE id=?", (status, iid))

    async def delete_invites_of(self, uid: str):
        await self.exec("DELETE FROM invites WHERE to_user=? OR from_user=?", (uid, uid))

    # ---------------------------------------------------------------- уведомления и журнал
    async def notify(self, uid: str, kind: str, payload: dict) -> dict:
        nid = await self.exec("INSERT INTO notifications (user_id,kind,payload,created_at) VALUES (?,?,?,?)",
                              (uid, kind, json.dumps(payload, ensure_ascii=False), time.time()))
        return {"id": nid, "kind": kind, "payload": payload}

    async def notifications(self, uid: str) -> list[dict]:
        rows = await self.all("SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50", (uid,))
        for r in rows:
            r["payload"] = json.loads(r["payload"])
        return rows

    async def mark_read(self, uid: str):
        await self.exec("UPDATE notifications SET read=1 WHERE user_id=?", (uid,))

    async def audit(self, uid: str | None, action: str, detail: str = ""):
        await self.exec("INSERT INTO audit (ts,user_id,action,detail) VALUES (?,?,?,?)", (time.time(), uid, action, detail))
