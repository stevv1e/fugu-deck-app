"""База знаний проекта: заметки со связями поверх памяти проекта.

Заметка — запись памяти (таблица memories) с заголовком, областью, группой, источником и состоянием. Связи между
заметками типизированы и имеют силу: она растёт, когда агент пользуется двумя заметками в одном запуске.
Здесь — то, что не зависит от хранилища: области, разбор ссылок [[…]], данные для экрана базы знаний.

Экран (мозг / паутина / Иггдрасиль) рисует приложение; пространство отдаёт ему заметки, области и связи.
"""
from __future__ import annotations

import re
import time

# Области — доли мозга, секторы паутины, ветви дерева. Порядок и ключи одни для сервера и экрана.
AREAS: dict[str, str] = {"dec": "Решения", "inf": "Инфраструктура", "code": "Код", "ppl": "Люди и агенты", "ops": "Операции"}

# Тип связи: часть, зависит от, решение по, противоречит, пример, ссылка.
LINK_TYPES: dict[str, str] = {"part": "часть", "dep": "зависит от", "dec": "решение по", "con": "противоречит",
                              "ex": "пример", "ref": "ссылка"}

# Откуда заметка. Экран показывает источники как пять «миров» у корней дерева и якорей паутины.
ORIGINS: dict[str, str] = {"docs": "Документы", "chats": "Чаты", "api": "Репозитории", "web": "Вручную", "prod": "Серверы"}

_HINTS: list[tuple[str, tuple[str, ...]]] = [
    ("ops", ("инцидент", "runbook", "ранбук", "алерт", "лог", "бэкап", "бекап", "резервн", "перезапус", "дежур", "мониторинг",
             "откат", "деплой", "выкат", "релиз", "incident", "backup", "alert", "deploy", "rollback", "postmortem")),
    ("inf", ("сервер", "кластер", "nginx", "kubernetes", "k8s", "k3s", "docker", "postgres", "redis", "dns", "tls", "сертификат",
             "домен", "порт", "vpn", "terraform", "argo", "traefik", "s3", "бакет", "сеть", "ssh", "хост", "инфраструктур")),
    ("code", ("репозитор", "repo", "модуль", "функци", "класс", "api", "эндпоинт", "endpoint", "миграци", "тест", "ci", "ветк",
              "коммит", "pull request", "pr ", "библиотек", "зависимост", "файл", ".py", ".ts", ".go", "код")),
    ("ppl", ("участник", "владелец", "редактор", "команда", "агент", "пользовател", "роль", "контакт", "отвечает", "клиент",
             "заказчик", "предпочита", "зовут")),
    ("dec", ("решени", "решили", "договор", "правило", "политик", "принцип", "всегда", "никогда", "только", "запрещ", "нельзя",
             "должн", "выбрали", "соглаш", "стандарт")),
]


_RU_END = re.compile(r"(иями|ями|ами|ого|его|ому|ему|ыми|ими|ией|ия|ий|ой|ей|ая|яя|ое|ее|ые|ие|ах|ях|ам|ям|ом|ем|ов|ев|ую|юю|ть|ся|ом|а|я|о|е|ы|и|у|ю|ь|й)$")
_EN_END = re.compile(r"(ations|ation|ings|ing|ers|er|ed|es|s)$")
_STOP = {"и", "в", "на", "с", "по", "к", "о", "об", "от", "до", "за", "из", "у", "не", "как", "что", "это", "для", "the", "a", "an",
         "of", "to", "in", "on", "for", "and", "or", "is", "где", "когда", "какой", "какая", "какие", "мы", "у", "нас", "наш"}


def stems(query: str, limit: int = 12) -> list[str]:
    """Основы слов запроса для поиска по началу: «бэкапы базы» находит «бэкап базы данных», «резервной» — «резервная».
    Грубо (отрезаем окончания), но без словарей и без модели: русский и английский."""
    out: list[str] = []
    for w in re.findall(r"\w+", query.lower()):
        if w in _STOP or len(w) < 2:
            continue
        cyr = bool(re.search(r"[а-яё]", w))
        base = _RU_END.sub("", w) if cyr and len(w) > 4 else _EN_END.sub("", w) if len(w) > 4 else w
        base = base if len(base) >= 3 else w
        if base not in out:
            out.append(base)
    return out[:limit]


def relevance(stems_: list[str], title: str, content: str, tags: str = "") -> float:
    """Сколько разных основ запроса встретилось: в заголовке и метках — вдвое весомее, чем в тексте."""
    t, c = f"{title} {tags}".lower(), content.lower()
    return sum(2.0 if s in t else 1.0 if s in c else 0.0 for s in stems_)


def classify(content: str, tags: str = "") -> str:
    """Область заметки по словам. Грубая, но предсказуемая замена кластеризации; человек может задать область сам."""
    text = f"{tags} {content}".lower()
    best, score = "dec", 0
    for area, words in _HINTS:
        n = sum(text.count(w) for w in words)
        if n > score:
            best, score = area, n
    return best


def title_of(content: str, title: str | None = None) -> str:
    if title and title.strip():
        return title.strip()[:120]
    first = next((ln.strip() for ln in content.splitlines() if ln.strip()), "")
    first = re.sub(r"^#+\s*", "", first)
    first = re.split(r"(?<=[.!?:;—])\s", first, maxsplit=1)[0].rstrip(".:;—")
    return (first[:70].rstrip() + "…") if len(first) > 72 else (first or "Заметка")


def group_of(tags: str, grp: str | None = None) -> str:
    if grp and grp.strip():
        return grp.strip()[:40]
    first = next((t.strip() for t in re.split(r"[,;]", tags or "") if t.strip()), "")
    return first[:40] or "Прочее"


_WIKI = re.compile(r"\[\[([^\[\]\n|]{1,120})(?:\|[^\[\]\n]*)?\]\]")


def wiki_links(content: str) -> list[str]:
    """Заголовки заметок, на которые текст ссылается как [[Заголовок]] или [[Заголовок|подпись]]."""
    seen: list[str] = []
    for m in _WIKI.finditer(content or ""):
        t = m.group(1).strip()
        if t and t.lower() not in (s.lower() for s in seen):
            seen.append(t)
    return seen[:50]


def origin_of(m: dict) -> str:
    o = m.get("origin")
    if o in ORIGINS:
        return o
    return "chats" if m.get("source") == "agent" or m.get("conversation_id") else "web"


def effective_strength(strength: float, last_used: float | None, created: float, now: float) -> float:
    """Сила связи с учётом давности: без использования она медленно слабеет (вдвое за ~90 дней), но не исчезает."""
    idle_days = max(0.0, (now - (last_used or created)) / 86400)
    return round(max(0.12, min(1.0, strength) * 0.5 ** (idle_days / 90)), 3)


def graph(project: dict, memories: list[dict], links: list[dict], now: float | None = None) -> dict:
    """Данные экрана базы знаний. Тексты отдаются как есть: экран обязан выводить их как текст, а не как разметку."""
    now = now or time.time()
    hub = f"p:{project['id']}"
    notes, groups = [], {a: {} for a in AREAS}
    for m in memories:
        area = m.get("area") if m.get("area") in AREAS else classify(m["content"], m.get("tags") or "")
        nid = f"n{m['id']}"
        used = m.get("last_used_at") or m.get("updated_at") or now
        notes.append({
            "id": nid, "mid": m["id"], "area": area, "title": title_of(m["content"], m.get("title")), "body": m["content"],
            "days": max(0, int((now - used) // 86400)),
            "source": m.get("source_ref") or {"agent": "записал агент", "user": "записал(а) " + (m.get("author") or "участник")}.get(
                m.get("source") or "", m.get("author") or "заметка"),
            "src": origin_of(m), "stale": bool(m.get("stale")), "ext": bool(m.get("external")),
            "pinned": bool(m.get("pinned")), "tags": m.get("tags") or "",
        })
        groups[area].setdefault(group_of(m.get("tags") or "", m.get("grp")), []).append(nid)
    # Проект — ствол дерева, центр паутины, узел в височной доле: на нём держится всё остальное.
    notes.append({"id": hub, "mid": None, "area": "ppl", "title": f"Проект {project.get('name') or project['id']}",
                  "body": project.get("description") or "Всё в базе знаний держится на проекте.", "days": 0, "source": "проект",
                  "src": "web", "stale": False, "ext": False, "pinned": False, "tags": "", "hub": True})
    ids = {n["id"] for n in notes}
    edges = []
    for ln in links:
        a, b = f"n{ln['a']}", f"n{ln['b']}"
        if a in ids and b in ids and ln["type"] in LINK_TYPES:
            edges.append([a, b, ln["type"], effective_strength(ln["strength"], ln.get("last_used_at"), ln["created_at"], now)])
    return {
        "project": {"id": project["id"], "name": project.get("name") or project["id"]}, "hub": hub,
        "areas": {a: {"name": name, "groups": [[g, sorted(v)] for g, v in sorted(groups[a].items())]} for a, name in AREAS.items()},
        "sources": ORIGINS, "link_types": LINK_TYPES, "notes": notes, "edges": edges, "generated_at": now,
    }
