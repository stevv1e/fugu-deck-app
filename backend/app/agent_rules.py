"""Правила агентов пространства — общие для API (/api/agents) и инструмента agent_save, которым модель создаёт агента."""
from __future__ import annotations

import re

from .db import AGENT_TOOLS

AGENT_ID = re.compile(r"^[a-z][a-z0-9-]{1,30}$")
MAX_AGENTS = 20
# Подтверждения действий агента: sign — с подписью (биометрия), tap — без подписи, dangerous — только опасные
# (с подписью), none — без подтверждений; "" — как на сервере. Команды на серверах подписываются всегда (их
# требует ssh-gateway), изменение агентов (agent_save) — тоже.
APPROVALS = ("", "sign", "tap", "dangerous", "none")
APPROVAL_TITLES = {"sign": "с подписью", "tap": "без подписи", "dangerous": "только опасные", "none": "без подтверждений"}


def approval_mode(agent: dict | None, server_mode: str) -> tuple[str, bool]:
    """(режим ApprovalPolicy, нужна ли подпись) для агента; без своей настройки — режим сервера и подпись."""
    a = (agent or {}).get("approvals") or ""
    if a == "tap":
        return "all", False
    if a == "sign":
        return "all", True
    if a in ("dangerous", "none"):
        return a, True
    return server_mode, True


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
    if fields.get("approvals") is not None and fields["approvals"] not in APPROVALS:
        return "Подтверждения: sign, tap, dangerous, none или пусто"
    if fields.get("model") and fields["model"] not in models:
        return f"Неизвестная модель {fields['model']}"
    if not exists and count >= MAX_AGENTS:
        return f"В пространстве не больше {MAX_AGENTS} агентов"
    if not exists and not fields.get("name"):
        return "Нужно имя агента"
    return None
