"""SQLite-хранилище: чаты, сообщения, вложения, расходы, журнал действий."""
from __future__ import annotations

import json
import re
import time
import uuid
from typing import Any

import aiosqlite

SCHEMA = [
    # v1
    """
    CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT 'Новый чат',
        model TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT,
        tool_calls TEXT,
        tool_call_id TEXT,
        name TEXT,
        meta TEXT,
        created_at REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
    CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        path TEXT NOT NULL,
        created_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT,
        model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        created_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts REAL NOT NULL,
        conversation_id TEXT,
        tool TEXT NOT NULL,
        args TEXT NOT NULL,
        approved INTEGER,
        ok INTEGER,
        summary TEXT
    );
    """,
    # v2: пользователи, проекты, память
    """
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        password_hash TEXT,
        role TEXT NOT NULL DEFAULT 'member',
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '',
        skills TEXT NOT NULL DEFAULT '["*"]',
        color TEXT NOT NULL DEFAULT '',
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_members (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        PRIMARY KEY (project_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS memory_links (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        PRIMARY KEY (project_id, source_id)
    );
    CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '',
        pinned INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'user',
        author TEXT,
        conversation_id TEXT,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id, updated_at);
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content, tags, content='memories', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.id, old.content, old.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.id, old.content, old.tags);
        INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
    END;
    ALTER TABLE conversations ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;
    ALTER TABLE conversations ADD COLUMN created_by TEXT;
    CREATE INDEX IF NOT EXISTS idx_conv_project ON conversations(project_id, updated_at);
    """,
    # v3: модель общего чата — спонсор и предложения о смене модели
    """
    ALTER TABLE conversations ADD COLUMN sponsor_id TEXT;
    ALTER TABLE conversations ADD COLUMN sponsor_limit_usd REAL;
    ALTER TABLE conversations ADD COLUMN sponsor_since REAL;
    CREATE TABLE IF NOT EXISTS model_proposals (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        proposer_id TEXT NOT NULL,
        limit_usd REAL,
        status TEXT NOT NULL DEFAULT 'pending',
        decided_by TEXT,
        created_at REAL NOT NULL,
        decided_at REAL
    );
    CREATE INDEX IF NOT EXISTS idx_proposals_conv ON model_proposals(conversation_id, status);
    """,
    # v4: лимит спонсора в токенах и срок спонсорства
    """
    ALTER TABLE conversations ADD COLUMN sponsor_limit_tokens INTEGER;
    ALTER TABLE conversations ADD COLUMN sponsor_until REAL;
    ALTER TABLE model_proposals ADD COLUMN limit_tokens INTEGER;
    ALTER TABLE model_proposals ADD COLUMN days REAL;
    """,
    # v5: кто запускал и кто платил (сводка расходов по участникам); срок спонсорства датой
    """
    ALTER TABLE usage ADD COLUMN user_id TEXT;
    ALTER TABLE usage ADD COLUMN payer_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_usage_time ON usage(created_at);
    ALTER TABLE model_proposals ADD COLUMN until REAL;
    """,
    # v6: политика смены модели, голосование, срок предложения, состав участников из control-plane
    """
    ALTER TABLE conversations ADD COLUMN model_policy TEXT NOT NULL DEFAULT 'vote';
    ALTER TABLE model_proposals ADD COLUMN expires_at REAL;
    CREATE TABLE IF NOT EXISTS proposal_votes (
        proposal_id TEXT NOT NULL REFERENCES model_proposals(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        vote INTEGER NOT NULL,
        ts REAL NOT NULL,
        PRIMARY KEY (proposal_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS space_members (
        user_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        updated_at REAL NOT NULL
    );
    """,
    # v7: устройства (нативное приложение): ключ сессии (DPoP), ключ подтверждения (подпись действий), сертификат mTLS
    """
    CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT '',
        session_jwk TEXT NOT NULL,
        session_jkt TEXT NOT NULL UNIQUE,
        confirm_jwk TEXT NOT NULL,
        confirm_jkt TEXT NOT NULL,
        key_storage TEXT NOT NULL DEFAULT 'software',
        attestation TEXT,
        cert_serial TEXT,
        cert_expires REAL,
        created_at REAL NOT NULL,
        last_seen REAL,
        revoked_at REAL
    );
    CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
    """,
    # v8: кластер — разрешение спонсора в keyguard (id), привязанное к предложению и к действующей модели чата
    """
    ALTER TABLE model_proposals ADD COLUMN grant_id TEXT;
    ALTER TABLE conversations ADD COLUMN grant_id TEXT;
    """,
]

DEFAULT_PROJECT = "general"


def new_id() -> str:
    return uuid.uuid4().hex[:16]


class Database:
    def __init__(self, path: str):
        self.path = path
        self.conn: aiosqlite.Connection | None = None

    async def connect(self) -> None:
        self.conn = await aiosqlite.connect(self.path)
        self.conn.row_factory = aiosqlite.Row
        await self.conn.execute("PRAGMA journal_mode=WAL")
        await self.conn.execute("PRAGMA foreign_keys=ON")
        await self.conn.execute("CREATE TABLE IF NOT EXISTS schema_version (v INTEGER)")
        row = await (await self.conn.execute("SELECT v FROM schema_version")).fetchone()
        current = row["v"] if row else 0
        for i, script in enumerate(SCHEMA[current:], start=current + 1):
            await self.conn.executescript(script)
            await self.conn.execute("DELETE FROM schema_version")
            await self.conn.execute("INSERT INTO schema_version (v) VALUES (?)", (i,))
        await self.conn.commit()
        # проект по умолчанию + привязка старых чатов
        if not await self._one("SELECT id FROM projects WHERE id=?", (DEFAULT_PROJECT,)):
            now = time.time()
            await self._exec(
                "INSERT INTO projects (id,name,description,created_at,updated_at) VALUES (?,?,?,?,?)",
                (DEFAULT_PROJECT, "Общий", "Проект по умолчанию", now, now))
        await self._exec("UPDATE conversations SET project_id=? WHERE project_id IS NULL", (DEFAULT_PROJECT,))

    async def close(self) -> None:
        if self.conn:
            await self.conn.close()

    # --- helpers ---
    async def _all(self, sql: str, args: tuple = ()) -> list[dict[str, Any]]:
        assert self.conn
        rows = await (await self.conn.execute(sql, args)).fetchall()
        return [dict(r) for r in rows]

    async def _one(self, sql: str, args: tuple = ()) -> dict[str, Any] | None:
        assert self.conn
        row = await (await self.conn.execute(sql, args)).fetchone()
        return dict(row) if row else None

    async def _exec(self, sql: str, args: tuple = ()) -> int:
        assert self.conn
        cur = await self.conn.execute(sql, args)
        await self.conn.commit()
        return cur.lastrowid or 0

    # --- conversations ---
    async def list_conversations(self, project_id: str) -> list[dict]:
        return await self._all(
            "SELECT c.*, COALESCE((SELECT SUM(cost_usd) FROM usage u WHERE u.conversation_id=c.id),0) AS cost_usd, "
            "(SELECT display_name FROM users WHERE id=c.created_by) AS author "
            "FROM conversations c WHERE project_id=? ORDER BY updated_at DESC LIMIT 300", (project_id,)
        )

    async def get_conversation(self, cid: str) -> dict | None:
        return await self._one("SELECT * FROM conversations WHERE id=?", (cid,))

    async def create_conversation(self, model: str, project_id: str, created_by: str | None,
                                  title: str = "Новый чат") -> dict:
        cid, now = new_id(), time.time()
        await self._exec(
            "INSERT INTO conversations (id,title,model,project_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
            (cid, title, model, project_id, created_by, now, now),
        )
        return await self.get_conversation(cid)  # type: ignore[return-value]

    async def update_conversation(self, cid: str, **fields: Any) -> None:
        fields = {k: v for k, v in fields.items() if v is not None}
        if not fields:
            return
        fields["updated_at"] = time.time()
        sets = ",".join(f"{k}=?" for k in fields)
        await self._exec(f"UPDATE conversations SET {sets} WHERE id=?", (*fields.values(), cid))

    async def delete_conversation(self, cid: str) -> list[str]:
        paths = [a["path"] for a in await self._all("SELECT path FROM attachments WHERE conversation_id=?", (cid,))]
        await self._exec("DELETE FROM conversations WHERE id=?", (cid,))
        return paths

    # --- messages ---
    async def add_message(
        self,
        cid: str,
        role: str,
        content: str | None = None,
        tool_calls: list | None = None,
        tool_call_id: str | None = None,
        name: str | None = None,
        meta: dict | None = None,
    ) -> int:
        mid = await self._exec(
            "INSERT INTO messages (conversation_id,role,content,tool_calls,tool_call_id,name,meta,created_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (
                cid,
                role,
                content,
                json.dumps(tool_calls, ensure_ascii=False) if tool_calls else None,
                tool_call_id,
                name,
                json.dumps(meta, ensure_ascii=False) if meta else None,
                time.time(),
            ),
        )
        await self.update_conversation(cid)
        return mid

    # --- спонсор модели и предложения ---
    async def set_sponsor(self, cid: str, model: str, sponsor_id: str | None, limit_usd: float | None = None,
                          limit_tokens: int | None = None, days: float | None = None, until: float | None = None) -> None:
        now = time.time()
        if sponsor_id and until is None and days:
            until = now + days * 86400
        if not sponsor_id:
            until = None
        await self._exec(
            "UPDATE conversations SET model=?, sponsor_id=?, sponsor_limit_usd=?, sponsor_limit_tokens=?, sponsor_until=?, "
            "sponsor_since=?, updated_at=? WHERE id=?",
            (model, sponsor_id, limit_usd if sponsor_id else None, limit_tokens if sponsor_id else None, until,
             now if sponsor_id else None, now, cid))

    async def set_sponsor_limits(self, cid: str, **fields: Any) -> None:
        """Меняет только переданные поля: sponsor_limit_usd, sponsor_limit_tokens, sponsor_until (None = снять)."""
        if not fields:
            return
        sets = ",".join(f"{k}=?" for k in fields)
        await self._exec(f"UPDATE conversations SET {sets} WHERE id=?", (*fields.values(), cid))

    async def sponsor_usage(self, cid: str, since: float | None) -> dict:
        if not since:
            return {"usd": 0.0, "tokens": 0}
        r = await self._one("SELECT COALESCE(SUM(cost_usd),0) AS usd, COALESCE(SUM(prompt_tokens+completion_tokens),0) AS tokens "
                            "FROM usage WHERE conversation_id=? AND created_at>=?", (cid, since))
        return {"usd": float(r["usd"]), "tokens": int(r["tokens"])}

    async def sponsor_spent(self, cid: str, since: float | None) -> float:
        return (await self.sponsor_usage(cid, since))["usd"]

    async def create_proposal(self, cid: str, model: str, proposer_id: str, limit_usd: float | None,
                              limit_tokens: int | None = None, days: float | None = None,
                              until: float | None = None, ttl: float = 86400) -> dict:
        await self._exec("UPDATE model_proposals SET status='superseded', decided_at=? "
                         "WHERE conversation_id=? AND status='pending'", (time.time(), cid))
        pid = new_id()
        now = time.time()
        await self._exec("INSERT INTO model_proposals (id,conversation_id,model,proposer_id,limit_usd,limit_tokens,days,until,"
                         "created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                         (pid, cid, model, proposer_id, limit_usd, limit_tokens, days, until, now, now + ttl))
        await self.vote(pid, proposer_id, True)  # автор предложения голосует «за»
        return await self.proposal(pid)

    async def proposal(self, pid: str) -> dict | None:
        return await self._one("SELECT p.*, u.display_name AS proposer_name FROM model_proposals p "
                               "LEFT JOIN users u ON u.id=p.proposer_id WHERE p.id=?", (pid,))

    async def pending_proposal(self, cid: str) -> dict | None:
        return await self._one("SELECT p.*, u.display_name AS proposer_name FROM model_proposals p "
                               "LEFT JOIN users u ON u.id=p.proposer_id "
                               "WHERE p.conversation_id=? AND p.status='pending' ORDER BY p.created_at DESC LIMIT 1", (cid,))

    async def set_proposal_grant(self, pid: str, grant_id: str) -> None:
        await self._exec("UPDATE model_proposals SET grant_id=? WHERE id=? AND status='pending'", (grant_id, pid))

    async def proposal_of_grant(self, grant_id: str) -> str | None:
        r = await self._one("SELECT id FROM model_proposals WHERE grant_id=? ORDER BY created_at DESC LIMIT 1", (grant_id,))
        return r["id"] if r else None

    async def set_conversation_grant(self, cid: str, grant_id: str | None) -> None:
        await self._exec("UPDATE conversations SET grant_id=? WHERE id=?", (grant_id, cid))

    async def decide_proposal(self, pid: str, status: str, by: str) -> None:
        await self._exec("UPDATE model_proposals SET status=?, decided_by=?, decided_at=? WHERE id=? AND status='pending'",
                         (status, by, time.time(), pid))

    async def vote(self, pid: str, uid: str, yes: bool) -> None:
        await self._exec("INSERT INTO proposal_votes (proposal_id,user_id,vote,ts) VALUES (?,?,?,?) "
                         "ON CONFLICT(proposal_id,user_id) DO UPDATE SET vote=excluded.vote, ts=excluded.ts",
                         (pid, uid, int(yes), time.time()))

    async def votes(self, pid: str) -> list[dict]:
        return await self._all("SELECT v.user_id, v.vote, COALESCE(m.name, u.display_name, '?') AS name FROM proposal_votes v "
                               "LEFT JOIN space_members m ON m.user_id=v.user_id LEFT JOIN users u ON u.id=v.user_id "
                               "WHERE v.proposal_id=? ORDER BY v.ts", (pid,))

    async def expire_proposals(self, now: float | None = None) -> list[dict]:
        """Просроченные предложения помечаем expired и возвращаем (для отметки в чате)."""
        now = now or time.time()
        rows = await self._all("SELECT * FROM model_proposals WHERE status='pending' AND expires_at IS NOT NULL AND expires_at<=?",
                               (now,))
        for r in rows:
            await self._exec("UPDATE model_proposals SET status='expired', decided_at=? WHERE id=? AND status='pending'",
                             (now, r["id"]))
        return rows

    # --- состав участников пространства (присылает control-plane) ---
    async def set_roster(self, members: list[dict]) -> None:
        assert self.conn
        await self.conn.execute("DELETE FROM space_members")
        now = time.time()
        for m in members:
            await self.conn.execute("INSERT INTO space_members (user_id,name,role,updated_at) VALUES (?,?,?,?)",
                                    (m["id"], m["name"], m["role"], now))
        await self.conn.commit()

    async def roster(self) -> list[dict]:
        return await self._all("SELECT user_id AS id, name, role FROM space_members ORDER BY name")

    async def set_model_policy(self, cid: str, policy: str) -> None:
        await self._exec("UPDATE conversations SET model_policy=? WHERE id=?", (policy, cid))

    async def has_messages(self, cid: str) -> bool:
        return bool(await self._one("SELECT 1 FROM messages WHERE conversation_id=? LIMIT 1", (cid,)))

    async def has_dialogue(self, cid: str) -> bool:
        """Была ли в чате переписка (служебные отметки о выборе модели не в счёт)."""
        return bool(await self._one("SELECT 1 FROM messages WHERE conversation_id=? AND role!='note' LIMIT 1", (cid,)))

    async def get_messages(self, cid: str) -> list[dict]:
        rows = await self._all("SELECT * FROM messages WHERE conversation_id=? ORDER BY id", (cid,))
        for r in rows:
            r["tool_calls"] = json.loads(r["tool_calls"]) if r["tool_calls"] else None
            r["meta"] = json.loads(r["meta"]) if r["meta"] else None
        return rows

    # --- attachments ---
    async def add_attachment(self, cid: str, filename: str, mime: str, size: int, path: str) -> dict:
        aid = new_id()
        await self._exec(
            "INSERT INTO attachments (id,conversation_id,filename,mime,size,path,created_at) VALUES (?,?,?,?,?,?,?)",
            (aid, cid, filename, mime, size, path, time.time()),
        )
        return {"id": aid, "conversation_id": cid, "filename": filename, "mime": mime, "size": size}

    async def get_attachment(self, aid: str) -> dict | None:
        return await self._one("SELECT * FROM attachments WHERE id=?", (aid,))

    async def list_attachments(self, cid: str) -> list[dict]:
        return await self._all(
            "SELECT id,filename,mime,size,created_at FROM attachments WHERE conversation_id=? ORDER BY created_at",
            (cid,),
        )

    # --- usage ---
    async def add_usage(self, cid: str | None, model: str, p: int, c: int, cached: int, cost: float,
                        user_id: str | None = None, payer_id: str | None = None) -> None:
        await self._exec(
            "INSERT INTO usage (conversation_id,model,prompt_tokens,completion_tokens,cached_tokens,cost_usd,created_at,"
            "user_id,payer_id) VALUES (?,?,?,?,?,?,?,?,?)",
            (cid, model, p, c, cached, cost, time.time(), user_id, payer_id),
        )

    async def usage_by_member(self, since: float) -> list[dict]:
        """По каждому участнику: сколько стоили запуски, которые он сделал, и сколько оплачено его ключом."""
        rows = await self._all(
            "WITH u AS (SELECT * FROM usage WHERE created_at>=?), "
            "ids AS (SELECT user_id AS id FROM u UNION SELECT payer_id FROM u) "
            "SELECT ids.id AS user_id, us.display_name AS name, "
            " COALESCE((SELECT SUM(cost_usd) FROM u WHERE u.user_id IS ids.id),0) AS launched_usd, "
            " COALESCE((SELECT SUM(prompt_tokens+completion_tokens) FROM u WHERE u.user_id IS ids.id),0) AS launched_tokens, "
            " COALESCE((SELECT COUNT(*) FROM u WHERE u.user_id IS ids.id),0) AS requests, "
            " COALESCE((SELECT SUM(cost_usd) FROM u WHERE u.payer_id IS ids.id),0) AS paid_usd, "
            " COALESCE((SELECT SUM(prompt_tokens+completion_tokens) FROM u WHERE u.payer_id IS ids.id),0) AS paid_tokens, "
            " COALESCE((SELECT SUM(cost_usd) FROM u WHERE u.payer_id IS ids.id AND u.user_id IS NOT ids.id),0) AS paid_for_others_usd "
            "FROM ids LEFT JOIN users us ON us.id=ids.id "
            "ORDER BY paid_usd DESC, launched_usd DESC", (since,))
        return rows

    async def usage_by_model(self, since: float) -> list[dict]:
        return await self._all(
            "SELECT model, COALESCE(SUM(cost_usd),0) AS usd, COALESCE(SUM(prompt_tokens+completion_tokens),0) AS tokens, "
            "COUNT(*) AS requests FROM usage WHERE created_at>=? GROUP BY model ORDER BY usd DESC", (since,))

    async def usage_since(self, ts: float) -> dict:
        row = await self._one(
            "SELECT COALESCE(SUM(cost_usd),0) AS cost_usd, COALESCE(SUM(prompt_tokens),0) AS prompt_tokens, "
            "COALESCE(SUM(completion_tokens),0) AS completion_tokens, COUNT(*) AS requests FROM usage WHERE created_at>=?",
            (ts,),
        )
        return row or {}

    # --- audit ---
    async def audit(self, cid: str | None, tool: str, args: dict, approved: bool | None, ok: bool, summary: str) -> None:
        await self._exec(
            "INSERT INTO audit_log (ts,conversation_id,tool,args,approved,ok,summary) VALUES (?,?,?,?,?,?,?)",
            (time.time(), cid, tool, json.dumps(args, ensure_ascii=False)[:20000],
             None if approved is None else int(approved), int(ok), summary[:2000]),
        )

    async def list_audit(self, limit: int = 100) -> list[dict]:
        rows = await self._all("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (limit,))
        for r in rows:
            r["args"] = json.loads(r["args"])
        return rows

    # ================================================================ пользователи
    # --- устройства ---
    async def add_device(self, user_id: str, name: str, platform: str, session_jwk: dict, session_jkt: str,
                         confirm_jwk: dict, confirm_jkt: str, key_storage: str, attestation: dict | None) -> dict:
        did = new_id()
        await self._exec("INSERT INTO devices (id,user_id,name,platform,session_jwk,session_jkt,confirm_jwk,confirm_jkt,"
                         "key_storage,attestation,created_at,last_seen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                         (did, user_id, name[:80], platform[:40], json.dumps(session_jwk), session_jkt, json.dumps(confirm_jwk),
                          confirm_jkt, key_storage, json.dumps(attestation) if attestation else None, time.time(), time.time()))
        return await self.get_device(did)

    async def get_device(self, did: str) -> dict | None:
        d = await self._one("SELECT * FROM devices WHERE id=?", (did,))
        if d:
            d["session_jwk"] = json.loads(d["session_jwk"]); d["confirm_jwk"] = json.loads(d["confirm_jwk"])
        return d

    async def list_devices(self, user_id: str) -> list[dict]:
        return await self._all("SELECT id,name,platform,key_storage,cert_serial,cert_expires,created_at,last_seen,revoked_at "
                               "FROM devices WHERE user_id=? ORDER BY created_at", (user_id,))

    async def touch_device(self, did: str) -> None:
        await self._exec("UPDATE devices SET last_seen=? WHERE id=?", (time.time(), did))

    async def revoke_device(self, did: str) -> None:
        await self._exec("UPDATE devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL", (time.time(), did))

    async def set_device_cert(self, did: str, serial: str, expires: float) -> None:
        await self._exec("UPDATE devices SET cert_serial=?, cert_expires=? WHERE id=?", (serial, expires, did))

    async def get_user(self, uid: str) -> dict | None:
        return await self._one("SELECT * FROM users WHERE id=?", (uid,))

    async def get_user_by_name(self, username: str) -> dict | None:
        return await self._one("SELECT * FROM users WHERE username=?", (username,))

    async def list_users(self) -> list[dict]:
        return await self._all("SELECT id,username,display_name,role,disabled,created_at FROM users ORDER BY created_at")

    async def upsert_owner(self, username: str) -> dict:
        u = await self._one("SELECT * FROM users WHERE role='owner'")
        if u:
            if u["username"] != username:
                await self._exec("UPDATE users SET username=? WHERE id=?", (username, u["id"]))
            return await self.get_user(u["id"])  # type: ignore[return-value]
        uid = new_id()
        await self._exec("INSERT INTO users (id,username,display_name,role,created_at) VALUES (?,?,?,?,?)",
                         (uid, username, username, "owner", time.time()))
        return await self.get_user(uid)  # type: ignore[return-value]

    async def create_space_user(self, uid: str, username: str, display_name: str) -> None:
        """Пользователь пространства кластера: учётка живёт в control-plane, здесь — только имя."""
        await self._exec("INSERT OR IGNORE INTO users (id,username,display_name,role,created_at) VALUES (?,?,?,?,?)",
                         (uid, f"{username}#{uid[:6]}", display_name, "member", time.time()))

    async def list_all_projects(self, role: str) -> list[dict]:
        rows = await self._all(
            "SELECT p.*, ? AS my_role, "
            "(SELECT COUNT(*) FROM conversations c WHERE c.project_id=p.id) AS conversations, "
            "(SELECT COUNT(*) FROM memories m WHERE m.project_id=p.id) AS memories "
            "FROM projects p ORDER BY p.updated_at DESC", (role,))
        for r in rows:
            r["skills"] = json.loads(r["skills"])
        return rows

    async def create_user(self, username: str, display_name: str, password_hash: str) -> dict:
        uid = new_id()
        await self._exec(
            "INSERT INTO users (id,username,display_name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)",
            (uid, username, display_name, password_hash, "member", time.time()))
        return await self.get_user(uid)  # type: ignore[return-value]

    async def update_user(self, uid: str, **fields: Any) -> None:
        fields = {k: v for k, v in fields.items() if v is not None}
        if fields:
            sets = ",".join(f"{k}=?" for k in fields)
            await self._exec(f"UPDATE users SET {sets} WHERE id=?", (*fields.values(), uid))

    async def delete_user(self, uid: str) -> None:
        await self._exec("DELETE FROM users WHERE id=? AND role!='owner'", (uid,))

    # ================================================================ проекты
    async def list_projects_for(self, user: dict) -> list[dict]:
        base = ("SELECT p.*, {role} AS my_role, "
                "(SELECT COUNT(*) FROM conversations c WHERE c.project_id=p.id) AS conversations, "
                "(SELECT COUNT(*) FROM memories m WHERE m.project_id=p.id) AS memories "
                "FROM projects p {join} ORDER BY p.updated_at DESC")
        if user["role"] == "owner":
            rows = await self._all(base.format(role="'owner'", join=""))
        else:
            rows = await self._all(base.format(
                role="pm.role", join="JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=?"), (user["id"],))
        for r in rows:
            r["skills"] = json.loads(r["skills"])
        return rows

    async def get_project(self, pid: str) -> dict | None:
        p = await self._one("SELECT * FROM projects WHERE id=?", (pid,))
        if p:
            p["skills"] = json.loads(p["skills"])
        return p

    async def create_project(self, name: str, description: str, creator: dict) -> dict:
        pid, now = new_id(), time.time()
        await self._exec(
            "INSERT INTO projects (id,name,description,created_at,updated_at) VALUES (?,?,?,?,?)",
            (pid, name, description, now, now))
        if creator["role"] != "owner":
            await self.set_member(pid, creator["id"], "owner")
        return await self.get_project(pid)  # type: ignore[return-value]

    async def update_project(self, pid: str, **fields: Any) -> None:
        fields = {k: (json.dumps(v) if k == "skills" else v) for k, v in fields.items() if v is not None}
        if not fields:
            return
        fields["updated_at"] = time.time()
        sets = ",".join(f"{k}=?" for k in fields)
        await self._exec(f"UPDATE projects SET {sets} WHERE id=?", (*fields.values(), pid))

    async def delete_project(self, pid: str) -> None:
        await self._exec("DELETE FROM projects WHERE id=?", (pid,))

    async def project_role(self, user: dict, pid: str) -> str | None:
        if user["role"] == "owner":
            return "owner" if await self._one("SELECT 1 FROM projects WHERE id=?", (pid,)) else None
        r = await self._one("SELECT role FROM project_members WHERE project_id=? AND user_id=?", (pid, user["id"]))
        return r["role"] if r else None

    async def members(self, pid: str) -> list[dict]:
        return await self._all(
            "SELECT u.id,u.username,u.display_name,pm.role FROM project_members pm JOIN users u ON u.id=pm.user_id "
            "WHERE pm.project_id=? ORDER BY u.username", (pid,))

    async def set_member(self, pid: str, uid: str, role: str | None) -> None:
        if role is None:
            await self._exec("DELETE FROM project_members WHERE project_id=? AND user_id=?", (pid, uid))
        else:
            await self._exec("INSERT INTO project_members (project_id,user_id,role) VALUES (?,?,?) "
                             "ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role", (pid, uid, role))

    async def project_user_ids(self, pid: str) -> set[str]:
        rows = await self._all("SELECT user_id FROM project_members WHERE project_id=? "
                               "UNION SELECT id FROM users WHERE role='owner'", (pid,))
        return {r["user_id"] for r in rows}

    # ================================================================ связи памяти
    async def memory_sources(self, pid: str) -> list[dict]:
        """Проекты, память которых доступна проекту pid на чтение."""
        return await self._all("SELECT p.id,p.name FROM memory_links l JOIN projects p ON p.id=l.source_id "
                               "WHERE l.project_id=? ORDER BY p.name", (pid,))

    async def set_memory_sources(self, pid: str, source_ids: list[str]) -> None:
        assert self.conn
        await self.conn.execute("DELETE FROM memory_links WHERE project_id=?", (pid,))
        for s in source_ids:
            if s != pid:
                await self.conn.execute("INSERT OR IGNORE INTO memory_links (project_id,source_id) VALUES (?,?)", (pid, s))
        await self.conn.commit()

    # ================================================================ память
    async def list_memories(self, pid: str, limit: int = 500) -> list[dict]:
        return await self._all("SELECT * FROM memories WHERE project_id=? ORDER BY pinned DESC, updated_at DESC LIMIT ?",
                               (pid, limit))

    async def get_memory(self, mid: int) -> dict | None:
        return await self._one("SELECT * FROM memories WHERE id=?", (mid,))

    async def add_memory(self, pid: str, content: str, tags: str = "", source: str = "user",
                         author: str | None = None, conversation_id: str | None = None, pinned: bool = False) -> dict:
        now = time.time()
        mid = await self._exec(
            "INSERT INTO memories (project_id,content,tags,pinned,source,author,conversation_id,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)", (pid, content, tags, int(pinned), source, author, conversation_id, now, now))
        return await self.get_memory(mid)  # type: ignore[return-value]

    async def update_memory(self, mid: int, **fields: Any) -> None:
        fields = {k: (int(v) if k == "pinned" else v) for k, v in fields.items() if v is not None}
        if not fields:
            return
        fields["updated_at"] = time.time()
        sets = ",".join(f"{k}=?" for k in fields)
        await self._exec(f"UPDATE memories SET {sets} WHERE id=?", (*fields.values(), mid))

    async def delete_memory(self, mid: int) -> None:
        await self._exec("DELETE FROM memories WHERE id=?", (mid,))

    async def search_memories(self, project_ids: list[str], query: str, limit: int = 20) -> list[dict]:
        if not project_ids:
            return []
        marks = ",".join("?" * len(project_ids))
        words = [w for w in re.findall(r"\w+", query.lower()) if len(w) > 1][:12]
        if words:
            fts = " OR ".join(f'"{w}"*' for w in words)
            try:
                return await self._all(
                    f"SELECT m.*, p.name AS project_name FROM memories_fts f JOIN memories m ON m.id=f.rowid "
                    f"JOIN projects p ON p.id=m.project_id WHERE memories_fts MATCH ? AND m.project_id IN ({marks}) "
                    f"ORDER BY bm25(memories_fts) LIMIT ?", (fts, *project_ids, limit))
            except Exception:
                pass
        return await self._all(
            f"SELECT m.*, p.name AS project_name FROM memories m JOIN projects p ON p.id=m.project_id "
            f"WHERE m.project_id IN ({marks}) AND (m.content LIKE ? OR m.tags LIKE ?) ORDER BY m.updated_at DESC LIMIT ?",
            (*project_ids, f"%{query}%", f"%{query}%", limit))
