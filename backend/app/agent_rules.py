"""Правила агентов пространства — общие для API (/api/agents) и инструмента agent_save, которым модель создаёт агента."""
from __future__ import annotations

import re

from .db import AGENT_TOOLS

AGENT_ID = re.compile(r"^[a-z][a-z0-9-]{1,30}$")
MAX_AGENTS = 20


def is_owner(user: dict, settings) -> bool:
    """Владелец: в кластере — владелец пространства, на одиночном сервере — владелец сервера."""
    return user.get("space_role") == "owner" if settings.is_space else user.get("role") == "owner"


def agent_problem(aid: str, fields: dict, exists: bool, count: int, models: list[str]) -> str | None:
    """Почему агента нельзя сохранить (None — можно). fields — то, что меняется (name, model, tools, …)."""
    if not AGENT_ID.match(aid):
        return "Имя агента (id): латинские строчные буквы, цифры и дефис, 2–31 знак, с буквы"
    tools = fields.get("tools")
    if tools is not None and any(t not in AGENT_TOOLS for t in tools):
        return f"Доступы агента: {', '.join(AGENT_TOOLS)}"
    if fields.get("model") and fields["model"] not in models:
        return f"Неизвестная модель {fields['model']}"
    if not exists and count >= MAX_AGENTS:
        return f"В пространстве не больше {MAX_AGENTS} агентов"
    if not exists and not fields.get("name"):
        return "Нужно имя агента"
    return None
