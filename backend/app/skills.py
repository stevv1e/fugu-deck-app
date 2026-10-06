"""Скилы — инструкции для агента, хранятся файлами в отдельной папке.

Структура (совместима с форматом Agent Skills):

    skills/
      conventional-commits/
        SKILL.md          ← frontmatter (name, description) + текст инструкции
        examples.md       ← необязательные доп. файлы, агент может их прочитать

Папку можно смонтировать из отдельного git-репозитория — тогда скилы
версионируются и деплоятся по GitOps, а в приложении редактируются (если папка
доступна на запись) или только просматриваются.
"""
from __future__ import annotations

import os
import re
import shutil
from pathlib import Path

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
FM_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.S)
MAX_SKILL_BYTES = 200_000


class SkillError(Exception):
    pass


def parse(text: str) -> tuple[dict, str]:
    m = FM_RE.match(text)
    meta: dict = {}
    body = text
    if m:
        for line in m.group(1).splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                meta[k.strip()] = v.strip().strip('"').strip("'")
        body = text[m.end():]
    return meta, body


def render(name: str, description: str, body: str) -> str:
    desc = description.replace("\n", " ").strip()
    return f"---\nname: {name}\ndescription: {desc}\n---\n\n{body.strip()}\n"


class SkillStore:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    @property
    def writable(self) -> bool:
        return os.access(self.root, os.W_OK)

    def _dir(self, name: str) -> Path:
        if not NAME_RE.match(name):
            raise SkillError("Имя скила: латиница в нижнем регистре, цифры и дефис (до 64 символов)")
        return self.root / name

    def list(self) -> list[dict]:
        out = []
        for d in sorted(self.root.iterdir()):
            f = d / "SKILL.md"
            if not d.is_dir() or not f.exists() or not NAME_RE.match(d.name):
                continue
            meta, body = parse(f.read_text("utf-8", errors="replace"))
            out.append({
                "name": d.name,
                "description": meta.get("description", ""),
                "files": sorted(p.name for p in d.iterdir() if p.is_file() and p.name != "SKILL.md"),
                "size": f.stat().st_size,
                "updated_at": f.stat().st_mtime,
            })
        return out

    def get(self, name: str) -> dict:
        f = self._dir(name) / "SKILL.md"
        if not f.exists():
            raise SkillError(f"Скил {name} не найден")
        meta, body = parse(f.read_text("utf-8", errors="replace"))
        return {"name": name, "description": meta.get("description", ""), "body": body.strip(),
                "files": sorted(p.name for p in f.parent.iterdir() if p.is_file() and p.name != "SKILL.md"),
                "updated_at": f.stat().st_mtime}

    def read_file(self, name: str, filename: str) -> str:
        d = self._dir(name)
        f = (d / filename).resolve()
        if d.resolve() not in f.parents or not f.is_file():
            raise SkillError("Файл скила не найден")
        return f.read_text("utf-8", errors="replace")[:MAX_SKILL_BYTES]

    def save(self, name: str, description: str, body: str, rename_from: str | None = None) -> dict:
        if not self.writable:
            raise SkillError("Папка скилов доступна только на чтение (управляется через git)")
        d = self._dir(name)
        if rename_from and rename_from != name:
            old = self._dir(rename_from)
            if d.exists():
                raise SkillError(f"Скил {name} уже существует")
            if old.exists():
                old.rename(d)
        text = render(name, description, body)
        if len(text.encode()) > MAX_SKILL_BYTES:
            raise SkillError("Скил слишком большой")
        d.mkdir(exist_ok=True)
        tmp = d / ".SKILL.md.tmp"
        tmp.write_text(text, "utf-8")
        tmp.replace(d / "SKILL.md")
        return self.get(name)

    def delete(self, name: str) -> None:
        if not self.writable:
            raise SkillError("Папка скилов доступна только на чтение")
        d = self._dir(name)
        if d.exists():
            shutil.rmtree(d)

    def seed(self) -> None:
        marker = self.root / ".seeded"
        if marker.exists() or not self.writable:
            return
        examples = {
            "conventional-commits": (
                "Как оформлять коммиты и названия веток. Используй при любом коммите или создании ветки.",
                "# Conventional Commits\n\n"
                "Формат: `<type>(<scope>): <кратко, в повелительном наклонении>`\n\n"
                "Типы: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `perf`.\n\n"
                "- Заголовок до 72 символов, без точки в конце.\n"
                "- В теле — *зачем* сделано изменение, если это не очевидно.\n"
                "- Ветки: `feat/<кратко>`, `fix/<кратко>`, латиница и дефисы.\n",
            ),
            "python-service": (
                "Шаблон и правила для новых Python-сервисов (FastAPI, Docker, CI). Используй при создании нового сервиса.",
                "# Python-сервис\n\n"
                "Структура:\n\n```\napp/\n  main.py\n  config.py      # pydantic-settings, всё из env\ntests/\n"
                "Dockerfile       # python:3.12-slim, непривилегированный пользователь\n"
                "requirements.txt\n.github/workflows/ci.yml  # ruff + pytest\nREADME.md\n```\n\n"
                "Правила:\n- Секреты только из переменных окружения, `.env` в `.gitignore`.\n"
                "- Эндпоинт `/health` для healthcheck.\n- Логи в stdout.\n- Версии зависимостей с верхней границей.\n",
            ),
        }
        for name, (desc, body) in examples.items():
            if not (self.root / name).exists():
                self.save(name, desc, body)
        marker.write_text("1")
