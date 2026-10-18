"""Общий чат в кластере: предложение модели → подписанное разрешение спонсора → голосование → keyguard.

Запускается отдельным процессом (tests/test_team_kg.py): режим пространства задаётся переменными окружения до
импорта приложения. keyguard здесь — маленький HTTP-сервер, который ведёт себя как настоящий в части разрешений:
включает и снимает их и отдаёт условия, «подписанные спонсором».
"""
import json
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

SPACE = "t-shop000001"
GRANTS: dict[str, dict] = {}   # id -> условия, как их подписал спонсор
CALLS: list[tuple[str, str]] = []  # (activate|deactivate, id)
LLM: list[tuple[str, str]] = []  # (чат, участник) — запросы к модели, которые keyguard пропустил


class KG(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        if self.path.startswith("/llm/"):
            return self.llm(body)
        op = self.path.rsplit("/", 1)[-1]
        g = GRANTS.get(body.get("grant_id"))
        if self.headers.get("Authorization") != "Bearer space-token" or op not in ("activate", "deactivate") or not g or g.get("revoked"):
            self.send_response(403); self.end_headers(); self.wfile.write(b'{"error":"\\u043d\\u0435\\u0442"}'); return
        g["active"] = op == "activate"
        CALLS.append((op, g["id"]))
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(json.dumps({"ok": True, "grant": g}).encode())

    def llm(self, body: dict):
        # как настоящий keyguard: действующее разрешение на чат и модель, участник — в списке допущенных спонсором
        chat, member = self.headers.get("X-Deck-Chat"), self.headers.get("X-Deck-Member")
        g = next((g for g in GRANTS.values() if g["active"] and g["chat"] == chat and g["model"] == body.get("model")), None)
        if not g or member not in g["members"]:
            self.send_response(403); self.send_header("Content-Type", "application/json"); self.end_headers()
            self.wfile.write(json.dumps({"error": "участник не допущен спонсором"}).encode()); return
        LLM.append((chat, member))
        self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.end_headers()
        for d in ({"role": "assistant", "content": "Готово"}, {}):
            ch = {"id": "x", "object": "chat.completion.chunk", "created": 0, "model": body["model"],
                  "choices": [{"index": 0, "delta": d, "finish_reason": None if d else "stop"}]}
            self.wfile.write(f"data: {json.dumps(ch)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")


kg = HTTPServer(("127.0.0.1", 0), KG)
threading.Thread(target=kg.serve_forever, daemon=True).start()

tmp = Path(tempfile.mkdtemp())
(tmp / "token").write_text("space-token\n")
key = ec.generate_private_key(ec.SECP256R1())
os.environ.update({
    "DECK_MODE": "space", "SPACE_KIND": "team", "SPACE_ID": SPACE, "SPACE_NAME": "Магазин", "DATA_DIR": str(tmp / "data"),
    "KEYGUARD_URL": f"http://127.0.0.1:{kg.server_port}", "KEYGUARD_TOKEN_PATH": str(tmp / "token"),
    "CP_PUBLIC_KEY": key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode(),
})
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402

MAX, ULTRA = "sakana:fugu-max-v1.0", "sakana:fugu-ultra-v2.0"


def tok(claims: dict) -> str:
    now = int(time.time())
    return jwt.encode({"iss": "deck-control-plane", "iat": now, "exp": now + 600, **claims}, key, algorithm="ES256")


def user(nick: str, role: str) -> dict:
    return {"Authorization": "Bearer " + tok({"aud": f"space:{SPACE}", "sub": nick, "nick": nick, "name": nick, "role": role})}


def grant(gid: str, chat: str, proposal: str, model: str, sponsor: str, **over) -> None:
    GRANTS[gid] = {"id": gid, "chat": chat, "proposal": proposal, "provider": "sakana", "model": model.split(":")[1],
                   "sponsor": sponsor, "limit_usd": 20.0, "per_member_usd_day": 5.0, "members": ["anna", "bob"],
                   "until": "2027-01-01T00:00:00Z", "key_until": "2027-01-01T00:00:00Z", "active": False, **over}


with TestClient(main.app) as c:
    anna, bob, carol = user("anna", "owner"), user("bob", "editor"), user("carol", "viewer")
    pid = c.get("/api/projects", headers=anna).json()[0]["id"]
    chat = c.post(f"/api/projects/{pid}/conversations", headers=anna, json={}).json()["id"]

    # Пока control-plane не прислал состав, подписывать нечего: список допущенных неизвестен.
    r = c.post(f"/api/conversations/{chat}/model", headers=anna, json={"model": MAX, "limit_usd": 20, "days": 7})
    assert r.status_code == 409, r.text
    roster = tok({"aud": f"space-internal:{SPACE}", "sub": "control-plane", "action": "roster", "members": [
        {"id": "anna", "name": "anna", "role": "owner"}, {"id": "bob", "name": "bob", "role": "editor"},
        {"id": "carol", "name": "carol", "role": "viewer"}]})
    assert c.post("/internal/roster", json={"token": roster}).status_code == 200
    assert c.post("/internal/roster", json={"token": tok({"aud": f"space:{SPACE}", "sub": "anna", "action": "roster", "members": []})}).status_code == 401

    # 1. Новый чат: создатель выбирает модель. Без подписанного разрешения ничего не применяется.
    assert c.post(f"/api/conversations/{chat}/model", headers=anna, json={"model": MAX, "limit_tokens": 100000}).status_code == 400
    r = c.post(f"/api/conversations/{chat}/model", headers=anna, json={"model": MAX, "limit_usd": 20, "days": 7}).json()
    assert r["applied"] is False and r["need_grant"] is True, r
    g = r["grant"]
    assert g == {"space": SPACE, "chat": chat, "proposal": r["proposal"]["id"], "provider": "sakana", "model": "fugu-max-v1.0",
                 "members": ["anna", "bob"]}, g  # читатель в список допущенных не попадает
    p1 = g["proposal"]
    assert c.get(f"/api/conversations/{chat}", headers=anna).json()["sponsor"] is None
    # разрешение прикладывает только автор; неизвестное keyguard разрешение не принимается
    assert c.post(f"/api/model-proposals/{p1}/grant", headers=bob, json={"grant_id": "g-00000001"}).status_code == 403
    assert c.post(f"/api/model-proposals/{p1}/grant", headers=anna, json={"grant_id": "nope"}).status_code == 422
    r = c.post(f"/api/model-proposals/{p1}/grant", headers=anna, json={"grant_id": "g-0000dead"}).json()
    assert r["status"] == "rejected" and c.get(f"/api/conversations/{chat}", headers=anna).json()["sponsor"] is None, r

    r = c.post(f"/api/conversations/{chat}/model", headers=anna, json={"model": MAX, "limit_usd": 20, "days": 7}).json()
    p1 = r["proposal"]["id"]
    grant("g-000000a1", chat, p1, MAX, "anna")
    r = c.post(f"/api/model-proposals/{p1}/grant", headers=anna, json={"grant_id": "g-000000a1"}).json()
    assert r["applied"] is True and CALLS[-1] == ("activate", "g-000000a1"), (r, CALLS)
    conv = c.get(f"/api/conversations/{chat}", headers=bob).json()
    assert conv["model"] == MAX and conv["sponsor"]["id"] == "anna" and conv["sponsor"]["limit_usd"] == 20.0 \
        and conv["sponsor"]["grant_id"] == "g-000000a1" and conv["sponsor"]["online"] is True \
        and conv["sponsor"]["proposal_id"] == p1, conv
    # условия подписаны: менять их правкой нельзя — только новым предложением
    assert c.patch(f"/api/conversations/{chat}/sponsor", headers=anna, json={"limit_usd": 500}).status_code == 409

    # 2. Боб предлагает другую модель: до его подписи голосование не идёт, после — нужно большинство.
    assert c.post(f"/api/conversations/{chat}/model", headers=carol, json={"model": ULTRA, "limit_usd": 5, "days": 1}).status_code == 403
    r = c.post(f"/api/conversations/{chat}/model", headers=bob, json={"model": ULTRA, "limit_usd": 50, "days": 3}).json()
    p2 = r["proposal"]["id"]
    assert c.post(f"/api/model-proposals/{p2}", headers=anna, json={"approve": True}).json()["status"] == "pending"
    assert c.get(f"/api/conversations/{chat}", headers=anna).json()["model"] == MAX, "голос без подписи спонсора ничего не меняет"

    # подписано не то, что предложено (другая модель) — отклоняется, и разрешение снимается
    grant("g-000000b0", chat, p2, MAX, "bob")
    r = c.post(f"/api/model-proposals/{p2}/grant", headers=bob, json={"grant_id": "g-000000b0"}).json()
    assert r["status"] == "rejected" and CALLS[-1] == ("deactivate", "g-000000b0"), (r, CALLS)
    assert c.get(f"/api/conversations/{chat}", headers=anna).json()["model"] == MAX

    # разрешение, подписанное не автором предложения, — тоже
    r = c.post(f"/api/conversations/{chat}/model", headers=bob, json={"model": ULTRA, "limit_usd": 50, "days": 3}).json()
    p3 = r["proposal"]["id"]
    grant("g-000000b1", chat, p3, ULTRA, "mallory")
    # условия разрешения пространство узнаёт от keyguard при включении — подмена вскрывается, когда голоса собраны
    assert c.post(f"/api/model-proposals/{p3}/grant", headers=bob, json={"grant_id": "g-000000b1"}).json()["status"] == "pending"
    assert c.post(f"/api/model-proposals/{p3}", headers=anna, json={"approve": True}).json()["status"] == "rejected"
    assert CALLS[-1] == ("deactivate", "g-000000b1") and c.get(f"/api/conversations/{chat}", headers=anna).json()["model"] == MAX

    r = c.post(f"/api/conversations/{chat}/model", headers=bob, json={"model": ULTRA, "limit_usd": 50, "days": 3}).json()
    p4 = r["proposal"]["id"]
    grant("g-000000b2", chat, p4, ULTRA, "bob", limit_usd=50.0)
    r = c.post(f"/api/model-proposals/{p4}/grant", headers=bob, json={"grant_id": "g-000000b2"}).json()
    assert r["status"] == "pending", r  # голос Боба есть, нужен ещё голос Анны
    assert c.post(f"/api/model-proposals/{p4}/grant", headers=bob, json={"grant_id": "g-000000b2"}).status_code == 409
    assert c.post(f"/api/model-proposals/{p4}", headers=carol, json={"approve": True}).status_code == 403
    n = len(CALLS)
    assert c.post(f"/api/model-proposals/{p4}", headers=anna, json={"approve": True}).json()["status"] == "approved"
    # новое разрешение включено, прежнее (Анны) снято
    assert CALLS[n:] == [("activate", "g-000000b2"), ("deactivate", "g-000000a1")], CALLS[n:]
    conv = c.get(f"/api/conversations/{chat}", headers=anna).json()
    assert conv["model"] == ULTRA and conv["sponsor"]["id"] == "bob" and conv["sponsor"]["limit_usd"] == 50.0, conv

    # Участник пишет в чат: keyguard узнаёт его по id из состава (как в разрешении), а не по username «ник#…».
    r = c.post(f"/api/conversations/{chat}/messages", headers=anna, json={"content": "привет"})
    assert r.status_code == 200, r.text
    for _ in range(100):
        if any(m["role"] == "assistant" for m in c.get(f"/api/conversations/{chat}", headers=anna).json()["messages"]):
            break
        time.sleep(0.05)
    assert LLM == [(chat, "anna")], LLM

    # 3. Спонсор уходит: разрешение снято, чат без модели до нового предложения.
    assert c.patch(f"/api/conversations/{chat}/sponsor", headers=anna, json={"withdraw": True}).status_code == 403
    assert c.patch(f"/api/conversations/{chat}/sponsor", headers=bob, json={"withdraw": True}).status_code == 200
    assert CALLS[-1] == ("deactivate", "g-000000b2")
    conv = c.get(f"/api/conversations/{chat}", headers=anna).json()
    assert conv["sponsor"] is None, conv
    r = c.post(f"/api/conversations/{chat}/messages", headers=anna, json={"content": "привет"})
    assert r.status_code == 409 and "спонсор" in r.json()["detail"], r.text

    # 4. Владелец пространства меняет модель на свою сразу, без голосования (переписка в чате уже была).
    assert c.get(f"/api/conversations/{chat}", headers=anna).json()["owner_switch"] is True
    assert c.get(f"/api/conversations/{chat}", headers=bob).json()["owner_switch"] is False
    r = c.post(f"/api/conversations/{chat}/model", headers=anna, json={"model": ULTRA, "limit_usd": 10, "days": 2}).json()
    p5 = r["proposal"]["id"]
    grant("g-000000c1", chat, p5, ULTRA, "anna", limit_usd=10.0)
    r = c.post(f"/api/model-proposals/{p5}/grant", headers=anna, json={"grant_id": "g-000000c1"}).json()
    assert r["status"] == "approved" and r["applied"] is True, r
    conv = c.get(f"/api/conversations/{chat}", headers=anna).json()
    assert conv["model"] == ULTRA and conv["sponsor"]["id"] == "anna" and conv["proposal"] is None, conv
    assert any("(владелец) сменил(а) модель" in (m.get("content") or "") for m in conv["messages"]), conv["messages"][-3:]

    # 5. Расписание в общем пространстве: в чате с разрешением спонсора, от имени автора, в пределах лимитов спонсора.
    for _ in range(100):  # прошлый ответ модели должен закончиться: в чате один запуск за раз
        run = main.agent().active_run(chat)
        if not run or run.status != "running":
            break
        time.sleep(0.05)
    body = {"title": "Сводка", "prompt": "Собери сводку", "kind": "daily", "at_time": "09:00"}
    r = c.post(f"/api/projects/{pid}/schedules", headers=bob, json=body)
    assert r.status_code == 400 and "выберите чат" in r.json()["detail"], r.text
    assert c.post(f"/api/projects/{pid}/schedules", headers=carol, json={**body, "conversation_id": chat}).status_code == 403
    bare = c.post(f"/api/projects/{pid}/conversations", headers=bob, json={}).json()["id"]
    r = c.post(f"/api/projects/{pid}/schedules", headers=bob, json={**body, "conversation_id": bare})
    assert r.status_code == 409 and "спонсор" in r.json()["detail"], r.text
    r = c.post(f"/api/projects/{pid}/schedules", headers=bob, json={**body, "conversation_id": chat, "model": MAX})
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["conversation_id"] == chat and s["model"] == ULTRA, s  # модель — чата (её оплачивает спонсор)
    assert c.patch(f"/api/schedules/{s['id']}", headers=carol, json={"enabled": False}).status_code == 403
    LLM.clear()
    r = c.post(f"/api/schedules/{s['id']}/run", headers=bob)
    assert r.status_code == 200 and r.json()["last_status"].startswith("запущено"), r.text
    for _ in range(100):
        if LLM:
            break
        time.sleep(0.05)
    assert LLM == [(chat, "bob")], LLM  # keyguard видит автора задания — допущенного спонсором участника
    msgs = c.get(f"/api/conversations/{chat}", headers=anna).json()["messages"]
    assert any((m.get("meta") or {}).get("author", "").startswith("⏰ Сводка · bob") for m in msgs), msgs[-3:]
    # Боба исключили из пространства — его задание больше не запускается и выключается
    roster = tok({"aud": f"space-internal:{SPACE}", "sub": "control-plane", "action": "roster", "members": [
        {"id": "anna", "name": "anna", "role": "owner"}, {"id": "carol", "name": "carol", "role": "viewer"}]})
    assert c.post("/internal/roster", json={"token": roster}).status_code == 200
    for _ in range(100):
        run = main.agent().active_run(chat)
        if not run or run.status != "running":
            break
        time.sleep(0.05)
    r = c.post(f"/api/schedules/{s['id']}/run", headers=anna)
    assert r.status_code == 409 and "больше не редактор" in r.json()["detail"], r.text
    assert c.get(f"/api/projects/{pid}/schedules", headers=anna).json()[0]["enabled"] is False

print("team-kg: ok")
