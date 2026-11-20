"""Google Drive: поиск, импорт выбранных файлов, загрузка вложений и создание папок."""
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


@tool("drive_upload",
      "Загрузить вложение этого чата в Google Drive как новый файл. Можно указать folder_id; без него файл попадёт в корень. "
      "Не изменяет и не удаляет существующие файлы.",
      obj({"attachment_id": {"type": "string"}, "folder_id": {"type": "string"}}, ["attachment_id"]),
      risk="write", group="drive", title="Загрузка в Google Drive")
async def drive_upload(ctx, a):
    try:
        return await DriveClient(ctx).upload(a["attachment_id"], a.get("folder_id", ""))
    except DriveError as e:
        raise ProviderError(str(e))


@tool("drive_create_folder",
      "Создать новую папку в Google Drive. Можно указать folder_id родительской папки; без него папка создаётся в корне. "
      "Возвращает ID и ссылку новой папки, не изменяет существующие файлы.",
      obj({"name": {"type": "string", "description": "Название новой папки"},
           "folder_id": {"type": "string", "description": "Необязательный ID родительской папки"}}, ["name"]),
      risk="write", group="drive", title="Создание папки в Google Drive")
async def drive_create_folder(ctx, a):
    try:
        return await DriveClient(ctx).create_folder(a["name"], a.get("folder_id", ""))
    except DriveError as e:
        raise ProviderError(str(e))
