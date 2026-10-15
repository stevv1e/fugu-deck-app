"""Очередь уведомлений пространства: control-plane забирает её (POST /internal/outbox) и рассылает push.

Ключа Firebase в пространстве нет. Событие несёт только тип, кого уведомить и куда вести по нажатию — никакого
текста переписки: уведомление проходит через Google. Очередь в памяти: перезапуск агента — новый boot, и
control-plane начинает её читать с начала.
"""
from __future__ import annotations

import secrets
import time
from collections import deque

KEEP = 500
TTL = 3600


class Outbox:
    def __init__(self) -> None:
        self.boot = secrets.token_hex(8)
        self.seq = 0
        self.items: deque[dict] = deque(maxlen=KEEP)

    def add(self, user_id: str | None, kind: str, conversation_id: str = "", project_id: str = "", **extra) -> None:
        if not user_id:
            return
        self.seq += 1
        self.items.append({"seq": self.seq, "ts": time.time(), "user": user_id, "kind": kind,
                           "conversation_id": conversation_id, "project_id": project_id, **extra})

    def since(self, after: int) -> list[dict]:
        cutoff = time.time() - TTL  # старше часа — уже не новость
        return [e for e in self.items if e["seq"] > after and e["ts"] >= cutoff]


outbox = Outbox()
