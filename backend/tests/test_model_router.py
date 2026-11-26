import asyncio
import json

import pytest

from app.llm import LLMResult
from app.model_router import AUTO_MODEL, route_model
from tests.test_devices import client, main  # noqa: F401
from tests.test_api_extra import login


ROUTES = {"simple": "google:gemini-3.5-flash-lite", "code": "kimi:kimi-for-coding",
          "complex": "anthropic:claude-sonnet-5-5", "media": "google:gemini-3.8-flash"}


def test_deterministic_router_categories_and_catalog_guard():
    assert route_model("Привет, как дела?", ROUTES, "general")["category"] == "simple"
    assert route_model("Исправь ошибку в функции и запусти тесты", ROUTES, "general")["category"] == "code"
    assert route_model("Проведи полный security audit архитектуры", ROUTES, "general")["category"] == "complex"
    media = route_model("Расшифруй", ROUTES, "general", [{"mime": "audio/ogg"}])
    assert media["category"] == "media" and media["model"] == "google:gemini-3.8-flash"
    assert route_model("Привет", ROUTES, "general") == route_model("Привет", ROUTES, "general")
    with pytest.raises(ValueError, match="отсутствует"):
        route_model("Привет", ROUTES, "general", available=[])
    with pytest.raises(ValueError, match="не настроена"):
        route_model("Исправь код", {"simple": "google:simple"}, "general")


async def test_auto_model_is_visible_and_route_is_recorded(client, monkeypatch):
    login(client)
    monkeypatch.setattr(main.settings, "model_router_json", json.dumps(ROUTES))
    response = client.get("/api/config")
    assert AUTO_MODEL in response.json()["models"]
    assert "auto" in response.json()["llm_ready"]
    conversation = client.post("/api/projects/general/conversations", json={"model": AUTO_MODEL}).json()
    async def access(c, u, wanted):
        return wanted, {}, None, None
    monkeypatch.setattr(main, "_llm_access", access)
    agent = main.agent()
    async def stream(run, messages):
        return LLMResult("Готово", [], None)
    monkeypatch.setattr(agent, "_stream", stream)
    sent = client.post(f"/api/conversations/{conversation['id']}/messages",
                       json={"content": "Исправь баг в API", "model": AUTO_MODEL})
    assert sent.status_code == 200, sent.text
    route = sent.json()["route"]
    assert route["category"] == "code" and route["model"] == "kimi:kimi-for-coding"
    run = agent.runs[sent.json()["run_id"]]
    for _ in range(100):
        if run.status != "running":
            break
        await asyncio.sleep(0.02)
    assert run.status == "done" and run.model == "kimi:kimi-for-coding" and run.requested_model == AUTO_MODEL
    saved = await main.db().get_conversation(conversation["id"])
    assert saved["model"] == AUTO_MODEL
    messages = await main.db().get_messages(conversation["id"])
    assert messages[-1]["meta"]["route"]["reason"] == route["reason"]
    record = await main.db().get_run(run.id)
    assert record["state"]["route"] == route
