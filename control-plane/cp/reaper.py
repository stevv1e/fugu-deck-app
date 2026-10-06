"""Правило неактивности: 48 ч — предупреждение, 72 ч — удаление всех данных пользователя.

Запускается раз в час (CronJob в кластере, фоновая задача в локальном режиме):
    python -m cp.reaper
Учётная запись (ник + публичный ключ passkey) сохраняется, чтобы человек мог войти снова —
он получит пустое пространство. Ключи API и так хранятся только на его телефоне.
"""
from __future__ import annotations

import asyncio
import logging
import time

from .db import ROLES

log = logging.getLogger("reaper")


async def purge_user(db, orch, notifier, user: dict, revoke, on_change=None) -> dict:
    uid = user["id"]
    report = {"user": user["nick"], "deleted_spaces": [], "left_spaces": [], "transferred": []}
    for sp in await db.spaces_of(uid):
        if sp["kind"] == "personal":
            await orch.delete(sp)
            await db.delete_space(sp["id"])
            report["deleted_spaces"].append(sp["id"])
            continue
        # общий проект: выходим из него
        await db.remove_member(sp["id"], uid)
        await revoke(sp, uid)
        rest = await db.members(sp["id"])
        if not rest:
            await orch.delete(sp)
            await db.delete_space(sp["id"])
            report["deleted_spaces"].append(sp["id"])
            continue
        report["left_spaces"].append(sp["id"])
        if sp["role"] == "owner" and not any(m["role"] == "owner" for m in rest):
            heir = sorted(rest, key=lambda m: (-ROLES[m["role"]], m["joined_at"]))[0]
            await db.set_role(sp["id"], heir["id"], "owner")
            await db.exec("UPDATE spaces SET owner_id=? WHERE id=?", (heir["id"], sp["id"]))
            await db.notify(heir["id"], "ownership", {"space_id": sp["id"], "space_name": sp["name"]})
            notifier.send(heir["id"], {"type": "spaces"})
            report["transferred"].append({"space": sp["id"], "to": heir["nick"]})
        for m in rest:
            notifier.send(m["id"], {"type": "members", "space_id": sp["id"]})
        if on_change:
            await on_change(sp)
    await db.delete_invites_of(uid)
    await db.exec("DELETE FROM notifications WHERE user_id=?", (uid,))
    await db.exec("UPDATE users SET purged_at=?, warned_at=NULL WHERE id=?", (time.time(), uid))
    await db.audit(None, "purge", user["nick"])
    return report


async def run_once(db, orch, notifier, settings, revoke, now: float | None = None, on_change=None) -> dict:
    now = now or time.time()
    warn, purge = settings.warn_after_hours * 3600, settings.purge_after_hours * 3600
    result = {"warned": [], "purged": []}
    for u in await db.all("SELECT * FROM users WHERE purged_at IS NULL"):
        last = u["last_seen"] or u["created_at"]
        idle = now - last
        if idle >= purge:
            result["purged"].append(await purge_user(db, orch, notifier, u, revoke, on_change))
        elif idle >= warn and not u["warned_at"]:
            left_h = max(1, round((purge - idle) / 3600))
            await db.notify(u["id"], "inactivity", {"hours_left": left_h})
            await db.exec("UPDATE users SET warned_at=? WHERE id=?", (now, u["id"]))
            notifier.send(u["id"], {"type": "notification", "kind": "inactivity", "hours_left": left_h})
            result["warned"].append(u["nick"])
    if result["warned"] or result["purged"]:
        log.info("reaper: %s", result)
    return result


async def _main():
    from .config import get_settings
    from .db import DB
    from .events import Notifier
    from .keys import Keys
    from .main import revoke_in_space
    from .orchestrator import make_orchestrator

    s = get_settings()
    db = DB(str(s.db_path))
    await db.connect()
    keys = Keys(s.data_dir)
    orch = make_orchestrator(s, keys)
    try:
        res = await run_once(db, orch, Notifier(), s, lambda sp, uid: revoke_in_space(orch, keys, sp, uid))
        print(res)
    finally:
        await orch.close()
        await db.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(_main())
