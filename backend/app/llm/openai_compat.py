"""OpenAI-совместимые API: Sakana (сейчас), OpenAI и xAI (задел)."""
from __future__ import annotations

import hashlib

import asyncio

from openai import APIConnectionError, APIError, APITimeoutError, AsyncOpenAI, InternalServerError, RateLimitError

from . import LLMError, LLMResult, OnText, OnTool, Usage

BASE_URLS = {"openai": "https://api.openai.com/v1", "xai": "https://api.x.ai/v1"}
_clients: dict[str, AsyncOpenAI] = {}
_no_stream_usage: set[str] = set()


def _client(base_url: str, key: str, timeout: int) -> AsyncOpenAI:
    k = hashlib.sha256(f"{base_url}|{key}".encode()).hexdigest()
    if k not in _clients:
        if len(_clients) > 50:
            _clients.clear()
        # Сами SDK не повторяем: повтор после тайм-аута долгого запроса (Ultra думает минутами) мог бы оплатить один и
        # тот же шаг дважды — провайдер успел обработать запрос, а ответ потерялся. Повторы — в stream(), только безопасные.
        _clients[k] = AsyncOpenAI(api_key=key, base_url=base_url, timeout=timeout, max_retries=0)
    return _clients[k]


class OpenAICompatProvider:
    def __init__(self, name: str, settings):
        self.name = name
        from .. import keyguard_client as kgc
        if kgc.enabled():
            self.base_url = kgc.llm_base(name)   # только sakana; openai/xai keyguard не проксирует
        else:
            self.base_url = settings.sakana_base_url if name == "sakana" else BASE_URLS[name]
        self.max_tokens = settings.sakana_max_tokens
        self.timeout = settings.llm_timeout_seconds

    @staticmethod
    async def _create(client: AsyncOpenAI, kwargs: dict):
        """Один повтор — только когда провайдер запрос точно не обработал: не удалось подключиться, «слишком часто»
        (429) или «перегружен» (503). Тайм-аут и обрыв посреди ответа не повторяются — показываем ошибку."""
        for attempt in (0, 1):
            try:
                return await client.chat.completions.create(**kwargs)
            except APITimeoutError as e:
                raise LLMError("модель не ответила вовремя; запрос не повторён, чтобы не оплачивать его дважды") from e
            except (APIConnectionError, RateLimitError) as e:
                if attempt:
                    raise
                await asyncio.sleep(3)
            except InternalServerError as e:
                if attempt or getattr(e, "status_code", 0) != 503:
                    raise
                await asyncio.sleep(3)

    async def stream(self, key: str, model: str, messages: list[dict], tools: list[dict],
                     on_text: OnText, on_tool: OnTool, headers: dict | None = None) -> LLMResult:
        client = _client(self.base_url, key, self.timeout)
        kwargs: dict = dict(model=model, messages=_strip_meta(messages), stream=True, tools=tools,
                            max_tokens=self.max_tokens)
        if headers:
            kwargs["extra_headers"] = headers
        if self.base_url not in _no_stream_usage:
            kwargs["stream_options"] = {"include_usage": True}
        try:
            stream = await self._create(client, kwargs)
        except APIError as e:
            if "stream_options" in str(e) and self.base_url not in _no_stream_usage:
                _no_stream_usage.add(self.base_url)
                return await self.stream(key, model, messages, tools, on_text, on_tool, headers)
            raise LLMError(f"{self.name}: {getattr(e, 'message', str(e))}") from e

        text, calls, usage = [], {}, None
        try:
            async for chunk in stream:
                if getattr(chunk, "usage", None):
                    u = chunk.usage
                    d = getattr(u, "prompt_tokens_details", None)
                    usage = Usage(u.prompt_tokens or 0, u.completion_tokens or 0,
                                  (getattr(d, "cached_tokens", 0) or 0) if d else 0)
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                if delta.content:
                    text.append(delta.content)
                    await on_text(delta.content)
                for tc in delta.tool_calls or []:
                    c = calls.setdefault(tc.index, {"id": "", "type": "function",
                                                    "function": {"name": "", "arguments": ""}})
                    if tc.id:
                        c["id"] = tc.id
                    if tc.function and tc.function.name:
                        c["function"]["name"] += tc.function.name
                        await on_tool(tc.index, c["function"]["name"])
                    if tc.function and tc.function.arguments:
                        c["function"]["arguments"] += tc.function.arguments
        except APIError as e:
            raise LLMError(f"{self.name}: {getattr(e, 'message', str(e))}") from e
        return LLMResult("".join(text), [calls[k] for k in sorted(calls)], usage, provider=self.name)


def _strip_meta(messages: list[dict]) -> list[dict]:
    return [{k: v for k, v in m.items() if not k.startswith("_")} for m in messages]
