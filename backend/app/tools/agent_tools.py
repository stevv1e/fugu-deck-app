"""Агенты пространства по просьбе в чате: модель предлагает агента, владелец подтверждает карточкой.

Только владельцу (как и экран «Агенты»). agent_save подтверждается всегда — даже когда подтверждения выключены:
агент получает доступы, в том числе к серверам, и это решает человек, а не модель.
"""
from __future__ import annotations

from ..agent_rules import agent_problem
from ..db import AGENT_TOOLS
from .registry import ToolContext, obj, tool


@tool("agent_list", "Список агентов этого пространства: id, имя, модель, доступы и начало инструкции.",
      obj({}), risk="read", group="agents", title="Агенты пространства")
async def agent_list(ctx: ToolContext, args: dict):
    return [{"id": a["id"], "name": a["name"], "model": a.get("model") or "(модель чата)", "tools": a.get("tools"),
             "skills": a.get("skills"), "instructions": (a.get("instructions") or "")[:300]}
            for a in await ctx.db.list_agents()]


@tool("agent_save",
      "Создать нового агента пространства или изменить существующего (по id). Владелец подтверждает это в приложении. "
      "Доступы (tools): git — репозитории; ssh — серверы; memory — база знаний; files — вложения; skills — навыки. "
      "Давайте только нужные задаче. Модель — из списка моделей пространства или пусто (модель чата).",
      obj({
          "id": {"type": "string", "description": "латиницей: строчные буквы, цифры, дефис; 2–31 знак, с буквы"},
          "name": {"type": "string", "description": "имя агента для людей, до 40 символов"},
          "instructions": {"type": "string", "description": "инструкция агента: роль, правила, стиль"},
          "tools": {"type": "array", "items": {"type": "string", "enum": list(AGENT_TOOLS)}},
          "model": {"type": "string", "description": "провайдер:модель или пусто"},
          "skills": {"type": "array", "items": {"type": "string"}, "description": "имена навыков; [\"*\"] — все"},
      }, ["id", "name", "instructions", "tools"]),
      risk="write", group="agents", title="Агент пространства", always_confirm=True)
async def agent_save(ctx: ToolContext, args: dict):
    aid = str(args.get("id") or "").strip()
    fields = {k: args[k] for k in ("name", "instructions", "tools", "model", "skills") if k in args and args[k] is not None}
    if isinstance(fields.get("name"), str):
        fields["name"] = fields["name"].strip()[:40]
    if len(fields.get("instructions") or "") > 20000:
        raise ValueError("Инструкция длиннее 20000 символов")
    exists = await ctx.db.get_agent(aid)
    if why := agent_problem(aid, fields, bool(exists), len(await ctx.db.list_agents()), ctx.settings.model_list):
        raise ValueError(why)
    a = await ctx.db.put_agent(aid, **fields)
    if ctx.broker:
        await ctx.broker.publish("agent", None, action="saved", agent_id=aid)
    return {"ok": True, "created": not exists, "agent": {"id": a["id"], "name": a["name"], "tools": a.get("tools"),
            "model": a.get("model") or "(модель чата)"},
            "hint": "Агента можно выбрать при создании чата или в шапке чата."}
