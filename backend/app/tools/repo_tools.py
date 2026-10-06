"""Инструменты для работы с репозиториями GitHub / GitLab."""
from __future__ import annotations

from pathlib import Path

from .providers import FileChange, GitProvider, ProviderError
from .registry import ToolContext, obj, tool

MAX_READ_CHARS = 60_000
MAX_LIST_FILES = 1500

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
@tool("list_attachments", "Файлы, которые пользователь загрузил в этот чат с телефона.",
      obj({}), group="files", title="Вложения")
async def list_attachments(ctx, a):
    return await ctx.db.list_attachments(ctx.conversation_id)


@tool("read_attachment", "Прочитать текстовое содержимое загруженного пользователем файла.",
      obj({"attachment_id": {"type": "string"}}, ["attachment_id"]), group="files", title="Чтение вложения")
async def read_attachment(ctx, a):
    att = await ctx.db.get_attachment(a["attachment_id"])
    if not att or att["conversation_id"] != ctx.conversation_id:
        raise ProviderError("вложение не найдено")
    raw = Path(att["path"]).read_bytes()
    try:
        return {"filename": att["filename"], "content": raw.decode("utf-8")[:MAX_READ_CHARS]}
    except UnicodeDecodeError:
        return {"filename": att["filename"], "binary": True, "size": len(raw),
                "hint": "Бинарный файл можно закоммитить через commit_files с attachment_id"}


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
    return await _provider(ctx, a["provider"]).create_repo(a["name"], a.get("description", ""), a.get("private", True))


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
