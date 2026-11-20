from pathlib import Path

import httpx
import pytest

from app.config import Settings
from app.db import Database
from app.drive import DriveClient


class FakeStream:
    def __init__(self, response):
        self.response = response

    async def __aenter__(self):
        return self.response

    async def __aexit__(self, *args):
        return None


class FakeClient:
    files = []
    content = b""
    requests = []

    def __init__(self, *args, **kwargs):
        pass

    async def aclose(self):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def get(self, url, **kwargs):
        self.requests.append((url, kwargs))
        if url.endswith("/files"):
            return httpx.Response(200, json={"files": self.files})
        return httpx.Response(200, json=self.files[0])

    def stream(self, method, url, **kwargs):
        self.requests.append((url, kwargs))
        response = httpx.Response(200, content=self.content)
        response.request = httpx.Request("GET", url)
        return FakeStream(response)

    async def post(self, url, **kwargs):
        if "json" in kwargs:
            self.requests.append((url, kwargs))
            return httpx.Response(200, json={"id": "new-folder", "name": kwargs["json"]["name"],
                                             "mimeType": "application/vnd.google-apps.folder",
                                             "parents": kwargs["json"].get("parents", []),
                                             "webViewLink": "https://drive.test/new-folder"})
        chunks = []
        async for chunk in kwargs["content"]:
            chunks.append(chunk)
        self.requests.append((url, {**kwargs, "content": b"".join(chunks)}))
        return httpx.Response(200, json={"id": "new-file", "name": "voice.ogg", "webViewLink": "https://drive.test/new-file"})


@pytest.mark.asyncio
async def test_drive_search_and_import_google_doc(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("app.drive.httpx.AsyncClient", FakeClient)
    settings = Settings(data_dir=tmp_path)
    db = Database(str(settings.db_path))
    await db.connect()
    await db._exec("INSERT INTO conversations (id,model,created_at,updated_at) VALUES ('c','openai:test',1,1)")
    ctx = type("Ctx", (), {"settings": settings, "db": db, "conversation_id": "c"})()
    client = DriveClient(ctx)
    client._access = "token"
    client._expires = 4_000_000_000
    FakeClient.files = [{"id": "doc-1", "name": "План", "mimeType": "application/vnd.google-apps.document",
                         "webViewLink": "https://docs.google.com/document/d/doc-1"}]
    found = await client.search("бюджет", folder_id="folder-1")
    assert found["files"][0]["id"] == "doc-1"
    url, call = FakeClient.requests[-1]
    assert "name contains 'бюджет'" in call["params"]["q"]
    assert "'folder-1' in parents" in call["params"]["q"]
    FakeClient.content = b"docx-content"
    got = await client.import_file("doc-1")
    assert got["attachment"]["filename"] == "План.docx"
    att = await db.get_attachment(got["attachment"]["id"])
    assert Path(att["path"]).read_bytes() == b"docx-content"
    assert FakeClient.requests[-1][1]["params"]["mimeType"].endswith("wordprocessingml.document")
    await db.close()


@pytest.mark.asyncio
async def test_drive_upload_attachment(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("app.drive.httpx.AsyncClient", FakeClient)
    settings = Settings(data_dir=tmp_path)
    db = Database(str(settings.db_path))
    await db.connect()
    await db._exec("INSERT INTO conversations (id,model,created_at,updated_at) VALUES ('c','openai:test',1,1)")
    source = tmp_path / "voice.ogg"
    source.write_bytes(b"audio-data")
    att = await db.add_attachment("c", "voice.ogg", "audio/ogg", 10, str(source))
    ctx = type("Ctx", (), {"settings": settings, "db": db, "conversation_id": "c"})()
    client = DriveClient(ctx)
    client._access = "token"
    client._expires = 4_000_000_000
    got = await client.upload(att["id"], "folder-1")
    assert got["file"]["id"] == "new-file"
    url, call = FakeClient.requests[-1]
    assert url.endswith("/upload/drive/v3/files")
    assert b'"parents": ["folder-1"]' in call["content"] and b"audio-data" in call["content"]
    assert int(call["headers"]["Content-Length"]) == len(call["content"])
    await db.close()


@pytest.mark.asyncio
async def test_drive_create_folder(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("app.drive.httpx.AsyncClient", FakeClient)
    settings = Settings(data_dir=tmp_path)
    ctx = type("Ctx", (), {"settings": settings})()
    client = DriveClient(ctx)
    client._access = "token"
    client._expires = 4_000_000_000
    got = await client.create_folder("Проекты", "folder-1")
    assert got["folder"]["id"] == "new-folder"
    url, call = FakeClient.requests[-1]
    assert url.endswith("/drive/v3/files")
    assert call["json"] == {"name": "Проекты", "mimeType": "application/vnd.google-apps.folder",
                            "parents": ["folder-1"]}
    assert call["params"]["supportsAllDrives"] == "true"
    with pytest.raises(Exception, match="ID родительской папки"):
        await client.create_folder("Проекты", "../other")


@pytest.mark.asyncio
async def test_drive_rejects_oversized_media_before_download(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("app.drive.httpx.AsyncClient", FakeClient)
    settings = Settings(data_dir=tmp_path, max_media_upload_mb=1)
    db = Database(str(settings.db_path))
    await db.connect()
    await db._exec("INSERT INTO conversations (id,model,created_at,updated_at) VALUES ('c','openai:test',1,1)")
    ctx = type("Ctx", (), {"settings": settings, "db": db, "conversation_id": "c"})()
    client = DriveClient(ctx)
    client._access = "token"
    client._expires = 4_000_000_000
    FakeClient.files = [{"id": "video-1", "name": "video.mp4", "mimeType": "video/mp4", "size": str(2 * 1024 * 1024)}]
    with pytest.raises(Exception, match="больше 1 МБ"):
        await client.import_file("video-1")
    await db.close()
