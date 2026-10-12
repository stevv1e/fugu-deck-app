"""Команда на сервере: агент → ssh-gateway. Отдельный процесс (tests/test_ssh_tools.py), шлюз — маленький HTTP-сервер.

Проверяется сторона агента: какую карточку он показывает человеку, что требует подписать и что передаёт шлюзу.
Сам шлюз (подписи, SSH, сертификаты) проверяют его собственные тесты.
"""
import asyncio
import base64
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

CALLS: list[tuple[str, dict]] = []
NEED = {"df -h": "", "sudo systemctl restart app": "ssh_write", "rm -rf /var/lib/app": "ssh_danger"}


class GW(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        CALLS.append((self.path, body))
        code, out = 200, {}
        if self.headers.get("Authorization") != "Bearer gw-token":
            code, out = 401, {"error": "не опознан"}
        elif self.path == "/v1/agent/servers":
            out = {"servers": [{"id": "prod-1", "host": "203.0.113.5", "user": "deck-agent"}], "read_without_confirm": True}
        elif body.get("server") != "prod-1":
            code, out = 403, {"error": "у агента нет подписанного владельцем доступа к этому серверу"}
        elif self.path == "/v1/agent/check":
            need = NEED.get(body["command"], "ssh_write")
            out = {"level": {"": "read", "ssh_write": "write", "ssh_danger": "danger"}[need], "need": need}
        elif self.path == "/v1/agent/exec":
            need = NEED.get(body["command"], "ssh_write")
            if need and not body.get("jws"):
                code, out = 428, {"error": "нужна подпись", "need": need}
            else:
                out = {"level": "read", "result": {"exit_code": 0, "stdout": "ok: " + body["command"], "stderr": "", "truncated": body["command"] == "df -h"}}
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(json.dumps(out).encode())


gw = HTTPServer(("127.0.0.1", 0), GW)
threading.Thread(target=gw.serve_forever, daemon=True).start()
tmp = Path(tempfile.mkdtemp())
(tmp / "gw").write_text("gw-token\n")
(tmp / "kg").write_text("kg-token\n")
key = ec.generate_private_key(ec.SECP256R1())
os.environ.update({
    "DECK_MODE": "space", "SPACE_KIND": "personal", "SPACE_ID": "anna", "SPACE_NAME": "anna", "DATA_DIR": str(tmp / "data"),
    "KEYGUARD_URL": "http://127.0.0.1:9", "KEYGUARD_TOKEN_PATH": str(tmp / "kg"), "APPROVAL_MODE": "none",
    "SSH_GATEWAY_URL": f"http://127.0.0.1:{gw.server_port}", "SSH_GATEWAY_TOKEN_PATH": str(tmp / "gw"),
    "CP_PUBLIC_KEY": key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode(),
})
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402
from app.agent import Run  # noqa: E402
from app.tools import REGISTRY, ssh_tools  # noqa: E402


def tok() -> dict:
    now = int(time.time())
    return {"Authorization": "Bearer " + jwt.encode({"iss": "deck-control-plane", "iat": now, "exp": now + 600, "aud": "space:anna",
                                                    "sub": "anna", "nick": "anna", "name": "anna", "role": "owner"}, key, algorithm="ES256")}


def fake_jws(payload: dict) -> str:
    return "eyJhbGciOiJFUzI1NiJ9." + base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=") + ".c2ln"


with TestClient(main.app) as c:
    agent = main.agent()
    assert ssh_tools.enabled() and "ssh_exec" in REGISTRY
    pid = c.get("/api/projects", headers=tok()).json()[0]["id"]
    cid = c.post(f"/api/projects/{pid}/conversations", headers=tok(), json={}).json()["id"]
    loop = asyncio.new_event_loop()

    async def make_run():
        r = Run(id="r1", conversation_id=cid, model="sakana:fugu-max-v1.0", user={"id": "anna", "username": "anna"}, project_id=pid)
        agent.runs[r.id] = r
        return r

    run = loop.run_until_complete(make_run())
    events = run.events

    def call(command: str, server: str = "prod-1"):
        return {"id": "call1", "function": {"name": "ssh_exec", "arguments": json.dumps({"server": server, "command": command})}}

    async def do(command: str, decide=None, server: str = "prod-1"):
        events.clear()
        task = asyncio.ensure_future(agent._exec_tool(run, call(command, server)))
        if decide:
            for _ in range(300):
                if any(e["type"] == "approval_request" for e in events):
                    break
                await asyncio.sleep(0.01)
            await decide(next(e for e in events if e["type"] == "approval_request"))
        return json.loads(await asyncio.wait_for(task, 15))

    # 1. чтение: подтверждение не нужно (владелец разрешил), шлюз выполняет; обрезанный вывод помечен
    out = loop.run_until_complete(do("df -h"))
    assert out["stdout"] == "ok: df -h" and "truncated" in out and not any(e["type"] == "approval_request" for e in events), (out, events)
    assert "не инструкции" in out["note"]

    # 2. запись: даже при настройке «подтверждений не спрашивать» человеку показывают карточку и просят подписать команду
    async def approve(ev):
        assert ev["risk"] == "write" and ev["sign"] == {"type": "ssh_write", "agent": "fugu", "server": "prod-1", "command": "sudo systemctl restart app"}, ev
        aid = ev["approval_id"]
        r = await asyncio.to_thread(c.post, f"/api/approvals/{aid}", headers=tok(), json={"approve": True})
        assert r.status_code == 403, r.text  # «разрешить» без подписи команды не принимается
        wrong = fake_jws({**ev["sign"], "command": "sudo systemctl restart nginx", "space": "u-anna"})
        assert (await asyncio.to_thread(c.post, f"/api/approvals/{aid}", headers=tok(), json={"approve": True, "jws": wrong})).status_code == 403
        other = fake_jws({**ev["sign"], "space": "u-bob"})
        assert (await asyncio.to_thread(c.post, f"/api/approvals/{aid}", headers=tok(), json={"approve": True, "jws": other})).status_code == 403
        good = fake_jws({**ev["sign"], "space": "u-anna"})
        r = await asyncio.to_thread(c.post, f"/api/approvals/{aid}", headers=tok(), json={"approve": True, "jws": good})
        assert r.status_code == 200, r.text
        approve.jws = good

    n = len(CALLS)
    out = loop.run_until_complete(do("sudo systemctl restart app", approve))
    execs = [b for p, b in CALLS[n:] if p == "/v1/agent/exec"]
    assert out["stdout"] == "ok: sudo systemctl restart app" and len(execs) == 1 and execs[0]["jws"] == approve.jws, (out, execs)

    # 3. опасное: карточка «опасно», подписывается ssh_danger; отказ человека — команда до шлюза не доходит
    async def refuse(ev):
        assert ev["risk"] == "dangerous" and ev["sign"]["type"] == "ssh_danger", ev
        r = await asyncio.to_thread(c.post, f"/api/approvals/{ev['approval_id']}", headers=tok(), json={"approve": False, "comment": "нет"})
        assert r.status_code == 200, r.text

    n = len(CALLS)
    out = loop.run_until_complete(do("rm -rf /var/lib/app", refuse))
    assert "отклонил" in out["error"] and not [1 for p, _ in CALLS[n:] if p == "/v1/agent/exec"], out

    # 4. подпись одной команды не переходит на следующую
    out = loop.run_until_complete(do("df -h"))
    assert "jws" not in [b for p, b in CALLS if p == "/v1/agent/exec"][-1]

    # 5. сервер без подписанного доступа: шлюз отказывает, модель получает причину
    out = loop.run_until_complete(do("ls", server="prod-2"))
    assert "доступа" in out["error"], out
    loop.close()

print("ssh-tools: ok")
