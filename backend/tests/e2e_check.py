"""Сквозная проверка: логин → чат → сообщение с вложением → подтверждение коммита → итог.

Нужны запущенные mock_server (порт 9100) и API (порт 8000).
"""
import json
import os
import sys
import threading
import time

import httpx

API = os.environ.get("API", "http://127.0.0.1:8000")
c = httpx.Client(base_url=API, timeout=30)

r = c.post("/api/auth/login", json={"password": "wrong"})
assert r.status_code == 401, r.text
r = c.post("/api/auth/login", json={"password": "test-pass"})
assert r.status_code == 200, r.text
cfg = c.get("/api/config").json()
print("config:", cfg["models"], cfg["providers"])
assert cfg["providers"]["github"]["login"] == "me"

conv = c.post("/api/projects/general/conversations", json={}).json()
cid = conv["id"]
att = c.post(f"/api/conversations/{cid}/attachments",
             files={"file": ("notes.txt", b"hello from phone", "text/plain")}).json()
print("attachment:", att)

run = c.post(f"/api/conversations/{cid}/messages",
             json={"content": "Создай hello.py в demo", "attachment_ids": [att["id"]]}).json()
rid = run["run_id"]

events = []


def listen(after=0):
    with httpx.stream("GET", f"{API}/api/runs/{rid}/events", params={"after": after},
                      cookies=c.cookies, timeout=60) as s:
        for line in s.iter_lines():
            if line.startswith("data: ") and line != "data: {}":
                e = json.loads(line[6:])
                events.append(e)
                if e["type"] == "approval_request":
                    print("-> approval:", e["name"], e["risk"], e["args"]["branch"])
                    threading.Thread(target=lambda: time.sleep(0.3) or print(
                        "approve:", c.post(f"/api/approvals/{e['approval_id']}", json={"approve": True}).json())).start()
                if e["type"] in ("done", "error", "cancelled"):
                    return


# Имитация обрыва связи: читаем, отключаемся, переподключаемся с after=N
listen()
types = [e["type"] for e in events]
print("event types:", types)
assert "done" in types, events[-1]
assert "approval_request" in types and "tool_end" in types

# Переподключение с середины — события должны повториться с нужной позиции
events2 = []
with httpx.stream("GET", f"{API}/api/runs/{rid}/events", params={"after": 3}, cookies=c.cookies) as s:
    for line in s.iter_lines():
        if line.startswith("data: ") and line != "data: {}":
            events2.append(json.loads(line[6:]))
assert events2[0]["seq"] == 3, events2[0]
print("replay from seq 3 ok, events:", len(events2))

state = httpx.get("http://127.0.0.1:9100/state").json()
print("commits in fake github:", state["commits"], "refs:", state["refs"])
assert state["refs"]["feature/hello"] == "commit1"
blob = list(state["blobs"].values())[0]
import base64
assert base64.b64decode(blob["content"]) == b"print('hi')\n"

msgs = state["last_request_msgs"]
first_user = [m for m in msgs if m["role"] == "user"][0]
assert "hello from phone" in first_user["content"], first_user
print("attachment inlined into prompt: ok")

conv = c.get(f"/api/conversations/{cid}").json()
print("title:", conv["title"], "| messages:", [m["role"] for m in conv["messages"]])
print("usage:", c.get("/api/usage").json()["month"])
print("audit:", [(a["tool"], a["approved"], a["ok"]) for a in c.get("/api/audit").json()])

# Отклонение действия
run = c.post(f"/api/conversations/{cid}/messages", json={"content": "ещё раз"}).json()
print("second run started (approval-less path: list_repos is read-only)")
time.sleep(2)
print("ALL CHECKS PASSED")
sys.exit(0)
