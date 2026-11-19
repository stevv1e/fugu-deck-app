"""Google Drive: поиск, скачивание во вложения чата и загрузка новых файлов."""
from __future__ import annotations

import asyncio
import json
import mimetypes
import re
import time
import uuid
from pathlib import Path
from urllib.parse import quote

import httpx

from . import keyguard_client as kgc

FILE_ID = re.compile(r"^[A-Za-z0-9_-]{1,200}$")
EXPORTS = {
    "application/vnd.google-apps.document": ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"),
    "application/vnd.google-apps.spreadsheet": ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"),
    "application/vnd.google-apps.presentation": ("application/pdf", ".pdf"),
}


class DriveError(ValueError):
    pass


def _q(value: str) -> str:
    return value.replace("\\", "\\\\").replace("'", "\\'")


class DriveClient:
    def __init__(self, ctx):
        self.ctx = ctx
        self.settings = ctx.settings
        self._access = ""
        self._expires = 0.0

    def _headers(self) -> dict[str, str]:
        if kgc.enabled():
            return {"Authorization": f"Bearer {kgc.token()}"}
        return {"Authorization": f"Bearer {self._access}"}

    async def _refresh(self) -> None:
        if kgc.enabled() or self._expires > time.time() + 300:
            return
        s = self.settings
        if not s.google_drive_refresh_token or not s.google_oauth_client_id or not s.google_oauth_client_secret:
            raise DriveError("Google Drive не подключён или не настроен OAuth client")
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post("https://oauth2.googleapis.com/token", data={
                "client_id": s.google_oauth_client_id, "client_secret": s.google_oauth_client_secret,
                "refresh_token": s.google_drive_refresh_token, "grant_type": "refresh_token"})
        data = r.json()
        if r.status_code != 200 or not data.get("access_token"):
            raise DriveError("Google отклонил OAuth refresh token")
        self._access = data["access_token"]
        self._expires = time.time() + int(data.get("expires_in") or 3600)

    async def _get(self, path: str, params: dict | None = None, stream: bool = False):
        await self._refresh()
        base = self.settings.keyguard_url.rstrip("/") + "/drive" if kgc.enabled() else "https://www.googleapis.com/drive/v3"
        url = base + path
        timeout = httpx.Timeout(300, connect=30)
        client = httpx.AsyncClient(timeout=timeout)
        if stream:
            return client, client.stream("GET", url, params=params, headers=self._headers())
        try:
            r = await client.get(url, params=params, headers=self._headers())
        finally:
            await client.aclose()
        if r.status_code != 200:
            raise DriveError(f"Google Drive: {r.status_code} {r.text[:300]}")
        return r.json()

    async def search(self, query: str = "", mime: str = "", folder_id: str = "", limit: int = 20) -> dict:
        limit = max(1, min(limit, 100))
        conditions = ["trashed=false"]
        if query.strip():
            conditions.append(f"name contains '{_q(query.strip())}'")
        if mime.strip():
            conditions.append(f"mimeType='{_q(mime.strip())}'")
        if folder_id:
            if not FILE_ID.fullmatch(folder_id):
                raise DriveError("Некорректный ID папки")
            conditions.append(f"'{folder_id}' in parents")
        params = {"q": " and ".join(conditions), "pageSize": limit,
                  "fields": "nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,webViewLink)",
                  "orderBy": "modifiedTime desc", "spaces": "drive", "includeItemsFromAllDrives": "true",
                  "supportsAllDrives": "true"}
        return await self._get("/files", params)

    async def metadata(self, file_id: str) -> dict:
        if not FILE_ID.fullmatch(file_id):
            raise DriveError("Некорректный ID файла")
        return await self._get("/files/" + quote(file_id), {
            "fields": "id,name,mimeType,size,modifiedTime,parents,webViewLink", "supportsAllDrives": "true"})

    async def import_file(self, file_id: str) -> dict:
        meta = await self.metadata(file_id)
        mime = meta["mimeType"]
        name = re.sub(r"[^\w.\-() ]+", "_", Path(meta["name"]).name, flags=re.UNICODE)[:120].strip(" .") or "drive-file"
        export = EXPORTS.get(mime)
        path = "/files/" + quote(file_id) + ("/export" if export else "")
        params = {"mimeType": export[0]} if export else {"alt": "media"}
        if export:
            name += export[1]
        else:
            name = Path(name).name
        if not Path(name).suffix:
            name += mimetypes.guess_extension(export[0] if export else mime) or ".bin"
        out_mime = export[0] if export else mime
        is_media = out_mime.startswith(("audio/", "video/")) or Path(name).suffix.lower() in {
            ".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac", ".mp4", ".mov", ".mkv", ".webm", ".mpeg"}
        limit = (self.settings.max_media_upload_mb if is_media else self.settings.max_upload_mb) * 1024 * 1024
        if meta.get("size") and int(meta["size"]) > limit:
            raise DriveError(f"Файл больше {limit // 1024 // 1024} МБ")
        client, stream = await self._get(path, params, stream=True)
        directory = self.settings.data_dir / "attachments" / self.ctx.conversation_id
        directory.mkdir(parents=True, exist_ok=True)
        dest = directory / f"{uuid.uuid4().hex[:16]}_{name}"
        size = 0
        try:
            async with stream as r:
                if r.status_code != 200:
                    await r.aread()
                    raise DriveError(f"Google Drive: {r.status_code} {r.text[:300]}")
                with dest.open("wb") as f:
                    async for chunk in r.aiter_bytes(2 * 1024 * 1024):
                        size += len(chunk)
                        if size > limit:
                            raise DriveError(f"Файл больше {limit // 1024 // 1024} МБ")
                        f.write(chunk)
        except Exception:
            dest.unlink(missing_ok=True)
            raise
        finally:
            await client.aclose()
        if not size:
            dest.unlink(missing_ok=True)
            raise DriveError("Google Drive вернул пустой файл")
        att = await self.ctx.db.add_attachment(self.ctx.conversation_id, name, out_mime, size, str(dest), origin="user")
        return {"attachment": {k: att[k] for k in ("id", "filename", "mime", "size")},
                "source": {"id": file_id, "name": meta["name"], "url": meta.get("webViewLink")},
                "note": "Файл импортирован в чат; для аудио/видео используйте transcribe_media, для документов — read_attachment"}

    async def upload(self, attachment_id: str, folder_id: str = "") -> dict:
        att = await self.ctx.db.get_attachment(attachment_id)
        if not att or att["conversation_id"] != self.ctx.conversation_id:
            raise DriveError("Вложение не найдено")
        if folder_id and not FILE_ID.fullmatch(folder_id):
            raise DriveError("Некорректный ID папки")
        path = Path(att["path"])
        if not path.is_file():
            raise DriveError("Файл вложения не найден")
        size = path.stat().st_size
        limit = self.settings.max_media_upload_mb * 1024 * 1024
        if not size or size > limit:
            raise DriveError(f"Файл должен быть непустым и не больше {limit // 1024 // 1024} МБ")
        await self._refresh()
        name = re.sub(r"[^\w.\-() ]+", "_", Path(att["filename"]).name, flags=re.UNICODE)[:120].strip(" .") or "fugu-file"
        mime = att["mime"] or mimetypes.guess_type(name)[0] or "application/octet-stream"
        metadata = {"name": name, **({"parents": [folder_id]} if folder_id else {})}
        boundary = "fugu-" + uuid.uuid4().hex
        prefix = (f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n"
                  + json.dumps(metadata, ensure_ascii=False)
                  + f"\r\n--{boundary}\r\nContent-Type: {mime}\r\n\r\n").encode()
        suffix = f"\r\n--{boundary}--\r\n".encode()

        async def content():
            yield prefix
            with path.open("rb") as f:
                while chunk := await asyncio.to_thread(f.read, 2 * 1024 * 1024):
                    yield chunk
            yield suffix

        base = self.settings.keyguard_url.rstrip("/") + "/drive/upload/files" if kgc.enabled() else \
            "https://www.googleapis.com/upload/drive/v3/files"
        params = {"uploadType": "multipart", "fields": "id,name,mimeType,size,webViewLink", "supportsAllDrives": "true"}
        headers = self._headers() | {"Content-Type": f"multipart/related; boundary={boundary}",
                                    "Content-Length": str(len(prefix) + size + len(suffix))}
        async with httpx.AsyncClient(timeout=httpx.Timeout(900, connect=30)) as client:
            r = await client.post(base, params=params, headers=headers, content=content())
        if r.status_code != 200:
            raise DriveError(f"Google Drive upload: {r.status_code} {r.text[:300]}")
        data = r.json()
        if not data.get("id"):
            raise DriveError("Google Drive не вернул ID загруженного файла")
        return {"file": data, "attachment_id": attachment_id,
                "note": "Новый файл загружен в Google Drive; существующие файлы не изменялись"}
