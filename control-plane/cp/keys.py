"""Ключи control-plane.

- ES256 (приватный) — подписывает токены пространств; публичная половина раздаётся пространствам.
- HS256-секрет — подписывает cookie сессии control-plane.
Оба хранятся в data_dir (в кластере — на отдельном томе/в Secret), генерируются при первом запуске.
"""
from __future__ import annotations

import secrets
import time
import uuid

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

ISSUER = "deck-control-plane"


class Keys:
    def __init__(self, data_dir):
        d = data_dir / "keys"
        d.mkdir(parents=True, exist_ok=True)
        pk = d / "space-signing.pem"
        if not pk.exists():
            key = ec.generate_private_key(ec.SECP256R1())
            pk.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                             serialization.NoEncryption()))
            pk.chmod(0o600)
        self.private_pem = pk.read_bytes()
        key = serialization.load_pem_private_key(self.private_pem, None)
        self.public_pem = key.public_key().public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
        ss = d / "session.secret"
        if not ss.exists():
            ss.write_text(secrets.token_urlsafe(48))
            ss.chmod(0o600)
        self.session_secret = ss.read_text().strip()

    # ---------------------------------------------------------------- токены пространств
    def space_token(self, space_id: str, user: dict, role: str, ttl: int) -> str:
        now = int(time.time())
        return jwt.encode({"iss": ISSUER, "aud": f"space:{space_id}", "sub": user["id"], "nick": user["nick"],
                           "name": user["display_name"], "role": role, "iat": now, "exp": now + ttl,
                           "jti": uuid.uuid4().hex}, self.private_pem, algorithm="ES256")

    def internal_token(self, space_id: str, action: str, **claims) -> str:
        now = int(time.time())
        return jwt.encode({"iss": ISSUER, "aud": f"space-internal:{space_id}", "sub": "control-plane",
                           "action": action, "iat": now, "exp": now + 60, **claims},
                          self.private_pem, algorithm="ES256")

    # ---------------------------------------------------------------- сессия control-plane
    def session(self, uid: str, hours: float) -> str:
        now = int(time.time())
        return jwt.encode({"sub": uid, "iat": now, "exp": now + int(hours * 3600)}, self.session_secret, "HS256")

    def read_session(self, token: str) -> str | None:
        try:
            return jwt.decode(token, self.session_secret, algorithms=["HS256"])["sub"]
        except jwt.PyJWTError:
            return None
