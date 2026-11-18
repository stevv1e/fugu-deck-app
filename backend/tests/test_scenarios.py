import pytest

from app.agent import Agent, Run
from app.config import Settings
from app.llm import LLMError, LLMResult
from tests.test_devices import client, main  # noqa: F401
from tests.test_api_extra import login


async def test_fallback_only_before_output(monkeypatch):
    import app.agent as module

    agent = Agent.__new__(Agent)
    agent.settings = Settings()
    agent.tools_for = lambda run: []

    class Failed:
        def __init__(self, partial=False): self.partial = partial
        async def stream(self, key, model, messages, tools, on_text, on_tool, headers=None):
            if self.partial:
                await on_text("часть")
            raise LLMError("provider unavailable")

    class Good:
        async def stream(self, key, model, messages, tools, on_text, on_tool, headers=None):
            await on_text("ok")
            return LLMResult("ok", [], None)

    failed, good = Failed(), Good()
    monkeypatch.setattr(module, "get_provider", lambda name, settings: failed if name == "openai" else good)
    run = Run(id="r", conversation_id="c", model="openai:main", fallback_models=["moonshot:backup"],
              keys={"openai": "a", "moonshot": "b"})
    result = await agent._stream(run, [])
    assert result.text == "ok" and run.model == "moonshot:backup"
    assert run.events[0]["type"] == "model_fallback"

    run = Run(id="r2", conversation_id="c", model="openai:main", fallback_models=["moonshot:backup"],
              keys={"openai": "a", "moonshot": "b"})
    failed.partial = True
    with pytest.raises(LLMError, match="unavailable"):
        await agent._stream(run, [])
    assert not [e for e in run.events if e["type"] == "model_fallback"]


async def test_code_review_summary_scenario(client, monkeypatch):
    login(client)
    cid = client.post("/api/projects/general/conversations", json={}).json()["id"]
    await main.db().add_message(cid, "user", "Сделай задачу")
    agent = main.agent()
    calls = []

    async def step(run, stage, model, task):
        calls.append((stage, model, task))
        return {"work": "Код готов", "review": "Ошибок нет", "summary": "Всё готово"}[stage]

    monkeypatch.setattr(agent, "_scenario_step", step)
    run = Run(id="scenario", conversation_id=cid, model="openai:worker", project_id="general",
              scenario={"worker": "openai:worker", "review": "anthropic:review", "summary": "moonshot:summary"})
    await agent._run_scenario(run)
    assert [x[:2] for x in calls] == [("work", "openai:worker"), ("review", "anthropic:review"), ("summary", "moonshot:summary")]
    assert "Код готов" in calls[1][2] and "Ошибок нет" in calls[2][2]
    final = (await main.db().get_messages(cid))[-1]
    assert final["role"] == "assistant" and final["meta"]["model"] == "multi:code-review-summary"
    assert "## Независимое ревью\nОшибок нет" in final["content"]
    assert [e["type"] for e in run.events] == ["text", "message_saved"]
