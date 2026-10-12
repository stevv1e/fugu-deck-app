"""Удаление чата убирает всю переписку и отдаёт пути вложений на удаление — в базе ничего не остаётся."""

from app.db import DEFAULT_PROJECT, Database


async def test_delete_conversation_cascades(tmp_path):
    db = Database(str(tmp_path / "t.sqlite3"))
    await db.connect()
    try:
        tables = [r["name"] for r in await db._all("SELECT name FROM sqlite_master WHERE type='table'")]
        keep = await db.create_conversation("sakana:fugu", DEFAULT_PROJECT, None, "оставить")
        gone = await db.create_conversation("sakana:fugu", DEFAULT_PROJECT, None, "удалить")
        for c in (keep, gone):
            await db.add_message(c["id"], "user", "привет")
            await db.add_message(c["id"], "assistant", "ответ")
        await db.delete_conversation(gone["id"])
        assert await db.get_conversation(gone["id"]) is None
        assert await db.get_conversation(keep["id"]) is not None
        # Ни в одной таблице не осталось строк удалённого чата.
        for t in tables:
            cols = [r["name"] for r in await db._all(f"PRAGMA table_info({t})")]
            if "conversation_id" in cols:
                left = await db._all(f"SELECT 1 FROM {t} WHERE conversation_id=?", (gone["id"],))
                assert not left, f"в таблице {t} остались строки удалённого чата"
        assert len(await db._all("SELECT 1 FROM messages WHERE conversation_id=?", (keep["id"],))) == 2
    finally:
        await db.close()
