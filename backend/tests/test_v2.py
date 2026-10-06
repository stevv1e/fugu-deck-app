import sqlite3
import time

import pytest

from app.db import SCHEMA, Database
from app.skills import SkillError, SkillStore


def test_skill_store_roundtrip(tmp_path):
    st = SkillStore(tmp_path / "skills")
    st.seed()
    names = [s["name"] for s in st.list()]
    assert "conventional-commits" in names
    st.save("my-skill", "Когда деплоим", "# Шаги\n1. тест")
    s = st.get("my-skill")
    assert s["description"] == "Когда деплоим" and "1. тест" in s["body"]
    st.save("my-skill-2", "d", "b", rename_from="my-skill")
    assert "my-skill" not in [s["name"] for s in st.list()]
    with pytest.raises(SkillError):
        st.save("../evil", "d", "b")
    with pytest.raises(SkillError):
        st.read_file("my-skill-2", "../../etc/passwd")


@pytest.mark.asyncio
async def test_migration_from_v1_keeps_chats(tmp_path):
    path = tmp_path / "old.sqlite3"
    con = sqlite3.connect(path)
    con.executescript(SCHEMA[0])
    con.execute("CREATE TABLE schema_version (v INTEGER)")
    con.execute("INSERT INTO schema_version VALUES (1)")
    con.execute("INSERT INTO conversations (id,title,model,created_at,updated_at) VALUES ('c1','old','m',?,?)",
                (time.time(), time.time()))
    con.commit()
    con.close()
    db = Database(str(path))
    await db.connect()
    convs = await db.list_conversations("general")
    assert [c["id"] for c in convs] == ["c1"]
    await db.add_memory("general", "Прод на Алматы", "infra")
    res = await db.search_memories(["general"], "алматы")
    assert res and res[0]["content"] == "Прод на Алматы"
    await db.close()
