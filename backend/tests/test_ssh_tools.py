"""Команды на серверах через ssh-gateway (сторона агента) — сценарий в отдельном процессе: tests/ssh_gateway_check.py."""
import subprocess
import sys
from pathlib import Path


def test_agent_ssh_commands_via_gateway():
    r = subprocess.run([sys.executable, str(Path(__file__).with_name("ssh_gateway_check.py"))], capture_output=True, text=True, timeout=120)
    assert r.returncode == 0 and "ssh-tools: ok" in r.stdout, r.stdout[-2000:] + r.stderr[-3000:]


async def test_preview_and_review(monkeypatch):
    """Пробный прогон — от шлюза, до подтверждения; проверка команды — отдельный запрос к модели без инструментов."""
    from app import agent as agent_mod
    from app.agent import Agent, Run
    from app.config import get_settings
    from app.llm import LLMResult, Usage
    from app.tools import ssh_tools
    from app.tools.registry import ToolContext

    calls = []

    async def fake_call(path, body, timeout=30):
        calls.append((path, body))
        if path == "/v1/agent/check":
            return 200, {"level": "write", "need": "ssh_write"}
        if path == "/v1/agent/exec" and body.get("preview"):
            return 200, {"result": {"exit_code": 0, "stdout": "Plan: 1 to add, 0 to change, 0 to destroy."}}
        return 500, {"error": "не ждали"}

    monkeypatch.setattr(ssh_tools, "_call", fake_call)
    ctx = ToolContext("c", None, get_settings(), {})
    risk = await ssh_tools._risk(ctx, {"server": "prod-1", "command": "terraform apply -auto-approve", "preview": "terraform plan"})
    assert risk == "write" and ctx.ssh_preview["output"].startswith("Plan: 1 to add")
    assert calls[1] == ("/v1/agent/exec", {"agent": "fugu", "server": "prod-1", "command": "terraform plan", "preview": True})

    seen = {}

    class FakeProvider:
        async def stream(self, key, model, messages, tools, on_text, on_tool, headers=None):
            seen.update(model=model, tools=tools, prompt=messages[-1]["content"])
            return LLMResult("Создаст один ресурс; необратимого нет.", [], Usage(10, 5))

    monkeypatch.setattr(agent_mod, "get_provider", lambda name, s: FakeProvider())
    ag = Agent.__new__(Agent)
    ag.settings, ag.db = get_settings(), None
    recorded = []

    async def rec(run, usage):
        recorded.append(usage)

    ag._record_usage = rec
    run = Run(id="r", conversation_id="c", model="sakana:fugu-max-v1.0", llm_key="k")
    text = await ag._review(run, {"server": "prod-1", "command": "terraform apply", "why": "развернуть"}, ctx.ssh_preview)
    assert text.startswith("Создаст") and seen["tools"] == [] and "Plan: 1 to add" in seen["prompt"] and recorded
