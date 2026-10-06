import base64
import json

import httpx
import pytest
import respx

from app.tools.providers import FileChange, GitHubProvider, GitLabProvider

GL = "https://gitlab.example.com/api/v4"


@pytest.mark.asyncio
@respx.mock
async def test_gitlab_commit_create_update_delete_on_new_branch():
    p = GitLabProvider("t", "https://gitlab.example.com")
    respx.get(f"{GL}/projects/grp%2Fapp/repository/branches/feat").mock(return_value=httpx.Response(404))
    respx.head(url__regex=rf"{GL}/projects/grp%2Fapp/repository/files/a\.txt.*").mock(return_value=httpx.Response(200))
    respx.head(url__regex=rf"{GL}/projects/grp%2Fapp/repository/files/b\.txt.*").mock(return_value=httpx.Response(404))
    route = respx.post(f"{GL}/projects/grp%2Fapp/repository/commits").mock(
        return_value=httpx.Response(201, json={"id": "abc", "web_url": "u"}))
    res = await p.commit_files("grp/app", "feat", "msg",
                               [FileChange("a.txt", b"1"), FileChange("b.txt", b"2"), FileChange("c.txt", None)],
                               start_from="main")
    body = json.loads(route.calls[0].request.content)
    assert body["start_branch"] == "main"
    assert [a["action"] for a in body["actions"]] == ["update", "create", "delete"]
    assert base64.b64decode(body["actions"][1]["content"]) == b"2"
    assert res["sha"] == "abc"


@pytest.mark.asyncio
@respx.mock
async def test_github_empty_repo_uses_contents_api():
    p = GitHubProvider("t")
    respx.get("https://api.github.com/repos/me/new/git/ref/heads/main").mock(return_value=httpx.Response(409))
    put = respx.put("https://api.github.com/repos/me/new/contents/README.md").mock(
        return_value=httpx.Response(201, json={"commit": {"sha": "s1"}}))
    res = await p.commit_files("me/new", "main", "init", [FileChange("README.md", b"# hi")], None)
    assert put.called and res["sha"] == "s1"


@pytest.mark.asyncio
@respx.mock
async def test_github_error_message_is_readable():
    p = GitHubProvider("t")
    respx.get("https://api.github.com/user").mock(
        return_value=httpx.Response(401, json={"message": "Bad credentials"}))
    with pytest.raises(Exception, match="Bad credentials"):
        await p.whoami()


def test_repair_tool_pairs():
    from app.agent import _repair_tool_pairs
    msgs = [{"role": "user", "content": "x"},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "a"}, {"id": "b"}]},
            {"role": "tool", "tool_call_id": "a", "content": "ok"},
            {"role": "user", "content": "y"}]
    out = _repair_tool_pairs(msgs)
    assert [m.get("tool_call_id") for m in out if m["role"] == "tool"] == ["a", "b"]
