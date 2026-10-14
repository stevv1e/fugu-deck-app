"""API для приложения: переименование и перенос чата, предпросмотр вложений, задания по расписанию."""
import base64
import time

from tests.test_devices import client, main  # noqa: F401  (общий сервер в процессе)


def login(client):
    r = client.post("/api/auth/login", json={"password": "test-pass"})
    assert r.status_code == 200, r.text


def test_rename_and_move_chat(client):
    login(client)
    a = client.post("/api/projects", json={"name": "А"}).json()
    b = client.post("/api/projects", json={"name": "Б"}).json()
    c = client.post(f"/api/projects/{a['id']}/conversations", json={}).json()
    r = client.patch(f"/api/conversations/{c['id']}", json={"title": "  Мой чат  "})
    assert r.status_code == 200 and r.json()["title"] == "Мой чат"
    assert client.patch(f"/api/conversations/{c['id']}", json={"title": "   "}).status_code == 400
    r = client.patch(f"/api/conversations/{c['id']}", json={"project_id": b["id"]})
    assert r.status_code == 200 and r.json()["project_id"] == b["id"]
    assert [x["id"] for x in client.get(f"/api/projects/{b['id']}/conversations").json()] == [c["id"]]
    assert client.get(f"/api/projects/{a['id']}/conversations").json() == []
    assert client.patch(f"/api/conversations/{c['id']}", json={"project_id": "нет-такого"}).status_code == 404


def test_attachment_preview(client):
    login(client)
    c = client.post("/api/projects/general/conversations", json={}).json()
    raw = b"\x89PNG\r\n\x1a\n" + b"x" * 100
    up = client.post(f"/api/conversations/{c['id']}/attachments/json",
                     json={"filename": "a.png", "mime": "image/png", "data": base64.b64encode(raw).decode()}).json()
    r = client.get(f"/api/attachments/{up['id']}/json")
    assert r.status_code == 200 and base64.b64decode(r.json()["data"]) == raw and r.json()["mime"] == "image/png"
    assert client.get("/api/attachments/nope/json").status_code == 404


def test_schedules_crud(client):
    login(client)
    pid = client.post("/api/projects", json={"name": "Расписания"}).json()["id"]
    body = {"title": "Сводка", "prompt": "Собери сводку за вчера", "kind": "weekly", "at_time": "08:00",
            "weekdays": [0, 4], "tz": "Asia/Almaty"}
    r = client.post(f"/api/projects/{pid}/schedules", json=body)
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["description"] == "пн, пт в 08:00" and s["next_at"] > time.time() and s["enabled"]
    assert client.get("/api/health").json()["next_wake"] <= s["next_at"]
    assert client.post(f"/api/projects/{pid}/schedules", json={**body, "at_time": "25:00"}).status_code == 400
    assert client.post(f"/api/projects/{pid}/schedules", json={**body, "kind": "once", "run_at": time.time() - 60}).status_code == 400
    r = client.patch(f"/api/schedules/{s['id']}", json={"enabled": False})
    assert r.status_code == 200 and r.json()["next_at"] is None and not r.json()["enabled"]
    r = client.patch(f"/api/schedules/{s['id']}", json={"enabled": True, "kind": "daily", "at_time": "23:59"})
    assert r.status_code == 200 and r.json()["description"] == "каждый день в 23:59" and r.json()["next_at"]
    # на тестовом сервере ключа модели нет — запуск сейчас честно сообщает, почему не выполнен
    r = client.post(f"/api/schedules/{s['id']}/run")
    assert r.status_code == 409 and "нет ключа" in r.json()["detail"]
    assert "нет ключа" in client.get(f"/api/projects/{pid}/schedules").json()[0]["last_status"]
    assert client.delete(f"/api/schedules/{s['id']}").status_code == 200
    assert client.get(f"/api/projects/{pid}/schedules").json() == []


def test_chunked_upload_and_download(client):
    import os

    login(client)
    c = client.post("/api/projects/general/conversations", json={}).json()
    raw = os.urandom(5 * 1024 * 1024 + 123)
    r = client.post(f"/api/conversations/{c['id']}/uploads", json={"filename": "big.tar.gz", "mime": "", "size": len(raw)})
    assert r.status_code == 200, r.text
    upid, step = r.json()["upload_id"], r.json()["chunk_bytes"]
    assert client.post(f"/api/uploads/{upid}/finish").status_code == 409  # ещё не всё
    off = 0
    while off < len(raw):
        part = raw[off:off + step]
        r = client.post(f"/api/uploads/{upid}/chunk", json={"offset": off, "data": base64.b64encode(part).decode()})
        assert r.status_code == 200 and r.json()["got"] == off + len(part)
        # повтор той же части (потерянный ответ) не дублирует данные
        assert client.post(f"/api/uploads/{upid}/chunk", json={"offset": off, "data": base64.b64encode(part).decode()}).json()["got"] == off + len(part)
        off += len(part)
    att = client.post(f"/api/uploads/{upid}/finish").json()
    assert att["size"] == len(raw) and att["filename"] == "big.tar.gz"
    got, off = b"", 0
    while True:
        r = client.get(f"/api/attachments/{att['id']}/chunk?offset={off}").json()
        got += base64.b64decode(r["data"])
        off = len(got)
        if r["eof"]:
            break
    assert got == raw
    big = client.post(f"/api/conversations/{c['id']}/uploads", json={"filename": "x", "size": 51 * 1024 * 1024})
    assert big.status_code == 413


async def test_create_file_tool_and_janitor(client):
    import time

    from app.tools.registry import ToolContext
    from app.tools.repo_tools import create_file, read_attachment

    login(client)
    c = client.post("/api/projects/general/conversations", json={}).json()
    up = client.post(f"/api/conversations/{c['id']}/attachments/json",
                     json={"filename": "a.txt", "data": base64.b64encode(b"hello").decode()}).json()
    ctx = ToolContext(c["id"], main.db(), main.settings, {})
    rep = await create_file(ctx, {"filename": "../отчёт.md", "content": "# Итог\nвсё хорошо"})
    assert rep["attachment"]["filename"] == "отчёт.md" and rep["attachment"]["mime"] == "text/markdown"
    z = await create_file(ctx, {"filename": "pack", "from_attachments": [up["id"], rep["attachment"]["id"]]})
    assert z["attachment"]["filename"] == "pack.zip"
    listing = await read_attachment(ctx, {"attachment_id": z["attachment"]["id"]})
    assert {e["path"] for e in listing["entries"]} == {"a.txt", "отчёт.md"}
    # уборка «неотправленных» не трогает файлы агента (они ни к одному сообщению пользователя не приложены)
    gone = {r["id"] for r in await main.db().unsent_attachments(time.time() + 1)}
    assert up["id"] in gone and rep["attachment"]["id"] not in gone and z["attachment"]["id"] not in gone


def test_talk_mode_project(client):
    login(client)
    assert "talk" not in [p["id"] for p in client.get("/api/projects").json()]  # не среди проектов инжиниринга
    c = client.post("/api/projects/talk/conversations", json={}).json()
    assert c["project_id"] == "talk"
    assert [x["id"] for x in client.get("/api/projects/talk/conversations").json()] == [c["id"]]
    assert client.delete("/api/projects/talk").status_code == 400
    assert client.patch("/api/projects/talk", json={"name": "x"}).status_code == 400
    r = client.post("/api/projects/talk/schedules", json={"title": "t", "prompt": "p", "kind": "daily", "at_time": "09:00"})
    assert r.status_code == 400


async def test_talk_agent_tools_and_prompt(client):
    from app.agent import TALK_PROMPT, Run

    login(client)
    ag = main.agent()
    talk = Run(id="r1", conversation_id="c", model="sakana:x", project_id="talk")
    assert {t.name for t in ag.tools_for(talk)} == {"list_attachments", "read_attachment", "create_file"}
    eng = Run(id="r2", conversation_id="c", model="sakana:x", project_id="general", git_status={"github": None})
    names = {t.name for t in ag.tools_for(eng)}
    assert "memory_save" in names and "commit_files" not in names  # ключа Git нет — инструменты Git не отправляются
    eng.git_status = {"github": "octo"}
    assert "commit_files" in {t.name for t in ag.tools_for(eng)}
    c = client.post("/api/projects/talk/conversations", json={}).json()
    msgs = await ag._build_messages(c["id"], await ag.context(c["id"], run=talk))
    assert msgs[0]["content"] == TALK_PROMPT


def test_vision_downscales_big_photo(tmp_path):
    import io

    from PIL import Image

    from app import vision

    p = tmp_path / "big.jpg"
    Image.effect_noise((4000, 3000), 80).convert("RGB").save(p, "JPEG", quality=98)
    assert p.stat().st_size > 5 << 20  # как фото из галереи: больше прежнего предела 5 МБ
    url = vision.for_model("big", p)
    raw = base64.b64decode(url.split(",", 1)[1])
    im = Image.open(io.BytesIO(raw))
    assert max(im.size) == 1600 and len(raw) < (2 << 20)
    bad = tmp_path / "bad.jpg"
    bad.write_bytes(b"not an image")
    assert vision.for_model("bad", bad) is None
