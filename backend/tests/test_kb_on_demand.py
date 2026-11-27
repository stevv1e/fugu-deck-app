"""HTTP: короткие доказательства в поиске и on-demand сверка заметки с Git-источником."""
from app import kb_watch
from tests.test_api_extra import login
from tests.test_devices import client, main  # noqa: F401  (общий сервер в процессе)


class FakeGit:
    def __init__(self, raw: bytes):
        self.raw = raw

    async def read_file(self, repo, path, ref):
        return self.raw


def test_search_evidence_and_verify_endpoint(client):
    login(client)
    pid = client.post("/api/projects", json={"name": "Проверка источника"}).json()["id"]
    original = ("введение\n" * 100 + "needle: порт 443\n" + "продолжение\n" * 100).encode()
    src = kb_watch.source_file({"provider": "github", "repo": "me/app", "path": "docs/runbook.md",
                                "version": kb_watch.version_of(original)})

    async def add():
        return await main.db().add_memory(pid, "начало " * 100 + "needle: порт 443 " + "конец " * 100,
                                         title="Сетевой runbook", src_file=src[0], src_version=src[1])

    m = client.portal.call(add)
    git = FakeGit(original)
    main.state["providers"]["github"] = git
    try:
        found = client.get(f"/api/projects/{pid}/memory", params={"q": "needle", "linked": "true"}).json()
        assert found[0]["truncated"] is True and len(found[0]["content"]) <= 362
        assert found[0]["source"] == "me/app/docs/runbook.md" and found[0]["can_verify"] is True

        fresh = client.post(f"/api/memory/{m['id']}/verify")
        assert fresh.status_code == 200, fresh.text
        result = fresh.json()
        assert result["state"] == "fresh" and result["current_revision"] == result["revision"]
        assert "needle: порт 443" in result["source_evidence"]

        git.raw = original.replace(b"443", b"8443")
        stale = client.post(f"/api/memory/{m['id']}/verify").json()
        assert stale["state"] == "stale" and stale["current_revision"] != stale["revision"]
        assert "8443" in stale["source_evidence"]
        graph = client.get(f"/api/projects/{pid}/kb").json()
        note = next(n for n in graph["notes"] if n["mid"] == m["id"])
        assert note["verification_state"] == "stale" and note["can_verify"] is True

        plain = client.post(f"/api/projects/{pid}/memory", json={"content": "без источника"}).json()
        assert client.post(f"/api/memory/{plain['id']}/verify").status_code == 400
    finally:
        main.state["providers"].pop("github", None)
