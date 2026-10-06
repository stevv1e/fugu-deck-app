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


def test_convert_tools():
    t = [{"type": "function", "function": {"name": "a", "description": "d", "parameters": {"type": "object"}}}]
    assert convert_tools(t) == [{"name": "a", "description": "d", "input_schema": {"type": "object"}}]
