"""HTTP API Fugu Deck."""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import mimetypes
import re
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from pathlib import Path

from fastapi import Depends, FastAPI, File, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator

from . import auth, backup, devices, kb, kb_watch, mcp_client, obsidian, schedules as sched, spaceauth
from . import keyguard_client as kgc
from .agent import Agent
from .agent_rules import agent_problem
from .config import get_settings
from .db import DEFAULT_AGENT, DEFAULT_PROJECT, TALK_PROJECT, Database, new_id
from .events import Broker
from .keyvault import KeyVault
from .outbox import outbox
from .llm import split_model
from .skills import SkillError, SkillStore
from .tools.providers import GitHubProvider, GitLabProvider

settings = get_settings()
state: dict = {}
ROLES = {"viewer": 1, "editor": 2, "owner": 3}


@asynccontextmanager
async def lifespan(app: FastAPI):
    if settings.is_space and backup.apply_pending_restore(settings.db_path):
        log.warning("база пространства восстановлена из резервной копии")
    db = Database(str(settings.db_path))
    await db.connect()
    if not settings.is_space:
        await db.upsert_owner(settings.owner_username)
    providers = {}
    if settings.github_token:
        providers["github"] = GitHubProvider(settings.github_token, settings.github_api_url)
    if settings.gitlab_token:
        providers["gitlab"] = GitLabProvider(settings.gitlab_token, settings.gitlab_url)
    skills = SkillStore(settings.skills_path)
    skills.seed()
    broker = Broker(db, all_users=settings.is_space)
    state.update(db=db, providers=providers, skills=skills, broker=broker, vault=KeyVault(settings.key_ttl_seconds),
                 agent=Agent(db, settings, providers, skills, broker))
    if not settings.is_space:
        state.update(server_keys=devices.ServerKeys(settings.data_dir, settings.server_name),
                     device_auth=devices.DeviceAuth(auth.jwt_secret(settings) + ":device"))
    await mark_interrupted()
    scheduler = sched.Scheduler(db, fire_schedule)
    scheduler.start()
    janitor = asyncio.create_task(attachment_janitor())
    watcher = asyncio.create_task(kb_watch.loop(db, lambda: state["agent"].git_providers()))
    yield
    await scheduler.stop()
    janitor.cancel()
    watcher.cancel()
    for p in providers.values():
        await p.http.aclose()
    await db.close()


log = logging.getLogger("fugu.deck")
if not log.handlers:  # без обработчика info терялись, а warning шли без времени
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    log.addHandler(_h)
    log.setLevel(logging.INFO)
    log.propagate = False

app = FastAPI(title="Fugu Deck", lifespan=lifespan, docs_url=None, redoc_url=None)
if settings.cors_origins:
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins.split(","),
                       allow_credentials=True, allow_methods=["*"], allow_headers=["*"])


def db() -> Database:
    return state["db"]


def agent() -> Agent:
    return state["agent"]


def broker() -> Broker:
    return state["broker"]


def skills() -> SkillStore:
    return state["skills"]


# ================================================================== доступ
def vault() -> KeyVault:
    return state["vault"]


async def current_user(request: Request) -> dict:
    if settings.is_space:
        token = spaceauth.bearer(request)
        if not token:
            raise HTTPException(401, "Нужен токен пространства")
        cl = spaceauth.verify(token, settings)
        u = await db().get_user(cl["sub"])
        name = cl.get("name") or cl.get("nick") or "?"
        if not u:
            await db().create_space_user(cl["sub"], cl.get("nick") or cl["sub"], name)
            u = await db().get_user(cl["sub"])
        elif u["display_name"] != name:
            await db().update_user(u["id"], display_name=name)
            u = await db().get_user(cl["sub"])
        u = dict(u)
        u["space_role"] = cl["role"]
        vault().touch(u["id"])
        return u
    authz = request.headers.get("authorization", "")
    if authz[:5].lower() == "dpop ":
        return await device_user(request, authz[5:].strip())
    uid = auth.token_user_id(request, settings)
    u = await db().get_user(uid)
    if not u or u["disabled"]:
        raise HTTPException(401, "Пользователь отключён")
    return u


async def device_user(request: Request, at: str) -> dict:
    """Запрос с телефона: токен привязан к ключу сессии устройства, к запросу приложено DPoP-доказательство."""
    da: devices.DeviceAuth = state["device_auth"]
    cl = da.read_token(at)
    _, jkt = da.check_proof(request.headers.get("dpop"), request.method, request.url.path, at=at)
    if jkt != cl.get("cnf", {}).get("jkt"):
        raise HTTPException(401, "DPoP: ключ не совпадает с токеном")
    d = await db().get_device(cl["did"])
    if not d or d["revoked_at"] or d["session_jkt"] != jkt:
        raise HTTPException(401, "Устройство отозвано")
    check_mtls(request, d)
    u = await db().get_user(cl["sub"])
    if not u or u["disabled"]:
        raise HTTPException(401, "Пользователь отключён")
    if not d["last_seen"] or time.time() - d["last_seen"] > 60:
        await db().touch_device(d["id"])
    u = dict(u)
    u["_device"] = d
    return u


def check_mtls(request: Request, d: dict) -> None:
    if settings.mtls_mode == "off":
        return
    serial = request.headers.get(settings.mtls_serial_header, "").strip().lower()
    if not serial:
        if settings.mtls_mode == "required":
            raise HTTPException(401, "Нужен сертификат устройства (mTLS)")
        return
    if not devices.serial_matches(d.get("cert_serial"), serial):
        raise HTTPException(401, "Сертификат не принадлежит этому устройству")


Me = Depends(current_user)


def owner_only(u: dict) -> None:
    if settings.is_space:
        if u.get("space_role") != "owner":
            raise HTTPException(403, "Только для владельца пространства")
        return
    if u["role"] != "owner":
        raise HTTPException(403, "Только для владельца")


async def need(u: dict, pid: str, min_role: str = "viewer") -> str:
    if settings.is_space:  # роль в пространстве действует на все его проекты
        role = u["space_role"] if await db().get_project(pid) else None
    else:
        role = await db().project_role(u, pid)
    if not role:
        raise HTTPException(404, "Проект не найден")
    if ROLES[role] < ROLES[min_role]:
        raise HTTPException(403, "Недостаточно прав в проекте")
    return role


async def conv_access(u: dict, cid: str, min_role: str = "viewer") -> dict:
    c = await db().get_conversation(cid)
    if not c or (c["project_id"] == TALK_PROJECT and not settings.is_space and u["role"] != "owner"
                 and c.get("created_by") != u["id"]):
        raise HTTPException(404, "Чат не найден")
    await need(u, c["project_id"], min_role)
    return c


def public_user(u: dict) -> dict:
    d = {k: u[k] for k in ("id", "username", "display_name", "role")}
    if u.get("space_role"):
        d["space_role"] = u["space_role"]
        d["role"] = "owner" if u["space_role"] == "owner" else "member"
    return d


def standalone_only():
    if settings.is_space:
        raise HTTPException(403, "В кластере пользователями управляет control-plane")


# ================================================================== служебное
@app.get("/api/health")
async def health():
    # busy — идёт ли задание агента. В кластере по нему control-plane решает, можно ли усыпить пространство:
    # задание продолжается и после того, как человек закрыл приложение.
    # next_wake — ближайшее задание по расписанию: перед сном control-plane запоминает его и будит пространство к сроку.
    return {"ok": True, "busy": any(r.status == "running" for r in agent().runs.values()),
            "next_wake": await db().next_schedule_at()}


class LoginIn(BaseModel):
    username: str = ""
    password: str
    totp: str | None = None


async def check_credentials(request: Request, username: str, password: str, totp: str | None) -> dict:
    ip = auth.client_ip(request)
    auth.check_rate_limit(ip)
    u = await db().get_user_by_name(username.strip() or settings.owner_username)
    ok = False
    if u and not u["disabled"]:
        if u["role"] == "owner":
            ok = auth.check_owner(password, totp, settings)
        else:
            ok = auth.verify_password(password, u["password_hash"])
    if not ok:
        auth.fail(ip)
        raise HTTPException(401, "Неверный логин, пароль или код")
    auth.clear(ip)
    return u


@app.post("/api/auth/login")
async def login(body: LoginIn, request: Request, response: Response):
    standalone_only()
    u = await check_credentials(request, body.username, body.password, body.totp)
    auth.issue(response, u["id"], settings)
    return {"ok": True}


@app.post("/api/auth/logout")
async def logout(response: Response):
    response.delete_cookie(auth.COOKIE, path="/")
    return {"ok": True}


@app.get("/api/auth/info")
async def auth_info():
    return {"owner_totp": bool(settings.totp_secret)}


# ================================================================== сервер и устройства (нативное приложение)
def server_keys() -> devices.ServerKeys:
    standalone_only()
    return state["server_keys"]


def device_auth() -> devices.DeviceAuth:
    return state["device_auth"]


@app.get("/.well-known/fugu-deck")
async def server_info():
    """Что приложение узнаёт о сервере до входа. Отпечаток пользователь сверяет с тем, что ему передал владелец."""
    if settings.is_space:
        raise HTTPException(404)
    k = server_keys()
    return {"app": "fugu-deck", "protocol": 1, "name": settings.server_name, "mode": "standalone",
            "identity": {"alg": "Ed25519", "key": devices.b64u(k.identity_pub), "fingerprint": k.fingerprint},
            "auth": {"password": True, "totp": bool(settings.totp_secret)},
            "devices": {"dpop": True, "signed_actions": True, "mtls": settings.mtls_mode},
            "public_url": settings.public_url or None}


@app.get("/api/devices/challenge")
async def device_challenge():
    server_keys()
    return {"challenge": device_auth().new_challenge(), "server_time": int(time.time() * 1000)}


class EnrollIn(BaseModel):
    username: str = ""
    password: str
    totp: str | None = None
    name: str = Field(..., min_length=1, max_length=80)
    platform: str = Field("", max_length=40)
    session_jwk: dict
    confirm_jwk: dict
    key_storage: str = Field("software", pattern="^(secure_enclave|strongbox|tee|software)$")
    attestation: dict | None = None
    challenge: str
    session_sig: str
    confirm_sig: str
    csr: str | None = None


@app.post("/api/devices/enroll")
async def device_enroll(body: EnrollIn, request: Request):
    """Регистрация телефона: пароль (+ код) один раз, дальше вход ключом устройства.
    Обе подписи доказывают, что у телефона есть оба закрытых ключа; ответ подписан ключом идентичности сервера."""
    k = server_keys()
    u = await check_credentials(request, body.username, body.password, body.totp)
    device_auth().take_challenge(body.challenge)
    sj, cj = devices.jwk_thumbprint(body.session_jwk), devices.jwk_thumbprint(body.confirm_jwk)
    if sj == cj:
        raise HTTPException(400, "Ключ сессии и ключ подтверждения должны быть разными")
    stmt = devices.canonical({"type": "enroll", "challenge": body.challenge, "server": k.fingerprint,
                              "session_jkt": sj, "confirm_jkt": cj})
    if not devices.verify_es256(body.session_jwk, stmt, body.session_sig) or not devices.verify_es256(body.confirm_jwk, stmt, body.confirm_sig):
        raise HTTPException(400, "Подписи регистрации неверны")
    if body.csr:
        k.check_csr(body.csr, body.session_jwk)
    if await db()._one("SELECT id FROM devices WHERE session_jkt=?", (sj,)):
        raise HTTPException(409, "Этот ключ уже зарегистрирован — удалите устройство и создайте ключи заново")
    pub = lambda j: {k2: j[k2] for k2 in ("kty", "crv", "x", "y")}
    d = await db().add_device(u["id"], body.name, body.platform, pub(body.session_jwk), sj, pub(body.confirm_jwk), cj,
                              body.key_storage, body.attestation)
    cert = None
    if body.csr:
        cert, serial, exp = k.issue_device_cert(body.csr, d["id"], u["username"], d["session_jwk"])
        await db().set_device_cert(d["id"], serial, exp)
    await db().audit(None, "device_enroll", {"device": d["id"], "name": body.name, "storage": body.key_storage}, True, True, u["username"])
    receipt = {"type": "enrolled", "device_id": d["id"], "challenge": body.challenge, "session_jkt": sj, "confirm_jkt": cj,
               "user": u["username"]}
    return {"device_id": d["id"], "user": public_user(u), "receipt": receipt, "server_sig": k.sign(receipt),
            **device_auth().issue(u["id"], d["id"], sj), "cert_pem": cert, "ca_pem": k.ca_pem if cert else None}


class DeviceTokenIn(BaseModel):
    device_id: str


@app.post("/api/devices/token")
async def device_token(body: DeviceTokenIn, request: Request):
    """Новый токен доступа: телефон подписывает DPoP-доказательство ключом сессии. Пароль не нужен."""
    server_keys()
    ip = auth.client_ip(request)
    auth.check_rate_limit("dev:" + ip)
    _, jkt = device_auth().check_proof(request.headers.get("dpop"), "POST", request.url.path)
    d = await db().get_device(body.device_id)
    if not d or d["revoked_at"] or d["session_jkt"] != jkt:
        auth.fail("dev:" + ip)
        raise HTTPException(401, "Устройство не зарегистрировано или отозвано")
    check_mtls(request, d)
    u = await db().get_user(d["user_id"])
    if not u or u["disabled"]:
        raise HTTPException(401, "Пользователь отключён")
    await db().touch_device(d["id"])
    return device_auth().issue(u["id"], d["id"], jkt)


@app.get("/api/devices")
async def list_my_devices(u: dict = Me):
    server_keys()
    cur = (u.get("_device") or {}).get("id")
    return [{**d, "current": d["id"] == cur} for d in await db().list_devices(u["id"])]


class SignedIn(BaseModel):
    action: dict | None = None
    sig: str | None = None


@app.post("/api/devices/{did}/revoke")
async def revoke_device(did: str, body: SignedIn, u: dict = Me):
    server_keys()
    d = await db().get_device(did)
    if not d or (d["user_id"] != u["id"] and u["role"] != "owner"):
        raise HTTPException(404, "Устройство не найдено")
    if u.get("_device"):
        me = u["_device"]
        device_auth().check_action(body.action or {}, body.sig or "", me["confirm_jwk"], me["id"],
                                   {"type": "revoke_device", "target": did})
    await db().revoke_device(did)
    await db().audit(None, "device_revoke", {"device": did}, True, True, u["username"])
    return {"ok": True}


class CsrIn(BaseModel):
    csr: str


@app.post("/api/devices/cert")
async def renew_device_cert(body: CsrIn, u: dict = Me):
    """Продление сертификата устройства (mTLS) — только с самого устройства."""
    k = server_keys()
    d = u.get("_device")
    if not d:
        raise HTTPException(403, "Сертификат выпускается только для устройства")
    cert, serial, exp = k.issue_device_cert(body.csr, d["id"], u["username"], d["session_jwk"])
    await db().set_device_cert(d["id"], serial, exp)
    return {"cert_pem": cert, "ca_pem": k.ca_pem, "expires": exp}


@app.get("/api/server/invite")
async def server_invite(request: Request, u: dict = Me):
    """Ссылка для QR: адрес сервера и отпечаток. Приложение сверит отпечаток при подключении."""
    k = server_keys()
    owner_only(u)
    from urllib.parse import urlencode
    base = settings.public_url or str(request.base_url).rstrip("/")
    link = "fugudeck://add?" + urlencode({"url": base, "fp": k.fingerprint.replace(" ", ""), "name": settings.server_name})
    return {"link": link, "url": base, "fingerprint": k.fingerprint}


@app.get("/api/config")
async def config(u: dict = Me):
    providers = {}
    keys = vault().providers(u["id"])
    if settings.is_space:
        for name in ("github", "gitlab"):
            if name in keys:
                providers[name] = {"ok": True, "login": "ключ с устройства"}
    else:
        for name, p in state["providers"].items():
            try:
                providers[name] = {"ok": True, **(await p.whoami())}
            except Exception as e:
                providers[name] = {"ok": False, "error": str(e)}
    llm_ready = sorted({split_model(m)[0] for m in settings.model_list
                        if agent().llm_key(split_model(m)[0], vault().get(u["id"]))})
    if kgc.enabled() and not is_team() and (mine := await kgc.my_llm_providers()) is not None:
        llm_ready = [p for p in llm_ready if p in mine]  # ключи владельца — в keyguard, не здесь
    return {
        "mode": settings.deck_mode,
        "space": {"id": settings.space_id, "kind": settings.space_kind, "name": settings.space_name}
        if settings.is_space else None,
        "keys": keys,
        "llm_ready": llm_ready,
        "me": public_user(u),
        "models": settings.model_list,
        "default_model": settings.model_list[0] if settings.model_list else "",
        "pricing": settings.pricing,
        "pricing_long": settings.pricing_long,
        "providers": providers,
        "approval_mode": settings.approval_mode,
        "llm_configured": bool(llm_ready),
        "skills_writable": skills().writable,
    }


@app.get("/api/usage")
async def usage(u: dict = Me):
    now = datetime.now(timezone.utc)
    month = datetime(now.year, now.month, 1, tzinfo=timezone.utc).timestamp()
    day = datetime(now.year, now.month, now.day, tzinfo=timezone.utc).timestamp()
    return {"month": await db().usage_since(month), "today": await db().usage_since(day)}


PERIODS = {"today": 1, "week": 7, "month": 30, "all": None}


@app.get("/api/usage/members")
async def usage_members(period: str = "month", u: dict = Me):
    """Сводка расходов по участникам: сколько стоили их запуски и сколько оплачено их ключом."""
    if period not in PERIODS:
        raise HTTPException(400, "period: today | week | month | all")
    now = datetime.now(timezone.utc)
    if period == "today":
        since = datetime(now.year, now.month, now.day, tzinfo=timezone.utc).timestamp()
    elif PERIODS[period]:
        since = time.time() - PERIODS[period] * 86400
    else:
        since = 0.0
    members = await db().usage_by_member(since)
    for m in members:
        m["name"] = m["name"] or ("до сводки (без автора)" if m["user_id"] is None else "бывший участник")
        m["me"] = m["user_id"] == u["id"]
        for k in ("launched_usd", "paid_usd", "paid_for_others_usd"):
            m[k] = round(m[k], 4)
    total = await db().usage_since(since)
    return {"period": period, "since": since, "members": members, "models": await db().usage_by_model(since),
            "total_usd": round(total.get("cost_usd", 0), 4),
            "total_tokens": (total.get("prompt_tokens", 0) or 0) + (total.get("completion_tokens", 0) or 0)}


@app.get("/api/audit")
async def audit(limit: int = 100, u: dict = Me):
    owner_only(u)
    return await db().list_audit(min(limit, 500))


# ================================================================== профиль и пользователи
class MeIn(BaseModel):
    display_name: str | None = Field(None, min_length=1, max_length=40)
    old_password: str | None = None
    new_password: str | None = None


@app.patch("/api/me")
async def update_me(body: MeIn, u: dict = Me):
    fields: dict = {"display_name": body.display_name}
    if body.new_password:
        if u["role"] == "owner":
            raise HTTPException(400, "Пароль владельца задаётся в APP_PASSWORD на сервере")
        if not auth.verify_password(body.old_password or "", u["password_hash"]):
            raise HTTPException(400, "Старый пароль неверен")
        auth.validate_new_password(body.new_password)
        fields["password_hash"] = auth.hash_password(body.new_password)
    await db().update_user(u["id"], **fields)
    return public_user(await db().get_user(u["id"]))


class UserIn(BaseModel):
    username: str = Field(..., pattern=r"^[A-Za-z0-9_.-]{2,32}$")
    display_name: str = Field(..., min_length=1, max_length=40)
    password: str


class UserPatch(BaseModel):
    display_name: str | None = None
    password: str | None = None
    disabled: bool | None = None


@app.get("/api/users")
async def list_users(u: dict = Me):
    rows = await db().list_users()
    if u["role"] != "owner":  # участникам — только имена (для выбора в проектах не нужно)
        rows = [{"id": r["id"], "display_name": r["display_name"], "username": r["username"]} for r in rows]
    return rows


@app.post("/api/users")
async def create_user(body: UserIn, u: dict = Me):
    standalone_only()
    owner_only(u)
    auth.validate_new_password(body.password)
    if await db().get_user_by_name(body.username):
        raise HTTPException(409, "Такой логин уже есть")
    nu = await db().create_user(body.username, body.display_name, auth.hash_password(body.password))
    return public_user(nu)


@app.patch("/api/users/{uid}")
async def patch_user(uid: str, body: UserPatch, u: dict = Me):
    standalone_only()
    owner_only(u)
    target = await db().get_user(uid)
    if not target or target["role"] == "owner":
        raise HTTPException(404, "Пользователь не найден")
    fields: dict = {"display_name": body.display_name,
                    "disabled": None if body.disabled is None else int(body.disabled)}
    if body.password:
        auth.validate_new_password(body.password)
        fields["password_hash"] = auth.hash_password(body.password)
    await db().update_user(uid, **fields)
    return {"ok": True}


@app.delete("/api/users/{uid}")
async def delete_user(uid: str, u: dict = Me):
    standalone_only()
    owner_only(u)
    await db().delete_user(uid)
    return {"ok": True}


# ================================================================== репозитории
@app.get("/api/repos")
async def list_my_repos(q: str = "", u: dict = Me):
    """Репозитории пользователя на GitHub и GitLab (по его ключам; в кластере — через keyguard)."""
    git = agent()._git_for(vault().get(u["id"]))
    out: dict = {}
    try:
        for name, p in git.items():
            try:
                out[name] = {"ok": True, "repos": await p.list_repos(q.strip() or None, 100)}
            except Exception as e:
                out[name] = {"ok": False, "error": str(e)[:200]}
    finally:
        for p in git.values():
            if p not in state["providers"].values():
                await p.http.aclose()
    return out


# ================================================================== проекты
class ProjectIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    description: str = ""


class RepoRef(BaseModel):
    provider: str = Field(..., pattern="^(github|gitlab)$")
    repo: str = Field(..., pattern=r"^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+){1,4}$", max_length=200)

    @field_validator("repo")
    @classmethod
    def _no_dots(cls, v: str) -> str:
        if any(seg in (".", "..") for seg in v.split("/")):
            raise ValueError("имя репозитория: owner/name")
        return v


class ProjectPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=80)
    description: str | None = None
    instructions: str | None = Field(None, max_length=20000)
    skills: list[str] | None = None
    color: str | None = None
    repos: list[RepoRef] | None = Field(None, max_length=100)
    kb_review: bool | None = None  # заметки агента — только после проверки человеком (очередь предложений)


@app.get("/api/projects")
async def list_projects(u: dict = Me):
    rows = await (db().list_all_projects(u["space_role"]) if settings.is_space else db().list_projects_for(u))
    for p in rows:
        p["running"] = len(agent().running_in_project(p["id"]))
    return rows


@app.post("/api/projects")
async def create_project(body: ProjectIn, u: dict = Me):
    p = await db().create_project(body.name, body.description, u)
    await broker().publish("project", p["id"], action="created")
    return p


@app.get("/api/projects/{pid}")
async def get_project(pid: str, u: dict = Me):
    role = await need(u, pid)
    p = await db().get_project(pid)
    p["my_role"] = role
    p["members"] = await db().members(pid)
    p["memory_sources"] = await db().memory_sources(pid)
    p["running"] = agent().running_in_project(pid)
    p["online"] = broker().project_presence(pid)
    return p


@app.patch("/api/projects/{pid}")
async def patch_project(pid: str, body: ProjectPatch, u: dict = Me):
    role = await need(u, pid, "editor")
    if pid == TALK_PROJECT:
        raise HTTPException(400, "«Общение» — не проект: его не переименовать и не настроить")
    if role != "owner" and (body.name is not None or body.description is not None):
        raise HTTPException(403, "Название и описание меняет владелец проекта")
    fields = body.model_dump(exclude_none=True)
    if "repos" in fields:  # без повторов, порядок — как прислали
        seen, repos = set(), []
        for r in fields["repos"]:
            k = (r["provider"], r["repo"].lower())
            if k not in seen:
                seen.add(k)
                repos.append(r)
        fields["repos"] = repos
    await db().update_project(pid, **fields)
    await broker().publish("project", pid, action="updated")
    return await get_project(pid, u)


@app.delete("/api/projects/{pid}")
async def delete_project(pid: str, u: dict = Me):
    await need(u, pid, "owner")
    if pid in (DEFAULT_PROJECT, TALK_PROJECT):
        raise HTTPException(400, "Этот проект удалить нельзя")
    users = await db().project_user_ids(pid)
    # Идущие задания в чатах проекта останавливаем; файлы вложений удаляем с диска (строки базы уйдут каскадом).
    for r in list(agent().runs.values()):
        if r.status == "running" and r.project_id == pid:
            await agent().cancel(r)
    paths = await db().project_attachment_paths(pid)
    await db().delete_project(pid)
    for p in paths:
        Path(p).unlink(missing_ok=True)
    await broker().publish("project", pid, users=users, action="deleted")
    return {"ok": True}


class MemberIn(BaseModel):
    role: str | None = Field(None, pattern="^(viewer|editor|owner)$")


@app.put("/api/projects/{pid}/members/{uid}")
async def set_member(pid: str, uid: str, body: MemberIn, u: dict = Me):
    await need(u, pid, "owner")
    target = await db().get_user(uid)
    if not target or target["role"] == "owner":
        raise HTTPException(404, "Пользователь не найден")
    before = await db().project_user_ids(pid)
    await db().set_member(pid, uid, body.role)
    await broker().publish("project", pid, users=before | {uid}, action="members")
    return {"ok": True}


class SourcesIn(BaseModel):
    source_ids: list[str]


@app.put("/api/projects/{pid}/memory-sources")
async def set_sources(pid: str, body: SourcesIn, u: dict = Me):
    await need(u, pid, "owner")
    for s in body.source_ids:
        await need(u, s, "viewer")  # нельзя открыть доступ к памяти, которую сам не видишь
    await db().set_memory_sources(pid, body.source_ids)
    await broker().publish("project", pid, action="updated")
    return await db().memory_sources(pid)


# ================================================================== память
AREA_RE = "^(" + "|".join(kb.AREAS) + ")$"
LINK_RE = "^(" + "|".join(kb.LINK_TYPES) + ")$"


class MemoryIn(BaseModel):
    content: str = Field(..., min_length=1, max_length=8000)
    tags: str = ""
    pinned: bool = False
    # поля заметки базы знаний; область без значения определяется по тексту
    title: str | None = Field(None, max_length=120)
    area: str | None = Field(None, pattern=AREA_RE)
    grp: str | None = Field(None, max_length=40)
    source_ref: str | None = Field(None, max_length=300)


class MemoryPatch(BaseModel):
    content: str | None = Field(None, min_length=1, max_length=8000)
    tags: str | None = None
    pinned: bool | None = None
    title: str | None = Field(None, max_length=120)
    area: str | None = Field(None, pattern=AREA_RE)
    grp: str | None = Field(None, max_length=40)
    source_ref: str | None = Field(None, max_length=300)
    stale: bool | None = None  # человек может снять «устарела» после проверки или поставить её сам


class NoteLinkIn(BaseModel):
    to: int
    type: str = Field("ref", pattern=LINK_RE)


@app.get("/api/projects/{pid}/memory")
async def list_memory(pid: str, q: str = "", linked: bool = False, u: dict = Me):
    await need(u, pid)
    ids = [pid]
    if linked:
        ids += [s["id"] for s in await db().memory_sources(pid)]
    if q.strip():
        rows = await db().search_memories(ids, q, 100)
        # соседи найденного по связям: по слову не найти, а по смыслу относятся (бэкап → порядок восстановления)
        for m in await db().note_neighbors([r["id"] for r in rows[:20]], 10):
            if m["project_id"] in ids:
                m["linked_to"] = m["link_from"]
                rows.append(m)
        return rows
    out = []
    for i in ids:
        rows = await db().list_memories(i)
        if i != pid:
            name = (await db().get_project(i) or {}).get("name")
            for r in rows:
                r["project_name"] = name
        out += rows
    return out


@app.post("/api/projects/{pid}/memory")
async def add_memory(pid: str, body: MemoryIn, u: dict = Me):
    await need(u, pid, "editor")
    m = await db().add_memory(pid, body.content.strip(), body.tags, "user", u["display_name"], pinned=body.pinned,
                              title=body.title, area=body.area, grp=body.grp, source_ref=body.source_ref, origin="web")
    await broker().publish("memory", pid, action="added", memory=m, by=u["display_name"])
    return m


@app.get("/api/projects/{pid}/kb")
async def knowledge_base(pid: str, u: dict = Me):
    """База знаний проекта для экрана (мозг / паутина / Иггдрасиль): заметки, области, группы, связи, источники."""
    await need(u, pid)
    p = await db().get_project(pid)
    return kb.graph(p, await db().list_memories(pid, 2000), await db().note_links(pid), thoughts=await db().recent_thoughts(pid))


@app.get("/api/projects/{pid}/kb/obsidian")
async def kb_obsidian_export(pid: str, u: dict = Me):
    """База знаний проекта — zip с папкой Obsidian (base64 в JSON: защищённый канал передаёт тело только текстом)."""
    await need(u, pid)
    p = await db().get_project(pid)
    data = obsidian.export_zip(p["name"], await db().list_memories(pid, 5000), await db().note_links(pid))
    return {"filename": f"{obsidian._safe(p['name'])}-obsidian.zip", "size": len(data), "data": base64.b64encode(data).decode()}


class ObsidianIn(BaseModel):
    data: str = Field(..., min_length=1, max_length=(8 << 20) * 4 // 3 + 16)  # zip до 8 МБ


@app.post("/api/projects/{pid}/kb/obsidian")
async def kb_obsidian_import(pid: str, body: ObsidianIn, u: dict = Me):
    """Импорт папки Obsidian (zip): заметки, связи по разделу «Связи» и ссылкам [[…]]."""
    await need(u, pid, "editor")
    try:
        notes = obsidian.import_zip(base64.b64decode(body.data, validate=True))
    except obsidian.ObsidianError as e:
        raise HTTPException(400, str(e))
    except ValueError:
        raise HTTPException(400, "Файл повреждён при передаче")
    by_title: dict[str, int] = {}
    created = 0
    for n in notes:
        m = await db().add_memory(pid, n["content"][:8000], n["tags"], "import", u["display_name"], title=n["title"],
                                  area=n["area"] or kb.classify(n["content"], n["tags"]), grp=n["grp"] or kb.group_of(n["tags"]),
                                  source_ref=n["source_ref"], origin="docs")
        if n["stale"]:
            await db().update_memory(m["id"], stale=True)
        by_title[n["title"].lower()] = m["id"]
        created += 1
    links = 0
    for n in notes:
        a = by_title.get(n["title"].lower())
        for typ, target in n["links"]:
            b = by_title.get(target.lower())
            if a and b and a != b:
                await db().add_note_link(a, b, typ)
                links += 1
    await broker().publish("memory", pid, action="imported", by=u["display_name"])
    return {"created": created, "links": links}


@app.post("/api/memory/{mid}/links")
async def link_notes(mid: int, body: NoteLinkIn, u: dict = Me):
    """Связать две заметки одного проекта: часть, зависит от, решение по, противоречит, пример, ссылка."""
    m = await _memory_for_edit(mid, u)
    o = await db().get_memory(body.to)
    if not o or o["project_id"] != m["project_id"] or o["id"] == mid:
        raise HTTPException(400, "Связать можно только две разные заметки одного проекта")
    await db().add_note_link(mid, body.to, body.type)
    await broker().publish("memory", m["project_id"], action="linked", memory_id=mid, by=u["display_name"])
    return {"ok": True}


@app.delete("/api/memory/{mid}/links/{other}")
async def unlink_notes(mid: int, other: int, type: str | None = None, u: dict = Me):
    m = await _memory_for_edit(mid, u)
    if type is not None and type not in kb.LINK_TYPES:
        raise HTTPException(400, "Неизвестный тип связи")
    n = await db().delete_note_link(mid, other, type)
    await broker().publish("memory", m["project_id"], action="unlinked", memory_id=mid, by=u["display_name"])
    return {"ok": True, "removed": n}


async def _memory_for_edit(mid: int, u: dict) -> dict:
    m = await db().get_memory(mid)
    if not m:
        raise HTTPException(404, "Запись не найдена")
    await need(u, m["project_id"], "editor")
    return m


@app.patch("/api/memory/{mid}")
async def patch_memory(mid: int, body: MemoryPatch, u: dict = Me):
    m = await _memory_for_edit(mid, u)
    ch = body.model_dump(exclude_none=True)
    if "stale" in ch:
        ch["stale_reason"] = ""  # пометку поставил или снял человек — причина сверки больше не относится к делу
    await db().update_memory(mid, **ch)
    nm = await db().get_memory(mid)
    await broker().publish("memory", m["project_id"], action="updated", memory=nm, by=u["display_name"])
    return nm


@app.get("/api/projects/{pid}/kb/proposals")
async def list_note_proposals(pid: str, u: dict = Me):
    await need(u, pid)
    return await db().list_proposals(pid)


async def _proposal_for_edit(nid: int, u: dict) -> dict:
    pr = await db().get_proposal(nid)
    if not pr:
        raise HTTPException(404, "Предложение не найдено")
    await need(u, pr["project_id"], "editor")
    return pr


@app.post("/api/kb/proposals/{nid}/accept")
async def accept_note_proposal(nid: int, u: dict = Me):
    """Принять предложение агента: заметка попадает в базу знаний такой, какой её предложил агент."""
    pr = await _proposal_for_edit(nid, u)
    f = dict(pr["fields"])
    m = await db().add_memory(pr["project_id"], pr["content"], f.pop("tags", ""), "agent", "Fugu", pr["conversation_id"],
                              bool(f.pop("pinned", False)), **f)
    await db().delete_proposal(nid)
    await broker().publish("memory", pr["project_id"], action="added", memory=m, by=u["display_name"])
    return m


@app.delete("/api/kb/proposals/{nid}")
async def reject_note_proposal(nid: int, u: dict = Me):
    pr = await _proposal_for_edit(nid, u)
    await db().delete_proposal(nid)
    await broker().publish("memory", pr["project_id"], action="rejected", proposal_id=nid, by=u["display_name"])
    return {"ok": True}


@app.delete("/api/memory/{mid}")
async def delete_memory(mid: int, u: dict = Me):
    m = await _memory_for_edit(mid, u)
    await db().delete_memory(mid)
    await broker().publish("memory", m["project_id"], action="deleted", memory_id=mid, by=u["display_name"])
    return {"ok": True}


# ================================================================== агенты пространства
class AgentIn(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=40)
    model: str | None = Field(None, max_length=120)  # "" — модель чата
    instructions: str | None = Field(None, max_length=20000)
    tools: list[str] | None = None
    skills: list[str] | None = Field(None, max_length=100)
    approvals: str | None = Field(None, pattern="^(|sign|tap|dangerous|none)$")


@app.get("/api/agents")
async def list_agents(u: dict = Me):
    return await db().list_agents()


@app.put("/api/agents/{aid}")
async def put_agent(aid: str, body: AgentIn, u: dict = Me):
    """Создать или изменить агента (владелец). id — латиницей: под ним агент входит на серверы (deck-<пространство>-<id>)."""
    owner_only(u)
    fields = body.model_dump(exclude_none=True)
    exists = await db().get_agent(aid)
    if why := agent_problem(aid, fields, bool(exists), len(await db().list_agents()), settings.model_list):
        raise HTTPException(409 if "не больше" in why else 400, why)
    a = await db().put_agent(aid, **fields)
    await broker().publish("agent", None, action="saved", agent_id=aid)
    return a


@app.delete("/api/agents/{aid}")
async def delete_agent(aid: str, u: dict = Me):
    owner_only(u)
    if aid == DEFAULT_AGENT:
        raise HTTPException(400, "Агента по умолчанию удалить нельзя")
    if not await db().get_agent(aid):
        raise HTTPException(404, "Агент не найден")
    await db().delete_agent(aid)  # его чаты переходят к агенту по умолчанию
    await broker().publish("agent", None, action="deleted", agent_id=aid)
    return {"ok": True}


# ================================================================== MCP-серверы владельца (через keyguard)
@app.get("/api/mcp")
async def mcp_status(u: dict = Me):
    """Подключённые MCP-серверы и их инструменты — сейчас, без кэша (экран «MCP-серверы» после добавления)."""
    owner_only(u)
    if not mcp_client.enabled() or settings.space_kind == "team":
        return {"available": False, "servers": []}
    mcp_client.forget()
    out = []
    for srv in await mcp_client.servers():
        item = {**srv, "tools": [], "error": None}
        try:
            for t in await asyncio.wait_for(mcp_client.list_tools(srv["id"]), 20):
                item["tools"].append({"name": t.get("name"), "title": t.get("title") or t.get("name"),
                                      "read_only": (t.get("annotations") or {}).get("readOnlyHint") is True,
                                      "description": (t.get("description") or "")[:300]})
        except Exception as e:
            item["error"] = str(e) or e.__class__.__name__
        out.append(item)
    return {"available": True, "servers": out}


# ================================================================== скилы
class SkillIn(BaseModel):
    description: str = Field(..., min_length=1, max_length=1024)
    body: str = Field(..., max_length=150_000)
    rename_from: str | None = None


def _skill_err(e: SkillError):
    raise HTTPException(400, str(e))


@app.get("/api/skills")
async def list_skills(u: dict = Me):
    return {"writable": skills().writable, "items": skills().list()}


@app.get("/api/skills/{name}")
async def get_skill(name: str, u: dict = Me):
    try:
        return skills().get(name)
    except SkillError as e:
        raise HTTPException(404, str(e))


@app.put("/api/skills/{name}")
async def save_skill(name: str, body: SkillIn, u: dict = Me):
    owner_only(u)
    try:
        s = skills().save(name, body.description, body.body, body.rename_from)
    except SkillError as e:
        _skill_err(e)
    await broker().publish("skill", None, action="saved", name=name)
    return s


@app.delete("/api/skills/{name}")
async def delete_skill(name: str, u: dict = Me):
    owner_only(u)
    try:
        skills().delete(name)
    except SkillError as e:
        _skill_err(e)
    await broker().publish("skill", None, action="deleted", name=name)
    return {"ok": True}


# ================================================================== чаты
class ConvIn(BaseModel):
    model: str | None = None
    agent_id: str | None = Field(None, max_length=31)  # какой агент ведёт чат (по умолчанию — fugu)
    title: str | None = Field(None, min_length=1, max_length=120)
    project_id: str | None = None  # перенести чат в другой проект (нужна роль редактора в обоих)


def _check_model(m: str | None) -> str:
    models = settings.model_list
    if m and m not in models:
        raise HTTPException(400, f"Неизвестная модель {m}")
    return m or models[0]


@app.get("/api/projects/{pid}/conversations")
async def list_convs(pid: str, u: dict = Me):
    await need(u, pid)
    convs = await db().list_conversations(pid)
    if pid == TALK_PROJECT and not settings.is_space and u["role"] != "owner":
        convs = [c for c in convs if c.get("created_by") == u["id"]]  # на своём сервере разговоры — у каждого свои
    for c in convs:
        r = agent().active_run(c["id"])
        c["running"] = bool(r and r.status == "running")
    return convs


@app.post("/api/projects/{pid}/conversations")
async def create_conv(pid: str, body: ConvIn, u: dict = Me):
    await need(u, pid, "editor")
    agent = None
    if body.agent_id and pid != TALK_PROJECT:
        agent = await db().get_agent(body.agent_id)
        if not agent:
            raise HTTPException(400, "Нет такого агента")
    model = _check_model(body.model or (agent or {}).get("model") or None)
    # в общем пространстве спонсора назначает выбор модели с условиями оплаты (POST /model)
    c = await db().create_conversation(model, pid, u["id"], body.title or "Новый чат")
    if agent:
        await db().update_conversation(c["id"], agent_id=agent["id"])
        c["agent_id"] = agent["id"]
    await broker().publish("conversation", pid, action="created", conversation_id=c["id"], by=u["display_name"])
    return c


def is_team() -> bool:
    return settings.is_space and settings.space_kind == "team"


def kg_team() -> bool:
    """Общее пространство в кластере: модель оплачивается ключом спонсора через keyguard по подписанному разрешению."""
    return is_team() and kgc.enabled()


@app.patch("/api/conversations/{cid}")
async def update_conv(cid: str, body: ConvIn, u: dict = Me):
    c = await conv_access(u, cid, "editor")
    if body.model and body.model != c["model"] and is_team():
        raise HTTPException(409, "В общем чате модель меняется через предложение участникам")
    title = body.title.strip() if body.title else None
    if body.title is not None and not title:
        raise HTTPException(400, "Название чата не может быть пустым")
    to = body.project_id if body.project_id and body.project_id != c["project_id"] else None
    if to:
        await need(u, to, "editor")
        if (r := agent().active_run(cid)) and r.status == "running":
            raise HTTPException(409, "В чате идёт выполнение — перенесите его, когда агент закончит")
    if body.agent_id and not await db().get_agent(body.agent_id):
        raise HTTPException(400, "Нет такого агента")
    if body.agent_id and (r := agent().active_run(cid)) and r.status == "running":
        raise HTTPException(409, "Сменить агента можно, когда он закончит")
    await db().update_conversation(cid, title=title, model=_check_model(body.model) if body.model else None, project_id=to,
                                   agent_id=body.agent_id)
    await broker().publish("conversation", c["project_id"], action="updated", conversation_id=cid)
    if to:
        await broker().publish("conversation", to, action="created", conversation_id=cid, by=u["display_name"])
    return await db().get_conversation(cid)


@app.delete("/api/conversations/{cid}")
async def delete_conv(cid: str, u: dict = Me):
    c = await conv_access(u, cid, "editor")
    if r := agent().active_run(cid):
        await agent().cancel(r)
    for p in await db().delete_conversation(cid):
        Path(p).unlink(missing_ok=True)
    await broker().publish("conversation", c["project_id"], action="deleted", conversation_id=cid)
    return {"ok": True}


@app.get("/api/conversations/{cid}")
async def get_conv(cid: str, u: dict = Me):
    c = await conv_access(u, cid)
    c["my_role"] = await db().project_role(u, c["project_id"])
    ag = await db().get_agent(c.get("agent_id") or DEFAULT_AGENT)
    c["agent"] = {"id": ag["id"], "name": ag["name"]} if ag else None
    c.update(await chat_model_state(c, u))
    msgs = await db().get_messages(cid)
    items = []
    for m in msgs:
        it = {"id": m["id"], "role": m["role"], "content": m["content"], "created_at": m["created_at"]}
        if m["role"] == "assistant" and m["tool_calls"]:
            calls = []
            for tc in m["tool_calls"]:
                try:
                    args = json.loads(tc["function"]["arguments"] or "{}")
                except json.JSONDecodeError:
                    args = {"_raw": tc["function"]["arguments"]}
                calls.append({"id": tc["id"], "name": tc["function"]["name"], "args": args})
            it["tool_calls"] = calls
        if m["role"] == "tool":
            it["tool_call_id"] = m["tool_call_id"]
            it["name"] = m["name"]
            try:
                parsed = json.loads(m["content"] or "null")
                it["ok"] = not (isinstance(parsed, dict) and "error" in parsed and len(parsed) == 1)
            except json.JSONDecodeError:
                it["ok"] = True
            it["content"] = (m["content"] or "")[:3000]
        if m["meta"]:
            it["meta"] = m["meta"]
        items.append(it)
    run = agent().active_run(cid)
    running = run and run.status == "running"
    c["active_run"] = run.id if running else None
    c["active_run_started_at"] = run.started_at if running else None
    c["messages"] = items
    return c


SAFE = re.compile(r"[^\w.\-() ]+", re.UNICODE)


@app.post("/api/conversations/{cid}/attachments")
async def upload(cid: str, file: UploadFile = File(...), u: dict = Me):
    await conv_access(u, cid, "editor")
    name = SAFE.sub("_", Path(file.filename or "file").name)[:120] or "file"
    aid_dir = settings.data_dir / "attachments" / cid
    aid_dir.mkdir(parents=True, exist_ok=True)
    dest = aid_dir / f"{new_id()}_{name}"
    limit, size = settings.max_upload_mb * 1024 * 1024, 0
    with dest.open("wb") as f:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > limit:
                f.close()
                dest.unlink(missing_ok=True)
                raise HTTPException(413, f"Файл больше {settings.max_upload_mb} МБ")
            f.write(chunk)
    mime = file.content_type or mimetypes.guess_type(name)[0] or "application/octet-stream"
    return await db().add_attachment(cid, name, mime, size, str(dest))


class UploadIn(BaseModel):
    filename: str = Field(..., min_length=1, max_length=255)
    mime: str = Field("", max_length=120)
    data: str = Field(..., min_length=1)  # содержимое файла в base64


# Вложение с телефона. Защищённый канал приложения (mTLS ключом из чипа) передаёт тело запроса только текстом,
# поэтому файл приходит в JSON как base64, а не multipart. Предел меньше общего: base64 раздувает файл на треть,
# и всё это проходит через память телефона и прокси.
JSON_UPLOAD_MAX = 8 * 1024 * 1024


@app.post("/api/conversations/{cid}/attachments/json")
async def upload_json(cid: str, body: UploadIn, u: dict = Me):
    await conv_access(u, cid, "editor")
    if len(body.data) > JSON_UPLOAD_MAX * 4 // 3 + 16:
        raise HTTPException(413, f"Файл больше {JSON_UPLOAD_MAX // 1024 // 1024} МБ")
    try:
        raw = base64.b64decode(body.data, validate=True)
    except Exception:
        raise HTTPException(400, "Содержимое файла повреждено при передаче")
    if not raw or len(raw) > JSON_UPLOAD_MAX:
        raise HTTPException(413 if raw else 400, f"Файл пустой или больше {JSON_UPLOAD_MAX // 1024 // 1024} МБ")
    name = SAFE.sub("_", Path(body.filename).name)[:120] or "file"
    aid_dir = settings.data_dir / "attachments" / cid
    aid_dir.mkdir(parents=True, exist_ok=True)
    dest = aid_dir / f"{new_id()}_{name}"
    dest.write_bytes(raw)
    # Тип файла — по расширению; присланный телефоном учитываем, только если он обычного вида (в подсказку модели
    # и в data:-адрес картинки он попадает как есть).
    return await db().add_attachment(cid, name, _mime_for(name, body.mime), len(raw), str(dest))


# Предпросмотр на телефоне: тот же защищённый канал отдаёт тело только текстом — содержимое в JSON как base64.
@app.get("/api/attachments/{aid}/json")
async def download_json(aid: str, u: dict = Me):
    a = await db().get_attachment(aid)
    if not a:
        raise HTTPException(404, "Вложение не найдено")
    await conv_access(u, a["conversation_id"])
    p = Path(a["path"])
    if not p.is_file():
        raise HTTPException(404, "Файл вложения не найден")
    if a["size"] > JSON_UPLOAD_MAX:
        raise HTTPException(413, "Файл слишком большой для предпросмотра")
    return {"id": a["id"], "filename": a["filename"], "mime": a["mime"], "size": a["size"],
            "data": base64.b64encode(p.read_bytes()).decode()}


# Большие файлы — частями: каждая часть — обычный короткий запрос (base64 в JSON, как и малая загрузка), поэтому
# ни лимит прокси на время запроса, ни память телефона не мешают файлу до CHUNKED_MAX. Части идут строго по порядку.
CHUNK_BYTES = 2 * 1024 * 1024
CHUNKED_MAX = 50 * 1024 * 1024
UPLOAD_TTL = 3600
uploads: dict[str, dict] = {}  # незавершённые загрузки (в памяти: перезапуск агента — начать заново)


class UploadStart(BaseModel):
    filename: str = Field(..., min_length=1, max_length=255)
    mime: str = Field("", max_length=120)
    size: int = Field(..., gt=0)


class UploadChunk(BaseModel):
    offset: int = Field(..., ge=0)
    data: str = Field(..., min_length=1, max_length=CHUNK_BYTES * 4 // 3 + 16)


def _mime_for(name: str, sent: str) -> str:
    return mimetypes.guess_type(name)[0] or (sent if re.fullmatch(r"[a-z0-9.+-]+/[a-z0-9.+-]+", sent) else "") \
        or "application/octet-stream"


def _drop_stale_uploads(now: float) -> None:
    for k, up in list(uploads.items()):
        if now - up["touched"] > UPLOAD_TTL:
            Path(up["path"]).unlink(missing_ok=True)
            uploads.pop(k, None)


@app.post("/api/conversations/{cid}/uploads")
async def upload_start(cid: str, body: UploadStart, u: dict = Me):
    await conv_access(u, cid, "editor")
    if body.size > CHUNKED_MAX:
        raise HTTPException(413, f"Файл больше {CHUNKED_MAX // 1024 // 1024} МБ")
    _drop_stale_uploads(time.time())
    if sum(1 for x in uploads.values() if x["user"] == u["id"]) >= 6:
        raise HTTPException(429, "Слишком много незавершённых загрузок — дождитесь окончания")
    name = SAFE.sub("_", Path(body.filename).name)[:120] or "file"
    d = settings.data_dir / "attachments" / cid
    d.mkdir(parents=True, exist_ok=True)
    uid = new_id()
    path = d / f"{uid}_{name}.part"
    path.write_bytes(b"")
    uploads[uid] = {"cid": cid, "user": u["id"], "name": name, "mime": _mime_for(name, body.mime), "size": body.size,
                    "got": 0, "path": str(path), "touched": time.time()}
    return {"upload_id": uid, "chunk_bytes": CHUNK_BYTES}


def _upload_of(upid: str, u: dict) -> dict:
    up = uploads.get(upid)
    if not up or up["user"] != u["id"]:
        raise HTTPException(404, "Загрузка не найдена или устарела — начните заново")
    return up


@app.post("/api/uploads/{upid}/chunk")
async def upload_chunk(upid: str, body: UploadChunk, u: dict = Me):
    up = _upload_of(upid, u)
    if body.offset != up["got"]:
        # повтор уже принятой части (ответ потерялся) — не ошибка: телефон продолжит с got
        return {"got": up["got"]}
    try:
        raw = base64.b64decode(body.data, validate=True)
    except Exception:
        raise HTTPException(400, "Часть файла повреждена при передаче")
    if not raw or len(raw) > CHUNK_BYTES or up["got"] + len(raw) > up["size"]:
        raise HTTPException(400, "Неверный размер части")
    with open(up["path"], "ab") as f:
        f.write(raw)
    up["got"] += len(raw)
    up["touched"] = time.time()
    return {"got": up["got"]}


@app.post("/api/uploads/{upid}/finish")
async def upload_finish(upid: str, u: dict = Me):
    up = _upload_of(upid, u)
    if up["got"] != up["size"]:
        raise HTTPException(409, f"Получено {up['got']} из {up['size']} байт")
    await conv_access(u, up["cid"], "editor")
    uploads.pop(upid, None)
    final = Path(up["path"][:-len(".part")])
    Path(up["path"]).rename(final)
    return await db().add_attachment(up["cid"], up["name"], up["mime"], up["size"], str(final))


@app.get("/api/attachments/{aid}/chunk")
async def download_chunk(aid: str, offset: int = 0, length: int = CHUNK_BYTES, u: dict = Me):
    """Скачивание частями (открыть или сохранить файл на телефоне): base64 в JSON, как и загрузка."""
    a = await db().get_attachment(aid)
    if not a:
        raise HTTPException(404, "Вложение не найдено")
    await conv_access(u, a["conversation_id"])
    p = Path(a["path"])
    if not p.is_file():
        raise HTTPException(404, "Файл вложения не найден")
    size = p.stat().st_size
    if offset < 0 or offset > size:
        raise HTTPException(400, "offset за пределами файла")
    with p.open("rb") as f:
        f.seek(offset)
        raw = f.read(max(1, min(length, CHUNK_BYTES)))
    return {"id": a["id"], "filename": a["filename"], "mime": a["mime"], "size": size, "offset": offset,
            "data": base64.b64encode(raw).decode(), "eof": offset + len(raw) >= size}


UNSENT_TTL = 24 * 3600


async def attachment_janitor(every: float = 3600) -> None:
    """Вложения, загруженные, но так и не отправленные (человек передумал), удаляются через сутки."""
    while True:
        try:
            _drop_stale_uploads(time.time())
            rows = await db().unsent_attachments(time.time() - UNSENT_TTL)
            for r in rows:
                Path(r["path"]).unlink(missing_ok=True)
            if rows:
                await db().delete_attachments([r["id"] for r in rows])
                log.info("убрано неотправленных вложений: %d", len(rows))
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("уборка вложений")
        await asyncio.sleep(every)


class MessageIn(BaseModel):
    content: str
    attachment_ids: list[str] = []
    model: str | None = None


async def _llm_access(c: dict, u: dict, want_model: str | None):
    """Чем платить за модель в этом чате: (модель, ключи автора, ключ модели, проверка бюджета). Отказ — HTTPException."""
    keys = vault().get(u["id"])
    if is_team():
        # одна модель на чат; платит спонсор — участник, который её выбрал и разрешил свой ключ
        llm_key, budget, why = await sponsor_access(c)
        if why:
            raise HTTPException(409, why)
        return c["model"], keys, llm_key, budget
    model = _check_model(want_model or c["model"])
    if kgc.enabled() and (mine := await kgc.my_llm_providers()) is not None and split_model(model)[0] not in mine:
        kgc.forget_providers()  # ключ могли только что ввести — спросим ещё раз
        if (mine := await kgc.my_llm_providers()) is not None and split_model(model)[0] not in mine:
            raise HTTPException(400, f"Нет ключа {split_model(model)[0]}: введите его на экране кластера → «Токены моделей» или выберите другую модель")
    if not agent().llm_key(split_model(model)[0], keys):
        raise HTTPException(400, f"Нет ключа для {split_model(model)[0]}: разблокируйте ключи в приложении"
                            if settings.is_space else f"На сервере не задан ключ {split_model(model)[0]}")
    return model, keys, None, None


@app.post("/api/conversations/{cid}/messages")
async def send(cid: str, body: MessageIn, u: dict = Me):
    c = await conv_access(u, cid, "editor")
    model, keys, llm_key, budget = await _llm_access(c, u, body.model)
    atts = []
    for aid in body.attachment_ids:
        a = await db().get_attachment(aid)
        if not a or a["conversation_id"] != cid:
            raise HTTPException(400, f"Вложение {aid} не найдено")
        atts.append({"id": a["id"], "filename": a["filename"], "mime": a["mime"], "size": a["size"]})
    run = agent().active_run(cid)
    if run and run.status == "running":
        raise HTTPException(409, "В этом чате уже идёт выполнение")
    meta: dict = {"author": u["display_name"], "author_id": u["id"]}
    if atts:
        meta["attachments"] = atts
    await db().add_message(cid, "user", body.content, meta=meta)
    updates: dict = {} if is_team() else {"model": model}
    if c["title"] == "Новый чат":
        t = body.content.strip().splitlines()[0] if body.content.strip() else (atts[0]["filename"] if atts else "")
        updates["title"] = (t[:60] + "…") if len(t) > 60 else t or "Новый чат"
    await db().update_conversation(cid, **updates)
    run = await agent().start(cid, model, u, c["project_id"], keys, llm_key=llm_key, budget=budget,
                              payer_id=c.get("sponsor_id") if is_team() else u["id"])
    return {"run_id": run.id}


@app.post("/api/conversations/{cid}/retry")
async def retry(cid: str, u: dict = Me):
    """Продолжить прерванное задание (агент перезапускался посреди ответа): та же переписка, без нового сообщения."""
    c = await conv_access(u, cid, "editor")
    run = agent().active_run(cid)
    if run and run.status == "running":
        raise HTTPException(409, "В этом чате уже идёт выполнение")
    if not await db().unanswered(cid):
        raise HTTPException(409, "Повторять нечего: на последнее сообщение агент уже ответил")
    model, keys, llm_key, budget = await _llm_access(c, u, None)
    await db().add_message(cid, "note", f"{u['display_name']}: повтор прерванного задания")
    run = await agent().start(cid, model, u, c["project_id"], keys, llm_key=llm_key, budget=budget,
                              payer_id=c.get("sponsor_id") if is_team() else u["id"])
    return {"run_id": run.id}


INTERRUPTED_NOTE = "Задание прервалось: агент перезапускался, ответа нет. Нажмите «Повторить», чтобы продолжить."


async def mark_interrupted(within: float = 2 * 86400) -> int:
    """При запуске агента: чаты, где задание оборвалось (последнее — вопрос или вызов инструмента без ответа),
    получают пометку с кнопкой «Повторить». Задания в памяти, и после перезапуска их не вернуть."""
    n = 0
    for cid in await db().unanswered_conversations(time.time() - within):
        await db().add_message(cid, "note", INTERRUPTED_NOTE, meta={"interrupted": True})
        n += 1
    if n:
        log.warning("прерванных заданий после перезапуска: %d", n)
    return n


async def _run_access(rid: str, u: dict, min_role: str = "viewer"):
    run = agent().runs.get(rid)
    if not run:
        raise HTTPException(404, "Запуск не найден (возможно, сервер перезапускался)")
    await need(u, run.project_id, min_role)
    return run


@app.get("/api/runs/{rid}/events")
async def events(rid: str, request: Request, after: int = 0, u: dict = Me):
    run = await _run_access(rid, u)

    started = time.time()

    async def gen():
        pos = after
        yield "retry: 2000\n\n"
        while True:
            if await request.is_disconnected():
                return
            if spaceauth.revoked_since(u["id"], started):
                yield "event: end\ndata: {}\n\n"
                return
            evs = await run.wait_events(pos)
            for e in evs:
                yield f"id: {e['seq']}\ndata: {json.dumps(e, ensure_ascii=False, default=str)}\n\n"
            pos += len(evs)
            if not evs:
                yield ": ping\n\n"
            if run.status != "running" and pos >= len(run.events):
                yield "event: end\ndata: {}\n\n"
                return

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/runs/{rid}/cancel")
async def cancel(rid: str, u: dict = Me):
    await agent().cancel(await _run_access(rid, u, "editor"))
    return {"ok": True}


class ApprovalIn(BaseModel):
    approve: bool
    comment: str = ""
    action: dict | None = None   # подписанное действие (с телефона)
    sig: str | None = None
    jws: str | None = None       # то же в кластере: компактный JWS, проверяет keyguard


@app.post("/api/approvals/{aid}")
async def approve(aid: str, body: ApprovalIn, u: dict = Me):
    run = next((r for r in agent().runs.values() if aid in r.approvals), None)
    if not run:
        raise HTTPException(404, "Запрос на подтверждение не найден или уже обработан")
    await need(u, run.project_id, "editor")
    nosign = bool((run.approval_meta.get(aid) or {}).get("nosign"))  # агент настроен «без подписи»
    if u.get("_device"):  # с телефона подтверждение «за» действует только с подписью ключом подтверждения (биометрия)
        meta = run.approval_meta.get(aid) or {}
        if (body.approve or body.action) and not (nosign and body.approve and not body.action):
            d = u["_device"]
            state["device_auth"].check_action(body.action or {}, body.sig or "", d["confirm_jwk"], d["id"], {
                "type": "approve_tool", "approval_id": aid, "tool": meta.get("name"),
                "args_sha256": devices.args_hash(meta.get("args")), "approve": body.approve})
    elif (run.approval_meta.get(aid) or {}).get("sign") and body.approve:
        # Команда на сервере: подписывается не «разрешение инструмента», а сама команда (ssh_write / ssh_danger).
        # Проверит подпись ssh-gateway (через keyguard) — у него же она и сгорит; здесь только сверка с тем, что
        # действительно ждёт подтверждения, чтобы человеку не пришлось подписывать заново из-за опечатки клиента.
        want = run.approval_meta[aid]["sign"]
        try:
            got = json.loads(base64.urlsafe_b64decode((body.jws or "").split(".")[1] + "=="))
        except Exception:
            raise HTTPException(403, "Нужна подпись команды: подтвердите её в приложении")
        if any(got.get(k) != v for k, v in want.items()) or got.get("space") != f"u-{u['id']}":
            raise HTTPException(403, "Подписана другая команда — не та, что ждёт подтверждения")
        agent().resolve_approval(aid, True, body.comment, jws=body.jws or "")
        await broker().publish("run.approval_resolved", run.project_id, conversation_id=run.conversation_id,
                               run_id=run.id, approved=True, by=u["display_name"])
        return {"ok": True}
    elif settings.is_space and kgc.enabled() and body.approve and not nosign:
        # В кластере «за» действует только с подписью ключа подтверждения владельца (биометрия на телефоне).
        # Иначе разрешить агенту действие мог бы любой, кто получил токен пространства, — в том числе control-plane.
        meta = run.approval_meta.get(aid) or {}
        if not body.jws:
            raise HTTPException(403, "Нужна подпись: подтвердите действие в приложении")
        try:
            res = await kgc.verify_action(body.jws)
        except PermissionError as e:
            raise HTTPException(403, f"Подпись не принята: {e}")
        except Exception:
            raise HTTPException(503, "Не удалось проверить подпись — повторите")
        # Подписать должен тот, кто нажал «Разрешить». В личном пространстве это владелец; в общем keyguard лишь
        # подтверждает подпись и называет подписавшего, а право разрешать (роль не ниже редактора) проверено выше.
        if res.get("user") != u["id"]:
            raise HTTPException(403, "Подпись сделана другим пользователем")
        a = res.get("action") or {}
        want = {"type": "tool_approve", "approval": aid, "tool": meta.get("name"), "args_sha256": devices.args_hash(meta.get("args"))}
        if any(a.get(k) != v for k, v in want.items()):
            raise HTTPException(403, "Подписано другое действие — не то, что ждёт подтверждения")
    agent().resolve_approval(aid, body.approve, body.comment)
    await broker().publish("run.approval_resolved", run.project_id, conversation_id=run.conversation_id,
                           run_id=run.id, approved=body.approve, by=u["display_name"])
    return {"ok": True}


# ================================================================== модель общего чата: спонсор и предложения
async def sponsor_blocker(c: dict) -> str | None:
    """Почему спонсор сейчас не может оплатить запуск: лимит в $ / токенах или срок спонсорства."""
    now = time.time()
    until = c.get("sponsor_until")
    if until and now >= until:
        return "Срок спонсорства истёк — спонсор может продлить его или кто-то предложит свою модель"
    if kg_team():
        return None  # деньги считает keyguard по своим ценам; местный подсчёт мог бы остановить чат раньше или позже
    used = await db().sponsor_usage(c["id"], c.get("sponsor_since"))
    lim_usd, lim_tok = c.get("sponsor_limit_usd"), c.get("sponsor_limit_tokens")
    if lim_usd is not None and used["usd"] >= lim_usd:
        return f"Лимит спонсора ${lim_usd:g} исчерпан"
    if lim_tok is not None and used["tokens"] >= lim_tok:
        return f"Лимит спонсора {lim_tok:,} токенов исчерпан".replace(",", " ")
    return None


async def sponsor_access(c: dict):
    """Ключ спонсора для запуска + проверка лимитов на каждом шаге. Возвращает (key, budget_fn, причина_отказа)."""
    if not c.get("sponsor_id"):
        return None, None, "У чата нет спонсора модели — предложите модель, которую оплатите своим ключом"
    pname = split_model(c["model"])[0]
    if kg_team():
        # Ключа здесь нет и не будет: keyguard подставит ключ спонсора, если его разрешение на этот чат и модель
        # действует, лимит не исчерпан и запускающий в списке допущенных. Спонсору не нужно быть в сети.
        if not c.get("grant_id"):
            return None, None, "У чата нет действующего разрешения спонсора — предложите модель заново"
        key = None
    else:
        key = vault().get(c["sponsor_id"]).get(pname)
        sponsor = await db().get_user(c["sponsor_id"])
        name = sponsor["display_name"] if sponsor else "спонсор"
        if not key:
            return None, None, f"Ключ спонсора недоступен: {name} сейчас не в сети. Можно предложить свою модель"
    if why := await sponsor_blocker(c):
        return None, None, why
    cid = c["id"]

    async def budget():
        cur = await db().get_conversation(cid)
        if not cur or cur.get("sponsor_id") != c["sponsor_id"] or cur.get("model") != c["model"]:
            return "Модель или спонсор чата изменились — остановлено"
        why = await sponsor_blocker(cur)
        return f"{why} — остановлено" if why else None

    return key, budget, None


async def chat_model_state(c: dict, u: dict) -> dict:
    out: dict = {"team": is_team()}
    if not is_team():
        return out
    out["owner_switch"] = u.get("space_role") == "owner"  # владелец меняет модель без голосования
    sp = await db().get_user(c["sponsor_id"]) if c.get("sponsor_id") else None
    pname = split_model(c["model"])[0]
    if sp:
        used = await db().sponsor_usage(c["id"], c.get("sponsor_since"))
        out["by_member"] = await db().chat_usage_by_member(c["id"], c.get("sponsor_since"))
        out["sponsor"] = {"id": sp["id"], "name": sp["display_name"],
                          "online": True if kg_team() else bool(vault().get(sp["id"]).get(pname)),
                          "grant_id": c.get("grant_id"),
                          # для подписанного отзыва: разрешение в keyguard отзывается по чату и предложению
                          "proposal_id": await db().proposal_of_grant(c["grant_id"]) if c.get("grant_id") else None,
                          "limit_usd": c.get("sponsor_limit_usd"), "limit_tokens": c.get("sponsor_limit_tokens"),
                          "until": c.get("sponsor_until"), "since": c.get("sponsor_since"),
                          "spent_usd": round(used["usd"], 4), "spent_tokens": used["tokens"],
                          "blocked": await sponsor_blocker(c)}
        if c.get("sponsor_member_day"):
            # дневной лимит на участника keyguard считает по суткам UTC — так же считаем и здесь
            day = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
            out["sponsor"]["per_member_usd_day"] = c["sponsor_member_day"]
            out["sponsor"]["my_today_usd"] = round(await db().member_usage_since(c["id"], u["id"], day), 4)
    else:
        out["sponsor"] = None
    await expire_due()
    out["proposal"] = await proposal_view(await db().pending_proposal(c["id"]), u)
    out["model_policy"] = c.get("model_policy") or "vote"
    out["created_by"] = c.get("created_by")
    out["proposal_ttl_hours"] = round(settings.proposal_ttl_seconds / 3600)
    return out


async def _note(c: dict, text: str) -> None:
    """Служебная отметка в ленте чата (модели не отправляется)."""
    await db().add_message(c["id"], "note", text)
    await broker().publish("conversation", c["project_id"], action="updated", conversation_id=c["id"])


def _title(model: str) -> str:
    return model.split(":", 1)[-1]


def _terms(limit_usd, limit_tokens, days, until=None) -> str:
    parts = []
    if until:
        days = None
    if limit_usd is not None:
        parts.append(f"до ${limit_usd:g}")
    if limit_tokens is not None:
        parts.append(f"до {int(limit_tokens):,} токенов".replace(",", " "))
    if days:
        parts.append(f"на {days:g} дн.")
    if until:
        try:
            tz = ZoneInfo(settings.display_tz)
        except Exception:
            tz = timezone.utc
        parts.append("до " + datetime.fromtimestamp(until, tz).strftime("%d.%m.%Y"))
    return ", ".join(parts) or "без ограничений"


NEED_LIMIT = "Нужно ограничение спонсорства: сумма ($ или токены) или срок"


def _check_until(until: float | None) -> None:
    if until is not None and not (time.time() + 60 < until <= time.time() + 366 * 86400):
        raise HTTPException(400, "Дата окончания спонсорства — от завтрашнего дня и не дальше года")


class ProposalIn(BaseModel):
    model: str
    limit_usd: float | None = Field(None, gt=0, le=100000)
    limit_tokens: int | None = Field(None, ge=1000, le=10_000_000_000)
    days: float | None = Field(None, gt=0, le=365)
    until: float | None = None  # дата окончания (unix-время), выбирается в календаре
    model_policy: str | None = Field(None, pattern="^(vote|open)$")  # только при создании чата

    def has_limit(self) -> bool:
        return any(v is not None for v in (self.limit_usd, self.limit_tokens, self.days, self.until))


POLICIES = {"vote": "по голосованию", "open": "свободно для коллег"}


async def voters() -> list[dict] | None:
    """Кто голосует: редакторы и владельцы пространства (состав присылает control-plane)."""
    r = await db().roster()
    return [m for m in r if m["role"] in ("editor", "owner")] if r else None


async def expire_due() -> None:
    """Предложения старше срока (24 ч) закрываем и отмечаем в чате."""
    for p in await db().expire_proposals():
        c = await db().get_conversation(p["conversation_id"])
        if c:
            await _note(c, f"Предложение перейти на {_title(p['model'])} истекло: за сутки не набрало голосов")


async def proposal_view(p: dict | None, u: dict) -> dict | None:
    if not p:
        return None
    vs = await db().votes(p["id"])
    eligible = await voters()
    total = len(eligible) if eligible else None
    need = total // 2 + 1 if total else 2  # большинство; без состава — автор + ещё один коллега
    mine = next((v["vote"] for v in vs if v["user_id"] == u["id"]), None)
    return {**p, "yes": [v["name"] for v in vs if v["vote"]], "no": [v["name"] for v in vs if not v["vote"]],
            "need": need, "voters": total, "my_vote": None if mine is None else bool(mine)}


async def _apply(c: dict, model: str, sponsor: dict, terms: dict) -> None:
    await db().set_sponsor(c["id"], model, sponsor["id"], terms.get("limit_usd"), terms.get("limit_tokens"),
                           terms.get("days"), terms.get("until"))


@app.post("/api/conversations/{cid}/model")
async def propose_model(cid: str, body: ProposalIn, u: dict = Me):
    """Выбрать, сменить или предложить модель чата. Кто выбирает модель — тот спонсор и платит своим ключом."""
    c = await conv_access(u, cid, "editor")
    model = _check_model(body.model)
    if not is_team():
        await db().update_conversation(cid, model=model)
        return {"applied": True}
    if not body.has_limit():
        raise HTTPException(400, NEED_LIMIT)
    _check_until(body.until)
    if not kg_team() and not agent().llm_key(split_model(model)[0], vault().get(u["id"])):
        raise HTTPException(400, "Выбрать можно только модель, для которой у вас есть ключ: вы становитесь спонсором")
    run = agent().active_run(cid)
    if run and run.status == "running":
        raise HTTPException(409, "Дождитесь окончания работы агента")
    await expire_due()
    if kg_team():
        return await _propose_with_grant(c, model, body, u)
    terms = body.model_dump(include={"limit_usd", "limit_tokens", "days", "until"})
    text_terms = _terms(body.limit_usd, body.limit_tokens, body.days, body.until)
    # новый чат: создатель выбирает модель и правило её смены
    if not await db().has_messages(cid) and c.get("created_by") == u["id"]:
        if body.model_policy:
            await db().set_model_policy(cid, body.model_policy)
        await _apply(c, model, u, terms)
        pol = POLICIES[body.model_policy or c.get("model_policy") or "vote"]
        await _note(c, f"{u['display_name']} выбрал(а) {_title(model)} и оплачивает чат ({text_terms}). Смена модели: {pol}")
        return {"applied": True}
    if u.get("space_role") == "owner":
        # владелец пространства меняет модель на свою сразу: платит он сам, голосовать не о чем
        await _apply(c, model, u, terms)
        await _note(c, f"{u['display_name']} (владелец) сменил(а) модель на {_title(model)} и оплачивает чат ({text_terms})")
        await broker().publish("model.proposal", c["project_id"], conversation_id=cid, by=u["display_name"], model=model)
        return {"applied": True}
    if c.get("model_policy") == "open":
        # смена модели разрешена коллегам — без голосования
        await _apply(c, model, u, terms)
        await _note(c, f"{u['display_name']} сменил(а) модель на {_title(model)} и теперь оплачивает чат ({text_terms})")
        await broker().publish("model.proposal", c["project_id"], conversation_id=cid, by=u["display_name"], model=model)
        return {"applied": True}
    p = await db().create_proposal(cid, model, u["id"], body.limit_usd, body.limit_tokens, body.days, body.until,
                                   ttl=settings.proposal_ttl_seconds)
    hours = round(settings.proposal_ttl_seconds / 3600)
    await _note(c, f"{u['display_name']} предлагает перейти на {_title(model)} (платит {u['display_name']}: {text_terms}). "
                   f"Голосование {hours} ч")
    await broker().publish("model.proposal", c["project_id"], conversation_id=cid, proposal_id=p["id"],
                           by=u["display_name"], model=model)
    res = await _tally(p["id"], c, u)  # если голосует только автор — решится сразу
    return {"applied": res == "approved", "proposal": await proposal_view(await db().proposal(p["id"]), u)}


async def _tally(pid: str, c: dict, u: dict) -> str:
    """Подсчёт голосов: большинство «за» — переход, большинство уже недостижимо — отклонено."""
    p = await db().proposal(pid)
    if not p or p["status"] != "pending":
        return p["status"] if p else "missing"
    vs = await db().votes(pid)
    eligible = await voters()
    yes = sum(1 for v in vs if v["vote"])
    no = sum(1 for v in vs if not v["vote"])
    if eligible:
        ids = {m["id"] for m in eligible}
        yes = sum(1 for v in vs if v["vote"] and v["user_id"] in ids)
        no = sum(1 for v in vs if not v["vote"] and v["user_id"] in ids)
        total = len(eligible)
        need = total // 2 + 1
        can_still = yes + (total - yes - no) >= need
    else:  # состав неизвестен: нужен хотя бы один коллега «за», любой «против» — отклоняет
        need, can_still = 2, no == 0
    if kg_team() and not p.get("grant_id"):
        return "pending"  # спонсор ещё не подписал разрешение: голосовать не о чем
    if yes >= need and kg_team():
        names = ", ".join(v["name"] for v in vs if v["vote"])
        return await _finish_with_grant(p, c, u, f"Голосование прошло ({yes} из {need} нужных: {names})")
    if yes >= need:
        await db().decide_proposal(pid, "approved", u["id"])
        proposer = await db().get_user(p["proposer_id"]) or {"id": p["proposer_id"]}
        await _apply(c, p["model"], proposer, {"limit_usd": p["limit_usd"], "limit_tokens": p["limit_tokens"],
                                               "days": p["days"], "until": p.get("until")})
        names = ", ".join(v["name"] for v in vs if v["vote"])
        await _note(c, f"Голосование прошло ({yes} из {need} нужных: {names}): чат переходит на {_title(p['model'])}, "
                       f"платит {p['proposer_name']}")
        return "approved"
    if not can_still:
        await db().decide_proposal(pid, "rejected", u["id"])
        await _note(c, f"Переход на {_title(p['model'])} отклонён голосованием")
        return "rejected"
    return "pending"


# ---- кластер: предложение модели с подписанным разрешением спонсора (keyguard) ----
async def _grant_members() -> list[str]:
    """Кого спонсор допускает к своему ключу: редакторы и владелец пространства (ники из состава control-plane)."""
    return sorted(m["id"] for m in (await voters() or []))


async def _propose_with_grant(c: dict, model: str, body: ProposalIn, u: dict) -> dict:
    """Шаг 1: предложение заведено, но ждёт подписи. Приложение подпишет разрешение (grant) с этим предложением
    и условиями и отдаст его в keyguard через control-plane; затем сообщит сюда id разрешения (шаг 2)."""
    members = await _grant_members()
    if u["id"] not in members:
        raise HTTPException(409, "Состав пространства ещё не получен — повторите через несколько секунд")
    if body.limit_usd is None:
        raise HTTPException(400, "В кластере лимит задаётся в долларах: расход считает keyguard")
    if body.model_policy and not await db().has_dialogue(c["id"]) and c.get("created_by") == u["id"]:
        await db().set_model_policy(c["id"], body.model_policy)
    p = await db().create_proposal(c["id"], model, u["id"], body.limit_usd, None, body.days, body.until,
                                   ttl=settings.proposal_ttl_seconds)
    provider, name = split_model(model)
    return {"applied": False, "need_grant": True, "proposal": await proposal_view(await db().proposal(p["id"]), u),
            "grant": {"space": settings.space_id, "chat": c["id"], "proposal": p["id"], "provider": provider, "model": name,
                      "members": members}}


async def _finish_with_grant(p: dict, c: dict, u: dict, why: str) -> str:
    """Утверждённое предложение вступает в силу: keyguard включает разрешение и отдаёт подписанные условия."""
    try:
        g = await kgc.grant_switch(p["grant_id"], True)
    except PermissionError as e:
        await db().decide_proposal(p["id"], "rejected", u["id"])
        await _note(c, f"Переход на {_title(p['model'])} не состоялся: разрешение спонсора не принято ({e})")
        return "rejected"
    except Exception:
        return "pending"  # keyguard недоступен — попытка повторится со следующим голосом или запросом
    provider, name = split_model(p["model"])
    # Спонсор подписал именно это: чат, предложение, модель — и он же автор предложения.
    if (g.get("chat"), g.get("proposal"), g.get("provider"), g.get("model"), g.get("sponsor")) != \
            (c["id"], p["id"], provider, name, p["proposer_id"]):
        try:
            await kgc.grant_switch(p["grant_id"], False)
        except Exception:
            pass
        await db().decide_proposal(p["id"], "rejected", u["id"])
        await _note(c, f"Переход на {_title(p['model'])} не состоялся: подписанное разрешение не соответствует предложению")
        return "rejected"
    old = c.get("grant_id")
    if old and old != p["grant_id"]:
        try:  # прежняя модель больше не действует: её разрешение снимаем (уменьшение прав подписи не требует)
            await kgc.grant_switch(old, False)
        except Exception:
            pass
    until = datetime.fromisoformat(g["until"].replace("Z", "+00:00")).timestamp() if g.get("until") else None
    await db().decide_proposal(p["id"], "approved", u["id"])
    await db().set_sponsor(c["id"], p["model"], p["proposer_id"], g.get("limit_usd"), None, None, until,
                           member_day=g.get("per_member_usd_day") or None)
    await db().set_conversation_grant(c["id"], p["grant_id"])
    await _note(c, f"{why}: чат переходит на {_title(p['model'])}, платит {p.get('proposer_name') or p['proposer_id']} "
                   f"({_terms(g.get('limit_usd'), None, None, until)})")
    return "approved"


class GrantIn(BaseModel):
    grant_id: str = Field(..., pattern="^g-[0-9a-f]{8,64}$")


@app.post("/api/model-proposals/{pid}/grant")
async def attach_grant(pid: str, body: GrantIn, u: dict = Me):
    """Шаг 2: спонсор подписал разрешение — предложение открыто для голосования (или вступает в силу сразу)."""
    if not kg_team():
        raise HTTPException(404)
    await expire_due()
    p = await db().proposal(pid)
    if not p or p["status"] != "pending":
        raise HTTPException(404, "Предложение не найдено, уже решено или истекло")
    if p["proposer_id"] != u["id"]:
        raise HTTPException(403, "Разрешение прикладывает автор предложения")
    if p.get("grant_id"):
        raise HTTPException(409, "Разрешение уже приложено")
    c = await conv_access(u, p["conversation_id"], "editor")
    await db().set_proposal_grant(pid, body.grant_id)
    p = await db().proposal(pid)
    hours = round(settings.proposal_ttl_seconds / 3600)
    # Чат, в котором ещё не было переписки, настраивает его создатель — без голосования.
    if not await db().has_dialogue(c["id"]) and c.get("created_by") == u["id"]:
        status = await _finish_with_grant(p, c, u, f"{u['display_name']} выбрал(а) модель нового чата")
    elif u.get("space_role") == "owner":  # владелец меняет модель на свою без голосования
        status = await _finish_with_grant(p, c, u, f"{u['display_name']} (владелец) сменил(а) модель")
    elif c.get("model_policy") == "open":
        status = await _finish_with_grant(p, c, u, f"{u['display_name']} сменил(а) модель")
    else:
        await _note(c, f"{u['display_name']} предлагает перейти на {_title(p['model'])} и оплачивает чат. Голосование {hours} ч")
        await broker().publish("model.proposal", c["project_id"], conversation_id=c["id"], proposal_id=pid,
                               by=u["display_name"], model=p["model"])
        status = await _tally(pid, c, u)  # если голосует только автор — решится сразу
    return {"ok": True, "status": status, "applied": status == "approved"}


class DecideIn(BaseModel):
    approve: bool


@app.post("/api/model-proposals/{pid}")
async def decide_proposal(pid: str, body: DecideIn, u: dict = Me):
    """Голос «за» или «против». Автор предложения голосом «против» отменяет его."""
    await expire_due()
    p = await db().proposal(pid)
    if not p or p["status"] != "pending":
        raise HTTPException(404, "Предложение не найдено, уже решено или истекло")
    c = await conv_access(u, p["conversation_id"], "editor")
    if p["proposer_id"] == u["id"]:
        if body.approve:
            raise HTTPException(403, "Ваш голос «за» уже учтён")
        await db().decide_proposal(pid, "cancelled", u["id"])
        await _note(c, f"{u['display_name']} отменил(а) предложение {_title(p['model'])}")
        return {"ok": True, "status": "cancelled"}
    run = agent().active_run(c["id"])
    if body.approve and run and run.status == "running":
        raise HTTPException(409, "Дождитесь окончания работы агента")
    await db().vote(pid, u["id"], body.approve)
    status = await _tally(pid, c, u)
    if status == "pending":
        await _note(c, f"{u['display_name']} голосует {'за' if body.approve else 'против'} {_title(p['model'])}")
    return {"ok": True, "status": status}


class PolicyIn(BaseModel):
    model_policy: str = Field(..., pattern="^(vote|open)$")


@app.patch("/api/conversations/{cid}/policy")
async def set_policy(cid: str, body: PolicyIn, u: dict = Me):
    """Правило смены модели меняет создатель чата или владелец пространства."""
    c = await conv_access(u, cid, "editor")
    if c.get("created_by") != u["id"] and u.get("space_role") != "owner":
        raise HTTPException(403, "Правило меняет создатель чата или владелец")
    await db().set_model_policy(cid, body.model_policy)
    await _note(c, f"{u['display_name']}: смена модели в этом чате — {POLICIES[body.model_policy]}")
    return {"ok": True}


class SponsorPatch(BaseModel):
    # передайте только то, что меняете; null — снять ограничение
    limit_usd: float | None = Field(None, gt=0, le=100000)
    limit_tokens: int | None = Field(None, ge=1000, le=10_000_000_000)
    days: float | None = Field(None, gt=0, le=365)  # срок считается от текущего момента
    until: float | None = None  # или конкретная дата окончания
    withdraw: bool = False


@app.patch("/api/conversations/{cid}/sponsor")
async def patch_sponsor(cid: str, body: SponsorPatch, u: dict = Me):
    c = await conv_access(u, cid, "editor")
    if c.get("sponsor_id") != u["id"]:
        raise HTTPException(403, "Это может только спонсор чата")
    if kg_team() and not body.withdraw:
        raise HTTPException(409, "Условия подписаны спонсором: чтобы изменить их, предложите модель заново")
    if body.withdraw:
        if kg_team() and c.get("grant_id"):
            try:  # отзыв с подписью спонсор отправляет в keyguard сам; здесь — снятие со стороны пространства
                await kgc.grant_switch(c["grant_id"], False)
            except Exception:
                pass
            await db().set_conversation_grant(cid, None)
        await db().set_sponsor(cid, c["model"], None, None)
        for r in list(agent().runs.values()):  # запуски на его ключе останавливаем
            if r.status == "running" and r.conversation_id == cid:
                await agent().cancel(r)
        await _note(c, f"{u['display_name']} больше не оплачивает этот чат — нужна новая модель")
    else:
        fs = body.model_fields_set
        upd: dict = {}
        if "limit_usd" in fs:
            upd["sponsor_limit_usd"] = body.limit_usd
        if "limit_tokens" in fs:
            upd["sponsor_limit_tokens"] = body.limit_tokens
        if "days" in fs:
            upd["sponsor_until"] = time.time() + body.days * 86400 if body.days else None
        if "until" in fs:
            _check_until(body.until)
            upd["sponsor_until"] = body.until
        if not upd:
            raise HTTPException(400, "Нечего менять")
        after = {"sponsor_limit_usd": c.get("sponsor_limit_usd"), "sponsor_limit_tokens": c.get("sponsor_limit_tokens"),
                 "sponsor_until": c.get("sponsor_until"), **upd}
        if all(v is None for v in after.values()):
            raise HTTPException(400, NEED_LIMIT)
        await db().set_sponsor_limits(cid, **upd)
        cur = await db().get_conversation(cid)
        await _note(c, f"{u['display_name']} изменил(а) условия оплаты: "
                       f"{_terms(cur.get('sponsor_limit_usd'), cur.get('sponsor_limit_tokens'), None, cur.get('sponsor_until'))}")
    return {"ok": True}


# ================================================================== ключи (только в памяти)
class KeysIn(BaseModel):
    keys: dict[str, str]


@app.post("/api/session/keys")
async def put_keys(body: KeysIn, u: dict = Me):
    """Телефон присылает расшифрованные ключи после Face ID. Хранятся только в RAM."""
    return {"providers": vault().put(u["id"], body.keys), "ttl": vault().ttl}


@app.get("/api/session/keys")
async def get_keys(u: dict = Me):
    return {"providers": vault().providers(u["id"])}


@app.delete("/api/session/keys")
async def wipe_keys(u: dict = Me):
    vault().wipe(u["id"])
    return {"ok": True}


# ================================================================== задания по расписанию
class ScheduleIn(BaseModel):
    title: str = Field(..., min_length=1, max_length=80)
    prompt: str = Field(..., min_length=1, max_length=8000)
    kind: str = Field(..., pattern="^(hourly|daily|weekly|once)$")
    at_time: str = Field("09:00", max_length=5)
    weekdays: list[int] = []
    tz: str = Field("UTC", max_length=64)
    run_at: float | None = None
    model: str | None = None
    enabled: bool = True
    # общее пространство: чат с действующим разрешением спонсора — в нём задание и выполняется
    conversation_id: str | None = Field(None, max_length=64)


class SchedulePatch(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=80)
    prompt: str | None = Field(None, min_length=1, max_length=8000)
    kind: str | None = Field(None, pattern="^(hourly|daily|weekly|once)$")
    at_time: str | None = Field(None, max_length=5)
    weekdays: list[int] | None = None
    tz: str | None = Field(None, max_length=64)
    run_at: float | None = None
    model: str | None = None
    enabled: bool | None = None


async def team_schedule_chat(pid: str, cid: str | None, u: dict) -> dict:
    """Общее пространство: модель оплачивает спонсор по разрешению на конкретный чат, поэтому задание выполняется
    в чате с действующим разрешением — от имени автора, в пределах лимитов спонсора (как если бы автор написал сам)."""
    if not cid:
        raise HTTPException(400, "В общем пространстве задание выполняется в чате с моделью спонсора — выберите чат")
    c = await conv_access(u, cid, "editor")
    if c["project_id"] != pid:
        raise HTTPException(400, "Чат из другого проекта")
    _, _, why = await sponsor_access(c)
    if why:
        raise HTTPException(409, why)
    return c


async def team_author(s: dict) -> dict | None:
    """Автор задания в общем пространстве — по составу от control-plane: исключённый или читатель не запускает."""
    for m in await db().roster():
        if m["id"] == s.get("created_by") and m["role"] in ("editor", "owner"):
            return m
    return None


def schedule_out(s: dict) -> dict:
    return {**s, "description": sched.describe(s)}


def _checked_schedule(s: dict) -> dict:
    try:
        sched.validate(s["kind"], s["at_time"], s["weekdays"], s["tz"], s.get("run_at"))
    except sched.ScheduleError as e:
        raise HTTPException(400, str(e))
    s["model"] = _check_model(s.get("model"))
    s["next_at"] = sched.next_run(s, time.time()) if s.get("enabled", True) else None
    if s["kind"] == "once" and s["next_at"] is None and s.get("enabled", True) and not s.get("last_run_at"):
        raise HTTPException(400, "Время разового задания уже прошло")
    return s


@app.get("/api/projects/{pid}/schedules")
async def list_schedules(pid: str, u: dict = Me):
    await need(u, pid)
    return [schedule_out(s) for s in await db().list_schedules(pid)]


@app.post("/api/projects/{pid}/schedules")
async def create_schedule(pid: str, body: ScheduleIn, u: dict = Me):
    await need(u, pid, "editor")
    if pid == TALK_PROJECT:
        raise HTTPException(400, "Задания по расписанию — в проектах инжиниринга")
    if await db().count_schedules(pid) >= sched.MAX_PER_PROJECT:
        raise HTTPException(409, f"В проекте не больше {sched.MAX_PER_PROJECT} заданий")
    s = {**body.model_dump(), "title": body.title.strip(), "prompt": body.prompt.strip()}
    if is_team():
        c = await team_schedule_chat(pid, body.conversation_id, u)
        s["model"] = c["model"]  # модель чата выбрал спонсор; у задания своей нет
    else:
        s["conversation_id"] = None  # в личном — свой чат задания («⏰ …»), создаётся при первом запуске
    s = _checked_schedule(s)
    out = await db().create_schedule(project_id=pid, created_by=u["id"], **s)
    await broker().publish("project", pid, action="updated")
    return schedule_out(out)


async def _schedule_for_edit(sid: str, u: dict) -> dict:
    s = await db().get_schedule(sid)
    if not s:
        raise HTTPException(404, "Задание не найдено")
    await need(u, s["project_id"], "editor")
    return s


@app.patch("/api/schedules/{sid}")
async def patch_schedule(sid: str, body: SchedulePatch, u: dict = Me):
    s = await _schedule_for_edit(sid, u)
    if is_team() and s.get("created_by") != u["id"] and u.get("space_role") != "owner":
        raise HTTPException(403, "Менять задание в общем пространстве может его автор или владелец")
    ch = body.model_dump(exclude_unset=True)
    merged = {**s, **{k: v for k, v in ch.items() if v is not None or k == "run_at"}}
    if s["kind"] == "once" and ("run_at" in ch or "kind" in ch):
        merged["last_run_at"] = None  # новое время разового задания — его можно выполнить ещё раз
    merged = _checked_schedule(merged)
    keys = ("title", "prompt", "kind", "at_time", "weekdays", "tz", "run_at", "model", "enabled", "next_at", "last_run_at")
    await db().update_schedule(sid, **{k: merged.get(k) for k in keys})
    await broker().publish("project", s["project_id"], action="updated")
    return schedule_out(await db().get_schedule(sid))


@app.delete("/api/schedules/{sid}")
async def delete_schedule(sid: str, u: dict = Me):
    s = await _schedule_for_edit(sid, u)
    await db().delete_schedule(sid)
    await broker().publish("project", s["project_id"], action="updated")
    return {"ok": True}


@app.post("/api/schedules/{sid}/run")
async def run_schedule_now(sid: str, u: dict = Me):
    """Выполнить задание сейчас (проверить, что оно делает); срок следующего запуска не меняется."""
    s = await _schedule_for_edit(sid, u)
    status = await fire_schedule(s)
    await db().update_schedule(sid, last_status=status[:300])
    out = await db().get_schedule(sid)
    if not status.startswith("запущено"):
        raise HTTPException(409, status)
    return schedule_out(out)


async def fire_schedule(s: dict) -> str:
    """Запуск задания: сообщение агенту в чат задания от имени автора. Возвращает итог для last_status."""
    if is_team():
        return await fire_team_schedule(s)
    u = await db().get_user(s["created_by"]) if s.get("created_by") else None
    if not u or u.get("disabled"):
        await db().update_schedule(s["id"], enabled=False, next_at=None)
        return "выключено: автора задания больше нет"
    if not await db().get_project(s["project_id"]):
        return "пропущено: проект удалён"
    u = dict(u)
    if settings.is_space:
        u["space_role"] = "owner"  # личное пространство: автор задания — его владелец
    model = s["model"] if s["model"] in settings.model_list else _check_model(None)
    keys = vault().get(u["id"])
    if not agent().llm_key(split_model(model)[0], keys):
        return f"пропущено: нет ключа для {split_model(model)[0]}"
    c = await db().get_conversation(s["conversation_id"]) if s.get("conversation_id") else None
    if not c or c["project_id"] != s["project_id"]:
        c = await db().create_conversation(model, s["project_id"], u["id"], f"⏰ {s['title']}"[:120])
        await db().update_schedule(s["id"], conversation_id=c["id"])
        await broker().publish("conversation", s["project_id"], action="created", conversation_id=c["id"], by=u["display_name"])
    if (r := agent().active_run(c["id"])) and r.status == "running":
        return "пропущено: в чате задания ещё идёт прошлый запуск"
    await db().add_message(c["id"], "user", s["prompt"],
                           meta={"author": f"⏰ {s['title']}", "author_id": u["id"], "schedule": s["id"]})
    await db().update_conversation(c["id"], model=model)
    await agent().start(c["id"], model, u, s["project_id"], keys, payer_id=u["id"])
    tz = sched.zone(s.get("tz") or "UTC")
    return "запущено " + datetime.now(tz).strftime("%d.%m %H:%M")


async def fire_team_schedule(s: dict) -> str:
    """Общее пространство: в чате задания, моделью и ключом спонсора (его разрешение и лимиты проверяет keyguard)."""
    m = await team_author(s)
    if not m:
        await db().update_schedule(s["id"], enabled=False, next_at=None)
        return "выключено: автор задания больше не редактор этого пространства"
    c = await db().get_conversation(s["conversation_id"]) if s.get("conversation_id") else None
    if not c or c["project_id"] != s["project_id"]:
        await db().update_schedule(s["id"], enabled=False, next_at=None)
        return "выключено: чата задания больше нет"
    llm_key, budget, why = await sponsor_access(c)
    if why:
        return f"пропущено: {why}"
    if (r := agent().active_run(c["id"])) and r.status == "running":
        return "пропущено: в чате задания ещё идёт другой запуск"
    u = dict(await db().get_user(m["id"]) or {"id": m["id"], "username": m["id"], "display_name": m["name"]})
    u["space_role"] = m["role"]
    await db().add_message(c["id"], "user", s["prompt"],
                           meta={"author": f"⏰ {s['title']} · {m['name']}", "author_id": m["id"], "schedule": s["id"]})
    await agent().start(c["id"], c["model"], u, s["project_id"], vault().get(m["id"]), llm_key=llm_key, budget=budget,
                        payer_id=c.get("sponsor_id"))
    tz = sched.zone(s.get("tz") or "UTC")
    return "запущено " + datetime.now(tz).strftime("%d.%m %H:%M")


# ================================================================== экспорт/импорт проекта (перенос в общий)
@app.get("/api/projects/{pid}/export")
async def export_project(pid: str, u: dict = Me):
    await need(u, pid, "editor")
    p = await db().get_project(pid)
    mems = await db().list_memories(pid, 5000)
    sk = []
    for s in skills().list():
        if "*" in p["skills"] or s["name"] in p["skills"]:
            full = skills().get(s["name"])
            sk.append({"name": full["name"], "description": full["description"], "body": full["body"]})
    return {"format": "fugu-deck-project/1", "name": p["name"], "description": p["description"],
            "instructions": p["instructions"], "skills": sk,
            "memories": [{"content": m["content"], "tags": m["tags"], "pinned": bool(m["pinned"])} for m in mems]}


class ImportIn(BaseModel):
    format: str
    name: str = Field(..., min_length=1, max_length=80)
    description: str = ""
    instructions: str = ""
    skills: list[dict] = []
    memories: list[dict] = []


@app.post("/api/projects/import")
async def import_project(body: ImportIn, u: dict = Me):
    if body.format != "fugu-deck-project/1":
        raise HTTPException(400, "Неизвестный формат")
    if settings.is_space and ROLES[u["space_role"]] < ROLES["editor"]:
        raise HTTPException(403, "Нужна роль редактора")
    p = await db().create_project(body.name, body.description, u)
    names = []
    can_write_skills = skills().writable and (not settings.is_space or u["space_role"] == "owner")
    for sk in body.skills[:50]:
        try:
            name = str(sk["name"])
            if can_write_skills and name not in {x["name"] for x in skills().list()}:
                skills().save(name, str(sk.get("description", ""))[:1024], str(sk.get("body", ""))[:150_000])
            names.append(name)
        except (SkillError, KeyError):
            continue
    await db().update_project(p["id"], instructions=body.instructions[:20000], skills=names or ["*"])
    for m in body.memories[:5000]:
        c = str(m.get("content", "")).strip()[:8000]
        if c:
            await db().add_memory(p["id"], c, str(m.get("tags", ""))[:200], "import", u["display_name"],
                                  pinned=bool(m.get("pinned")))
    await broker().publish("project", p["id"], action="created")
    return await db().get_project(p["id"])


# ================================================================== служебное для control-plane
class RevokeIn(BaseModel):
    token: str


app.include_router(backup.router(settings))


class RosterIn(BaseModel):
    token: str


@app.post("/internal/roster")
async def internal_roster(body: RosterIn):
    """Control-plane присылает состав участников (для голосования). Подписано ключом control-plane."""
    if not settings.is_space:
        raise HTTPException(404)
    cl = spaceauth.verify(body.token, settings, audience=f"space-internal:{settings.space_id}")
    if cl.get("action") != "roster" or not isinstance(cl.get("members"), list):
        raise HTTPException(400, "bad action")
    await db().set_roster([{"id": m["id"], "name": m["name"], "role": m["role"]} for m in cl["members"]
                           if m.get("role") in ("viewer", "editor", "owner")])
    await drop_departed_sponsors({m["id"] for m in cl["members"] if m.get("role") in ("editor", "owner")})
    return {"ok": True, "members": len(cl["members"])}


async def drop_departed_sponsors(payers: set[str]) -> None:
    """Спонсор больше не редактор пространства (исключён или стал читателем): его ключом не платим. keyguard отзывает
    его разрешения по сигналу control-plane; здесь — чат без модели и остановка запусков на его ключе."""
    for c in await db().sponsored_conversations():
        if c["sponsor_id"] in payers:
            continue
        if c.get("grant_id"):
            try:
                await kgc.grant_switch(c["grant_id"], False)
            except Exception:  # noqa: BLE001 — разрешение уже отозвано keyguard
                pass
            await db().set_conversation_grant(c["id"], None)
        await db().set_sponsor(c["id"], c["model"], None, None)
        for r in list(agent().runs.values()):
            if r.status == "running" and r.conversation_id == c["id"]:
                await agent().cancel(r)
        await _note(c, "Спонсор модели больше не участник пространства — нужна новая модель")


class OutboxIn(BaseModel):
    token: str


@app.post("/internal/outbox")
async def internal_outbox(body: OutboxIn):
    """Control-plane забирает очередь уведомлений (подписано ключом control-plane): события после after этого boot."""
    if not settings.is_space:
        raise HTTPException(404)
    cl = spaceauth.verify(body.token, settings, audience=f"space-internal:{settings.space_id}")
    if cl.get("action") != "outbox":
        raise HTTPException(400, "bad action")
    after = cl.get("after") if cl.get("boot") == outbox.boot and isinstance(cl.get("after"), int) else 0
    return {"boot": outbox.boot, "events": outbox.since(after)}


@app.post("/internal/revoke")
async def internal_revoke(body: RevokeIn):
    """Control-plane сообщает: участника удалили из пространства. Подписано ключом control-plane."""
    if not settings.is_space:
        raise HTTPException(404)
    cl = spaceauth.verify(body.token, settings, audience=f"space-internal:{settings.space_id}")
    if cl.get("action") != "revoke" or not cl.get("user_id"):
        raise HTTPException(400, "bad action")
    uid = cl["user_id"]
    spaceauth.revoke(uid)
    vault().wipe(uid)
    broker().kick(uid)
    for r in list(agent().runs.values()):  # его запуски останавливаем
        if r.status == "running" and r.user.get("id") == uid:
            await agent().cancel(r)
    return {"ok": True}


# ================================================================== realtime
@app.get("/api/events")
async def event_stream(request: Request, device_id: str = "", u: dict = Me):
    device_id = device_id[:64] or new_id()
    sub = broker().subscribe(u["id"], device_id)

    async def gen():
        try:
            yield "retry: 2000\n\n"
            yield f"data: {json.dumps({'type': 'hello', 'device_id': device_id})}\n\n"
            while True:
                if await request.is_disconnected():
                    return
                try:
                    ev = await asyncio.wait_for(sub.queue.get(), 20)
                    yield f"data: {json.dumps(ev, ensure_ascii=False, default=str)}\n\n"
                    if sub.kicked:
                        return
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            await broker().unsubscribe(sub)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class PresenceIn(BaseModel):
    device_id: str = Field(..., max_length=64)
    project_id: str | None = None
    conversation_id: str | None = None


@app.post("/api/presence")
async def presence(body: PresenceIn, u: dict = Me):
    if body.project_id:
        await need(u, body.project_id)
    await broker().set_presence(u, body.device_id, body.project_id, body.conversation_id)
    return {"online": broker().project_presence(body.project_id) if body.project_id else []}
