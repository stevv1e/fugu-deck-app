"""
Пространство в кластере v2 ходит к моделям и Git только через keyguard (architecture.md, 5.2).
Ключей в пространстве нет: вместо ключа API — проецируемый токен ServiceAccount (audience=keyguard).
keyguard проверяет его (TokenReview), вырезает и подставляет настоящий ключ владельца или спонсора.

Токен живёт ~10 минут, kubelet переписывает файл заранее — читаем его на КАЖДЫЙ запрос
(запуск Ultra может идти дольше жизни одного токена).
"""
from __future__ import annotations

import functools
import time

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
    if provider == "deepseek":
        return f"{base}/llm/deepseek"           # SDK добавит /chat/completions (у DeepSeek путь без /v1)
    raise ValueError(f"провайдер {provider} через keyguard не поддерживается")


def git_base(provider: str) -> str:
    return f"{_s().keyguard_url.rstrip('/')}/git/{provider}"


def headers(chat_id: str, member: str) -> dict[str, str]:
    """Для общих пространств keyguard ищет разрешение спонсора на этот чат и проверяет участника.
    member — id участника (ник из control-plane, как в составе разрешения), не username: тот здесь «ник#id»."""
    return {"X-Deck-Chat": chat_id, "X-Deck-Member": member}


_mine: tuple[float, set[str]] | None = None


async def my_llm_providers() -> set[str] | None:
    """У каких провайдеров моделей у владельца личного пространства есть ключ (keyguard /v1/keys/mine).
    None — не узнать (общее пространство или keyguard недоступен). Кэш 20 с: экран моделей и чат спрашивают часто."""
    global _mine
    if _mine and time.monotonic() - _mine[0] < 20:
        return _mine[1]
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            r = await c.get(f"{_s().keyguard_url.rstrip('/')}/v1/keys/mine", headers={"Authorization": f"Bearer {token()}"})
        if r.status_code != 200:
            return None
        got = set(r.json().get("providers") or [])
    except Exception:
        return None
    _mine = (time.monotonic(), got)
    return got


def forget_providers() -> None:
    """Ключ добавлен или удалён — следующий запрос спросит keyguard заново."""
    global _mine
    _mine = None


async def verify_action(jws: str) -> dict:
    """Проверить подписанное действие владельца через keyguard (POST /v1/actions/verify).

    Пространство само подписи не проверяет: ключей устройств у него нет. keyguard сверяет подпись с реестром
    устройств, сжигает одноразовый nonce и отвечает действием и подписавшим — только если подписал владелец
    этого пространства и именно для него. Возвращает {"action": {...}, "user": ..., "device_id": ...}.
    """
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.post(f"{_s().keyguard_url.rstrip('/')}/v1/actions/verify", json={"jws": jws},
                         headers={"Authorization": f"Bearer {token()}"})
    if r.status_code != 200:
        try:
            why = r.json().get("error") or r.text
        except ValueError:
            why = r.text
        raise PermissionError(str(why)[:300])
    return r.json()


async def grant_switch(grant_id: str, on: bool) -> dict:
    """Включить или снять разрешение спонсора в keyguard (POST /v1/grants/activate | deactivate).

    Включить можно только то, что спонсор подписал для ЭТОГО пространства; в ответе — условия из подписи
    (чат, модель, лимит, срок, участники): пространство берёт их отсюда, а не из слов приложения.
    """
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.post(f"{_s().keyguard_url.rstrip('/')}/v1/grants/{'activate' if on else 'deactivate'}",
                         json={"grant_id": grant_id}, headers={"Authorization": f"Bearer {token()}"})
    if r.status_code != 200:
        try:
            why = r.json().get("error") or r.text
        except ValueError:
            why = r.text
        raise PermissionError(str(why)[:300])
    return r.json().get("grant") or {}


class Auth(httpx.Auth):
    """Свежий токен пространства на каждый запрос Git (httpx)."""

    def auth_flow(self, request: httpx.Request):
        request.headers.pop("PRIVATE-TOKEN", None)
        request.headers["Authorization"] = f"Bearer {token()}"
        yield request
