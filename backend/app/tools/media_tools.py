"""Инструменты медиа-конвейера: транскрибация, прогресс и отмена."""
from __future__ import annotations

from .. import keyguard_client as kgc
from ..media import MediaError, media_kind
from .providers import ProviderError
from .registry import obj, tool


def _worker(ctx):
    return ctx.orchestrator.media


async def _provider(ctx) -> tuple[str, str]:
    run = ctx.run
    wanted = ctx.settings.media_transcribe_provider
    keys = run.keys if run else {}
    if wanted == "auto":
        if kgc.enabled():
            available = await kgc.my_llm_providers()
            wanted = "openai" if available is None or "openai" in available else "google" if "google" in available else ""
        else:
            wanted = "openai" if keys.get("openai") or ctx.settings.openai_api_key else \
                "google" if keys.get("google") or ctx.settings.google_api_key else ""
    if wanted not in ("openai", "google"):
        raise ProviderError("Добавьте ключ OpenAI или Google в разделе «Токены моделей»")
    return wanted, "" if kgc.enabled() else keys.get(wanted, "")


@tool("transcribe_media",
      "Транскрибировать аудио или видео из вложения. Извлекает звук, при необходимости делит запись на части и создаёт "
      "TXT, JSON и SRT с таймингами. Работает долго: прогресс приходит событиями. После результата можно сделать отчёт.",
      obj({"attachment_id": {"type": "string"},
           "provider": {"type": "string", "enum": ["auto", "openai", "google"], "default": "auto"}},
          ["attachment_id"]), risk="write", group="media", title="Транскрибация медиа")
async def transcribe_media(ctx, a):
    att = await ctx.db.get_attachment(a["attachment_id"])
    if not att or att["conversation_id"] != ctx.conversation_id:
        raise ProviderError("Вложение не найдено")
    try:
        media_kind(att["filename"], att["mime"])
    except MediaError as e:
        raise ProviderError(str(e))
    provider, key = await _provider(ctx)
    job = await _worker(ctx).submit(ctx.conversation_id, att["id"], provider, ctx.user.get("id", ""), key)

    async def progress(current):
        if ctx.run:
            await ctx.run.emit("media_progress", job_id=job["id"], status=current["status"], progress=current["progress"])

    done = await _worker(ctx).wait(job["id"], progress)
    return {"job_id": job["id"], **done["result"],
            "note": "Транскрипт готов и приложен к чату в форматах TXT, JSON и SRT"}


@tool("media_jobs", "Список задач обработки медиа в этом чате: статус, прогресс, ошибка и готовые файлы.",
      obj({"active": {"type": "boolean", "default": False}}), group="media", title="Задачи обработки медиа")
async def media_jobs(ctx, a):
    return await ctx.db.list_media_jobs(ctx.conversation_id, bool(a.get("active")))


@tool("media_cancel", "Остановить выполняющуюся или стоящую в очереди задачу обработки медиа.",
      obj({"job_id": {"type": "string"}}, ["job_id"]), risk="write", group="media", title="Остановка медиа-задачи")
async def media_cancel(ctx, a):
    job = await _worker(ctx).cancel(a["job_id"], ctx.conversation_id)
    return {"job_id": job["id"], "status": job["status"]}
