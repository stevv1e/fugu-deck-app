"""Устройства: регистрация, DPoP, подписанные действия, сертификат mTLS. Сервер — в процессе (TestClient)."""
import base64
import hashlib
import importlib
import json
import os
import tempfile
import time
import uuid

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.x509.oid import NameOID

os.environ.update(DATA_DIR=tempfile.mkdtemp(prefix="fd-dev-"), APP_PASSWORD="test-pass", COOKIE_SECURE="false",
                  DECK_MODE="standalone", SERVER_NAME="Тестовый сервер", MTLS_MODE="off")
from app import config  # noqa: E402

config.get_settings.cache_clear()
import app.main as main  # noqa: E402

main = importlib.reload(main)
from fastapi.testclient import TestClient  # noqa: E402

from app.devices import canonical  # noqa: E402


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def jwk(k: ec.EllipticCurvePrivateKey) -> dict:
    n = k.public_key().public_numbers()
    return {"kty": "EC", "crv": "P-256", "x": b64u(n.x.to_bytes(32, "big")), "y": b64u(n.y.to_bytes(32, "big"))}


def raw_sig(k, data: bytes) -> str:
    r, s = decode_dss_signature(k.sign(data, ec.ECDSA(hashes.SHA256())))
    return b64u(r.to_bytes(32, "big") + s.to_bytes(32, "big"))


def jkt(j: dict) -> str:
    return b64u(hashlib.sha256(canonical({"crv": j["crv"], "kty": "EC", "x": j["x"], "y": j["y"]})).digest())


def proof(k, method: str, url: str, at: str | None = None, iat: int | None = None) -> str:
    hdr = {"typ": "dpop+jwt", "alg": "ES256", "jwk": jwk(k)}
    pl = {"jti": uuid.uuid4().hex, "htm": method, "htu": url, "iat": iat or int(time.time())}
    if at:
        pl["ath"] = b64u(hashlib.sha256(at.encode()).digest())
    si = b64u(json.dumps(hdr, separators=(",", ":")).encode()) + "." + b64u(json.dumps(pl, separators=(",", ":")).encode())
    return si + "." + raw_sig(k, si.encode())


@pytest.fixture(scope="module")
def client():
    with TestClient(main.app, base_url="https://deck.test") as c:
        yield c


def enroll(client, sess, conf, csr=None, password="test-pass"):
    info = client.get("/.well-known/fugu-deck").json()
    ch = client.get("/api/devices/challenge").json()["challenge"]
    stmt = canonical({"type": "enroll", "challenge": ch, "server": info["identity"]["fingerprint"],
                      "session_jkt": jkt(jwk(sess)), "confirm_jkt": jkt(jwk(conf))})
    body = {"password": password, "name": "Pixel тест", "platform": "android", "session_jwk": jwk(sess), "confirm_jwk": jwk(conf),
            "key_storage": "software", "challenge": ch, "session_sig": raw_sig(sess, stmt), "confirm_sig": raw_sig(conf, stmt)}
    if csr:
        body["csr"] = csr
    return info, client.post("/api/devices/enroll", json=body)


def call(client, k, at, method, path, **kw):
    return client.request(method, path, headers={"Authorization": f"DPoP {at}", "DPoP": proof(k, method, "https://deck.test" + path, at)}, **kw)


def test_enroll_dpop_refresh_revoke(client):
    sess, conf = ec.generate_private_key(ec.SECP256R1()), ec.generate_private_key(ec.SECP256R1())
    info, r = enroll(client, sess, conf)
    assert r.status_code == 200, r.text
    res = r.json()
    # квитанция подписана ключом идентичности сервера с тем самым отпечатком
    pub = ed25519.Ed25519PublicKey.from_public_bytes(base64.urlsafe_b64decode(info["identity"]["key"] + "=="))
    pub.verify(base64.urlsafe_b64decode(res["server_sig"] + "=="), canonical(res["receipt"]))
    assert res["receipt"]["session_jkt"] == jkt(jwk(sess))
    at = res["access_token"]

    assert call(client, sess, at, "GET", "/api/config").status_code == 200
    # без доказательства, с чужим ключом, с повтором, с другим путём — отказ
    assert client.get("/api/config", headers={"Authorization": f"DPoP {at}"}).status_code == 401
    other = ec.generate_private_key(ec.SECP256R1())
    assert client.get("/api/config", headers={"Authorization": f"DPoP {at}", "DPoP": proof(other, "GET", "https://deck.test/api/config", at)}).status_code == 401
    p = proof(sess, "GET", "https://deck.test/api/config", at)
    assert client.get("/api/config", headers={"Authorization": f"DPoP {at}", "DPoP": p}).status_code == 200
    assert client.get("/api/config", headers={"Authorization": f"DPoP {at}", "DPoP": p}).status_code == 401
    assert client.get("/api/config", headers={"Authorization": f"DPoP {at}", "DPoP": proof(sess, "GET", "https://deck.test/api/projects", at)}).status_code == 401
    assert client.get("/api/config", headers={"Authorization": f"DPoP {at}", "DPoP": proof(sess, "GET", "https://deck.test/api/config", at, iat=int(time.time()) - 600)}).status_code == 401

    # новый токен — только подписью ключа сессии
    did = res["device_id"]
    r2 = client.post("/api/devices/token", json={"device_id": did}, headers={"DPoP": proof(sess, "POST", "https://deck.test/api/devices/token")})
    assert r2.status_code == 200, r2.text
    assert client.post("/api/devices/token", json={"device_id": did}, headers={"DPoP": proof(conf, "POST", "https://deck.test/api/devices/token")}).status_code == 401

    devs = call(client, sess, r2.json()["access_token"], "GET", "/api/devices").json()
    assert any(d["id"] == did and d["current"] for d in devs)

    # отзыв с телефона — только с подписью ключом подтверждения
    at2 = r2.json()["access_token"]
    assert call(client, sess, at2, "POST", f"/api/devices/{did}/revoke", json={}).status_code == 403
    action = {"type": "revoke_device", "target": did, "device_id": did, "nonce": uuid.uuid4().hex, "ts": int(time.time() * 1000)}
    bad = dict(action, target="other")
    assert call(client, sess, at2, "POST", f"/api/devices/{did}/revoke", json={"action": bad, "sig": raw_sig(conf, canonical(bad))}).status_code == 403
    assert call(client, sess, at2, "POST", f"/api/devices/{did}/revoke", json={"action": action, "sig": raw_sig(sess, canonical(action))}).status_code == 403
    assert call(client, sess, at2, "POST", f"/api/devices/{did}/revoke", json={"action": action, "sig": raw_sig(conf, canonical(action))}).status_code == 200
    assert call(client, sess, at2, "GET", "/api/config").status_code == 401
    assert client.post("/api/devices/token", json={"device_id": did}, headers={"DPoP": proof(sess, "POST", "https://deck.test/api/devices/token")}).status_code == 401


def test_enroll_rejects_bad_signatures_and_password(client):
    sess, conf = ec.generate_private_key(ec.SECP256R1()), ec.generate_private_key(ec.SECP256R1())
    _, r = enroll(client, sess, conf, password="wrong")
    assert r.status_code == 401
    main.auth.clear("testclient")
    info = client.get("/.well-known/fugu-deck").json()
    ch = client.get("/api/devices/challenge").json()["challenge"]
    stmt = canonical({"type": "enroll", "challenge": ch, "server": "ЧУЖОЙ", "session_jkt": jkt(jwk(sess)), "confirm_jkt": jkt(jwk(conf))})
    r = client.post("/api/devices/enroll", json={"password": "test-pass", "name": "x", "session_jwk": jwk(sess), "confirm_jwk": jwk(conf),
                                                 "challenge": ch, "session_sig": raw_sig(sess, stmt), "confirm_sig": raw_sig(conf, stmt)})
    assert r.status_code == 400 and info["name"] == "Тестовый сервер"
    main.auth.clear("testclient")


def test_signed_action_rules():
    da = main.state["device_auth"]
    conf = ec.generate_private_key(ec.SECP256R1())
    base = {"type": "approve_tool", "approval_id": "a1", "tool": "commit_files", "args_sha256": "h", "approve": True,
            "device_id": "d1", "nonce": "n1", "ts": int(time.time() * 1000)}
    expect = {k: base[k] for k in ("type", "approval_id", "tool", "args_sha256", "approve")}
    da.check_action(base, raw_sig(conf, canonical(base)), jwk(conf), "d1", expect)
    with pytest.raises(Exception):  # повтор
        da.check_action(base, raw_sig(conf, canonical(base)), jwk(conf), "d1", expect)
    old = dict(base, nonce="n2", ts=int(time.time() * 1000) - 10 * 60 * 1000)
    with pytest.raises(Exception):
        da.check_action(old, raw_sig(conf, canonical(old)), jwk(conf), "d1", expect)
    other = dict(base, nonce="n3", args_sha256="подмена")
    with pytest.raises(Exception):
        da.check_action(other, raw_sig(conf, canonical(other)), jwk(conf), "d1", expect)
    unicode_ok = dict(base, nonce="n4", tool="commit_files", approval_id="a1")
    da.check_action(unicode_ok, raw_sig(conf, canonical(unicode_ok)), jwk(conf), "d1", expect)


def test_device_cert_must_match_session_key(client):
    sess, conf = ec.generate_private_key(ec.SECP256R1()), ec.generate_private_key(ec.SECP256R1())
    mk = lambda key: x509.CertificateSigningRequestBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "phone")])) \
        .sign(key, hashes.SHA256()).public_bytes(serialization.Encoding.PEM).decode()
    _, r = enroll(client, sess, conf, csr=mk(conf))
    assert r.status_code == 400
    main.auth.clear("testclient")
    _, r = enroll(client, sess, conf, csr=mk(sess))
    assert r.status_code == 200, r.text
    cert = x509.load_pem_x509_certificate(r.json()["cert_pem"].encode())
    assert cert.public_key().public_numbers() == sess.public_key().public_numbers()
    ca = x509.load_pem_x509_certificate(r.json()["ca_pem"].encode())
    ca.public_key().verify(cert.signature, cert.tbs_certificate_bytes, ec.ECDSA(hashes.SHA256()))


def test_mtls_serial_header_formats(client, monkeypatch):
    from app.devices import serial_matches
    assert serial_matches("1a2b", "6699")          # Caddy: десятичный
    assert serial_matches("1a2b", "1A2B")          # hex
    assert serial_matches("1a2b", "00:1a:2b")      # hex с разделителями
    assert not serial_matches("1a2b", "1a2c")
    assert not serial_matches(None, "1a2b")
    # режим required: без сертификата — отказ, со своим — пропуск, с чужим — отказ
    sess, conf = ec.generate_private_key(ec.SECP256R1()), ec.generate_private_key(ec.SECP256R1())
    mk = x509.CertificateSigningRequestBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "phone")])) \
        .sign(sess, hashes.SHA256()).public_bytes(serialization.Encoding.PEM).decode()
    _, r = enroll(client, sess, conf, csr=mk)
    assert r.status_code == 200, r.text
    at = r.json()["access_token"]
    serial = x509.load_pem_x509_certificate(r.json()["cert_pem"].encode()).serial_number
    monkeypatch.setattr(main.settings, "mtls_mode", "required")
    hdr = main.settings.mtls_serial_header
    assert call(client, sess, at, "GET", "/api/config").status_code == 401
    ok = client.get("/api/config", headers={"Authorization": f"DPoP {at}", "DPoP": proof(sess, "GET", "https://deck.test/api/config", at), hdr: str(serial)})
    assert ok.status_code == 200, ok.text
    bad = client.get("/api/config", headers={"Authorization": f"DPoP {at}", "DPoP": proof(sess, "GET", "https://deck.test/api/config", at), hdr: "12345"})
    assert bad.status_code == 401


def test_health_reports_busy(client):
    """По busy control-plane решает, можно ли усыпить пространство: идущее задание усыплять нельзя."""
    assert client.get("/api/health").json() == {"ok": True, "busy": False, "next_wake": None}
    runs = main.agent().runs
    runs["r-test"] = type("R", (), {"status": "running"})()
    try:
        assert client.get("/api/health").json()["busy"] is True
        runs["r-test"].status = "done"
        assert client.get("/api/health").json()["busy"] is False
    finally:
        runs.pop("r-test", None)

