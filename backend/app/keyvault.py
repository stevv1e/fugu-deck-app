"""Ключи пользователей — только в оперативной памяти.

Телефон присылает ключи (API провайдеров ИИ, git-токены) после разблокировки.
Они живут здесь, пока пользователь активен + TTL, и никогда не пишутся на диск и в логи.
Запуск агента берёт копию ключей своего автора и держит её до конца работы.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

from .llm.catalog import PROVIDER_TITLES

ALLOWED = {*PROVIDER_TITLES, "github", "gitlab", "gitlab_url"}


@dataclass
class _Entry:
    keys: dict[str, str] = field(default_factory=dict)
    expires: float = 0.0


class KeyVault:
    def __init__(self, ttl_seconds: int = 1800):
        self.ttl = ttl_seconds
        self._data: dict[str, _Entry] = {}

    @staticmethod
    def _allowed(key: str) -> bool:
        return key in ALLOWED or (key.startswith("custom-") and 8 <= len(key) <= 38)

    def put(self, user_id: str, keys: dict[str, str]) -> list[str]:
        clean = {k: v.strip() for k, v in keys.items() if self._allowed(k) and isinstance(v, str) and v.strip()}
        e = self._data.setdefault(user_id, _Entry())
        custom = {k: v for k, v in e.keys.items() if k.startswith("custom-")}
        e.keys = {**custom, **clean}  # обычные ключи заменяются; endpoint-ключи меняются только через свой экран
        e.expires = time.time() + self.ttl
        return sorted(k for k in clean if k != "gitlab_url")

    def set(self, user_id: str, key: str, value: str) -> None:
        if not self._allowed(key):
            raise ValueError("Неизвестный тип ключа")
        e = self._data.setdefault(user_id, _Entry())
        if value:
            e.keys[key] = value
        else:
            e.keys.pop(key, None)
        e.expires = time.time() + self.ttl

    def touch(self, user_id: str) -> None:
        if e := self._data.get(user_id):
            e.expires = time.time() + self.ttl

    def get(self, user_id: str) -> dict[str, str]:
        e = self._data.get(user_id)
        if not e:
            return {}
        if e.expires < time.time():
            self.wipe(user_id)
            return {}
        return dict(e.keys)

    def providers(self, user_id: str) -> list[str]:
        return sorted(k for k in self.get(user_id) if k != "gitlab_url")

    def wipe(self, user_id: str) -> None:
        e = self._data.pop(user_id, None)
        if e:
            e.keys.clear()

    def sweep(self) -> None:
        now = time.time()
        for uid, e in list(self._data.items()):
            if e.expires < now:
                self.wipe(uid)

    def __repr__(self) -> str:  # никогда не печатаем содержимое
        return f"<KeyVault users={len(self._data)}>"
