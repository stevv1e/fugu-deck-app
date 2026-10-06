"""Вход, пароли, сессии.

Владелец (owner) входит по APP_PASSWORD (+ TOTP_SECRET) из окружения.
Остальных пользователей владелец создаёт в приложении; их пароли хранятся как scrypt-хэши.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time
from collections import defaultdict, deque

import jwt
import pyotp
from fastapi import HTTPException, Request, Response

from .config import Settings

COOKIE = "fd_session"
_fails: dict[str, deque] = defaultdict(deque)
MAX_FAILS, WINDOW = 5, 15 * 60


# ---------------------------------------------------------------- пароли
def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return f"scrypt${base64.b64encode(salt).decode()}${base64.b64encode(h).decode()}"


def verify_password(password: str, stored: str | None) -> bool:
    if not stored or not stored.startswith("scrypt$"):
        return False
    _, salt_b64, h_b64 = stored.split("$")
    h = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt_b64), n=2**14, r=8, p=1, dklen=32)
    return hmac.compare_digest(h, base64.b64decode(h_b64))


def validate_new_password(p: str) -> None:
    if len(p) < 10:
        raise HTTPException(400, "Пароль должен быть не короче 10 символов")


# ---------------------------------------------------------------- сессии
def jwt_secret(s: Settings) -> str:
    if s.jwt_secret:
        return s.jwt_secret
    f = s.data_dir / "jwt_secret"
    if not f.exists():
        f.write_text(secrets.token_urlsafe(48))
        f.chmod(0o600)
    return f.read_text().strip()


def client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    return fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else "?")


def check_rate_limit(key: str) -> None:
    q = _fails[key]
    now = time.time()
    while q and now - q[0] > WINDOW:
        q.popleft()
    if len(q) >= MAX_FAILS:
        raise HTTPException(429, "Слишком много попыток. Подождите 15 минут.")


def fail(key: str) -> None:
    _fails[key].append(time.time())


def clear(key: str) -> None:
    _fails.pop(key, None)


def check_owner(password: str, totp: str | None, s: Settings) -> bool:
    if not s.app_password:
        raise HTTPException(503, "На сервере не задан APP_PASSWORD")
    ok = hmac.compare_digest(password.encode(), s.app_password.encode())
    if ok and s.totp_secret:
        ok = bool(totp) and pyotp.TOTP(s.totp_secret).verify(totp, valid_window=1)
    return ok


def issue(response: Response, user_id: str, s: Settings) -> None:
    exp = int(time.time()) + s.session_days * 86400
    token = jwt.encode({"sub": user_id, "exp": exp}, jwt_secret(s), algorithm="HS256")
    response.set_cookie(COOKIE, token, max_age=s.session_days * 86400, httponly=True,
                        secure=s.cookie_secure, samesite="strict", path="/")


def token_user_id(request: Request, s: Settings) -> str:
    token = request.cookies.get(COOKIE)
    if not token:
        auth = request.headers.get("authorization", "")
        token = auth[7:] if auth.lower().startswith("bearer ") else None
    if not token:
        raise HTTPException(401, "Нужен вход")
    try:
        return jwt.decode(token, jwt_secret(s), algorithms=["HS256"])["sub"]
    except jwt.PyJWTError:
        raise HTTPException(401, "Сессия истекла")
