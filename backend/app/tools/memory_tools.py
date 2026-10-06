"""Память проекта: агент сам сохраняет важное и ищет по своей памяти и памяти связанных проектов."""
from __future__ import annotations

from .providers import ProviderError
from .registry import ToolContext, obj, tool


def _fmt(m: dict, ctx: ToolContext) -> dict:
    out = {"id": m["id"], "content": m["content"], "tags": m["tags"], "pinned": bool(m["pinned"])}
    if m["project_id"] != ctx.project_id:
        out["project"] = ctx.readable_projects.get(m["project_id"], m["project_id"])
        out["read_only"] = True
    return out


async def _own(ctx: ToolContext, mid: int) -> dict:
    m = await ctx.db.get_memory(mid)
    if not m or m["project_id"] not in ctx.readable_projects:
        raise ProviderError("запись памяти не найдена")
    if m["project_id"] != ctx.project_id:
        raise ProviderError("это память другого проекта — доступ только на чтение")
    return m


async def _changed(ctx: ToolContext, action: str, memory: dict | None = None, mid: int | None = None):
    if ctx.broker:
        await ctx.broker.publish("memory", ctx.project_id, action=action,
                                 memory=memory, memory_id=mid, by="agent")


@tool("memory_search",
      "Поиск по памяти проекта (факты, решения, договорённости). Ищет также в памяти связанных проектов "
      "(только чтение). project — имя проекта, чтобы искать только в нём.",
      obj({"query": {"type": "string"}, "project": {"type": "string"},
           "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 15}}, ["query"]),
      group="memory", title="Поиск в памяти")
async def memory_search(ctx, a):
    ids = list(ctx.readable_projects)
    if a.get("project"):
        want = a["project"].lower()
        ids = [i for i, n in ctx.readable_projects.items() if n.lower() == want or i == a["project"]]
        if not ids:
            raise ProviderError(f"нет доступа к памяти проекта {a['project']}")
    rows = await ctx.db.search_memories(ids, a["query"], a.get("limit", 15))
    return [_fmt(m, ctx) for m in rows]


@tool("memory_save",
      "Сохранить в память ТЕКУЩЕГО проекта важный долговременный факт: решение, соглашение, "
      "адрес сервиса, предпочтение пользователя, структуру репозитория. Одна мысль — одна запись. "
      "Не сохраняй секреты и временные детали.",
      obj({"content": {"type": "string"}, "tags": {"type": "string", "description": "через запятую"},
           "pinned": {"type": "boolean", "description": "всегда показывать в контексте"}}, ["content"]),
      group="memory", title="Запомнить")
async def memory_save(ctx, a):
    m = await ctx.db.add_memory(ctx.project_id, a["content"].strip(), a.get("tags", ""), "agent",
                                "Fugu", ctx.conversation_id, a.get("pinned", False))
    await _changed(ctx, "added", memory=m)
    return {"id": m["id"], "saved": True}


@tool("memory_update", "Исправить запись памяти текущего проекта (устаревший факт).",
      obj({"id": {"type": "integer"}, "content": {"type": "string"}, "tags": {"type": "string"}}, ["id", "content"]),
      group="memory", title="Обновить память")
async def memory_update(ctx, a):
    await _own(ctx, a["id"])
    await ctx.db.update_memory(a["id"], content=a["content"].strip(), tags=a.get("tags"))
    m = await ctx.db.get_memory(a["id"])
    await _changed(ctx, "updated", memory=m)
    return {"id": a["id"], "updated": True}


@tool("memory_delete", "Удалить запись памяти текущего проекта.",
      obj({"id": {"type": "integer"}, "reason": {"type": "string"}}, ["id"]),
      risk="write", group="memory", title="Удалить из памяти")
async def memory_delete(ctx, a):
    await _own(ctx, a["id"])
    await ctx.db.delete_memory(a["id"])
    await _changed(ctx, "deleted", mid=a["id"])
    return {"id": a["id"], "deleted": True}
