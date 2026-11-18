import httpx

from app.tools.providers import GitHubProvider, GitLabProvider
from tests.test_devices import client, main  # noqa: F401
from tests.test_api_extra import login


async def test_github_compare_normalizes_files():
    provider = GitHubProvider("token")
    await provider.http.aclose()
    provider.http = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={
        "ahead_by": 2, "behind_by": 1,
        "files": [{"filename": "app.py", "status": "modified", "patch": "@@ -1 +1 @@"}],
    })), base_url="https://api.github.com")
    result = await provider.compare("owner/repo", "main", "feature")
    assert result["ahead_by"] == 2 and result["files"][0]["path"] == "app.py"
    await provider.http.aclose()


async def test_gitlab_compare_normalizes_files():
    provider = GitLabProvider("token")
    await provider.http.aclose()
    provider.http = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={
        "commits": [{"id": "a"}], "diffs": [{"new_path": "new.py", "new_file": True, "diff": "+print()"}],
    })), base_url="https://gitlab.com/api/v4")
    result = await provider.compare("group/repo", "main", "feature")
    assert result["ahead_by"] == 1 and result["files"] == [{"path": "new.py", "status": "added", "patch": "+print()"}]
    await provider.http.aclose()


async def test_manual_terminal_run(client, monkeypatch):
    login(client)
    conversation = client.post("/api/projects/general/conversations", json={}).json()
    calls = []

    async def execute(run, call):
        calls.append(call)
        await run.emit("tool_end", call_id=call["id"], name="ssh_exec", ok=True, result={"stdout": "active"})
        return '{"stdout":"active","exit_code":0}'

    agent = main.agent()
    monkeypatch.setattr(agent, "_exec_tool", execute)
    run = await agent.start_terminal(conversation["id"], {"id": "u1", "display_name": "Owner"}, "srv", "systemctl status x")
    await run.task
    assert run.status == "done" and calls[0]["function"]["name"] == "ssh_exec"
    assert [e["type"] for e in run.events] == ["start", "tool_end", "terminal_result", "done"]
    assert run.events[2]["result"]["exit_code"] == 0
    listed = client.get("/api/workspace/runs").json()
    assert any(item["run_id"] == run.id and item["terminal"] for item in listed)
