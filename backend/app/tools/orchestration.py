"""Оркестрация: план-задача → разбиение → под-агенты. Группа «agents» (только владелец, как и agent_save);
под-прогону эти инструменты не дают (глубина 1 — см. tools_for). Вся работа — в Agent.plan / Agent.delegate.
"""
from __future__ import annotations

from .registry import ToolContext, obj, tool


@tool("plan_task",
      "Разбить крупную задачу на независимые под-задачи для под-агентов. Возвращает список {role, task, model, access} "
      "от модели-планировщика — это совет: дальше сам создаёшь агентов (agent_save) и раздаёшь им задачи (delegate). "
      "Для простой задачи не нужен.",
      obj({"task": {"type": "string", "description": "полная формулировка задачи"}}, ["task"]),
      risk="read", group="agents", title="План задачи")
async def plan_task(ctx: ToolContext, args: dict):
    if ctx.orchestrator is None or ctx.run is None:
        raise ValueError("план доступен только в запуске агента")
    return await ctx.orchestrator.plan(ctx.run, str(args.get("task") or ""))


@tool("delegate",
      "Поручить под-задачи под-агентам пространства. Новая под-задача — укажи agent_id именованного агента (создай его "
      "заранее через agent_save с нужными доступами и моделью): он получит отдельный под-чат, у него своя память, он не "
      "видит ни этот чат, ни других. Починка после отчёта теста — укажи conversation_id уже существующего под-чата (без "
      "agent_id): задача дошлётся туда и исполнитель перезапустится, помня, что делал (максимум 3 раунда на часть). "
      "parallel=true — запустить разом, иначе по очереди. Инструмент ждёт завершения и возвращает итоговые ответы. "
      "Опасные действия под-агентов всё равно подтверждает владелец.",
      obj({
          "subtasks": {"type": "array", "description": "под-задачи",
                       "items": obj({"agent_id": {"type": "string", "description": "id агента — для новой под-задачи"},
                                     "conversation_id": {"type": "string", "description": "id под-чата — для починки"},
                                     "task": {"type": "string", "description": "что сделать, самодостаточно"}},
                                    ["task"])},
          "parallel": {"type": "boolean", "description": "запустить одновременно (иначе по очереди)"},
      }, ["subtasks"]),
      risk="write", group="agents", title="Поручить под-агентам")
async def delegate(ctx: ToolContext, args: dict):
    if ctx.orchestrator is None or ctx.run is None:
        raise ValueError("делегирование доступно только в запуске агента")
    return await ctx.orchestrator.delegate(ctx.run, args.get("subtasks") or [], bool(args.get("parallel")))
