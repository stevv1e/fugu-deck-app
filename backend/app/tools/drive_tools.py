"""Google Drive read-only: поиск и импорт выбранных файлов в текущий чат."""
from __future__ import annotations

from ..drive import DriveClient, DriveError
from .providers import ProviderError
from .registry import obj, tool


@tool("drive_search",
      "Найти файлы в Google Drive пользователя. Без query — последние файлы. Можно указать MIME или ID папки. "
      "Возвращает file_id для drive_import; ничего не скачивает.",
      obj({"query": {"type": "string", "description": "Часть имени файла"},
           "mime": {"type": "string", "description": "Например video/mp4 или application/vnd.google-apps.spreadsheet"},
           "folder_id": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20}}),
      group="drive", title="Поиск в Google Drive")
async def drive_search(ctx, a):
    try:
        return await DriveClient(ctx).search(a.get("query", ""), a.get("mime", ""), a.get("folder_id", ""), a.get("limit", 20))
    except DriveError as e:
        raise ProviderError(str(e))


@tool("drive_import",
      "Импортировать файл Google Drive в чат по file_id. Google Docs/Sheets/Slides экспортируются как DOCX/XLSX/PDF, "
      "остальные файлы скачиваются. Затем документ читается через read_attachment, медиа — через transcribe_media.",
      obj({"file_id": {"type": "string"}}, ["file_id"]), risk="write", group="drive", title="Импорт из Google Drive")
async def drive_import(ctx, a):
    try:
        return await DriveClient(ctx).import_file(a["file_id"])
    except DriveError as e:
        raise ProviderError(str(e))
