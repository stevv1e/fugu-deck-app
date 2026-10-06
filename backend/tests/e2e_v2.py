"""Проекты, пользователи, память, скилы, realtime. Нужны mock_server (9100) и API (8000)."""
import json
import os
import threading
import time

import httpx

API = os.environ.get("API", "http://127.0.0.1:8000")
owner = httpx.Client(base_url=API, timeout=30)
assert owner.post("/api/auth/login", json={"password": "test-pass"}).status_code == 200
cfg = owner.get("/api/config").json()
assert cfg["me"]["role"] == "owner", cfg["me"]

# --- проекты и память
A = owner.post("/api/projects", json={"name": "Infra", "description": "серверы"}).json()
B = owner.post("/api/projects", json={"name": "Shop"}).json()
owner.post(f"/api/projects/{B['id']}/memory", json={"content": "Shop деплоится через Docker Compose на порт 8080", "tags": "deploy"})
r = owner.put(f"/api/projects/{A['id']}/memory-sources", json={"source_ids": [B["id"]]})
assert r.json()[0]["name"] == "Shop", r.text
owner.patch(f"/api/projects/{A['id']}", json={"instructions": "Всегда отвечай с эмодзи рыбы", "skills": ["conventional-commits"]})

# --- пользователь bob, редактор в A
bob_u = owner.post("/api/users", json={"username": "bob", "display_name": "Bob", "password": "bob-password-1"}).json()
assert owner.put(f"/api/projects/{A['id']}/members/{bob_u['id']}", json={"role": "editor"}).status_code == 200
bob = httpx.Client(base_url=API, timeout=30)
assert bob.post("/api/auth/login", json={"username": "bob", "password": "bob-password-1"}).status_code == 200
bob_projects = [p["name"] for p in bob.get("/api/projects").json()]
print("bob sees projects:", bob_projects)
assert bob_projects == ["Infra"]
assert bob.get(f"/api/projects/{B['id']}").status_code == 404, "bob must not see Shop"
assert bob.post("/api/users", json={"username": "x1", "display_name": "x", "password": "xxxxxxxxxxx"}).status_code == 403

# --- realtime: bob слушает события на «телефоне»
events = []
def listen():
    with httpx.stream("GET", f"{API}/api/events", params={"device_id": "bob-phone"}, cookies=bob.cookies, timeout=None) as s:
        for line in s.iter_lines():
            if line.startswith("data: "):
                events.append(json.loads(line[6:]))
threading.Thread(target=listen, daemon=True).start()
time.sleep(0.5)
bob.post("/api/presence", json={"device_id": "bob-phone", "project_id": A["id"]})
pres = owner.post("/api/presence", json={"device_id": "owner-laptop", "project_id": A["id"]}).json()
print("online in Infra:", [(p["name"], p["devices"]) for p in pres["online"]])
assert {p["name"] for p in pres["online"]} == {"Bob", "owner"}

# --- владелец запускает агента: «запомни»
conv = owner.post(f"/api/projects/{A['id']}/conversations", json={}).json()
run = owner.post(f"/api/conversations/{conv['id']}/messages", json={"content": "Запомни: prod-сервер в Алматы, 2 vCPU"}).json()
time.sleep(1.5)
types = [e["type"] for e in events]
print("bob received:", types)
assert "conversation" in types and "run.started" in types and "memory" in types and "run.finished" in types
mem_ev = next(e for e in events if e["type"] == "memory")
assert mem_ev["by"] == "agent" and "Алматы" in mem_ev["memory"]["content"]

# системный промпт: инструкции, скил, память, связанные проекты
st = httpx.get("http://127.0.0.1:9100/state").json()["last_request_msgs"]
sysmsg = st[0]["content"]
for needle in ["Infra", "эмодзи рыбы", "conventional-commits", "Shop", "[Owner]" if False else "Память проекта"]:
    assert needle in sysmsg, needle
assert "python-service" not in sysmsg, "disabled skill leaked"
assert st[1]["content"].startswith("[owner]"), st[1]["content"][:40]
print("system prompt ok, author prefix ok")

# --- bob в параллельном чате: «вспомни» → ищет в памяти связанного проекта Shop
conv2 = bob.post(f"/api/projects/{A['id']}/conversations", json={}).json()
bob.post(f"/api/conversations/{conv2['id']}/messages", json={"content": "Вспомни, как деплоится shop"})
time.sleep(1.5)
last = bob.get(f"/api/conversations/{conv2['id']}").json()["messages"]
tool_res = [m for m in last if m["role"] == "tool"][-1]["content"]
print("memory_search result:", tool_res[:160])
assert "8080" in tool_res and "read_only" in tool_res

# --- скил
conv3 = bob.post(f"/api/projects/{A['id']}/conversations", json={}).json()
bob.post(f"/api/conversations/{conv3['id']}/messages", json={"content": "Используй скил коммитов"})
time.sleep(1.2)
last = bob.get(f"/api/conversations/{conv3['id']}").json()["messages"]
assert "Conventional Commits" in [m for m in last if m["role"] == "tool"][-1]["content"]
print("load_skill ok")

# --- права: bob не может редактировать скилы и память Shop
assert bob.put("/api/skills/evil", json={"description": "x", "body": "y"}).status_code == 403
shop_mem = owner.get(f"/api/projects/{B['id']}/memory").json()[0]
assert bob.delete(f"/api/memory/{shop_mem['id']}").status_code == 404
# bob не может привязать память проекта, которого не видит
assert bob.put(f"/api/projects/{A['id']}/memory-sources", json={"source_ids": [B["id"]]}).status_code == 403
# владелец создаёт скил → bob получает событие
owner.put("/api/skills/deploy-checklist", json={"description": "Чеклист деплоя", "body": "1. Бэкап\n2. Деплой"})
time.sleep(0.4)
assert any(e["type"] == "skill" for e in events)
print("permissions + skill events ok")

# --- поиск по памяти через API (кириллица, регистр)
res = owner.get(f"/api/projects/{A['id']}/memory", params={"q": "алматы"}).json()
assert res and "Алматы" in res[0]["content"], res
print("ALL V2 CHECKS PASSED")
