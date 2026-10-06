"""
Пространство в кластере v2 ходит к моделям и Git только через keyguard (architecture.md, 5.2).
Ключей в пространстве нет: вместо ключа API — проецируемый токен ServiceAccount (audience=keyguard).
keyguard проверяет его (TokenReview), вырезает и подставляет настоящий ключ владельца или спонсора.

Токен живёт ~10 минут, kubelet переписывает файл заранее — читаем его на КАЖДЫЙ запрос
(запуск Ultra может идти дольше жизни одного токена).
"""
from __future__ import annotations

import functools

import httpx

from .config import get_settings


@functools.lru_cache(maxsize=1)
def _s():
    return get_settings()


def enabled() -> bool:
    return bool(_s().keyguard_url)


def token() -> str:
    with open(_s().keyguard_token_path, encoding="utf-8") as f:
        t = f.read().strip()
    if not t:
        raise RuntimeError("пустой токен keyguard")
    return t


def llm_base(provider: str) -> str:
    base = _s().keyguard_url.rstrip("/")
    if provider == "anthropic":
        return f"{base}/llm/anthropic"          # SDK добавит /v1/messages
    if provider == "sakana":
        return f"{base}/llm/sakana/v1"          # SDK добавит /chat/completions
    raise ValueError(f"провайдер {provider} через keyguard не поддерживается")


def git_base(provider: str) -> str:
    return f"{_s().keyguard_url.rstrip('/')}/git/{provider}"


def headers(chat_id: str, member: str) -> dict[str, str]:
    """Для общих пространств keyguard ищет разрешение спонсора на этот чат и проверяет участника."""
    return {"X-Deck-Chat": chat_id, "X-Deck-Member": member}


class Auth(httpx.Auth):
    """Свежий токен пространства на каждый запрос Git (httpx)."""

    def auth_flow(self, request: httpx.Request):
        request.headers.pop("PRIVATE-TOKEN", None)
        request.headers["Authorization"] = f"Bearer {token()}"
        yield request
