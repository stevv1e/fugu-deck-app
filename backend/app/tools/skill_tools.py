"""Скилы: агент видит их список в системном промпте и загружает нужный целиком."""
from __future__ import annotations

from .providers import ProviderError
from .registry import obj, tool


def enabled(ctx, name: str) -> bool:
    """Скил включён и в проекте, и у агента («*» — все)."""
    allowed = ctx.project.get("skills") or []
    mine = ctx.agent.get("skills") or ["*"]
    return ("*" in allowed or name in allowed) and ("*" in mine or name in mine)


@tool("load_skill", "Загрузить полный текст скила перед выполнением задачи, к которой он относится.",
      obj({"name": {"type": "string"}}, ["name"]), group="skills", title="Скил")
async def load_skill(ctx, a):
    if not enabled(ctx, a["name"]):
        raise ProviderError(f"скил {a['name']} не включён в этом проекте")
    s = ctx.skills.get(a["name"])
    return {"name": s["name"], "instructions": s["body"], "extra_files": s["files"]}


@tool("read_skill_file", "Прочитать дополнительный файл скила (шаблон, пример).",
      obj({"name": {"type": "string"}, "file": {"type": "string"}}, ["name", "file"]),
      group="skills", title="Файл скила")
async def read_skill_file(ctx, a):
    if not enabled(ctx, a["name"]):
        raise ProviderError(f"скил {a['name']} не включён в этом проекте")
    return {"file": a["file"], "content": ctx.skills.read_file(a["name"], a["file"])}
