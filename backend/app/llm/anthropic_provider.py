"""Claude через Anthropic Messages API.

Особенности:
- история хранится в формате OpenAI и переводится в блоки Anthropic;
- thinking-блоки (с подписью) сохраняются и возвращаются без изменений на следующем шаге
  цикла инструментов — этого требует API;
- кэш промпта: точка на стабильной части системы (вместе со схемами инструментов) и точка на конце истории.
"""
from __future__ import annotations

import hashlib
import json
import re

import anthropic

from . import LLMError, LLMResult, OnText, OnTool, Usage

_clients: dict[str, anthropic.AsyncAnthropic] = {}
DATA_URL = re.compile(r"^data:(?P<mime>[\w/+.-]+);base64,(?P<data>.+)$", re.S)


def _client(key: str, base_url: str | None, timeout: int) -> anthropic.AsyncAnthropic:
    k = hashlib.sha256(f"{base_url}|{key}".encode()).hexdigest()
    if k not in _clients:
        if len(_clients) > 50:
            _clients.clear()
        kw: dict = dict(api_key=key, timeout=timeout, max_retries=2)
        if base_url:
            kw["base_url"] = base_url
        _clients[k] = anthropic.AsyncAnthropic(**kw)
    return _clients[k]


# ------------------------------------------------------------ OpenAI → Anthropic
def _user_blocks(content) -> list[dict]:
    if isinstance(content, str):
        return [{"type": "text", "text": content or " "}]
    out = []
    for part in content:
        if part.get("type") == "text":
            out.append({"type": "text", "text": part["text"] or " "})
        elif part.get("type") == "image_url":
            m = DATA_URL.match(part["image_url"]["url"])
            if m:
                out.append({"type": "image", "source": {"type": "base64", "media_type": m["mime"], "data": m["data"]}})
    return out or [{"type": "text", "text": " "}]


def convert_messages(messages: list[dict]) -> tuple[list[dict], list[dict]]:
    system: list[dict] = []
    out: list[dict] = []
    stable_sys = -1  # индекс последнего стабильного системного блока — на нём точка кэширования

    def push(role: str, blocks: list[dict]):
        if out and out[-1]["role"] == role:
            out[-1]["content"].extend(blocks)
        else:
            out.append({"role": role, "content": list(blocks)})

    for m in messages:
        role = m["role"]
        if role == "system":
            system.append({"type": "text", "text": m["content"]})
            if m.get("_cache"):
                stable_sys = len(system) - 1
        elif role == "user":
            push("user", _user_blocks(m["content"]))
        elif role == "assistant":
            raw = m.get("_provider_blocks")
            if raw:  # ответ самого Claude — возвращаем как был (с thinking и подписями)
                push("assistant", raw)
                continue
            blocks: list[dict] = []
            if m.get("content"):
                blocks.append({"type": "text", "text": m["content"]})
            for tc in m.get("tool_calls") or []:
                try:
                    args = json.loads(tc["function"]["arguments"] or "{}")
                except json.JSONDecodeError:
                    args = {}
                blocks.append({"type": "tool_use", "id": _tool_id(tc["id"]), "name": tc["function"]["name"],
                               "input": args})
            if blocks:
                push("assistant", blocks)
        elif role == "tool":
            push("user", [{"type": "tool_result", "tool_use_id": _tool_id(m["tool_call_id"]),
                           "content": m.get("content") or "", "is_error": _is_error(m.get("content"))}])
    # API требует, чтобы диалог начинался с user
    if out and out[0]["role"] != "user":
        out.insert(0, {"role": "user", "content": [{"type": "text", "text": "(продолжение)"}]})
    # Кэш промпта (prefix match, порядок tools → system → messages). Точка на стабильной части системы кэширует её
    # вместе со всеми схемами инструментов — она не зависит ни от памяти, ни от растущей истории. Вторая точка на
    # конце диалога доращивает кэш историей, пока память не менялась. Volatile-блок памяти идёт после первой точки.
    if stable_sys >= 0:
        system[stable_sys]["cache_control"] = {"type": "ephemeral"}
        if out:
            out[-1]["content"][-1]["cache_control"] = {"type": "ephemeral"}
    return system, out


def _tool_id(i: str) -> str:
    """Anthropic принимает id вида [a-zA-Z0-9_-]+; id других провайдеров приводим к этому виду."""
    return re.sub(r"[^a-zA-Z0-9_-]", "_", i)[:64] or "call"


def _is_error(content) -> bool:
    try:
        d = json.loads(content or "")
        return isinstance(d, dict) and set(d) == {"error"}
    except Exception:
        return False


def convert_tools(tools: list[dict]) -> list[dict]:
    return [{"name": t["function"]["name"], "description": t["function"]["description"],
             "input_schema": t["function"]["parameters"]} for t in tools]


class AnthropicProvider:
    name = "anthropic"

    def __init__(self, settings):
        from .. import keyguard_client as kgc
        self.base_url = kgc.llm_base("anthropic") if kgc.enabled() else (settings.anthropic_base_url or None)
        self.timeout = settings.llm_timeout_seconds
        self.max_tokens = settings.anthropic_max_tokens

    async def stream(self, key: str, model: str, messages: list[dict], tools: list[dict],
                     on_text: OnText, on_tool: OnTool, headers: dict | None = None) -> LLMResult:
        client = _client(key, self.base_url, self.timeout)
        system, msgs = convert_messages(messages)
        kwargs: dict = dict(model=model, max_tokens=self.max_tokens, messages=msgs)  # точки кэша расставлены в convert_messages
        if tools:
            kwargs["tools"] = convert_tools(tools)
        if system:
            kwargs["system"] = system
        if headers:
            kwargs["extra_headers"] = headers
        text: list[str] = []
        idx_to_tool: dict[int, int] = {}
        try:
            async with client.messages.stream(**kwargs) as stream:
                async for ev in stream:
                    if ev.type == "content_block_start" and ev.content_block.type == "tool_use":
                        n = len(idx_to_tool)
                        idx_to_tool[ev.index] = n
                        await on_tool(n, ev.content_block.name)
                    elif ev.type == "content_block_delta" and ev.delta.type == "text_delta":
                        text.append(ev.delta.text)
                        await on_text(ev.delta.text)
                final = await stream.get_final_message()
        except anthropic.APIStatusError as e:
            raise LLMError(f"Claude {e.status_code}: {_err(e)}") from e
        except anthropic.APIError as e:
            raise LLMError(f"Claude: {e}") from e

        blocks = [b.model_dump(exclude_none=True) for b in final.content]
        tool_calls = [{"id": b["id"], "type": "function",
                       "function": {"name": b["name"], "arguments": json.dumps(b.get("input") or {}, ensure_ascii=False)}}
                      for b in blocks if b["type"] == "tool_use"]
        u = final.usage
        cache_read = getattr(u, "cache_read_input_tokens", 0) or 0
        cache_write = getattr(u, "cache_creation_input_tokens", 0) or 0
        usage = Usage(prompt_tokens=(u.input_tokens or 0) + cache_read + cache_write,
                      completion_tokens=u.output_tokens or 0, cached_tokens=cache_read, cache_write_tokens=cache_write)
        # thinking-блоки нужны только для продолжения цикла инструментов
        keep = [b for b in blocks if b["type"] in ("thinking", "redacted_thinking", "text", "tool_use")]
        has_thinking = any(b["type"] in ("thinking", "redacted_thinking") for b in keep)
        return LLMResult("".join(text) or "".join(b.get("text", "") for b in blocks if b["type"] == "text"),
                         tool_calls, usage, provider_blocks=keep if has_thinking and tool_calls else None,
                         provider="anthropic", extra={"stop_reason": final.stop_reason})


def _err(e) -> str:
    try:
        return e.body["error"]["message"]
    except Exception:
        return str(e)
