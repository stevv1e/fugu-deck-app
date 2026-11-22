import base64
from pathlib import Path

import httpx
import pytest

from app.config import Settings
from app.db import Database
from app.image import ImageGenerator, decode_image

PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="


class FakeClient:
    response = None
    calls = []

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.response


def test_decode_image():
    data, mime, ext = decode_image(PNG, "")
    assert data.startswith(b"\x89PNG") and mime == "image/png" and ext == ".png"
    with pytest.raises(Exception):
        decode_image(base64.b64encode(b"not image").decode(), "image/png")


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["openai", "google"])
async def test_generate_image_attachment(provider, tmp_path: Path, monkeypatch):
    monkeypatch.setattr("app.image.httpx.AsyncClient", FakeClient)
    settings = Settings(data_dir=tmp_path)
    db = Database(str(settings.db_path))
    await db.connect()
    await db._exec("INSERT INTO conversations (id,model,created_at,updated_at) VALUES ('c','openai:test',1,1)")
    run = type("Run", (), {"keys": {provider: "secret"}})()
    ctx = type("Ctx", (), {"settings": settings, "db": db, "conversation_id": "c", "run": run})()
    if provider == "openai":
        FakeClient.response = httpx.Response(200, json={"data": [{"b64_json": PNG}]})
    else:
        FakeClient.response = httpx.Response(200, json={"output_image": {"mime_type": "image/png", "data": PNG}})
    got = await ImageGenerator(ctx).generate(provider, "Draw an otter", "")
    assert got["attachments"][0]["mime"] == "image/png"
    att = await db.get_attachment(got["attachments"][0]["id"])
    assert Path(att["path"]).read_bytes().startswith(b"\x89PNG")
    url, call = FakeClient.calls[-1]
    if provider == "openai":
        assert url.endswith("/v1/images/generations") and call["json"]["model"] == "gpt-image-2.5-flare"
        assert call["headers"]["Authorization"] == "Bearer secret"
    else:
        assert url.endswith("/v1beta/interactions") and call["json"]["model"] == "gemini-3.1-flash-lite-image"
        assert call["headers"]["x-goog-api-key"] == "secret" and call["headers"]["Api-Revision"] == "2026-05-20"
    await db.close()


@pytest.mark.asyncio
async def test_google_image_free_tier_error_without_retries(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("app.image.httpx.AsyncClient", FakeClient)
    FakeClient.response = httpx.Response(429, json={"error": {"message":
        "Quota exceeded for gemini-3.1-flash-lite-image: limit: 0 for free tier; use a paid tier to access image generation."}})
    settings = Settings(data_dir=tmp_path)
    db = Database(str(settings.db_path))
    await db.connect()
    await db._exec("INSERT INTO conversations (id,model,created_at,updated_at) VALUES ('c','google:test',1,1)")
    run = type("Run", (), {"keys": {"google": "secret"}})()
    ctx = type("Ctx", (), {"settings": settings, "db": db, "conversation_id": "c", "run": run})()
    before = len(FakeClient.calls)
    with pytest.raises(ValueError, match="Free Tier"):
        await ImageGenerator(ctx).generate("google", "Draw an otter", "")
    assert len(FakeClient.calls) == before + 1
    await db.close()
