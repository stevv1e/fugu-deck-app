"""Сквозной сценарий «Анна, Боб, Вика» на локальном оркестраторе.

Нужны: mock_server (порт 9100) и control-plane (порт 8080) с CP_TEST_MODE=true, CP_ORCHESTRATOR=local.
"""
import json
import os
import sqlite3
import subprocess
import threading
import time

import httpx

CP = os.environ.get("CP", "http://127.0.0.1:8080")
DATA = os.environ.get("CP_DATA_DIR", "/tmp/claude-0/cp-e2e")


def client(nick, name, admin=False):
    c = httpx.Client(base_url=CP, timeout=60)
    r = c.post("/cp/api/test/login", json={"nick": nick, "display_name": name, "admin": admin})
    assert r.status_code == 200, r.text
    return c


def token(c, sid):
    r = c.post(f"/cp/api/spaces/{sid}/token")
    assert r.status_code == 200, r.text
    return r.json()


def sp(c, tok, method, path, **kw):
    return c.request(method, f"{tok['base']}{path}", headers={"Authorization": f"Bearer {tok['token']}"}, **kw)


def wait_run(c, tok, cid, timeout=20):
    for _ in range(timeout * 5):
        conv = sp(c, tok, "GET", f"/api/conversations/{cid}").json()
        if not conv["active_run"]:
            return conv
        time.sleep(0.2)
    raise AssertionError("run did not finish")


anna, bob, vika = client("anna", "Анна", True), client("bob", "Боб"), client("vika", "Вика")
me = {n: c.get("/cp/api/me").json() for n, c in (("anna", anna), ("bob", bob), ("vika", vika))}
personal = {n: next(s for s in m["spaces"] if s["kind"] == "personal") for n, m in me.items()}
assert all(p["status"] == "ready" for p in personal.values()), personal
print("1. три личных пространства:", {n: p["id"] for n, p in personal.items()})

# --- Анна: Claude в личном пространстве
ta = token(anna, personal["anna"]["id"])
assert ta["role"] == "owner"
r = sp(anna, ta, "POST", "/api/session/keys", json={"keys": {"anthropic": "sk-ant-test", "github": "gh-x"}})
assert r.json()["providers"] == ["anthropic", "github"], r.text
cfg = sp(anna, ta, "GET", "/api/config").json()
assert cfg["mode"] == "space" and cfg["llm_ready"] == ["anthropic"], cfg
conv = sp(anna, ta, "POST", "/api/projects/general/conversations", json={"model": "anthropic:claude-sonnet-5"}).json()
sp(anna, ta, "POST", f"/api/conversations/{conv['id']}/messages", json={"content": "Запомни: прод в Алматы"})
res = wait_run(anna, ta, conv["id"])
assert res["messages"][-1]["content"].startswith("Готово"), res["messages"][-1]
mem = sp(anna, ta, "GET", "/api/projects/general/memory").json()
assert "Алматы" in mem[0]["content"]
print("2. Анна работает с Claude своим ключом; память:", mem[0]["content"])

# ключ нигде не записан на диск
leak = subprocess.run(["grep", "-rl", "sk-ant-test", DATA], capture_output=True, text=True).stdout.strip()
assert not leak, f"ключ найден на диске: {leak}"
print("3. ключ API на диске не найден ✓")

# --- чужие пространства недоступны
assert bob.post(f"/cp/api/spaces/{personal['anna']['id']}/token").status_code == 404
tb_personal = token(bob, personal["bob"]["id"])
r = bob.get(f"/s/{personal['anna']['id']}/api/config", headers={"Authorization": f"Bearer {tb_personal['token']}"})
assert r.status_code == 401, r.status_code  # токен от другого пространства не подходит
print("4. токен Боба в пространство Анны не пускает ✓")

# --- общий проект
team = anna.post("/cp/api/spaces", json={"name": "Shop"}).json()
assert team["status"] == "ready"
assert anna.get("/cp/api/users/search", params={"q": "bo"}).json() == []
found = anna.get("/cp/api/users/search", params={"q": "bob"}).json()
assert [u["nick"] for u in found] == ["bob"]
vika_events = []


def listen_vika():
    with httpx.stream("GET", f"{CP}/cp/api/events", cookies=vika.cookies, timeout=None) as s:
        for line in s.iter_lines():
            if line.startswith("data: "):
                vika_events.append(json.loads(line[6:]))


threading.Thread(target=listen_vika, daemon=True).start()
time.sleep(0.4)
assert anna.post(f"/cp/api/spaces/{team['id']}/invites", json={"nick": "bob", "role": "editor"}).status_code == 200
assert anna.post(f"/cp/api/spaces/{team['id']}/invites", json={"nick": "vika", "role": "viewer"}).status_code == 200
time.sleep(0.4)
assert any(e["type"] == "invite" for e in vika_events), vika_events
# до принятия доступа нет
assert bob.post(f"/cp/api/spaces/{team['id']}/token").status_code == 404
for c in (bob, vika):
    inv = c.get("/cp/api/invites").json()[0]
    assert c.post(f"/cp/api/invites/{inv['id']}/accept").json()["space_id"] == team["id"]
members = anna.get(f"/cp/api/spaces/{team['id']}").json()["members_list"]
print("5. Shop, участники:", [(m["nick"], m["role"]) for m in members])

# --- параллельная работа: Боб (Sakana) и Анна (Claude) в Shop, Вика смотрит
tA, tB, tV = token(anna, team["id"]), token(bob, team["id"]), token(vika, team["id"])
assert (tA["role"], tB["role"], tV["role"]) == ("owner", "editor", "viewer")
sp(bob, tB, "POST", "/api/session/keys", json={"keys": {"sakana": "sk-sakana-bob"}})
sp(anna, tA, "POST", "/api/session/keys", json={"keys": {"anthropic": "sk-ant-test"}})
anna_live = []


def listen_anna():
    with httpx.stream("GET", f"{CP}{tA['base']}/api/events", params={"device_id": "anna-laptop"},
                      headers={"Authorization": f"Bearer {tA['token']}"}, timeout=None) as s:
        for line in s.iter_lines():
            if line.startswith("data: "):
                anna_live.append(json.loads(line[6:]))


threading.Thread(target=listen_anna, daemon=True).start()
time.sleep(0.4)
cb = sp(bob, tB, "POST", "/api/projects/general/conversations", json={"model": "sakana:fugu-max-v1.0"}).json()
assert sp(bob, tB, "POST", f"/api/conversations/{cb['id']}/model", json={"model": "sakana:fugu-max-v1.0", "limit_usd": 2, "model_policy": "open"}).json()["applied"]
ca = sp(anna, tA, "POST", "/api/projects/general/conversations", json={"model": "anthropic:claude-sonnet-5"}).json()
r = sp(anna, tA, "POST", f"/api/conversations/{ca['id']}/model", json={"model": "anthropic:claude-sonnet-5"})
assert r.status_code == 400 and "ограничение" in r.text, r.text  # без ограничения нельзя
r = sp(anna, tA, "POST", f"/api/conversations/{ca['id']}/model", json={"model": "anthropic:claude-sonnet-5", "days": 1})
assert r.json()["applied"] is True, r.text
r1 = sp(bob, tB, "POST", f"/api/conversations/{cb['id']}/messages", json={"content": "Запомни: staging на stg.shop.kz"})
r2 = sp(anna, tA, "POST", f"/api/conversations/{ca['id']}/messages", json={"content": "Запомни: релиз по вторникам"})
assert r1.status_code == 200 and r2.status_code == 200, (r1.text, r2.text)
wait_run(bob, tB, cb["id"])
wait_run(anna, tA, ca["id"])
shop_mem = [m["content"] for m in sp(vika, tV, "GET", "/api/projects/general/memory").json()]
print("6. память Shop (видит Вика):", shop_mem)
assert any("stg.shop.kz" in m for m in shop_mem) and any("вторникам" in m for m in shop_mem)
assert any(e["type"] == "memory" for e in anna_live), [e["type"] for e in anna_live]
# Вика — читатель: запускать не может
r = sp(vika, tV, "POST", f"/api/conversations/{cb['id']}/messages", json={"content": "привет"})
assert r.status_code == 403, r.status_code
# у Вики нет ключей — и чужие ей не достаются
assert sp(vika, tV, "GET", "/api/session/keys").json()["providers"] == []
print("7. Вика видит всё в реальном времени, но не запускает ✓; ключи Боба и Анны ей недоступны ✓")

# --- перенос личного проекта в общий
exp = sp(anna, ta, "GET", "/api/projects/general/export").json()
imp = sp(anna, tA, "POST", "/api/projects/import", json={**exp, "name": "Из личного"})
assert imp.status_code == 200, imp.text
print("8. «Сделать общим»: проект перенесён, записей памяти:", len(exp["memories"]))

# --- одна модель на общий чат: спонсор и предложение о смене модели
st = sp(anna, tA, "GET", f"/api/conversations/{ca['id']}").json()
assert st["sponsor"]["name"] == "Анна" and st["model"] == "anthropic:claude-sonnet-5", st.get("sponsor")
assert st["sponsor"]["until"], "спонсорство без ограничения"
# у Боба нет ключа Claude, но чат оплачивает спонсор — Анна
r = sp(bob, tB, "POST", f"/api/conversations/{ca['id']}/messages", json={"content": "Запомни: Боб пишет в чат Анны"})
assert r.status_code == 200, r.text
wait_run(bob, tB, ca["id"])
print("9. Боб пишет в Claude-чат Анны без своего ключа — платит спонсор (Анна) ✓")
# в общем чате нельзя просто сменить модель
assert sp(bob, tB, "PATCH", f"/api/conversations/{ca['id']}", json={"model": "sakana:fugu-max-v1.0"}).status_code == 409
# дата окончания в прошлом — нельзя
bad = sp(bob, tB, "POST", f"/api/conversations/{ca['id']}/model", json={"model": "sakana:fugu-max-v1.0", "until": time.time() - 10})
assert bad.status_code == 400, bad.text
# Боб предлагает Sakana (сам будет платить)
r = sp(bob, tB, "POST", f"/api/conversations/{ca['id']}/model", json={"model": "sakana:fugu-max-v1.0", "limit_usd": 5, "until": time.time() + 3 * 86400})
prop = r.json()["proposal"]
assert r.status_code == 200 and prop["status"] == "pending", r.text
# голосуют редакторы и владельцы (Анна, Боб); Вика — читатель; нужно большинство: 2 из 2
assert prop["voters"] == 2 and prop["need"] == 2 and prop["yes"] == ["Боб"], prop
assert sp(bob, tB, "POST", f"/api/model-proposals/{prop['id']}", json={"approve": True}).status_code == 403  # не сам себе
assert sp(vika, tV, "POST", f"/api/model-proposals/{prop['id']}", json={"approve": True}).status_code == 403  # читатель
assert sp(anna, tA, "POST", f"/api/model-proposals/{prop['id']}", json={"approve": True}).status_code == 200
st = sp(anna, tA, "GET", f"/api/conversations/{ca['id']}").json()
assert st["model"] == "sakana:fugu-max-v1.0" and st["sponsor"]["name"] == "Боб" and st["sponsor"]["limit_usd"] == 5
assert 2.9 < (st["sponsor"]["until"] - time.time()) / 86400 <= 3
assert any("Голосование прошло" in (m["content"] or "") for m in st["messages"] if m["role"] == "note")

# --- чат Боба: смена модели «свободно для коллег» — Анна меняет без голосования
cbs = sp(anna, tA, "GET", f"/api/conversations/{cb['id']}").json()
assert cbs["model_policy"] == "open"
r = sp(anna, tA, "POST", f"/api/conversations/{cb['id']}/model", json={"model": "anthropic:claude-sonnet-5", "limit_usd": 1})
assert r.json()["applied"] is True, r.text
cbs = sp(bob, tB, "GET", f"/api/conversations/{cb['id']}").json()
assert cbs["model"] == "anthropic:claude-sonnet-5" and cbs["sponsor"]["name"] == "Анна" and cbs["proposal"] is None
print("   политика «свободно для коллег»: Анна сменила модель в чате Боба без голосования ✓")

# --- срок голосования 24 ч: просроченное предложение закрывается
r = sp(anna, tA, "POST", f"/api/conversations/{ca['id']}/model", json={"model": "anthropic:claude-haiku-4-5", "limit_usd": 1})
p2 = r.json()["proposal"]
assert p2["status"] == "pending" and 23.9 * 3600 < p2["expires_at"] - time.time() <= 24 * 3600, p2
import sqlite3 as _sq
_con = _sq.connect(f"{DATA}/spaces/{team['id']}/fugu-deck.sqlite3")
_con.execute("UPDATE model_proposals SET expires_at=? WHERE id=?", (time.time() - 1, p2["id"]))
_con.commit(); _con.close()
st = sp(bob, tB, "GET", f"/api/conversations/{ca['id']}").json()
assert st["proposal"] is None and st["model"] == "sakana:fugu-max-v1.0", st["proposal"]
assert any("истекло" in (m["content"] or "") for m in st["messages"] if m["role"] == "note")
assert sp(bob, tB, "POST", f"/api/model-proposals/{p2['id']}", json={"approve": True}).status_code == 404
print("   голосование 24 ч: просроченное предложение закрыто ✓")
notes = [m["content"] for m in st["messages"] if m["role"] == "note"]
print("10. смена модели голосованием:", next(n for n in notes if "Голосование прошло" in n))
# теперь Анна пишет в тот же чат — работает Sakana на ключе Боба; история с Claude переводится
r = sp(anna, tA, "POST", f"/api/conversations/{ca['id']}/messages", json={"content": "Запомни: чат уже на Sakana"})
assert r.status_code == 200, r.text
res = wait_run(anna, tA, ca["id"])
assert res["messages"][-1]["role"] == "assistant", res["messages"][-1]
last_model = [m for m in res["messages"] if m["role"] == "assistant"][-1].get("meta", {}).get("model")
assert last_model == "sakana:fugu-max-v1.0", last_model
# лимит спонсора в $
sp(bob, tB, "PATCH", f"/api/conversations/{ca['id']}/sponsor", json={"limit_usd": 0.0001})
r = sp(anna, tA, "POST", f"/api/conversations/{ca['id']}/messages", json={"content": "ещё"})
assert r.status_code == 409 and "$0.0001" in r.text, r.text
# лимит в токенах (денежный снимаем)
r = sp(bob, tB, "PATCH", f"/api/conversations/{ca['id']}/sponsor", json={"limit_usd": None, "days": None})
assert r.status_code == 400 and "ограничение" in r.text, r.text
sp(bob, tB, "PATCH", f"/api/conversations/{ca['id']}/sponsor", json={"limit_usd": None, "limit_tokens": 1000})
st = sp(anna, tA, "GET", f"/api/conversations/{ca['id']}").json()["sponsor"]
assert st["limit_usd"] is None and st["limit_tokens"] == 1000 and st["spent_tokens"] >= 1000, st
r = sp(anna, tA, "POST", f"/api/conversations/{ca['id']}/messages", json={"content": "ещё"})
assert r.status_code == 409 and "токенов" in r.text, r.text
# срок спонсорства: ~1 секунда, затем продление на 7 дней
sp(bob, tB, "PATCH", f"/api/conversations/{ca['id']}/sponsor", json={"limit_tokens": None, "days": 0.00001})
time.sleep(1.5)
r = sp(anna, tA, "POST", f"/api/conversations/{ca['id']}/messages", json={"content": "ещё"})
assert r.status_code == 409 and "Срок" in r.text, r.text
sp(bob, tB, "PATCH", f"/api/conversations/{ca['id']}/sponsor", json={"days": 7})
st = sp(anna, tA, "GET", f"/api/conversations/{ca['id']}").json()["sponsor"]
assert 6.9 < (st["until"] - time.time()) / 86400 <= 7 and st["blocked"] is None, st
r = sp(anna, tA, "POST", f"/api/conversations/{ca['id']}/messages", json={"content": "Запомни: продлили"})
assert r.status_code == 200, r.text
wait_run(anna, tA, ca["id"])
print("   лимиты: $ ✓, токены ✓, срок и продление ✓")
# спонсор отказался — чат ждёт новую модель
sp(bob, tB, "PATCH", f"/api/conversations/{ca['id']}/sponsor", json={"withdraw": True})
r = sp(anna, tA, "POST", f"/api/conversations/{ca['id']}/messages", json={"content": "ещё"})
assert r.status_code == 409 and "спонсора" in r.text, r.text
# --- сводка расходов по участникам
rep = sp(vika, tV, "GET", "/api/usage/members", params={"period": "month"}).json()
by = {m["name"]: m for m in rep["members"]}
print("   расходы:", {n: (m["launched_usd"], m["paid_usd"], m["paid_for_others_usd"]) for n, m in by.items()})
assert by["Анна"]["paid_for_others_usd"] > 0          # оплатила запуск Боба в своём Claude-чате
assert by["Боб"]["paid_for_others_usd"] > 0           # оплатил запуск Анны после перехода на Sakana
assert by["Боб"]["launched_usd"] > 0 and by["Анна"]["launched_usd"] > 0
assert abs(sum(m["paid_usd"] for m in rep["members"]) - rep["total_usd"]) < 1e-3
assert "Вика" not in by  # ничего не запускала и не оплачивала
print("11. Claude → Sakana в одном чате, лимит спонсора и отказ от спонсорства работают ✓")

# --- удаление Боба: мгновенное отключение
bob_events = []


def listen_bob():
    with httpx.stream("GET", f"{CP}{tB['base']}/api/events", params={"device_id": "bob-phone"},
                      headers={"Authorization": f"Bearer {tB['token']}"}, timeout=10) as s:
        for line in s.iter_lines():
            if line.startswith("data: "):
                bob_events.append(json.loads(line[6:]))


th = threading.Thread(target=listen_bob, daemon=True)
th.start()
time.sleep(0.4)
bob_id = next(m["id"] for m in members if m["nick"] == "bob")
assert anna.delete(f"/cp/api/spaces/{team['id']}/members/{bob_id}").status_code == 200
time.sleep(0.5)
r = sp(bob, tB, "GET", "/api/config")
assert r.status_code == 401, r.status_code  # токен ещё не истёк, но отозван
assert any(e["type"] == "kicked" for e in bob_events), bob_events
assert bob.post(f"/cp/api/spaces/{team['id']}/token").status_code == 404
print("12. Боба удалили: старый токен отклонён, поток событий закрыт ✓")

# --- 72 часа: Вика неактивна
con = sqlite3.connect(f"{DATA}/control-plane.sqlite3")
con.execute("UPDATE users SET last_seen=? WHERE nick='vika'", (time.time() - 73 * 3600,))
con.commit()
con.close()
rep = anna.post("/cp/api/admin/reaper").json()
assert [p["user"] for p in rep["purged"]] == ["vika"], rep
assert not os.path.exists(f"{DATA}/spaces/{personal['vika']['id']}")
members = [m["nick"] for m in anna.get(f"/cp/api/spaces/{team['id']}").json()["members_list"]]
assert members == ["anna"], members
# Вика возвращается — пустое новое пространство
me_v = vika.get("/cp/api/me").json()
new_p = next(s for s in me_v["spaces"] if s["kind"] == "personal")
assert new_p["id"] != personal["vika"]["id"] and [s["kind"] for s in me_v["spaces"]] == ["personal"]
print("13. Вика неактивна 72 ч: данные удалены, из Shop вышла; при входе — новое пустое пространство ✓")
print("ALL THREE-USER CHECKS PASSED")
