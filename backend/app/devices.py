"""Устройства: идентичность сервера, регистрация телефона, DPoP и подписи действий.

Модель (прототип архитектуры v2 на одиночном сервере):
  • У сервера есть ключ идентичности Ed25519. Его отпечаток пользователь сверяет при добавлении сервера
    (или получает в QR-приглашении). Сервер подписывает ответ регистрации — так приложение знает,
    что зарегистрировалось именно на том сервере, который выбрал пользователь.
  • У телефона два ключа P-256:
      – ключ сессии: подписывает DPoP-доказательство к каждому запросу (RFC 9449);
      – ключ подтверждения: требует биометрию на каждую подпись, подписывает важные действия.
  • Токен доступа живёт 10 минут и привязан к ключу сессии (cnf.jkt). Новый токен телефон получает,
    подписав DPoP-доказательство ключом сессии — пароль после регистрации больше не нужен.
  • Подпись действия — ES256 над каноническим JSON (ключи по алфавиту, без пробелов, UTF-8).
"""
from __future__ import annotations

import base64
import hashlib
import json
import secrets
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any

import jwt
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from cryptography.x509.oid import NameOID
from fastapi import HTTPException

ACCESS_TTL = 600            # токен доступа устройства, секунд
PROOF_SKEW = 120            # допустимое расхождение часов для DPoP и подписей, секунд
ACTION_MAX_AGE = 300        # подпись действия действует 5 минут
CHALLENGE_TTL = 300
CERT_DAYS = 30


# ------------------------------------------------------------------ утилиты
def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def b64u_dec(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def js_number(x: float) -> str:
    """Число так, как его печатает JavaScript (Number.prototype.toString): 1.0 → "1", 1e-07 → "1e-7", 1e16 → "10000000000000000".
    Нужно, чтобы телефон и сервер получали одинаковые байты для подписи."""
    import decimal
    import math
    if not math.isfinite(x):
        return "null"
    if x == 0:
        return "0"
    sign, digits, exp = decimal.Decimal(repr(x)).as_tuple()
    ds = list(digits)
    while len(ds) > 1 and ds[-1] == 0:
        ds.pop()
        exp += 1
    s = "".join(map(str, ds))
    k, n = len(s), len(s) + exp
    if k <= n <= 21:
        out = s + "0" * (n - k)
    elif 0 < n <= 21:
        out = s[:n] + "." + s[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * (-n) + s
    else:
        e = n - 1
        out = (s if k == 1 else s[0] + "." + s[1:]) + "e" + ("+" if e >= 0 else "-") + str(abs(e))
    return ("-" if sign else "") + out


def canonical(obj: Any) -> bytes:
    """Канонический JSON: ключи по кодовым точкам, без пробелов, UTF-8, числа в формате JavaScript.
    Тот же алгоритм, что в приложении (mobile/src/core/canonical.ts)."""
    floats: list[str] = []
    tag = "\x00f" + secrets.token_hex(6) + ":"

    def walk(v):
        if isinstance(v, int) and not isinstance(v, bool) and abs(v) > 2 ** 53:
            v = float(v)  # в JavaScript такое целое уже приблизительное — печатаем так же
        if isinstance(v, float):
            floats.append(js_number(v))
            return f"{tag}{len(floats) - 1}\x00"
        if isinstance(v, dict):
            return {str(k): walk(w) for k, w in v.items()}
        if isinstance(v, (list, tuple)):
            return [walk(w) for w in v]
        return v

    s = json.dumps(walk(obj), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    if floats:
        enc = json.dumps(tag, ensure_ascii=False)[1:-1]
        for i, f in enumerate(floats):
            s = s.replace(f'"{enc}{i}\\u0000"', f, 1)
    return s.encode()


def sha256_b64u(data: bytes) -> str:
    return b64u(hashlib.sha256(data).digest())


def args_hash(args: Any) -> str:
    return sha256_b64u(canonical(args))


def jwk_thumbprint(jwk: dict) -> str:
    """RFC 7638 для EC P-256."""
    if jwk.get("kty") != "EC" or jwk.get("crv") != "P-256" or not jwk.get("x") or not jwk.get("y"):
        raise HTTPException(400, "Нужен ключ EC P-256 в формате JWK")
    return sha256_b64u(canonical({"crv": "P-256", "kty": "EC", "x": jwk["x"], "y": jwk["y"]}))


def p256_public(jwk: dict) -> ec.EllipticCurvePublicKey:
    jwk_thumbprint(jwk)
    x, y = int.from_bytes(b64u_dec(jwk["x"]), "big"), int.from_bytes(b64u_dec(jwk["y"]), "big")
    return ec.EllipticCurvePublicNumbers(x, y, ec.SECP256R1()).public_key()


def verify_es256(jwk: dict, data: bytes, sig_b64u: str) -> bool:
    """Подпись ES256 в «сыром» виде r||s (64 байта), как её отдают WebCrypto, Secure Enclave и Android Keystore через наш модуль."""
    try:
        raw = b64u_dec(sig_b64u)
        if len(raw) != 64:
            return False
        der = encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
        p256_public(jwk).verify(der, data, ec.ECDSA(hashes.SHA256()))
        return True
    except Exception:
        return False


def base32_fp(raw: bytes) -> str:
    s = base64.b32encode(hashlib.sha256(raw).digest()).decode().rstrip("=")
    return " ".join(s[i:i + 4] for i in range(0, len(s), 4))


def serial_matches(stored_hex: str | None, header: str) -> bool:
    """Серийный номер сертификата из заголовка прокси. Caddy отдаёт его десятичным, nginx/Traefik — hex (возможно с ':')."""
    if not stored_hex:
        return False
    want = int(stored_hex, 16)
    h = header.strip().lower().replace(":", "")
    try:
        if h.isdigit() and int(h, 10) == want:
            return True
        return int(h, 16) == want
    except ValueError:
        return False


class _Seen:
    """Одноразовые значения (jti, nonce) — защита от повтора. Хватает памяти процесса: один экземпляр."""

    def __init__(self, ttl: int = 900, cap: int = 50000):
        self.ttl, self.cap, self.d = ttl, cap, OrderedDict()

    def add(self, key: str) -> bool:
        now = time.time()
        while self.d and next(iter(self.d.values())) < now - self.ttl:
            self.d.popitem(last=False)
        if key in self.d:
            return False
        self.d[key] = now
        if len(self.d) > self.cap:
            self.d.popitem(last=False)
        return True


# ------------------------------------------------------------------ идентичность сервера и CA устройств
class ServerKeys:
    def __init__(self, data_dir: Path, name: str):
        self.name = name
        d = Path(data_dir)
        idf = d / "server-identity.key"
        if not idf.exists():
            k = ed25519.Ed25519PrivateKey.generate()
            idf.write_bytes(k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                            serialization.NoEncryption()))
            idf.chmod(0o600)
        self.identity = serialization.load_pem_private_key(idf.read_bytes(), None)
        self.identity_pub = self.identity.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        self.fingerprint = base32_fp(self.identity_pub)
        # центр сертификации устройств (для mTLS)
        kf, cf = d / "device-ca.key", d / "device-ca.pem"
        if not kf.exists():
            ck = ec.generate_private_key(ec.SECP256R1())
            subj = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, f"{name} device CA")])
            now = _utcnow()
            cert = (x509.CertificateBuilder().subject_name(subj).issuer_name(subj).public_key(ck.public_key())
                    .serial_number(x509.random_serial_number()).not_valid_before(now)
                    .not_valid_after(now + _days(3650))
                    .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
                    .add_extension(x509.KeyUsage(digital_signature=False, content_commitment=False, key_encipherment=False,
                                                 data_encipherment=False, key_agreement=False, key_cert_sign=True,
                                                 crl_sign=True, encipher_only=False, decipher_only=False), critical=True)
                    .sign(ck, hashes.SHA256()))
            kf.write_bytes(ck.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                            serialization.NoEncryption()))
            kf.chmod(0o600)
            cf.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        self.ca_key = serialization.load_pem_private_key(kf.read_bytes(), None)
        self.ca_cert = x509.load_pem_x509_certificate(cf.read_bytes())
        self.ca_pem = cf.read_text()

    def sign(self, obj: Any) -> str:
        return b64u(self.identity.sign(canonical(obj)))

    def check_csr(self, csr_pem: str, session_jwk: dict) -> None:
        self._csr_key(csr_pem, session_jwk)

    def _csr_key(self, csr_pem: str, session_jwk: dict):
        try:
            csr = x509.load_pem_x509_csr(csr_pem.encode())
        except Exception:
            raise HTTPException(400, "Не удалось прочитать CSR")
        if not csr.is_signature_valid:
            raise HTTPException(400, "Подпись CSR неверна")
        pub = csr.public_key()
        want = p256_public(session_jwk)
        if not isinstance(pub, ec.EllipticCurvePublicKey) or pub.public_numbers() != want.public_numbers():
            raise HTTPException(400, "Ключ в CSR не совпадает с ключом сессии устройства")
        return pub

    def issue_device_cert(self, csr_pem: str, device_id: str, username: str, session_jwk: dict) -> tuple[str, str, float]:
        """Сертификат устройства для mTLS. Ключ в CSR обязан совпадать с ключом сессии устройства."""
        pub = self._csr_key(csr_pem, session_jwk)
        now = _utcnow()
        cert = (x509.CertificateBuilder()
                .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, device_id),
                                         x509.NameAttribute(NameOID.ORGANIZATION_NAME, username)]))
                .issuer_name(self.ca_cert.subject).public_key(pub).serial_number(x509.random_serial_number())
                .not_valid_before(now - _days(0.01)).not_valid_after(now + _days(CERT_DAYS))
                .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
                .add_extension(x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.CLIENT_AUTH]), critical=False)
                .sign(self.ca_key, hashes.SHA256()))
        return cert.public_bytes(serialization.Encoding.PEM).decode(), format(cert.serial_number, "x"), (now + _days(CERT_DAYS)).timestamp()


def _utcnow():
    import datetime as dt
    return dt.datetime.now(dt.timezone.utc)


def _days(n: float):
    import datetime as dt
    return dt.timedelta(days=n)


# ------------------------------------------------------------------ токены и DPoP
class DeviceAuth:
    def __init__(self, secret: str):
        self.secret = secret
        self.jti = _Seen(ttl=PROOF_SKEW * 3)
        self.nonces = _Seen(ttl=ACTION_MAX_AGE * 3)
        self.challenges: dict[str, float] = {}

    # --- вызов для регистрации
    def new_challenge(self) -> str:
        now = time.time()
        for k, exp in list(self.challenges.items()):
            if exp < now:
                self.challenges.pop(k, None)
        c = secrets.token_urlsafe(24)
        self.challenges[c] = now + CHALLENGE_TTL
        return c

    def take_challenge(self, c: str) -> None:
        exp = self.challenges.pop(c, None)
        if not exp or exp < time.time():
            raise HTTPException(400, "Вызов регистрации истёк — начните заново")

    # --- токен доступа
    def issue(self, user_id: str, device_id: str, jkt: str) -> dict:
        exp = int(time.time()) + ACCESS_TTL
        at = jwt.encode({"sub": user_id, "did": device_id, "cnf": {"jkt": jkt}, "typ": "dpop-at", "exp": exp},
                        self.secret, algorithm="HS256")
        return {"access_token": at, "token_type": "DPoP", "expires_in": ACCESS_TTL}

    def read_token(self, at: str) -> dict:
        try:
            cl = jwt.decode(at, self.secret, algorithms=["HS256"])
        except jwt.ExpiredSignatureError:
            raise HTTPException(401, "Токен устройства истёк", headers={"WWW-Authenticate": 'DPoP error="invalid_token"'})
        except jwt.PyJWTError:
            raise HTTPException(401, "Неверный токен устройства")
        if cl.get("typ") != "dpop-at":
            raise HTTPException(401, "Неверный тип токена")
        return cl

    # --- доказательство DPoP
    def check_proof(self, proof: str | None, method: str, path: str, at: str | None = None) -> tuple[dict, str]:
        """Возвращает (jwk, jkt). Сверяем метод и путь (без хоста: сервер может стоять за прокси)."""
        if not proof:
            raise HTTPException(401, "Нужно DPoP-доказательство")
        try:
            hdr = jwt.get_unverified_header(proof)
        except jwt.PyJWTError:
            raise HTTPException(401, "DPoP: неверный формат")
        jwk = hdr.get("jwk") or {}
        if hdr.get("typ") != "dpop+jwt" or hdr.get("alg") != "ES256" or "d" in jwk:
            raise HTTPException(401, "DPoP: неверный заголовок")
        try:
            claims = jwt.decode(proof, key=p256_public(jwk), algorithms=["ES256"], options={"verify_aud": False})
        except HTTPException:
            raise
        except jwt.PyJWTError:
            raise HTTPException(401, "DPoP: подпись неверна")
        now = time.time()
        if abs(now - float(claims.get("iat", 0))) > PROOF_SKEW:
            raise HTTPException(401, "DPoP: время не совпадает — проверьте часы телефона")
        if (claims.get("htm") or "").upper() != method.upper():
            raise HTTPException(401, "DPoP: метод не совпадает")
        htu = str(claims.get("htu") or "")
        from urllib.parse import urlsplit
        if urlsplit(htu).path.rstrip("/") != path.rstrip("/"):
            raise HTTPException(401, "DPoP: адрес не совпадает")
        if not claims.get("jti") or not self.jti.add(str(claims["jti"])):
            raise HTTPException(401, "DPoP: доказательство уже использовано")
        if at is not None and claims.get("ath") != sha256_b64u(at.encode()):
            raise HTTPException(401, "DPoP: доказательство не привязано к токену")
        return jwk, jwk_thumbprint(jwk)

    # --- подпись действия
    def check_action(self, action: dict, sig: str, confirm_jwk: dict, device_id: str, expect: dict) -> None:
        """Проверяем подписанное действие: поля совпадают с ожидаемыми, устройство то же, время свежее, nonce новый."""
        if not isinstance(action, dict) or not sig:
            raise HTTPException(403, "Нужна подпись действия с телефона")
        for k, v in expect.items():
            if action.get(k) != v:
                raise HTTPException(403, f"Подписанное действие не совпадает с запросом ({k})")
        if action.get("device_id") != device_id:
            raise HTTPException(403, "Действие подписано другим устройством")
        ts = action.get("ts")
        if not isinstance(ts, int) or abs(time.time() * 1000 - ts) > ACTION_MAX_AGE * 1000:
            raise HTTPException(403, "Подпись действия устарела — подтвердите ещё раз")
        if not verify_es256(confirm_jwk, canonical(action), sig):
            raise HTTPException(403, "Подпись действия неверна")
        if not isinstance(action.get("nonce"), str) or not self.nonces.add(device_id + ":" + action["nonce"]):
            raise HTTPException(403, "Это подтверждение уже использовано")
