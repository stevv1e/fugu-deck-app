"""Control-plane Fugu Deck: вход по passkey, пространства, общие проекты, приглашения, токены."""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
from webauthn import (generate_authentication_options, generate_registration_options, options_to_json,
                      verify_authentication_response, verify_registration_response)
from webauthn.helpers import bytes_to_base64url
from webauthn.helpers.structs import (AuthenticatorSelectionCriteria,
                                      ResidentKeyRequirement, UserVerificationRequirement)

from . import reaper
from .config import get_settings
from .db import DB, ROLES, new_id
from .events import Notifier
from .keys import Keys
from .orchestrator import make_orchestrator

log = logging.getLogger("cp")
settings = get_settings()
S: dict = {}
COOKIE = "cp_session"
NICK_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{2,23}$")
CHALLENGE_TTL = 300
_challenges: dict[str, tuple[bytes, float, dict]] = {}


def db() -> DB:
    return S["db"]


def keys() -> Keys:
    return S["keys"]


def orch():
    return S["orch"]


def notifier() -> Notifier:
    return S["notifier"]


async def revoke_in_space(orchestrator, k: Keys, space: dict, uid: str) -> None:
    """Мгновенно отключить участника в пространстве: токены, потоки, ключи в памяти, запуски."""
    url = orchestrator.internal_url(space)
    if not url:
        return
    try:
        async with httpx.AsyncClient(timeout=5, trust_env=False) as c:
            await c.post(f"{url}/internal/revoke", json={"token": k.internal_token(space["id"], "revoke", user_id=uid)})
    except httpx.HTTPError as e:
        log.warning("revoke in %s failed: %s", space["id"], e)


async def sync_roster(space: dict) -> None:
    """Отправить пространству актуальный состав участников (нужен для голосования за смену модели)."""
    if space.get("kind") != "team":
        return
    url = orch().internal_url(space)
    if not url:
        return
    members = [{"id": m["id"], "name": m["display_name"], "role": m["role"]} for m in await db().members(space["id"])]
    tok = keys().internal_token(space["id"], "roster", members=members)
    try:
        async with httpx.AsyncClient(timeout=5, trust_env=False) as c:
            await c.post(f"{url}/internal/roster", json={"token": tok})
    except httpx.HTTPError as e:
        log.warning("roster sync %s failed: %s", space["id"], e)


def sync_later(space: dict) -> None:
    asyncio.create_task(sync_roster(space))


async def _reaper_loop():
    while True:
        await asyncio.sleep(settings.reaper_interval)
        try:
            await reaper.run_once(db(), orch(), notifier(), settings,
                                  lambda sp, uid: revoke_in_space(orch(), keys(), sp, uid), on_change=sync_roster)
        except Exception:
            log.exception("reaper failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    d = DB(str(settings.db_path))
    await d.connect()
    k = Keys(settings.data_dir)
    S.update(db=d, keys=k, orch=make_orchestrator(settings, k), notifier=Notifier(),
             http=httpx.AsyncClient(timeout=None, trust_env=False))
    if settings.orchestrator == "kubernetes":  # при старте приводим все пространства к актуальной версии
        for sp in await d.all_spaces():
            with contextlib.suppress(Exception):
                await orch().ensure(sp)
    task = asyncio.create_task(_reaper_loop())
    yield
    task.cancel()
    await S["http"].aclose()
    await orch().close()
    await d.close()


app = FastAPI(title="Fugu Deck control-plane", lifespan=lifespan, docs_url=None, redoc_url=None)


# ================================================================== сессия
async def me(request: Request) -> dict:
    tok = request.cookies.get(COOKIE)
    uid = keys().read_session(tok) if tok else None
    u = await db().user(uid) if uid else None
    if not u:
        raise HTTPException(401, "Нужен вход")
    await db().touch(u["id"])
    return u


Me = Depends(me)


def set_session(response: Response, uid: str):
    response.set_cookie(COOKIE, keys().session(uid, settings.session_hours), max_age=int(settings.session_hours * 3600),
                        httponly=True, secure=settings.cookie_secure, samesite="strict", path="/")


def pub(u: dict) -> dict:
    return {"id": u["id"], "nick": u["nick"], "display_name": u["display_name"], "is_admin": bool(u["is_admin"])}


def _challenge(data: dict) -> tuple[str, bytes]:
    now = time.time()
    for k, (_, t, _) in list(_challenges.items()):
        if now - t > CHALLENGE_TTL:
            _challenges.pop(k, None)
    sid, ch = secrets.token_urlsafe(16), secrets.token_bytes(32)
    _challenges[sid] = (ch, now, data)
    return sid, ch


def _take(sid: str) -> tuple[bytes, dict]:
    item = _challenges.pop(sid, None)
    if not item or time.time() - item[1] > CHALLENGE_TTL:
        raise HTTPException(400, "Запрос устарел, попробуйте ещё раз")
    return item[0], item[2]


async def ensure_personal(u: dict) -> dict:
    sp = await db().personal_space(u["id"])
    if not sp:
        sp = await db().create_space("personal", "Личное", u["id"])
    status = await orch().ensure(sp)
    await db().set_space_status(sp["id"], status)
    return await db().space(sp["id"])


# ================================================================== информация
@app.get("/cp/api/health")
async def health():
    return {"ok": True}


@app.get("/cp/api/info")
async def info():
    return {"rp_id": settings.rp_id, "bootstrap": await db().count_users() == 0,
            "test_mode": settings.test_mode, "orchestrator": orch().kind}


# ================================================================== регистрация по passkey
class RegOptionsIn(BaseModel):
    invite_code: str
    nick: str
    display_name: str = Field(..., min_length=1, max_length=40)


@app.post("/cp/api/register/options")
async def register_options(body: RegOptionsIn):
    nick = body.nick.strip().lower()
    if not NICK_RE.match(nick):
        raise HTTPException(400, "Ник: 3–24 символа, латиница, цифры, точка, дефис, подчёркивание")
    first = await db().count_users() == 0
    code_ok = (first and settings.bootstrap_code and secrets.compare_digest(body.invite_code.strip(), settings.bootstrap_code)) \
        or await db().code_valid(body.invite_code)
    if not code_ok:
        raise HTTPException(403, "Неверный или использованный код приглашения")
    if await db().user_by_nick(nick):
        raise HTTPException(409, "Этот ник занят")
    uid = new_id(16)
    sid, ch = _challenge({"uid": uid, "nick": nick, "display_name": body.display_name.strip(),
                          "code": body.invite_code.strip(), "first": first})
    opts = generate_registration_options(
        rp_id=settings.rp_id, rp_name=settings.rp_name, user_name=nick, user_id=uid.encode(),
        user_display_name=body.display_name.strip(), challenge=ch,
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.REQUIRED, user_verification=UserVerificationRequirement.REQUIRED))
    return {"session_id": sid, "options": json.loads(options_to_json(opts))}


class VerifyIn(BaseModel):
    session_id: str
    credential: dict


@app.post("/cp/api/register/verify")
async def register_verify(body: VerifyIn, response: Response):
    ch, data = _take(body.session_id)
    try:
        v = verify_registration_response(credential=body.credential, expected_challenge=ch,
                                         expected_rp_id=settings.rp_id, expected_origin=settings.origin,
                                         require_user_verification=True)
    except Exception as e:
        raise HTTPException(400, f"Passkey не прошёл проверку: {e}")
    if await db().user_by_nick(data["nick"]):
        raise HTTPException(409, "Этот ник занят")
    if not data["first"] and not await db().code_valid(data["code"]):
        raise HTTPException(403, "Код приглашения уже использован")
    u = await db().create_user(data["uid"], data["nick"], data["display_name"], is_admin=data["first"])
    if not data["first"]:
        await db().use_code(data["code"], u["id"])
    await db().add_credential(bytes_to_base64url(v.credential_id), u["id"], v.credential_public_key, v.sign_count,
                              body.credential.get("response", {}).get("transports"))
    await db().audit(u["id"], "register", u["nick"])
    set_session(response, u["id"])
    sp = await ensure_personal(u)
    return {"user": pub(u), "personal_space": sp["id"]}


# ================================================================== вход по passkey
@app.post("/cp/api/login/options")
async def login_options():
    sid, ch = _challenge({})
    opts = generate_authentication_options(rp_id=settings.rp_id, challenge=ch,
                                           user_verification=UserVerificationRequirement.REQUIRED)
    return {"session_id": sid, "options": json.loads(options_to_json(opts))}


@app.post("/cp/api/login/verify")
async def login_verify(body: VerifyIn, response: Response):
    ch, _ = _take(body.session_id)
    cred = await db().credential(body.credential.get("id", ""))
    if not cred:
        raise HTTPException(401, "Этот passkey не зарегистрирован")
    try:
        v = verify_authentication_response(credential=body.credential, expected_challenge=ch,
                                           expected_rp_id=settings.rp_id, expected_origin=settings.origin,
                                           credential_public_key=cred["public_key"],
                                           credential_current_sign_count=cred["sign_count"],
                                           require_user_verification=True)
    except Exception as e:
        raise HTTPException(401, f"Passkey не прошёл проверку: {e}")
    await db().bump_credential(cred["id"], v.new_sign_count)
    u = await db().user(cred["user_id"])
    await db().touch(u["id"])
    set_session(response, u["id"])
    await ensure_personal(u)
    return {"user": pub(u)}


class TestLoginIn(BaseModel):
    nick: str
    display_name: str = ""
    admin: bool = False


@app.post("/cp/api/test/login")
async def test_login(body: TestLoginIn, response: Response):
    """Вход без passkey для автотестов. Работает только при CP_TEST_MODE=true."""
    if not settings.test_mode:
        raise HTTPException(404)
    u = await db().user_by_nick(body.nick)
    if not u:
        u = await db().create_user(new_id(16), body.nick, body.display_name or body.nick, body.admin)
    await db().touch(u["id"])
    set_session(response, u["id"])
    await ensure_personal(u)
    return {"user": pub(u)}


@app.post("/cp/api/logout")
async def logout(response: Response):
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


# ================================================================== профиль, пространства
async def _space_view(sp: dict, u: dict) -> dict:
    return {"id": sp["id"], "kind": sp["kind"], "name": sp["name"], "role": sp.get("role"),
            "members": sp.get("members", 1), "status": sp["status"], "base": f"/s/{sp['id']}"}


@app.get("/cp/api/me")
async def get_me(u: dict = Me):
    if not await db().personal_space(u["id"]):  # вернулся после удаления по неактивности — пустое пространство
        await ensure_personal(u)
    spaces = [await _space_view(s, u) for s in await db().spaces_of(u["id"])]
    return {"user": pub(u), "spaces": spaces, "invites": await db().invites_for(u["id"]),
            "notifications": [n for n in await db().notifications(u["id"]) if not n["read"]],
            "purge_after_hours": settings.purge_after_hours}


class MePatch(BaseModel):
    display_name: str = Field(..., min_length=1, max_length=40)


@app.patch("/cp/api/me")
async def patch_me(body: MePatch, u: dict = Me):
    await db().exec("UPDATE users SET display_name=? WHERE id=?", (body.display_name.strip(), u["id"]))
    return {"ok": True}


@app.post("/cp/api/notifications/read")
async def read_notifications(u: dict = Me):
    await db().mark_read(u["id"])
    return {"ok": True}


async def _need(u: dict, sid: str, min_role: str = "viewer") -> tuple[dict, str]:
    sp = await db().space(sid)
    role = await db().role(sid, u["id"]) if sp else None
    if not sp or not role:
        raise HTTPException(404, "Пространство не найдено")
    if ROLES[role] < ROLES[min_role]:
        raise HTTPException(403, "Недостаточно прав")
    return sp, role


@app.post("/cp/api/spaces/{sid}/token")
async def space_token(sid: str, u: dict = Me):
    """Короткоживущий пропуск в пространство. Роль берётся из членства на момент выдачи."""
    sp, role = await _need(u, sid)
    status = await orch().status(sp)
    if status != "ready":
        status = await orch().ensure(sp)
        await db().set_space_status(sid, status)
    tok = keys().space_token(sid, u, role, settings.space_token_ttl)
    if sp["kind"] == "team":
        await sync_roster(sp)
    return {"token": tok, "expires_in": settings.space_token_ttl, "base": f"/s/{sid}", "role": role, "status": status}


class TeamIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=60)


@app.post("/cp/api/spaces")
async def create_team(body: TeamIn, u: dict = Me):
    teams = [s for s in await db().spaces_of(u["id"]) if s["kind"] == "team" and s["role"] == "owner"]
    if len(teams) >= 10:
        raise HTTPException(400, "Не больше 10 общих проектов на владельца")
    sp = await db().create_space("team", body.name.strip(), u["id"])
    status = await orch().ensure(sp)
    await db().set_space_status(sp["id"], status)
    await db().audit(u["id"], "team.create", sp["id"])
    return await _space_view({**(await db().space(sp["id"])), "role": "owner"}, u)


@app.get("/cp/api/spaces/{sid}")
async def get_space(sid: str, u: dict = Me):
    sp, role = await _need(u, sid)
    out = await _space_view({**sp, "role": role}, u)
    out["members_list"] = [{"id": m["id"], "nick": m["nick"], "display_name": m["display_name"], "role": m["role"]}
                           for m in await db().members(sid)]
    if role == "owner":
        out["pending"] = await db().pending_invites(sid)
    return out


@app.patch("/cp/api/spaces/{sid}")
async def rename_space(sid: str, body: TeamIn, u: dict = Me):
    sp, _ = await _need(u, sid, "owner")
    if sp["kind"] != "team":
        raise HTTPException(400, "Личное пространство не переименовывается")
    await db().rename_space(sid, body.name.strip())
    for m in await db().members(sid):
        notifier().send(m["id"], {"type": "spaces"})
    return {"ok": True}


@app.delete("/cp/api/spaces/{sid}")
async def delete_space(sid: str, u: dict = Me):
    sp, _ = await _need(u, sid, "owner")
    if sp["kind"] != "team":
        raise HTTPException(400, "Личное пространство удаляется только правилом неактивности")
    members = await db().members(sid)
    await orch().delete(sp)
    await db().delete_space(sid)
    await db().audit(u["id"], "team.delete", sid)
    for m in members:
        notifier().send(m["id"], {"type": "spaces"})
    return {"ok": True}


# ================================================================== участники и приглашения
@app.get("/cp/api/users/search")
async def search_users(q: str = "", u: dict = Me):
    q = q.strip().lower()
    if len(q) < 3:
        return []  # не даём пролистать список всех пользователей
    return await db().search_users(q, u["id"], 5)


class InviteIn(BaseModel):
    nick: str
    role: str = Field("editor", pattern="^(viewer|editor|owner)$")


@app.post("/cp/api/spaces/{sid}/invites")
async def invite(sid: str, body: InviteIn, u: dict = Me):
    sp, _ = await _need(u, sid, "owner")
    if sp["kind"] != "team":
        raise HTTPException(400, "Приглашать можно только в общий проект")
    target = await db().user_by_nick(body.nick.strip().lower())
    if not target or target["id"] == u["id"]:
        raise HTTPException(404, "Пользователь не найден")
    if await db().role(sid, target["id"]):
        raise HTTPException(409, "Уже участник")
    inv = await db().create_invite(sid, u["id"], target["id"], body.role)
    await db().notify(target["id"], "invite", {"space_name": sp["name"], "from": u["display_name"], "role": body.role})
    notifier().send(target["id"], {"type": "invite", "space_name": sp["name"], "from": u["display_name"]})
    await db().audit(u["id"], "invite", f"{sid} → {target['nick']} ({body.role})")
    return {"id": inv["id"], "nick": target["nick"], "role": body.role}


@app.get("/cp/api/invites")
async def my_invites(u: dict = Me):
    return await db().invites_for(u["id"])


@app.post("/cp/api/invites/{iid}/{action}")
async def answer_invite(iid: str, action: str, u: dict = Me):
    inv = await db().invite(iid)
    if not inv or inv["to_user"] != u["id"] or inv["status"] != "pending":
        raise HTTPException(404, "Приглашение не найдено")
    if action not in ("accept", "decline"):
        raise HTTPException(400, "accept | decline")
    sp = await db().space(inv["space_id"])
    if not sp:
        raise HTTPException(404, "Проект уже удалён")
    await db().set_invite(iid, "accepted" if action == "accept" else "declined")
    if action == "accept":
        await db().add_member(sp["id"], u["id"], inv["role"])
        await db().audit(u["id"], "invite.accept", sp["id"])
        sync_later(sp)
    for m in await db().members(sp["id"]):
        notifier().send(m["id"], {"type": "members", "space_id": sp["id"]})
    notifier().send(inv["from_user"], {"type": "members", "space_id": sp["id"]})
    return {"ok": True, "space_id": sp["id"] if action == "accept" else None}


@app.delete("/cp/api/spaces/{sid}/invites/{iid}")
async def cancel_invite(sid: str, iid: str, u: dict = Me):
    await _need(u, sid, "owner")
    inv = await db().invite(iid)
    if inv and inv["space_id"] == sid and inv["status"] == "pending":
        await db().set_invite(iid, "cancelled")
    return {"ok": True}


class RoleIn(BaseModel):
    role: str = Field(..., pattern="^(viewer|editor|owner)$")


@app.patch("/cp/api/spaces/{sid}/members/{uid}")
async def change_role(sid: str, uid: str, body: RoleIn, u: dict = Me):
    sp, _ = await _need(u, sid, "owner")
    if sp["kind"] != "team" or not await db().role(sid, uid):
        raise HTTPException(404, "Участник не найден")
    if uid == u["id"] and body.role != "owner":
        owners = [m for m in await db().members(sid) if m["role"] == "owner"]
        if len(owners) < 2:
            raise HTTPException(400, "Сначала назначьте другого владельца")
    await db().set_role(sid, uid, body.role)
    await revoke_in_space(orch(), keys(), sp, uid)
    await sync_roster(sp)  # старые токены с прежней ролью — недействительны
    notifier().send(uid, {"type": "role", "space_id": sid, "role": body.role})
    return {"ok": True}


@app.delete("/cp/api/spaces/{sid}/members/{uid}")
async def remove_member(sid: str, uid: str, u: dict = Me):
    sp, role = await _need(u, sid)
    if sp["kind"] != "team":
        raise HTTPException(400, "Нельзя")
    if uid != u["id"] and role != "owner":
        raise HTTPException(403, "Удалять участников может владелец")
    target_role = await db().role(sid, uid)
    if not target_role:
        raise HTTPException(404, "Участник не найден")
    rest = [m for m in await db().members(sid) if m["id"] != uid]
    if target_role == "owner" and rest and not any(m["role"] == "owner" for m in rest):
        raise HTTPException(400, "Сначала назначьте другого владельца")
    await db().remove_member(sid, uid)
    await revoke_in_space(orch(), keys(), sp, uid)
    await db().audit(u["id"], "member.remove", f"{sid} {uid}")
    if rest:
        await sync_roster(sp)
    notifier().send(uid, {"type": "removed", "space_id": sid, "space_name": sp["name"]})
    if not rest:
        await orch().delete(sp)
        await db().delete_space(sid)
    for m in rest:
        notifier().send(m["id"], {"type": "members", "space_id": sid})
    return {"ok": True}


# ================================================================== админ: коды приглашения в сервис
def admin(u: dict):
    if not u["is_admin"]:
        raise HTTPException(403, "Только для администратора")


@app.post("/cp/api/admin/codes")
async def new_code(u: dict = Me):
    admin(u)
    return {"code": await db().create_code(u["id"])}


@app.get("/cp/api/admin/codes")
async def list_codes(u: dict = Me):
    admin(u)
    return await db().list_codes()


@app.get("/cp/api/admin/users")
async def admin_users(u: dict = Me):
    admin(u)
    return await db().all("SELECT id,nick,display_name,is_admin,created_at,last_seen,purged_at FROM users ORDER BY nick")


@app.post("/cp/api/admin/reaper")
async def run_reaper(u: dict = Me):
    admin(u)
    return await reaper.run_once(db(), orch(), notifier(), settings,
                                 lambda sp, uid: revoke_in_space(orch(), keys(), sp, uid), on_change=sync_roster)


# ================================================================== личные уведомления (SSE)
@app.get("/cp/api/events")
async def events(request: Request, u: dict = Me):
    q = notifier().subscribe(u["id"])

    async def gen():
        try:
            yield "retry: 3000\n\n"
            while True:
                if await request.is_disconnected():
                    return
                try:
                    ev = await asyncio.wait_for(q.get(), 20)
                    yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            notifier().unsubscribe(u["id"], q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ================================================================== локальный режим: прокси в пространства
if settings.orchestrator == "local":
    HOP = {"host", "content-length", "connection", "keep-alive", "transfer-encoding", "te", "upgrade",
           "proxy-authorization", "proxy-authenticate", "trailer", "cookie"}

    @app.api_route("/s/{sid}/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    async def space_proxy(sid: str, path: str, request: Request):
        """В кластере это делает Traefik; здесь — для разработки. Cookie control-plane в пространство не уходят."""
        sp = await db().space(sid)
        if not sp:
            raise HTTPException(404, "Пространство не найдено")
        if await orch().status(sp) != "ready":
            await orch().ensure(sp)
        url = f"{orch().internal_url(sp)}/{path}"
        headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP}
        req = S["http"].build_request(request.method, url, params=request.query_params, headers=headers,
                                      content=await request.body())
        resp = await S["http"].send(req, stream=True)
        out_headers = {k: v for k, v in resp.headers.items() if k.lower() not in HOP | {"content-encoding"}}

        async def body():
            try:
                async for chunk in resp.aiter_raw():
                    yield chunk
            finally:
                await resp.aclose()

        return StreamingResponse(body(), status_code=resp.status_code, headers=out_headers)


# ================================================================== PWA
if settings.static_dir and Path(settings.static_dir).exists():
    _static = Path(settings.static_dir).resolve()

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str):
        if path.startswith(("cp/api", "s/")):
            raise HTTPException(404)
        f = (_static / path).resolve()
        if path and f.is_file() and _static in f.parents:
            return FileResponse(f)
        return FileResponse(_static / "index.html")
