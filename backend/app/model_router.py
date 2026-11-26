from __future__ import annotations

import re

AUTO_MODEL = "auto:auto"
CATEGORIES = ("simple", "code", "complex", "media")

COMPLEX = re.compile(
    r"архитектур|рефактор|безопасн|threat\s*model|security\s*audit|инцидент|миграци[яи]\s+бд|"
    r"распредел[её]нн|multi[- ]?step|многоэтап|production\s+incident|оптимизируй\s+весь|полный\s+аудит", re.I)
CODE = re.compile(
    r"\b(?:code|coding|bug|fix|debug|commit|pull\s*request|merge\s*request|function|class|api|sql|test|tests|ci|"
    r"docker|kubernetes|linux|python|typescript|javascript|golang|rust)\b|"
    r"код|функци|класс|ошибк|исправ|тест|коммит|репозитор|запрос\s+в\s+бд|сервер|деплой|сборк", re.I)


def route_model(task: str, routes: dict, project_id: str = "", attachments: list[dict] | None = None,
                available: list[str] | None = None) -> dict:
    if not isinstance(routes, dict) or not routes:
        raise ValueError("Детерминированный router не настроен")
    attachments = attachments or []
    media = any(str(item.get("mime") or "").startswith(("image/", "audio/", "video/")) or
                str(item.get("mime") or "") == "application/pdf" for item in attachments)
    if media:
        category = "media"
        reason = "медиа или PDF-вложение"
    elif len(task) > 5000 or COMPLEX.search(task):
        category = "complex"
        reason = "длинный или сложный запрос"
    elif project_id == "talk" or (len(task) <= 700 and not CODE.search(task)):
        category = "simple"
        reason = "общение или короткий запрос без инженерных признаков"
    else:
        category = "code"
        reason = "инженерный проект или признаки задачи разработки"
    model = routes.get(category) or routes.get("default")
    if not isinstance(model, str) or not model or model == AUTO_MODEL:
        raise ValueError(f"Для категории {category} не настроена модель")
    if available is not None and model not in available:
        raise ValueError(f"Модель {model} для категории {category} отсутствует в каталоге")
    return {"model": model, "category": category, "reason": reason,
            "task_chars": len(task), "attachments": len(attachments)}
