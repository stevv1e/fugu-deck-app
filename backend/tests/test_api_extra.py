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


def test_vision_huge_jpeg_low_memory(tmp_path):
    """Фото на 100+ Мп уменьшается без раскодирования целиком: памяти — десятки МБ, а не сотни."""
    import subprocess
    import sys

    p = tmp_path / "huge.jpg"
    # 12000×10000 = 120 Мп, как фото с камеры 108–200 Мп; создаём в отдельном процессе
    subprocess.run([sys.executable, "-c", f"from PIL import Image; Image.new('RGB',(12000,10000),(90,140,200)).save({str(p)!r},'JPEG',quality=90)"], check=True)
    code = f"""
import base64, io, re
from pathlib import Path
from PIL import Image
from app import vision
def hwm():
    return int(re.search(r"VmHWM:\\s+(\\d+)", open("/proc/self/status").read()).group(1)) // 1024
open("/proc/self/clear_refs", "w").write("5")  # сбросить пик памяти (унаследованный от pytest при fork)
base = hwm()
url = vision.for_model('h', Path({str(p)!r}))
im = Image.open(io.BytesIO(base64.b64decode(url.split(',',1)[1])))
print(max(im.size), hwm() - base)
"""
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True).stdout.split()
    side, rss_mb = int(out[0]), int(out[1])
    assert side == 1600
    assert rss_mb < 150, f"рост памяти {rss_mb} МБ — картинка раскодирована целиком (целиком было бы ~700)"
    # огромная картинка не в JPEG — отказ (None), а не сотни МБ в памяти
    png = tmp_path / "huge.png"
    subprocess.run([sys.executable, "-c", f"from PIL import Image; Image.new('L',(8000,4000)).save({str(png)!r})"], check=True)
    from app import vision
    assert vision.for_model("p", png) is None


async def test_interrupted_runs_marked_and_retry(client):
    login(client)
    db = main.db()
    pid = client.post("/api/projects", json={"name": "Прерывания"}).json()["id"]
    mk = lambda: client.post(f"/api/projects/{pid}/conversations", json={}).json()["id"]  # noqa: E731
    done, asked, tooled = mk(), mk(), mk()
    await db.add_message(done, "user", "привет")
    await db.add_message(done, "assistant", "здравствуйте")
    await db.add_message(asked, "user", "опиши фото")  # агент упал, не ответив
    await db.add_message(tooled, "user", "сделай")
    await db.add_message(tooled, "assistant", "", tool_calls=[{"id": "t1", "type": "function", "function": {"name": "x", "arguments": "{}"}}])
    await db.add_message(tooled, "tool", "{}", tool_call_id="t1", name="x")

    assert await main.mark_interrupted() == 2
    assert await main.mark_interrupted() == 0  # повторный запуск не множит пометки
    for cid in (asked, tooled):
        notes = [m for m in client.get(f"/api/conversations/{cid}").json()["messages"] if m["role"] == "note"]
        assert notes and notes[-1]["meta"]["interrupted"]
    assert not [m for m in client.get(f"/api/conversations/{done}").json()["messages"] if m["role"] == "note"]

    # повтор: на отвеченном чате — нечего повторять; на прерванном — ключа модели на тестовом сервере нет
    assert client.post(f"/api/conversations/{done}/retry").status_code == 409
    r = client.post(f"/api/conversations/{asked}/retry")
    assert r.status_code == 400 and "ключ" in r.json()["detail"]


def test_vision_target_sizes(tmp_path):
    from PIL import Image

    from app import vision

    assert vision.target(4000, 3000) == (1600, 1200)        # обычное фото — длинная сторона 1600
    assert vision.target(7532, 16320) == (1024, 2219)       # длинный скриншот — короткая сторона 1024
    assert vision.target(1000, 20000) == (154, 3072)        # очень узкая полоса — длинная не больше 3072
    assert vision.target(800, 600) == (800, 600)            # маленькую не увеличиваем
    # EXIF-поворот на 90°: в файле 4000×3000, на экране 3000×4000
    p = tmp_path / "rot.jpg"
    im = Image.new("RGB", (4000, 3000), (10, 20, 30))
    ex = im.getexif()
    ex[0x0112] = 6
    im.save(p, "JPEG", exif=ex)
    import base64
    import io
    url = vision.for_model("rot", p)
    assert Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1]))).size == (1200, 1600)


async def test_project_repos(client):
    from app.tools.registry import ToolContext
    from app.tools.repo_tools import project_repo_set, project_repos

    login(client)
    pid = client.post("/api/projects", json={"name": "Репы"}).json()["id"]
    r = client.patch(f"/api/projects/{pid}", json={"repos": [{"provider": "github", "repo": "anna/site"},
                                                              {"provider": "github", "repo": "Anna/Site"},
                                                              {"provider": "gitlab", "repo": "grp/sub/app"}]})
    assert r.status_code == 200 and r.json()["repos"] == [{"provider": "github", "repo": "anna/site"},
                                                          {"provider": "gitlab", "repo": "grp/sub/app"}]
    assert client.patch(f"/api/projects/{pid}", json={"repos": [{"provider": "bitbucket", "repo": "a/b"}]}).status_code == 422
    assert client.patch(f"/api/projects/{pid}", json={"repos": [{"provider": "github", "repo": "../x"}]}).status_code == 422
    proj = await main.db().get_project(pid)
    ctx = ToolContext("c", main.db(), main.settings, {}, project=proj)
    await project_repo_set(ctx, {"provider": "github", "repo": "anna/new", "on": True})
    await project_repo_set(ctx, {"provider": "github", "repo": "ANNA/SITE", "on": False})
    assert await project_repos(ctx, {}) == [{"provider": "gitlab", "repo": "grp/sub/app"}, {"provider": "github", "repo": "anna/new"}]
    ctx.project = await main.db().get_project(pid)  # агент перечитывает проект на каждом шаге
    msgs = await main.agent()._build_messages("нет", ctx)
    assert "anna/new" in msgs[0]["content"] and "Репозитории проекта" in msgs[0]["content"]
    assert client.get("/api/repos").status_code == 200  # без ключей Git — пустой ответ, а не ошибка


async def test_sponsor_thresholds_and_by_member(client):
    login(client)
    db = main.db()
    c = client.post("/api/projects/general/conversations", json={}).json()
    await db.set_sponsor(c["id"], "sakana:fugu-max-v1.0", "sp1", limit_usd=10)
    hits = []
    for cost in (3, 2.5, 0.1, 3, 2):  # 30 %, 55 %, 56 %, 86 %, 106 %
        await db.add_usage(c["id"], "m", 1, 1, 0, cost, "member1", "sp1")
        if hit := await db.sponsor_threshold(c["id"]):
            hits.append(hit)
    assert hits == [("sp1", 50), ("sp1", 80), ("sp1", 100)]  # каждый порог — один раз
    await db.set_sponsor_limits(c["id"], sponsor_limit_usd=100)  # лимит подняли — пороги заново
    await db.add_usage(c["id"], "m", 1, 1, 0, 45, "member2", "sp1")
    assert await db.sponsor_threshold(c["id"]) == ("sp1", 50)
    by = await db.chat_usage_by_member(c["id"], 0)
    assert [(x["user_id"], x["usd"]) for x in by] == [("member2", 45), ("member1", 10.6)]


async def test_agents(client):
    from app.agent import Run

    login(client)
    assert [a["id"] for a in client.get("/api/agents").json()] == ["fugu"]
    bad = client.put("/api/agents/Duty", json={"name": "x"})
    assert bad.status_code == 400
    assert client.put("/api/agents/duty", json={"name": "Дежурный", "tools": ["root"]}).status_code == 400
    r = client.put("/api/agents/duty", json={"name": "Дежурный", "tools": ["ssh", "files"], "skills": [],
                                             "instructions": "Только смотри, ничего не меняй."})
    assert r.status_code == 200 and r.json()["tools"] == ["ssh", "files"]
    c = client.post("/api/projects/general/conversations", json={"agent_id": "duty"}).json()
    assert c["agent_id"] == "duty" and client.get(f"/api/conversations/{c['id']}").json()["agent"]["name"] == "Дежурный"
    ag = main.agent()
    run = Run(id="r", conversation_id=c["id"], model="sakana:x", project_id="general", git_status={"github": "octo"},
              agent=await main.db().get_agent("duty"))
    names = {t.name for t in ag.tools_for(run)}
    assert "commit_files" not in names and "memory_save" not in names and "read_attachment" in names
    ctx = await ag.context(c["id"], run=run)
    msgs = await ag._build_messages(c["id"], ctx)
    assert "Дежурный" in msgs[0]["content"] and "Только смотри" in msgs[0]["content"] and ctx.agent_id == "duty"
    # чат можно передать другому агенту; удаление агента возвращает чаты агенту по умолчанию
    assert client.patch(f"/api/conversations/{c['id']}", json={"agent_id": "nope"}).status_code == 400
    assert client.delete("/api/agents/fugu").status_code == 400
    assert client.delete("/api/agents/duty").status_code == 200
    assert client.get(f"/api/conversations/{c['id']}").json()["agent"]["id"] == "fugu"


async def test_obsidian_roundtrip(client):
    import base64, io, zipfile

    login(client)
    a = client.post("/api/projects/general/memory", json={"content": "Бэкап базы каждую ночь в 3:00", "title": "Бэкап"}).json()
    b = client.post("/api/projects/general/memory", json={"content": "Порядок восстановления. См. [[Бэкап]]", "title": "Восстановление"}).json()
    assert client.post(f"/api/memory/{b['id']}/links", json={"to": a["id"], "type": "dep"}).status_code == 200
    ex = client.get("/api/projects/general/kb/obsidian").json()
    z = zipfile.ZipFile(io.BytesIO(base64.b64decode(ex["data"])))
    files = {n.split("/")[-1]: z.read(n).decode() for n in z.namelist()}
    assert "Восстановление.md" in files and "- зависит от: [[Бэкап]]" in files["Восстановление.md"]
    assert files["Бэкап.md"].startswith("---\ntitle: \"Бэкап\"")
    # обратно — в другой проект: заметки, связь «зависит от» и ссылка из текста
    pid = client.post("/api/projects", json={"name": "Копия"}).json()["id"]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as w:
        for n in z.namelist():
            w.writestr(n, z.read(n))
        w.writestr("vault/.obsidian/app.json", "{}")
        w.writestr("vault/Свободная.md", "# Без заголовочной части\nтекст")
    r = client.post(f"/api/projects/{pid}/kb/obsidian", json={"data": base64.b64encode(buf.getvalue()).decode()})
    assert r.status_code == 200 and r.json() == {"created": 3, "links": 1}, r.text
    kbd = client.get(f"/api/projects/{pid}/kb").json()
    types = sorted(e[2] for e in kbd["edges"])
    assert types == ["dep", "ref"], kbd["edges"]
    assert client.post(f"/api/projects/{pid}/kb/obsidian", json={"data": base64.b64encode(b"nope").decode()}).status_code == 400


async def test_memory_search_forms_and_links(client):
    login(client)
    pid = client.post("/api/projects", json={"name": "Поиск"}).json()["id"]
    a = client.post(f"/api/projects/{pid}/memory", json={"content": "Резервные копии базы данных делаются каждую ночь"}).json()
    b = client.post(f"/api/projects/{pid}/memory", json={"content": "Порядок восстановления: остановить приложение, затем pg_restore"}).json()
    client.post(f"/api/projects/{pid}/memory", json={"content": "Сервер базы — db-1"})
    client.post(f"/api/memory/{b['id']}/links", json={"to": a["id"], "type": "dep"})
    rows = client.get(f"/api/projects/{pid}/memory", params={"q": "резервная копия базы"}).json()
    assert rows[0]["id"] == a["id"]  # больше слов запроса — выше
    near = [r for r in rows if r.get("linked_to")]
    assert [r["id"] for r in near] == [b["id"]]
    from app.kb import stems
    assert stems("бэкапы на серверах") == ["бэкап", "сервер"]


async def test_llm_ready_from_keyguard(client, monkeypatch):
    """В кластере ключи — в keyguard: «ключ есть» только у провайдеров, для которых владелец его ввёл."""
    from app import keyguard_client as kgc

    login(client)
    monkeypatch.setattr(kgc, "enabled", lambda: True)
    monkeypatch.setattr(kgc, "token", lambda: "tok")

    async def mine():
        return {"deepseek"}
    monkeypatch.setattr(kgc, "my_llm_providers", mine)
    assert client.get("/api/config").json()["llm_ready"] == ["deepseek"]
    c = client.post("/api/projects/general/conversations", json={}).json()
    r = client.post(f"/api/conversations/{c['id']}/messages", json={"content": "hi", "model": "sakana:fugu-max-v1.0"})
    assert r.status_code == 400 and "Токены моделей" in r.json()["detail"], r.text
