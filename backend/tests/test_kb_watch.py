"""Сверка заметок с файлами-источниками: изменился, удалён, вернулся прежний текст, ошибка доступа, пометка человека."""
import json

import pytest

from app import kb_watch
from app.db import Database
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
