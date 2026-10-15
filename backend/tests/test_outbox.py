"""Очередь уведомлений: что попадает (без текста переписки), с какого места читать, что устаревает."""
import time

from app.outbox import TTL, Outbox


def test_outbox_since_and_privacy():
    o = Outbox()
    o.add("anna", "approval", "c1", "p1", tool="Запись файлов")
    o.add(None, "done", "c1")  # без адресата не копится
    o.add("anna", "done", "c1", "p1")
    ev = o.since(0)
    assert [e["kind"] for e in ev] == ["approval", "done"]
    assert set(ev[0]) == {"seq", "ts", "user", "kind", "conversation_id", "project_id", "tool"}  # ни слова переписки
    assert [e["kind"] for e in o.since(ev[0]["seq"])] == ["done"]
    assert o.since(ev[-1]["seq"]) == []
    o.items[0]["ts"] = time.time() - TTL - 1
    assert [e["kind"] for e in o.since(0)] == ["done"]  # старше часа — не уведомляем
    assert Outbox().boot != o.boot  # перезапуск — новая очередь
