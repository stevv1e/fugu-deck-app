"""Реестр инструментов, которые доступны модели.

Чтобы добавить новый инструмент (например, SSH на следующем этапе), достаточно
создать функцию-обработчик и зарегистрировать её декоратором @tool.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal

Risk = Literal["read", "write", "dangerous"]


@dataclass
class ToolContext:
    conversation_id: str
    db: Any
    settings: Any
    providers: dict[str, Any]
    project: dict = field(default_factory=dict)
    # проекты, чью память можно читать (свой + связанные, только чтение)
    readable_projects: dict[str, str] = field(default_factory=dict)  # id -> name
    user: dict = field(default_factory=dict)
    skills: Any = None
    broker: Any = None

    @property
    def project_id(self) -> str:
        return self.project.get("id", "")


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict
    handler: Callable[[ToolContext, dict], Awaitable[Any]]
    # Функция оценки риска конкретного вызова (зависит от аргументов)
    risk: Callable[[ToolContext, dict], Awaitable[Risk]]
    group: str = "general"
    title: str = ""

    def schema(self) -> dict:
        return {"type": "function",
                "function": {"name": self.name, "description": self.description, "parameters": self.parameters}}


REGISTRY: dict[str, Tool] = {}


def _const(r: Risk):
    async def f(ctx, args):
        return r
    return f


def tool(name: str, description: str, parameters: dict, *, risk: Risk | Callable = "read",
         group: str = "general", title: str = ""):
    def deco(fn):
        REGISTRY[name] = Tool(
            name=name, description=description, parameters=parameters, handler=fn,
            risk=risk if callable(risk) else _const(risk), group=group, title=title or name,
        )
        return fn
    return deco


def obj(properties: dict, required: list[str] | None = None) -> dict:
    return {"type": "object", "properties": properties, "required": required or [], "additionalProperties": False}


@dataclass
class ApprovalPolicy:
    mode: str = "all"

    def needs_approval(self, risk: Risk) -> bool:
        if self.mode == "none" or risk == "read":
            return False
        if self.mode == "dangerous":
            return risk == "dangerous"
        return True


@dataclass
class ToolResult:
    ok: bool
    data: Any = None
    error: str | None = None
    summary: str = ""
    extra: dict = field(default_factory=dict)
