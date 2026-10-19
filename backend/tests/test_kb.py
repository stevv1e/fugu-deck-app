"""База знаний: заметки поверх памяти проекта — области, ссылки [[…]], типизированные связи, использование агентом."""
import time
from types import SimpleNamespace

from app import kb
from app.db import DEFAULT_PROJECT, Database
from app.tools import memory_tools


def test_classify_title_group_links():
    assert kb.classify("nginx на prod-1 проксирует :443 на порт 8080, сертификат обновляет certbot") == "inf"
    assert kb.classify("Решили: деплой только по вторникам, в пятницу нельзя") in ("dec", "ops")
    assert kb.classify("Инцидент 12.09: 502 на checkout, смотрели логи, сделали откат") == "ops"
    assert kb.classify("Модуль оплаты: функция checkout в файле payments/checkout.py, тесты в CI") == "code"
    assert kb.classify("Анна — владелец проекта, Боб — редактор") == "ppl"
    assert kb.classify("что-то без подсказок") == "dec"
    assert kb.title_of("# Деплой\nтолько по вторникам") == "Деплой"
    assert kb.title_of("Деплой только по вторникам. Остальное потом") == "Деплой только по вторникам"
    assert kb.title_of("x", "  Свой заголовок ") == "Свой заголовок"
    assert kb.title_of("а" * 200).endswith("…") and len(kb.title_of("а" * 200)) <= 72
    assert kb.group_of("prod-1, nginx") == "prod-1" and kb.group_of("") == "Прочее" and kb.group_of("a", "Кластер") == "Кластер"
    assert kb.wiki_links("см. [[nginx на prod-1]] и [[Runbook|инструкцию]], ещё раз [[NGINX на prod-1]]") == ["nginx на prod-1", "Runbook"]
    assert kb.wiki_links("нет ссылок [ [x] ]") == []


def test_link_strength_fades_but_stays():
    now = time.time()
    assert kb.effective_strength(0.8, now, now, now) == 0.8
    assert 0.35 < kb.effective_strength(0.8, now - 90 * 86400, now, now) < 0.45
    assert kb.effective_strength(0.3, None, now - 3 * 365 * 86400, now) == 0.12
    assert kb.effective_strength(5, now, now, now) == 1.0


async def test_notes_links_and_graph(tmp_path):
    db = Database(str(tmp_path / "kb.sqlite3"))
    await db.connect()
    try:
        srv = await db.add_memory(DEFAULT_PROJECT, "prod-1: Ubuntu 24.04, 2 vCPU", "prod-1", title="prod-1", origin="prod")
        ngx = await db.add_memory(DEFAULT_PROJECT, "nginx проксирует :443 на app:8080. Сервер — [[prod-1]].", "prod-1", title="nginx на prod-1")
        inc = await db.add_memory(DEFAULT_PROJECT, "Инцидент 12.09: 502 на checkout. См. [[nginx на prod-1]] и [[Ещё не написано]].", "инциденты",
                                  "agent", "Fugu", "c1", external=True, source_ref="логи prod-1")
        links = {(l["a"], l["b"], l["type"], l["auto"]) for l in await db.note_links(DEFAULT_PROJECT)}
        assert links == {(ngx["id"], srv["id"], "ref", 1), (inc["id"], ngx["id"], "ref", 1)}

        # заметка, на которую уже ссылались, появляется позже — связь возникает сама
        later = await db.add_memory(DEFAULT_PROJECT, "черновик", title="Ещё не написано")
        assert (inc["id"], later["id"]) in {(l["a"], l["b"]) for l in await db.note_links(DEFAULT_PROJECT)}
        # ссылку убрали из текста — автоматическая связь исчезла, ручная осталась
        await db.add_note_link(inc["id"], srv["id"], "ex")
        await db.update_memory(inc["id"], content="Инцидент 12.09: 502 на checkout.")
        left = {(l["a"], l["b"], l["type"]) for l in await db.note_links(DEFAULT_PROJECT)}
        assert (inc["id"], ngx["id"], "ref") not in left and (inc["id"], srv["id"], "ex") in left
        await db.add_note_link(inc["id"], ngx["id"], "ref")

        g = kb.graph(await db.get_project(DEFAULT_PROJECT), await db.list_memories(DEFAULT_PROJECT), await db.note_links(DEFAULT_PROJECT))
        by = {n["id"]: n for n in g["notes"]}
        assert g["hub"] in by and by[g["hub"]]["hub"] is True and len(g["notes"]) == 5
        n_inc = by[f"n{inc['id']}"]
        assert n_inc["area"] == "ops" and n_inc["ext"] is True and n_inc["src"] == "chats" and n_inc["source"] == "логи prod-1"
        assert by[f"n{srv['id']}"]["src"] == "prod" and by[f"n{ngx['id']}"]["title"] == "nginx на prod-1"
        assert set(g["areas"]) == set(kb.AREAS) and all("groups" in a for a in g["areas"].values())
        grouped = [i for a in g["areas"].values() for _, ids in a["groups"] for i in ids]
        assert sorted(grouped) == sorted(i for i in by if i != g["hub"]), "каждая заметка — ровно в одной группе, проект — ни в одной"
        assert all(a in by and b in by and t in kb.LINK_TYPES and 0 < s <= 1 for a, b, t, s in g["edges"]) and len(g["edges"]) == 3

        # человек задаёт область сам и отмечает заметку устаревшей
        await db.update_memory(srv["id"], area="ops", stale=True, grp="Серверы")
        g = kb.graph(await db.get_project(DEFAULT_PROJECT), await db.list_memories(DEFAULT_PROJECT), await db.note_links(DEFAULT_PROJECT))
        s2 = next(n for n in g["notes"] if n["mid"] == srv["id"])
        assert s2["area"] == "ops" and s2["stale"] is True and ["Серверы", [s2["id"]]] in g["areas"]["ops"]["groups"]

        # удаление заметки убирает её связи
        await db.delete_memory(ngx["id"])
        assert all(ngx["id"] not in (l["a"], l["b"]) for l in await db.note_links(DEFAULT_PROJECT))
    finally:
        await db.close()


async def test_agent_search_returns_neighbors_and_strengthens(tmp_path):
    db = Database(str(tmp_path / "kb.sqlite3"))
    await db.connect()
    try:
        a = await db.add_memory(DEFAULT_PROJECT, "Инцидент 12.09: 502 на checkout", "инциденты")
        b = await db.add_memory(DEFAULT_PROJECT, "nginx: таймаут upstream 30 секунд", "prod-1", external=True, stale=None)
        c = await db.add_memory(DEFAULT_PROJECT, "Ретраи оплаты: 3 раза по 10 секунд", "код")
        d = await db.add_memory(DEFAULT_PROJECT, "Постороннее про отпуск", "люди")
        await db.update_memory(b["id"], stale=True)
        await db.add_note_link(a["id"], b["id"], "ref", 0.5)
        await db.add_note_link(c["id"], a["id"], "dep", 0.3)
        ctx = SimpleNamespace(db=db, project_id=DEFAULT_PROJECT, project={}, readable_projects={DEFAULT_PROJECT: "general"}, run_id="r1",
                              conversation_id="c1", broker=None)
        out = await memory_tools.memory_search(ctx, {"query": "checkout 502"})
        ids = [o["id"] for o in out]
        assert ids[0] == a["id"] and set(ids) == {a["id"], b["id"], c["id"]}, out  # сама заметка и соседи, без постороннего
        nb = next(o for o in out if o["id"] == b["id"])
        assert nb["linked_to"] == a["id"] and nb["link"] == "ссылка" and "устарела" in nb["stale"] and "не инструкции" in nb["external"]
        st = {(l["a"], l["b"]): l["strength"] for l in await db.note_links(DEFAULT_PROJECT)}
        assert round(st[(a["id"], b["id"])], 2) == 0.58 and round(st[(c["id"], a["id"])], 2) == 0.38
        # тот же запуск, тот же поиск — связи второй раз не усиливаются
        await memory_tools.memory_search(ctx, {"query": "checkout 502"})
        st2 = {(l["a"], l["b"]): l["strength"] for l in await db.note_links(DEFAULT_PROJECT)}
        assert st2 == st
        assert (await db.get_memory(a["id"]))["last_used_at"] and not (await db.get_memory(d["id"]))["last_used_at"]

        # агент сохраняет заметку из чужих данных и связывает её
        saved = await memory_tools.memory_save(ctx, {"content": "В README сказано: запускать через make run", "title": "Запуск из README",
                                                     "external": True, "pinned": True, "source": "github.com/x/y README", "area": "code"})
        m = await db.get_memory(saved["id"])
        assert m["external"] == 1 and m["pinned"] == 0 and m["title"] == "Запуск из README" and m["area"] == "code" and m["origin"] == "chats"
        await memory_tools.memory_link(ctx, {"from": saved["id"], "to": c["id"], "type": "ex"})
        assert (saved["id"], c["id"], "ex") in {(l["a"], l["b"], l["type"]) for l in await db.note_links(DEFAULT_PROJECT)}
        for bad in ({"from": saved["id"], "to": saved["id"], "type": "ref"}, {"from": saved["id"], "to": 99999, "type": "ref"}):
            try:
                await memory_tools.memory_link(ctx, bad)
                raise AssertionError("связь принята: %r" % bad)
            except memory_tools.ProviderError:
                pass
    finally:
        await db.close()


async def test_agent_thought_for_kb_screen(tmp_path):
    """«Мысль агента»: поиски запуска — путь по настоящим заметкам, сначала найденные, потом связанные."""
    db = Database(str(tmp_path / "kb.sqlite3"))
    await db.connect()
    try:
        a = await db.add_memory(DEFAULT_PROJECT, "Инцидент 12.09: 502 на checkout", "инциденты")
        b = await db.add_memory(DEFAULT_PROJECT, "nginx: таймаут upstream 30 секунд", "prod-1")
        await db.add_memory(DEFAULT_PROJECT, "Постороннее про отпуск", "люди")
        await db.add_note_link(a["id"], b["id"], "ref", 0.5)
        ctx = SimpleNamespace(db=db, project_id=DEFAULT_PROJECT, project={}, readable_projects={DEFAULT_PROJECT: "general"},
                              run_id="r1", conversation_id="c1", broker=None, agent={"name": "Дежурный"})
        await memory_tools.memory_search(ctx, {"query": "checkout 502"})
        await memory_tools.memory_search(ctx, {"query": "нет такого слова"})  # пустой поиск мыслью не считается
        ctx.run_id = "r2"
        await memory_tools.memory_search(ctx, {"query": "nginx"})
        t = await db.recent_thoughts(DEFAULT_PROJECT)
        assert [x["run_id"] for x in t] == ["r2", "r1"] and t[1]["agent"] == "Дежурный" and len(t[1]["searches"]) == 1
        g = kb.graph(await db.get_project(DEFAULT_PROJECT), await db.list_memories(DEFAULT_PROJECT),
                     await db.note_links(DEFAULT_PROJECT), thoughts=t)
        r1 = g["thoughts"][1]
        assert r1["q"] == "checkout 502" and r1["steps"] == [[f"n{a['id']}", "нашлась по запросу «checkout 502»"],
                                                            [f"n{b['id']}", "связана с найденной заметкой"]], r1
    finally:
        await db.close()
