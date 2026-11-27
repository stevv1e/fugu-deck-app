"""Сверка заметок с файлами-источниками: изменился, удалён, вернулся прежний текст, ошибка доступа, пометка человека."""
import json
from types import SimpleNamespace

import pytest

from app import kb_watch
from app.db import Database
from app.tools import memory_tools
from app.tools.providers import ProviderError


class FakeGit:
    def __init__(self):
        self.files: dict[str, bytes] = {}
        self.down = False

    async def read_file(self, repo, path, ref):
        if self.down:
            raise ProviderError("github: сетевая ошибка: timeout")
        if path not in self.files:
            raise ProviderError("github 404: Not Found")
        return self.files[path]


@pytest.fixture()
async def db(tmp_path):
    d = Database(str(tmp_path / "t.sqlite3"))
    await d.connect()
    yield d
    await d.close()


async def note(db, path, version, **kw):
    src = kb_watch.source_file({"provider": "github", "repo": "me/app", "path": path, "version": version})
    return (await db.add_memory("general", f"факт из {path}", src_file=src[0], src_version=src[1], **kw))["id"]


async def test_sources_checked(db):
    git = FakeGit()
    git.files = {"a.md": b"one", "b.md": b"two", "c.md": b"three"}
    a = await note(db, "a.md", kb_watch.version_of(b"one"))
    b = await note(db, "b.md", kb_watch.version_of(b"two"))
    c = await note(db, "c.md", kb_watch.version_of(b"three"))
    plain = (await db.add_memory("general", "без источника"))["id"]
    git.files["a.md"] = b"one, changed"
    del git.files["b.md"]
    t = 1_000_000_000.0
    n = await kb_watch.check_once(db, {"github": git}, now=t)
    assert n == {"fresh": 1, "stale": 2, "skipped": 0}, n
    ma, mb, mc = [await db.get_memory(x) for x in (a, b, c)]
    assert ma["stale"] and "изменился: me/app/a.md" in ma["stale_reason"]
    assert mb["stale"] and "удалён или переименован" in mb["stale_reason"]
    assert not mc["stale"] and mc["src_checked"] == t
    assert (await db.get_memory(plain))["src_checked"] is None
    # раньше чем через сутки не сверяем снова
    assert await kb_watch.check_once(db, {"github": git}, now=t + 3600) == {"fresh": 0, "stale": 0, "skipped": 0}
    # файл вернули — пометка, поставленная сверкой, снимается; ошибка доступа — повтор позже, пометки не трогаем
    git.files["a.md"] = b"one"
    git.down = True
    n = await kb_watch.check_once(db, {"github": git}, now=t + kb_watch.CHECK_EVERY + 1)
    assert n["skipped"] == 3 and (await db.get_memory(a))["stale"]
    git.down = False
    await kb_watch.check_once(db, {"github": git}, now=t + 2 * kb_watch.CHECK_EVERY + 2)
    assert not (await db.get_memory(a))["stale"]


async def test_human_stale_kept(db):
    git = FakeGit()
    git.files = {"a.md": b"one"}
    a = await note(db, "a.md", kb_watch.version_of(b"one"))
    await db.update_memory(a, stale=True)  # человек сам пометил «устарела»
    await kb_watch.check_once(db, {"github": git}, now=1_000_000_000.0)
    assert (await db.get_memory(a))["stale"], "файл не менялся, но пометку человека сверка не снимает"


def test_source_file_validation():
    ok = kb_watch.source_file({"provider": "gitlab", "repo": "g/x", "path": "README.md", "version": "sha256:" + "a" * 16})
    assert ok and json.loads(ok[0]) == {"provider": "gitlab", "repo": "g/x", "path": "README.md"}
    for bad in ({"provider": "svn", "repo": "x", "path": "y", "version": "sha256:" + "a" * 16},
                {"provider": "github", "repo": "x", "path": "y", "version": "abc"}, "строка", None):
        assert kb_watch.source_file(bad) is None


async def test_verification_metadata_distinguishes_fresh_stale_and_unavailable(db):
    git = FakeGit()
    git.files = {"a.md": b"one"}
    mid = await note(db, "a.md", kb_watch.version_of(b"one"))
    now = 1_000_000_000.0
    await kb_watch.check_once(db, {"github": git}, now=now)
    ctx = SimpleNamespace(project_id="general")
    fresh = memory_tools._fmt(await db.get_memory(mid), ctx)["verification"]
    assert fresh["state"] == "fresh" and fresh["last_verified"] == now
    assert fresh["source"] == "me/app/a.md" and fresh["revision"] == kb_watch.version_of(b"one")

    git.down = True
    await kb_watch.check_once(db, {"github": git}, now=now + kb_watch.CHECK_EVERY + 1)
    unavailable = memory_tools._fmt(await db.get_memory(mid), ctx)["verification"]
    assert unavailable["state"] == "unavailable" and unavailable["last_verified"] is None
    assert "не подтверждены" in unavailable["note"]

    await db.update_memory(mid, stale=False, stale_reason="", verification_error=None, src_checked=now + 10)
    recovered = memory_tools._fmt(await db.get_memory(mid), ctx)["verification"]
    assert recovered["state"] == "fresh" and recovered["note"] == ""


async def test_on_demand_verify_returns_current_revision_and_source_evidence(db):
    git = FakeGit()
    original = ("введение\n" * 100 + "Сетевая настройка: порт 443\n" + "продолжение\n" * 100).encode()
    git.files["a.md"] = original
    mid = await note(db, "a.md", kb_watch.version_of(original), title="Сетевая настройка")
    now = 1_000_000_000.0
    fresh = await kb_watch.verify_note(db, {"github": git}, await db.get_memory(mid), now=now, include_evidence=True)
    assert fresh["state"] == "fresh" and fresh["last_verified"] == now
    assert fresh["revision"] == fresh["current_revision"] == kb_watch.version_of(original)
    assert "Сетевая настройка: порт 443" in fresh["source_evidence"] and fresh["source_truncated"] is True

    changed = original.replace(b"443", b"8443")
    git.files["a.md"] = changed
    stale = await kb_watch.verify_note(db, {"github": git}, await db.get_memory(mid), now=now + 10, include_evidence=True)
    assert stale["state"] == "stale" and stale["last_verified"] is None
    assert stale["revision"] == kb_watch.version_of(original) and stale["current_revision"] == kb_watch.version_of(changed)
    assert "8443" in stale["source_evidence"] and "изменился" in stale["note"]


async def test_on_demand_verify_requires_machine_readable_source(db):
    m = await db.add_memory("general", "факт без источника")
    try:
        await kb_watch.verify_note(db, {}, m)
        raise AssertionError("проверка без источника принята")
    except ValueError as e:
        assert "нет машинно проверяемого" in str(e)
