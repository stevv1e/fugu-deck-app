"""Инструменты для работы с репозиториями GitHub / GitLab."""
from __future__ import annotations

import asyncio
import io
import mimetypes
import re
import uuid
import zipfile
from pathlib import Path

from .. import filetools

from .providers import FileChange, GitProvider, ProviderError
from .registry import ToolContext, obj, tool

MAX_READ_CHARS = 60_000
MAX_LIST_FILES = 1500
SAFE_NAME = re.compile(r"[^\w.\-() ]+", re.UNICODE)

PROVIDER = {"type": "string", "enum": ["github", "gitlab"], "description": "Где находится репозиторий"}
REPO = {"type": "string", "description": "Полное имя репозитория: owner/name (для GitLab — group/subgroup/name)"}


def _provider(ctx: ToolContext, name: str) -> GitProvider:
    p = ctx.providers.get(name)
    if not p:
        raise ProviderError(f"{name} не подключён: задайте токен в настройках сервера")
    return p


# ------------------------------------------------------------------ чтение
@tool("list_repos", "Список репозиториев пользователя (последние обновлённые). Можно фильтровать по подстроке.",
      obj({"provider": PROVIDER,
           "query": {"type": "string", "description": "Подстрока имени (необязательно)"},
           "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 30}}, ["provider"]),
      group="git", title="Список репозиториев")
async def list_repos(ctx, a):
    return await _provider(ctx, a["provider"]).list_repos(a.get("query"), a.get("limit", 30))


@tool("repo_info", "Информация о репозитории: ветка по умолчанию, список веток, описание.",
      obj({"provider": PROVIDER, "repo": REPO}, ["provider", "repo"]), group="git", title="О репозитории")
async def repo_info(ctx, a):
    return await _provider(ctx, a["provider"]).repo_info(a["repo"])


@tool("list_files", "Рекурсивный список файлов репозитория в ветке (или в подпапке).",
      obj({"provider": PROVIDER, "repo": REPO,
           "ref": {"type": "string", "description": "Ветка/тег/коммит; по умолчанию — основная ветка"},
           "path": {"type": "string", "description": "Подпапка (необязательно)"}}, ["provider", "repo"]),
      group="git", title="Файлы репозитория")
async def list_files(ctx, a):
    res = await _provider(ctx, a["provider"]).list_files(a["repo"], a.get("ref"), a.get("path"))
    if len(res["files"]) > MAX_LIST_FILES:
        res["total"] = len(res["files"])
        res["files"] = res["files"][:MAX_LIST_FILES]
        res["truncated"] = True
    return res


@tool("read_file", "Прочитать файл из репозитория. Для больших файлов используйте start_line/end_line.",
      obj({"provider": PROVIDER, "repo": REPO, "path": {"type": "string"},
           "ref": {"type": "string"},
           "start_line": {"type": "integer", "minimum": 1},
           "end_line": {"type": "integer", "minimum": 1}}, ["provider", "repo", "path"]),
      group="git", title="Чтение файла")
async def read_file(ctx, a):
    raw = await _provider(ctx, a["provider"]).read_file(a["repo"], a["path"], a.get("ref"))
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return {"path": a["path"], "binary": True, "size": len(raw)}
    lines = text.splitlines()
    s, e = a.get("start_line"), a.get("end_line")
    if s or e:
        s = (s or 1) - 1
        e = e or len(lines)
        text = "\n".join(lines[s:e])
    out = {"path": a["path"], "total_lines": len(lines), "content": text[:MAX_READ_CHARS]}
    if len(text) > MAX_READ_CHARS:
        out["truncated"] = True
        out["hint"] = "Файл обрезан — дочитайте через start_line/end_line"
    return out


@tool("ci_status", "Последние запуски CI (GitHub Actions / GitLab pipelines).",
      obj({"provider": PROVIDER, "repo": REPO, "ref": {"type": "string"}}, ["provider", "repo"]),
      group="git", title="Статус CI")
async def ci_status(ctx, a):
    return await _provider(ctx, a["provider"]).ci_status(a["repo"], a.get("ref"))


# ------------------------------------------------------------------ вложения
@tool("list_attachments", "Файлы этого чата: загруженные пользователем с телефона и созданные агентом (origin=agent).",
      obj({}), group="files", title="Вложения")
async def list_attachments(ctx, a):
    return await ctx.db.list_attachments(ctx.conversation_id)


@tool("read_attachment",
      "Прочитать вложение чата. Текст и код — как есть; PDF, DOCX, XLSX — извлечённый текст; архив zip/tar — список "
      "файлов, а с path — содержимое файла из архива. Длинный текст отдаётся кусками: следующий — с offset=next_offset.",
      obj({"attachment_id": {"type": "string"},
           "path": {"type": "string", "description": "Путь файла внутри архива (из списка)"},
           "offset": {"type": "integer", "minimum": 0, "description": "С какого символа читать длинный текст"},
           "start": {"type": "integer", "minimum": 0, "description": "С какой строки списка архива (next_start)"}},
          ["attachment_id"]), group="files", title="Чтение вложения")
async def read_attachment(ctx, a):
    att = await ctx.db.get_attachment(a["attachment_id"])
    if not att or att["conversation_id"] != ctx.conversation_id:
        raise ProviderError("вложение не найдено")
    p = Path(att["path"])
    if not p.is_file():
        raise ProviderError("файл вложения не найден на диске")
    try:
        # разбор документа или архива — в отдельном потоке: PDF на сотни страниц не должен останавливать сервер
        return await asyncio.to_thread(filetools.read, p, att["filename"], att["mime"], a.get("path"),
                                       a.get("offset", 0), a.get("start", 0))
    except filetools.FileError as e:
        raise ProviderError(str(e))


CREATE_MAX = 20 << 20


@tool("create_file",
      "Создать файл и приложить его к чату — пользователь откроет или сохранит его на телефоне. Либо content "
      "(текст: отчёт, CSV, код, Markdown), либо from_attachments — собрать zip из вложений этого чата.",
      obj({"filename": {"type": "string", "description": "Имя файла с расширением, например report.md или data.csv"},
           "content": {"type": "string", "description": "Текст файла"},
           "from_attachments": {"type": "array", "items": {"type": "string"}, "maxItems": 50,
                                "description": "attachment_id вложений, которые сложить в zip"}},
          ["filename"]), group="files", title="Файл для пользователя")
async def create_file(ctx, a):
    name = SAFE_NAME.sub("_", Path(a["filename"]).name)[:120].strip(" .") or "file.txt"
    has_text, ids = a.get("content") is not None, a.get("from_attachments") or []
    if has_text == bool(ids):
        raise ProviderError("нужно что-то одно: content или from_attachments")
    if has_text:
        data = a["content"].encode("utf-8")
    else:
        if not name.lower().endswith(".zip"):
            name += ".zip"
        buf, used = io.BytesIO(), set()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for aid in ids:
                att = await ctx.db.get_attachment(aid)
                if not att or att["conversation_id"] != ctx.conversation_id or not Path(att["path"]).is_file():
                    raise ProviderError(f"вложение {aid} не найдено")
                arc, n = att["filename"], 1
                while arc in used:  # одинаковые имена в архиве — с номером
                    stem, dot, ext = att["filename"].rpartition(".")
                    arc = f"{stem or ext} ({n}){dot}{ext if stem else ''}"
                    n += 1
                used.add(arc)
                z.write(att["path"], arc)
                if buf.tell() > CREATE_MAX:
                    raise ProviderError(f"архив больше {CREATE_MAX >> 20} МБ")
        data = buf.getvalue()
    if len(data) > CREATE_MAX:
        raise ProviderError(f"файл больше {CREATE_MAX >> 20} МБ")
    d = ctx.settings.data_dir / "attachments" / ctx.conversation_id
    d.mkdir(parents=True, exist_ok=True)
    dest = d / f"{uuid.uuid4().hex[:16]}_{name}"
    dest.write_bytes(data)
    mime = mimetypes.guess_type(name)[0] or ("text/plain" if has_text else "application/octet-stream")
    att = await ctx.db.add_attachment(ctx.conversation_id, name, mime, len(data), str(dest), origin="agent")
    return {"attachment": {k: att[k] for k in ("id", "filename", "mime", "size")},
            "note": "Файл приложен к чату: пользователь видит его в карточке этого инструмента"}


# ------------------------------------------------------------------ запись
async def _is_default_branch(ctx: ToolContext, provider: str, repo: str, branch: str) -> bool:
    try:
        info = await _provider(ctx, provider).repo_info(repo)
        return branch == info.get("default_branch")
    except Exception:
        return True  # не смогли проверить — считаем опасным


async def _commit_risk(ctx, a):
    if any(f.get("delete") for f in a.get("files", [])):
        return "dangerous"
    # запись в основную ветку — всегда опасно, даже если модель указала base_branch
    return "dangerous" if await _is_default_branch(ctx, a["provider"], a["repo"], a["branch"]) else "write"


@tool("create_repo", "Создать новый репозиторий (с README). name может быть 'org/name' для организации/группы.",
      obj({"provider": PROVIDER, "name": {"type": "string"},
           "description": {"type": "string", "default": ""},
           "private": {"type": "boolean", "default": True}}, ["provider", "name"]),
      risk="dangerous", group="git", title="Создание репозитория")
async def create_repo(ctx, a):
    out = await _provider(ctx, a["provider"]).create_repo(a["name"], a.get("description", ""), a.get("private", True))
    # созданный в проекте репозиторий сразу в работе проекта
    if ctx.project_id and isinstance(out, dict) and out.get("full_name"):
        await ctx.db.set_project_repo(ctx.project_id, a["provider"], out["full_name"], True)
        out["note"] = "Репозиторий добавлен в работу проекта"
    return out


REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+){1,4}$")


@tool("project_repos", "Репозитории, с которыми работает этот проект.", obj({}), group="git", title="Репозитории проекта")
async def project_repos(ctx, a):
    p = await ctx.db.get_project(ctx.project_id) if ctx.project_id else None
    return (p or {}).get("repos", [])


@tool("project_repo_set",
      "Добавить репозиторий в работу проекта (on=true) или убрать из неё (on=false). Добавляй, когда начинаешь "
      "работать с репозиторием в этом проекте; убирай, когда пользователь просит или проект с ним больше не связан.",
      obj({"provider": PROVIDER, "repo": REPO, "on": {"type": "boolean"}}, ["provider", "repo", "on"]),
      group="git", title="Репозиторий в проекте")
async def project_repo_set(ctx, a):
    if not ctx.project_id:
        raise ProviderError("чат не в проекте")
    if not REPO_RE.match(a["repo"]) or any(seg in (".", "..") for seg in a["repo"].split("/")):
        raise ProviderError("имя репозитория: owner/name")
    repos = await ctx.db.set_project_repo(ctx.project_id, a["provider"], a["repo"], bool(a["on"]))
    if ctx.broker:
        await ctx.broker.publish("project", ctx.project_id, action="updated")
    return {"repos": repos}


@tool("create_branch", "Создать ветку от другой ветки/коммита.",
      obj({"provider": PROVIDER, "repo": REPO, "branch": {"type": "string"},
           "from_ref": {"type": "string", "description": "По умолчанию — основная ветка"}},
          ["provider", "repo", "branch"]),
      risk="write", group="git", title="Новая ветка")
async def create_branch(ctx, a):
    return await _provider(ctx, a["provider"]).create_branch(a["repo"], a["branch"], a.get("from_ref"))


@tool(
    "commit_files",
    "Одним коммитом создать/изменить/удалить несколько файлов. Для каждого файла укажите либо content "
    "(полный новый текст файла), либо attachment_id (файл, загруженный пользователем), либо delete=true. "
    "Если указан base_branch и ветки branch ещё нет — она будет создана от base_branch.",
    obj({
        "provider": PROVIDER, "repo": REPO,
        "branch": {"type": "string"},
        "base_branch": {"type": "string", "description": "Создать branch от этой ветки, если её нет"},
        "message": {"type": "string", "description": "Сообщение коммита"},
        "files": {"type": "array", "minItems": 1, "items": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string"},
                "attachment_id": {"type": "string"},
                "delete": {"type": "boolean"},
            },
            "required": ["path"], "additionalProperties": False}},
    }, ["provider", "repo", "branch", "message", "files"]),
    risk=_commit_risk, group="git", title="Коммит",
)
async def commit_files(ctx, a):
    changes: list[FileChange] = []
    for f in a["files"]:
        path = f["path"].lstrip("/")
        if f.get("delete"):
            changes.append(FileChange(path, None))
        elif f.get("attachment_id"):
            att = await ctx.db.get_attachment(f["attachment_id"])
            if not att or att["conversation_id"] != ctx.conversation_id:
                raise ProviderError(f"вложение {f['attachment_id']} не найдено")
            changes.append(FileChange(path, Path(att["path"]).read_bytes()))
        elif "content" in f:
            changes.append(FileChange(path, f["content"].encode("utf-8")))
        else:
            raise ProviderError(f"для {path} не указано content/attachment_id/delete")
    return await _provider(ctx, a["provider"]).commit_files(
        a["repo"], a["branch"], a["message"], changes, a.get("base_branch"))


@tool("create_pull_request", "Создать Pull Request (GitHub) / Merge Request (GitLab).",
      obj({"provider": PROVIDER, "repo": REPO,
           "source_branch": {"type": "string"},
           "target_branch": {"type": "string", "description": "По умолчанию — основная ветка"},
           "title": {"type": "string"}, "body": {"type": "string", "default": ""}},
          ["provider", "repo", "source_branch", "title"]),
      risk="write", group="git", title="Pull/Merge Request")
async def create_pull_request(ctx, a):
    return await _provider(ctx, a["provider"]).create_pull_request(
        a["repo"], a["source_branch"], a.get("target_branch"), a["title"], a.get("body", ""))
