"""База знаний ⇄ папка Obsidian (zip с .md).

Экспорт: заметка — файл «<заголовок>.md» с заголовочной частью (title, area, group, tags, source, stale), текстом и
разделом «## Связи» — по строке на исходящую связь: «- <тип>: [[Заголовок]]». Импорт — обратно: заголовочная часть,
текст без раздела связей, связи по этим строкам; ссылки [[…]] в тексте становятся связями «ссылка» сами (как и при
обычном сохранении заметки). Чужие поля заголовочной части и вложения Obsidian пропускаются.
"""
from __future__ import annotations

import io
import re
import zipfile

from .kb import AREAS, LINK_TYPES, title_of

MAX_FILES = 2000
MAX_FILE = 200 << 10
MAX_TOTAL = 20 << 20
LINKS_HEADER = "## Связи"
_LABEL_TO_TYPE = {v: k for k, v in LINK_TYPES.items()}


class ObsidianError(ValueError):
    pass


def _safe(name: str) -> str:
    name = re.sub(r'[\\/:*?"<>|#^\[\]\x00-\x1f]+', " ", name).strip(" .")
    return (name or "Заметка")[:100]


def _yaml_str(v: str) -> str:
    return '"' + v.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ") + '"'


def export_zip(project_name: str, notes: list[dict], links: list[dict]) -> bytes:
    titles = {n["id"]: title_of(n["content"], n.get("title")) for n in notes}
    names: dict[int, str] = {}
    used: set[str] = set()
    for n in notes:
        base, k = _safe(titles[n["id"]]), 1
        name = base
        while name.lower() in used:
            k += 1
            name = f"{base} ({k})"
        used.add(name.lower())
        names[n["id"]] = name
    out_links: dict[int, list[tuple[str, int]]] = {}
    for l in links:
        if l.get("auto"):
            continue  # ссылки [[…]] из текста и так в тексте
        out_links.setdefault(l["a"], []).append((l["type"], l["b"]))
    folder = _safe(project_name)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for n in notes:
            fm = [f"title: {_yaml_str(titles[n['id']])}", f"area: {n.get('area') or 'dec'}"]
            if n.get("grp"):
                fm.append(f"group: {_yaml_str(n['grp'])}")
            tags = [t.strip() for t in (n.get("tags") or "").replace(";", ",").split(",") if t.strip()]
            if tags:
                fm.append("tags: [" + ", ".join(_yaml_str(t) for t in tags) + "]")
            if n.get("source_ref"):
                fm.append(f"source: {_yaml_str(n['source_ref'])}")
            if n.get("stale"):
                fm.append("stale: true")
            body = "---\n" + "\n".join(fm) + "\n---\n\n" + (n["content"] or "").strip() + "\n"
            ls = [(t, b) for t, b in out_links.get(n["id"], []) if b in names]
            if ls:
                body += f"\n{LINKS_HEADER}\n" + "".join(f"- {LINK_TYPES.get(t, t)}: [[{names[b]}]]\n" for t, b in ls)
            z.writestr(f"{folder}/{names[n['id']]}.md", body)
    return buf.getvalue()


def _fm_value(v: str):
    v = v.strip()
    if v.startswith("[") and v.endswith("]"):
        return [x.strip().strip('"').strip("'") for x in v[1:-1].split(",") if x.strip()]
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        return v[1:-1].replace('\\"', '"').replace("\\\\", "\\")
    if v.lower() in ("true", "false"):
        return v.lower() == "true"
    return v


def parse_note(filename: str, text: str) -> dict:
    fm: dict = {}
    body = text.replace("\r\n", "\n")
    m = re.match(r"^---\n(.*?)\n---\n?", body, re.S)
    if m:
        for line in m.group(1).splitlines():
            if ":" in line and not line.startswith((" ", "-")):
                k, v = line.split(":", 1)
                fm[k.strip().lower()] = _fm_value(v)
        body = body[m.end():]
    links: list[tuple[str, str]] = []
    parts = body.split(f"\n{LINKS_HEADER}\n", 1)
    if len(parts) == 2:
        body = parts[0]
        for ln in parts[1].splitlines():
            lm = re.match(r"^\s*-\s*([^:\[]+):\s*\[\[([^\]|#]+)", ln)
            if lm and lm.group(1).strip() in _LABEL_TO_TYPE:
                links.append((_LABEL_TO_TYPE[lm.group(1).strip()], lm.group(2).strip()))
    title = str(fm.get("title") or re.sub(r"\.md$", "", filename.rsplit("/", 1)[-1]))[:120]
    tags = fm.get("tags") or []
    if isinstance(tags, str):
        tags = [t.strip() for t in tags.split(",")]
    area = fm.get("area") if fm.get("area") in AREAS else None
    return {"title": title, "content": body.strip() or title, "area": area, "grp": (str(fm["group"])[:40] if fm.get("group") else None),
            "tags": ", ".join(str(t) for t in tags if t)[:200], "source_ref": (str(fm["source"])[:300] if fm.get("source") else None),
            "stale": bool(fm.get("stale")), "links": links}


def import_zip(data: bytes) -> list[dict]:
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ObsidianError("это не zip-архив")
    notes, total = [], 0
    for info in z.infolist():
        n = info.filename
        if info.is_dir() or not n.lower().endswith(".md") or "/." in "/" + n or "__MACOSX" in n:
            continue  # служебное Obsidian (.obsidian/), вложения и мусор архиваторов
        if len(notes) >= MAX_FILES:
            raise ObsidianError(f"больше {MAX_FILES} заметок")
        if info.file_size > MAX_FILE:
            continue
        total += info.file_size
        if total > MAX_TOTAL:
            raise ObsidianError("заметки в архиве больше 20 МБ")
        with z.open(info) as f:
            raw = f.read(MAX_FILE + 1)[:MAX_FILE]
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            continue
        notes.append(parse_note(n, text))
    if not notes:
        raise ObsidianError("в архиве нет заметок .md")
    return notes
