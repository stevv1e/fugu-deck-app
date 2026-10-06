"""Личные уведомления пользователю (приглашения, удаление из проекта, предупреждение о 72 ч)."""
from __future__ import annotations

import asyncio
from collections import defaultdict


class Notifier:
    def __init__(self):
        self.subs: dict[str, set[asyncio.Queue]] = defaultdict(set)

    def subscribe(self, uid: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=200)
        self.subs[uid].add(q)
        return q

    def unsubscribe(self, uid: str, q: asyncio.Queue) -> None:
        self.subs[uid].discard(q)

    def send(self, uid: str, event: dict) -> None:
        for q in list(self.subs.get(uid, ())):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass
