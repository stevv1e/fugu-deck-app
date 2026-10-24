import pytest
import json

from app.llm import split_model
from app.llm.anthropic_provider import convert_messages, convert_tools


def test_split_model():
    assert split_model("anthropic:claude-sonnet-5") == ("anthropic", "claude-sonnet-5")
    assert split_model("fugu-max-v1.0") == ("sakana", "fugu-max-v1.0")


def test_convert_history_with_tools_and_thinking():
    thinking = [{"type": "thinking", "thinking": "x", "signature": "s"},
                {"type": "tool_use", "id": "toolu_1", "name": "list_repos", "input": {"provider": "github"}}]
    msgs = [
        {"role": "system", "content": "SYS"},
        {"role": "user", "content": "привет"},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "call:1", "type": "function", "function": {"name": "read_file", "arguments": '{"path":"a"}'}}]},
        {"role": "tool", "tool_call_id": "call:1", "content": json.dumps({"error": "нет"})},
        {"role": "assistant", "content": "", "_provider_blocks": thinking,
         "tool_calls": [{"id": "toolu_1", "type": "function", "function": {"name": "list_repos", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "toolu_1", "content": "[]"},
        {"role": "user", "content": [{"type": "text", "text": "картинка"},
                                     {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}]},
    ]
    system, out = convert_messages(msgs)
    assert system == [{"type": "text", "text": "SYS"}]
    assert [m["role"] for m in out] == ["user", "assistant", "user", "assistant", "user"]
    assert out[1]["content"][0] == {"type": "tool_use", "id": "call_1", "name": "read_file", "input": {"path": "a"}}
    assert out[2]["content"][0]["tool_use_id"] == "call_1" and out[2]["content"][0]["is_error"] is True
    assert out[3]["content"] == thinking  # thinking вернулся без изменений
    # результат инструмента и следующее сообщение пользователя склеены в одно user-сообщение
    kinds = [b["type"] for b in out[4]["content"]]
    assert kinds == ["tool_result", "text", "image"]


def test_cache_breakpoints_prefix_stable():
    """Anthropic: точка кэша на стабильной части системы (с ней и схемы инструментов) и на конце истории;
    volatile-блок памяти идёт после первой точки и её не несёт."""
    msgs = [
        {"role": "system", "content": "STABLE", "_cache": True},
        {"role": "system", "content": "### Память проекта\n- [#1] заметка"},  # volatile — без _cache
        {"role": "user", "content": "привет"},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "c1", "type": "function", "function": {"name": "read_file", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "[]"},
    ]
    system, out = convert_messages(msgs)
    assert system[0]["text"] == "STABLE" and system[0]["cache_control"] == {"type": "ephemeral"}
    assert "cache_control" not in system[1]  # снимок памяти не кэшируется в этой точке
    assert out[-1]["content"][-1]["cache_control"] == {"type": "ephemeral"}  # конец истории
    # без пометки _cache точек кэша нет (проверка команды, общение)
    s2, o2 = convert_messages([{"role": "system", "content": "S"}, {"role": "user", "content": "x"}])
    assert "cache_control" not in s2[0] and "cache_control" not in o2[-1]["content"][-1]


def test_openai_compat_merges_system():
    """Sakana/DeepSeek: два системных блока склеиваются в одно сообщение, _cache снимается."""
    from app.llm.openai_compat import _strip_meta
    out = _strip_meta([
        {"role": "system", "content": "STABLE", "_cache": True},
        {"role": "system", "content": "MEM"},
        {"role": "user", "content": "x"},
    ])
    assert [m["role"] for m in out] == ["system", "user"]
    assert out[0]["content"] == "STABLE\n\nMEM" and "_cache" not in out[0]


def test_convert_tools():
    t = [{"type": "function", "function": {"name": "a", "description": "d", "parameters": {"type": "object"}}}]
    assert convert_tools(t) == [{"name": "a", "description": "d", "input_schema": {"type": "object"}}]


async def test_openai_compat_retries_only_when_safe(monkeypatch):
    import httpx
    from openai import APIConnectionError, APITimeoutError

    from app.llm import LLMError
    from app.llm import openai_compat as oc

    async def no_wait(_s):
        return None

    monkeypatch.setattr(oc.asyncio, "sleep", no_wait)
    req = httpx.Request("POST", "https://x/v1/chat/completions")

    class Fake:
        def __init__(self, errs):
            self.errs, self.calls = list(errs), 0
            self.chat = self
            self.completions = self

        async def create(self, **kw):
            self.calls += 1
            if self.errs:
                raise self.errs.pop(0)
            return "ok"

    f = Fake([APITimeoutError(req)])
    with pytest.raises(LLMError, match="не повторён"):
        await oc.OpenAICompatProvider._create(f, {})
    assert f.calls == 1  # тайм-аут долгого запроса не повторяется: можно оплатить дважды
    f = Fake([APIConnectionError(request=req)])
    assert await oc.OpenAICompatProvider._create(f, {}) == "ok" and f.calls == 2
    f = Fake([APIConnectionError(request=req), APIConnectionError(request=req)])
    with pytest.raises(APIConnectionError):
        await oc.OpenAICompatProvider._create(f, {})
    assert f.calls == 2


def test_deepseek_reasoning_roundtrip():
    from app.config import get_settings
    from app.llm import PROVIDER_TITLES, get_provider, split_model
    from app.llm.openai_compat import _strip_meta

    assert split_model("deepseek:deepseek-v4-pro") == ("deepseek", "deepseek-v4-pro") and PROVIDER_TITLES["deepseek"] == "DeepSeek"
    p = get_provider("deepseek", get_settings())
    assert p.base_url == "https://api.deepseek.com"
    msgs = _strip_meta([
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "", "tool_calls": [], "_provider_blocks": [{"reasoning_content": "думаю…"}]},
        {"role": "assistant", "content": "ok", "_provider_blocks": [{"type": "thinking", "thinking": "x"}]},  # блоки Claude не трогаем
    ])
    assert msgs[1]["reasoning_content"] == "думаю…" and "_provider_blocks" not in msgs[1]
    assert "reasoning_content" not in msgs[2]
    s = get_settings()
    assert "deepseek:deepseek-flash" in s.model_list and s.pricing["deepseek:deepseek-v4-pro"][1] == 3.96


def test_long_context_price():
    """Ultra: вход больше 272K — весь запрос по длинному тарифу ($10/$45, кэш $1); у других моделей тариф один."""
    from app.agent import Agent
    from app.config import Settings
    a = Agent.__new__(Agent)
    a.settings = Settings()
    assert a.price("sakana:fugu-ultra-v1.1", 272_000) == [5, 30, 0.5]
    assert a.price("sakana:fugu-ultra-v2.0", 272_001) == [10, 45, 1]
    assert a.price("anthropic:claude-sonnet-5", 900_000) == [2, 10, 0.2, 2.5]
