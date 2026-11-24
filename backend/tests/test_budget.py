import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

from app.agent import Agent, Run, _tool_groups
from app.config import Settings
from app.llm import Usage


def engine(settings: Settings) -> Agent:
    db = SimpleNamespace(add_usage=AsyncMock(), sponsor_threshold=AsyncMock(return_value=None))
    return Agent(db, settings, {})


def run() -> Run:
    return Run(id="r", conversation_id="c", model="sakana:fugu-max-v1.0", user={"id": "u"})


def test_time_token_cost_and_tool_budgets(tmp_path):
    settings = Settings(data_dir=tmp_path, agent_max_run_seconds=60, agent_max_total_tokens=1000,
                        agent_max_cost_usd=1.0, agent_max_tool_calls=3)
    agent = engine(settings)
    assert agent.budget_problem(run()) is None

    expired = run()
    expired.started_at = time.time() - 61
    assert "времени" in agent.budget_problem(expired)

    tokens = run()
    tokens.total_tokens = 1000
    assert "токенов" in agent.budget_problem(tokens)

    cost = run()
    cost.total_cost_usd = 1.0
    assert "стоимости" in agent.budget_problem(cost)

    tools = run()
    tools.tool_call_count = 3
    assert "инструментов" in agent.budget_problem(tools)


def test_zero_budget_values_keep_unlimited_compatibility(tmp_path):
    settings = Settings(data_dir=tmp_path, agent_max_run_seconds=0, agent_max_total_tokens=0,
                        agent_max_cost_usd=0, agent_max_tool_calls=0)
    agent = engine(settings)
    value = run()
    value.started_at = 0
    value.total_tokens = 10**12
    value.total_cost_usd = 10**6
    value.tool_call_count = 10**6
    assert agent.budget_problem(value) is None


async def test_usage_updates_run_totals_and_reports_cache(tmp_path):
    settings = Settings(data_dir=tmp_path, agent_max_total_tokens=1000)
    agent = engine(settings)
    value = run()
    await agent._record_usage(value, Usage(prompt_tokens=1000, completion_tokens=200, cached_tokens=300, cache_write_tokens=100))
    assert value.total_tokens == 1200
    assert value.total_cost_usd > 0
    assert "токенов" in agent.budget_problem(value)
    agent.db.add_usage.assert_awaited_once()
    event = value.events[-1]
    assert event["total_tokens"] == 1200
    assert event["cached_tokens"] == 300
    assert event["total_cost_usd"] == value.total_cost_usd


def test_only_consecutive_readonly_tools_grouped_for_parallel_execution():
    value = run()
    names = ["read_attachment", "memory_search", "create_file", "memory_search", "read_attachment"]
    calls = [{"id": str(i), "function": {"name": name, "arguments": "{}"}} for i, name in enumerate(names)]
    groups = _tool_groups(value, calls)
    assert [[call["function"]["name"] for call in group] for group in groups] == [
        ["read_attachment", "memory_search"], ["create_file"], ["memory_search", "read_attachment"],
    ]
    assert all("_readonly" not in call for call in calls)
