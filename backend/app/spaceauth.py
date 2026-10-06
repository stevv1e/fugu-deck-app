"""Вход в пространство кластера по короткоживущему токену control-plane.

Токен: ES256, выпускает control-plane, живёт ~10 минут.
  iss = deck-control-plane, aud = space:<id>, sub = user_id, nick, name, role (owner|editor|viewer), iat, exp
Пространство знает только публичный ключ — подделать токен или выпустить себе другую роль нельзя.
"""
from __future__ import annotations

import time

import jwt
from fastapi import HTTPException, Request

# user_id -> время отзыва: токены, выпущенные раньше, недействительны
_revoked: dict[str, float] = {}


def bearer(request: Request) -> str | None:
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:]
    # EventSource не умеет заголовки — разрешаем токен в query для SSE
    return request.query_params.get("access_token")


def verify(token: str, settings, audience: str | None = None) -> dict:
    if not settings.cp_public_key:
        raise HTTPException(503, "Пространство не настроено: нет CP_PUBLIC_KEY")
    try:
        claims = jwt.decode(token, settings.cp_public_key, algorithms=["ES256"],
                            audience=audience or f"space:{settings.space_id}", issuer=settings.cp_issuer,
                            options={"require": ["exp", "iat", "sub", "aud", "iss"]}, leeway=30)
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Токен истёк")
    except jwt.PyJWTError as e:
        raise HTTPException(401, f"Недействительный токен: {e}")
    if audience:  # служебный токен control-plane
        return claims
    rv = _revoked.get(claims["sub"])
    if rv and claims["iat"] <= rv:
        raise HTTPException(401, "Доступ отозван")
    if claims.get("role") not in ("owner", "editor", "viewer"):
        raise HTTPException(403, "Неизвестная роль")
    return claims


def revoke(user_id: str) -> None:
    _revoked[user_id] = time.time()
    # чистим старые записи (токены живут минуты)
    for k, v in list(_revoked.items()):
        if time.time() - v > 3600:
            _revoked.pop(k, None)


def revoked_since(user_id: str, ts: float) -> bool:
    return _revoked.get(user_id, 0) >= ts
