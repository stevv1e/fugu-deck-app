import asyncio
import json

import pytest

from app.agent import Agent, Run
from app.llm import LLMResult, Usage
from app.tools import REGISTRY
from tests.test_devices import client, main  # noqa: F401
from tests.test_api_extra import login


def call(call_id="call-1", name="memory_search"):
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": '{"query":"checkpoint"}'}}


async def test_durable_run_reloads_and_resumes_without_repeating_tool(client, monkeypatch):
    login(client)
    cid = client.post("/api/projects/general/conversations", json={}).json()["id"]
    await main.db().add_message(cid, "user", "Продолжи работу")
    user = {"id": "u1", "display_name": "Owner", "role": "owner"}
    monkeypatch.setattr(main.settings, "max_agent_steps", 1)
    executions = 0
    async def handler(ctx, args):
        nonlocal executions
        executions += 1
        return {"results": [], "checkpoint": True}

    monkeypatch.setattr(REGISTRY["memory_search"], "handler", handler)
    agent = main.agent()
    answers = 0

    async def first_stream(run, messages):
        nonlocal answers
        answers += 1
        return LLMResult("", [call()], Usage(prompt_tokens=100, completion_tokens=10))

    monkeypatch.setattr(agent, "_stream", first_stream)
    run = await agent.start(cid, "sakana:fugu-max-v1.0", user, "general")
    await run.task
    assert run.status == "paused" and run.step == 1 and executions == 1
    assert run.total_tokens == 110

    reloaded = Agent(main.db(), main.settings, {})
    restored = await reloaded.get_run(run.id)
    assert restored.status == "paused" and restored.step == 1
    assert restored.total_tokens == 110
    assert [event["type"] for event in restored.events][-1] == "done"

    async def final_stream(run, messages):
        return LLMResult("Продолжение завершено", [], Usage(prompt_tokens=50, completion_tokens=5))

    monkeypatch.setattr(reloaded, "_stream", final_stream)

    async def access(c, u, wanted):
        return record["model"], {}, None, None

    record = await main.db().get_run(run.id)
    monkeypatch.setattr(main, "_llm_access", access)
    main.state["agent"] = reloaded
    try:
        response = client.post(f"/api/conversations/{cid}/retry")
        assert response.status_code == 200 and response.json()["run_id"] == run.id
        assert response.json()["resumed"] is True and response.json()["step"] == 1
        for _ in range(100):
            if reloaded.runs[run.id].status != "running":
                break
            await asyncio.sleep(0.02)
    finally:
        main.state["agent"] = agent
    assert executions == 1
    assert reloaded.runs[run.id].status == "done"
    assert reloaded.runs[run.id].total_tokens == 165
    messages = await main.db().get_messages(cid)
    assert sum(1 for message in messages if message["role"] == "tool" and message["tool_call_id"] == "call-1") == 1
    assert messages[-1]["content"] == "Продолжение завершено"
    changed = call()
    changed["function"]["arguments"] = '{"query":"другая операция"}'
    rejected = json.loads(await reloaded._exec_tool(reloaded.runs[run.id], changed))
    assert "уже использован" in rejected["error"] and executions == 1


async def test_uncertain_write_is_not_replayed(client):
    login(client)
    cid = client.post("/api/projects/general/conversations", json={}).json()["id"]
    await main.db().add_message(cid, "user", "Измени файл")
    await main.db().add_message(cid, "assistant", "", tool_calls=[call("write-1", "commit_files")])
    agent = main.agent()
    run = Run(id="uncertain", conversation_id=cid, model="sakana:fugu-max-v1.0", project_id="general",
              user={"id": "u1"}, status="interrupted", step=1)
    await main.db().save_run(run)
    await main.db().save_run_tool(run.id, "write-1", "commit_files", {"path": "a.py"}, "write", "running")
    with pytest.raises(RuntimeError, match="небезопасно"):
        await agent.resume(run.id, {"id": "u1", "display_name": "Owner"})
    restored = await main.agent().get_run(run.id)
    assert restored.status == "interrupted" and restored.task is None
