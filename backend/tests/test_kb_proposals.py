"""Очередь предложений агента: в проекте с проверкой заметок memory_save не пишет в память, а предлагает."""
from types import SimpleNamespace

from app.tools import memory_tools
from tests.test_api_extra import login
from tests.test_devices import client, main  # noqa: F401  (общий сервер в процессе)


def test_proposals_queue(client):
    def save(pid: str, content: str, **a):
        """memory_save так, как его вызывает агент — в цикле событий сервера."""
        async def go():
            db = main.db()
            ctx = SimpleNamespace(db=db, project_id=pid, project=await db.get_project(pid), conversation_id=None, broker=None)
            return await memory_tools.memory_save(ctx, {"content": content, **a})
        return client.portal.call(go)

    login(client)
    pid = client.post("/api/projects", json={"name": "Проверка заметок"}).json()["id"]
    r = save(pid, "Без проверки: сразу в памяти", title="Сразу")
    assert r["saved"] is True
    assert client.patch(f"/api/projects/{pid}", json={"kb_review": True}).status_code == 200
    r = save(pid, "Деплой — только по пятницам", title="Деплой", area="ops", tags="релизы")
    assert r["saved"] is False and r["proposal"], r
    props = client.get(f"/api/projects/{pid}/kb/proposals").json()
    assert len(props) == 1 and props[0]["content"] == "Деплой — только по пятницам" and props[0]["fields"]["area"] == "ops", props
    g = client.get(f"/api/projects/{pid}/kb").json()
    assert all(n["title"] != "Деплой" for n in g["notes"]), "до решения предложение не в базе знаний"
    m = client.post(f"/api/kb/proposals/{props[0]['id']}/accept").json()
    assert m["title"] == "Деплой" and m["area"] == "ops" and m["tags"] == "релизы" and m["source"] == "agent", m
    assert client.get(f"/api/projects/{pid}/kb/proposals").json() == []
    r = save(pid, "Сомнительный факт")
    assert client.delete(f"/api/kb/proposals/{r['proposal']}").status_code == 200
    g = client.get(f"/api/projects/{pid}/kb").json()
    assert any(n["title"] == "Деплой" for n in g["notes"]) and all("Сомнительный" not in n["body"] for n in g["notes"])
    assert client.post(f"/api/kb/proposals/{r['proposal']}/accept").status_code == 404
