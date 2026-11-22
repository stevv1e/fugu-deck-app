"""Генерация изображений через OpenAI Images API и Gemini Interactions API."""
from __future__ import annotations

import base64
import binascii
import uuid
from pathlib import Path

import httpx

from . import keyguard_client as kgc
from .media import post_transient_retry


class ImageError(ValueError):
    pass


def decode_image(encoded: str, mime: str) -> tuple[bytes, str, str]:
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as e:
        raise ImageError("Провайдер вернул повреждённое изображение") from e
    if not data or len(data) > 25 * 1024 * 1024:
        raise ImageError("Изображение пустое или больше 25 МБ")
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        mime, ext = "image/png", ".png"
    elif data.startswith(b"\xff\xd8\xff"):
        mime, ext = "image/jpeg", ".jpg"
    elif data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        mime, ext = "image/webp", ".webp"
    else:
        raise ImageError("Провайдер вернул не PNG, JPEG или WebP")
    return data, mime, ext


class ImageGenerator:
    def __init__(self, ctx):
        self.ctx = ctx
        self.settings = ctx.settings

    def _key(self, provider: str) -> str:
        if kgc.enabled():
            return kgc.token()
        keys = self.ctx.run.keys if self.ctx.run else {}
        key = keys.get(provider) or getattr(self.settings, f"{provider}_api_key", "")
        if not key:
            raise ImageError(f"Нет ключа {provider}")
        return key

    async def generate(self, provider: str, prompt: str, model: str, count: int = 1,
                       size: str = "1024x1024", quality: str = "low") -> dict:
        prompt = prompt.strip()
        if not prompt or len(prompt) > 16000:
            raise ImageError("Опишите изображение текстом до 16 000 символов")
        key = self._key(provider)
        if provider == "openai":
            model = model or self.settings.openai_image_model
            body = {"model": model, "prompt": prompt, "n": count, "size": size, "quality": quality,
                    "output_format": "png"}
            url = self.settings.keyguard_url.rstrip("/") + "/media/openai/image" if kgc.enabled() else \
                "https://api.openai.com/v1/images/generations"
            headers = {"Authorization": f"Bearer {key}"}
        elif provider == "google":
            model = model or self.settings.google_image_model
            body = {"model": model, "input": [{"type": "text", "text": prompt}]}
            url = self.settings.keyguard_url.rstrip("/") + "/media/google/image" if kgc.enabled() else \
                "https://generativelanguage.googleapis.com/v1beta/interactions"
            headers = {"x-goog-api-key": key, "Api-Revision": "2026-05-20"}
            if kgc.enabled():
                headers = {"Authorization": f"Bearer {key}"}
        else:
            raise ImageError("Генерация поддерживается через OpenAI или Google")
        async with httpx.AsyncClient(timeout=httpx.Timeout(300, connect=30)) as client:
            response = await post_transient_retry(client, url, headers=headers, json=body)
        if response.status_code != 200:
            detail = response.text[:500]
            try:
                error = response.json().get("error") or {}
                if isinstance(error, dict):
                    detail = str(error.get("message") or detail)[:500]
            except ValueError:
                pass
            quota = detail.lower()
            if provider == "google" and response.status_code == 429 and (
                    "free tier" in quota or "limit: 0" in quota or "paid tier to access" in quota):
                raise ImageError(
                    "Google Gemini API: у проекта этого ключа действует Free Tier, а лимит генерации изображений равен 0. "
                    "Привяжите API-проект к платёжному аккаунту в Google AI Studio и создайте/выберите ключ этого проекта. "
                    "Подписка Google AI Pro/Ultra отдельно не оплачивает Gemini API."
                )
            raise ImageError(f"{provider} image ({model}): {response.status_code} {detail}")
        data = response.json()
        images = []
        if provider == "openai":
            images = [(x.get("b64_json", ""), "image/png") for x in data.get("data") or []]
        else:
            image = data.get("output_image") or {}
            images = [(image.get("data", ""), image.get("mime_type") or "image/png")]
        decoded = [decode_image(encoded, mime) for encoded, mime in images if encoded]
        if not decoded:
            raise ImageError("Провайдер не вернул изображение; измените описание или попробуйте другую модель")
        directory = self.settings.data_dir / "attachments" / self.ctx.conversation_id
        directory.mkdir(parents=True, exist_ok=True)
        attachments = []
        for i, (content, mime, ext) in enumerate(decoded, 1):
            name = f"fugu-image-{uuid.uuid4().hex[:12]}{ext}"
            dest = directory / name
            dest.write_bytes(content)
            att = await self.ctx.db.add_attachment(self.ctx.conversation_id, name, mime, len(content), str(dest), origin="agent")
            attachments.append({k: att[k] for k in ("id", "filename", "mime", "size")})
        return {"attachments": attachments, "provider": provider, "model": model,
                "note": "Изображения приложены к чату; их можно скачать или загрузить в Drive через drive_upload"}
