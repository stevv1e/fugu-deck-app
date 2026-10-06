"""Шина событий реального времени.

Все устройства и пользователи держат одно SSE-соединение /api/events.
Сервер рассылает изменения (чаты, запуски агентов, память, скилы, присутствие)
только тем, у кого есть доступ к проекту.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field

PRESENCE_TTL = 60


@dataclass(eq=False)
class Subscriber:
    user_id: str
    device_id: str
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=500))
    kicked: bool = False


class Broker:
    def __init__(self, db, all_users: bool = False):
        self.db = db
        # в пространстве кластера все участники видят все проекты — доступ уже проверен токеном
        self.all_users = all_users
        self.subs: set[Subscriber] = set()
        # (user_id, device_id) -> {project_id, conversation_id, name, ts}
        self.presence: dict[tuple[str, str], dict] = {}

    def subscribe(self, user_id: str, device_id: str) -> Subscriber:
        s = Subscriber(user_id, device_id)
        self.subs.add(s)
        return s

    def kick(self, user_id: str) -> None:
        """Отозванный участник: закрываем все его потоки событий."""
        for s in list(self.subs):
            if s.user_id == user_id:
                try:
                    s.queue.put_nowait({"type": "kicked"})
                except asyncio.QueueFull:
                    pass
                s.kicked = True

    async def unsubscribe(self, s: Subscriber) -> None:
        self.subs.discard(s)
        p = self.presence.pop((s.user_id, s.device_id), None)
        if p and p.get("project_id"):
            await self.broadcast_presence(p["project_id"])

    def _deliver(self, users: set[str] | None, event: dict, skip_device: str | None = None) -> None:
        for s in list(self.subs):
            if users is not None and s.user_id not in users:
                continue
            if skip_device and s.device_id == skip_device:
                continue
            try:
                s.queue.put_nowait(event)
            except asyncio.QueueFull:
                pass  # клиент сильно отстал — он перезагрузит данные при переподключении

    async def publish(self, type_: str, project_id: str | None = None, *, users: set[str] | None = None,
                      skip_device: str | None = None, **data) -> None:
        if project_id and users is None and not self.all_users:
            users = await self.db.project_user_ids(project_id)
        self._deliver(users, {"type": type_, "project_id": project_id, "ts": time.time(), **data}, skip_device)

    # ------------------------------------------------------------ присутствие
    def project_presence(self, project_id: str) -> list[dict]:
        now = time.time()
        seen: dict[str, dict] = {}
        for (uid, dev), p in list(self.presence.items()):
            if now - p["ts"] > PRESENCE_TTL:
                self.presence.pop((uid, dev), None)
                continue
            if p.get("project_id") != project_id:
                continue
            cur = seen.setdefault(uid, {"user_id": uid, "name": p["name"], "conversations": [], "devices": 0})
            cur["devices"] += 1
            if p.get("conversation_id") and p["conversation_id"] not in cur["conversations"]:
                cur["conversations"].append(p["conversation_id"])
        return list(seen.values())

    async def set_presence(self, user: dict, device_id: str, project_id: str | None, conversation_id: str | None):
        key = (user["id"], device_id)
        old = self.presence.get(key, {}).get("project_id")
        self.presence[key] = {"project_id": project_id, "conversation_id": conversation_id,
                              "name": user["display_name"], "ts": time.time()}
        for pid in {old, project_id} - {None}:
            await self.broadcast_presence(pid)

    async def broadcast_presence(self, project_id: str) -> None:
        await self.publish("presence", project_id, users_online=self.project_presence(project_id))
