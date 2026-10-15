"""Провайдеры LLM с единым интерфейсом.

История чата хранится в формате OpenAI (как раньше). Адаптеры переводят её в формат
конкретного API и обратно. Новый провайдер = новый класс с методом stream().
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Awaitable, Callable

PROVIDER_TITLES = {"sakana": "Sakana", "anthropic": "Claude", "deepseek": "DeepSeek", "openai": "OpenAI", "xai": "Grok"}


class LLMError(Exception):
    pass


@dataclass
class Usage:
    prompt_tokens: int = 0          # все входные токены (включая кэш)
    completion_tokens: int = 0
    cached_tokens: int = 0          # прочитано из кэша
    cache_write_tokens: int = 0     # записано в кэш


@dataclass
class LLMResult:
    text: str
    tool_calls: list[dict]
    usage: Usage | None
    # «сырые» блоки ответа провайдера, которые нужно вернуть ему без изменений на следующем шаге
    # (например, thinking-блоки Claude с подписью при работе с инструментами)
    provider_blocks: list[dict] | None = None
    provider: str = ""
    extra: dict = field(default_factory=dict)


OnText = Callable[[str], Awaitable[None]]
OnTool = Callable[[int, str], Awaitable[None]]


def split_model(model: str) -> tuple[str, str]:
    """'anthropic:claude-opus-5-5' → ('anthropic', 'claude-opus-5-5'); без префикса — Sakana."""
    if ":" in model:
        p, m = model.split(":", 1)
        return p, m
    return "sakana", model


def get_provider(name: str, settings):
    if name == "anthropic":
        from .anthropic_provider import AnthropicProvider
        return AnthropicProvider(settings)
    if name in ("sakana", "deepseek", "openai", "xai"):
        from .openai_compat import OpenAICompatProvider
        return OpenAICompatProvider(name, settings)
    raise LLMError(f"Неизвестный провайдер {name}")
