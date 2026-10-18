"""Страницы из интернета — только с доменов, которые владелец разрешил подписью (keyguard, egress.go; D65).

Пространство в интернет не выходит: запрос идёт на keyguard /egress/fetch с токеном пространства, keyguard сверяет
домен со списком владельца и сам ходит на сайт. Только GET, только личное пространство. HTML превращается в текст:
модели не нужны разметка, скрипты и стили — они только расходуют токены.
"""
from __future__ import annotations

import html
import re
import time

import httpx

from .. import keyguard_client as kgc
from .registry import ToolContext, obj, tool

TEXT_MAX = 30000
DOMAINS_TTL = 30

_domains: tuple[float, list[str]] | None = None


def enabled(settings) -> bool:
    return kgc.enabled() and getattr(settings, "space_kind", "personal") == "personal"


def _base() -> str:
    return kgc._s().keyguard_url.rstrip("/")


def forget() -> None:
    global _domains
    _domains = None


async def domains() -> list[str]:
    """Разрешённые домены владельца (кэш 30 с). Нет keyguard или ошибка — пусто."""
    global _domains
    if _domains and time.monotonic() - _domains[0] < DOMAINS_TTL:
        return _domains[1]
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            r = await c.get(f"{_base()}/v1/egress/mine", headers={"Authorization": f"Bearer {kgc.token()}"})
        r.raise_for_status()
        out = [d for d in r.json().get("domains", []) if isinstance(d, str)]
    except Exception:  # noqa: BLE001 — keyguard недоступен: инструмент скажет об этом при вызове
        out = []
    _domains = (time.monotonic(), out)
    return out


_DROP = re.compile(r"<(script|style|noscript|svg|template|iframe)\b.*?</\1\s*>", re.S | re.I)
_BLOCK = re.compile(r"</?(p|div|br|li|ul|ol|tr|table|section|article|header|footer|h[1-6]|pre|blockquote)\b[^>]*>", re.I)
_TAG = re.compile(r"<[^>]+>")
_COMMENT = re.compile(r"<!--.*?-->", re.S)


def html_text(src: str) -> str:
    """Текст страницы: без скриптов, стилей и тегов; блоки — с новой строки, пустые строки сжаты."""
    s = _COMMENT.sub("", src)
    s = _DROP.sub("", s)
    s = _BLOCK.sub("\n", s)
    s = html.unescape(_TAG.sub("", s))
    lines = [re.sub(r"[ \t ]+", " ", ln).strip() for ln in s.splitlines()]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


@tool("web_fetch",
      "Прочитать страницу из интернета (GET). Только домены из списка владельца — их задают в приложении "
      "(экран кластера → «Домены для агента»); другие адреса keyguard отклонит. HTML возвращается текстом.",
      obj({"url": {"type": "string", "description": "Полный адрес https://домен/путь"}}, ["url"]),
      risk="read", group="web", title="Страница из интернета")
async def web_fetch(ctx: ToolContext, args: dict):
    url = str(args.get("url") or "").strip()
    if not url.startswith("https://"):
        return {"error": "нужен адрес https://…"}
    try:
        async with httpx.AsyncClient(timeout=40) as c:
            r = await c.get(f"{_base()}/egress/fetch", params={"url": url},
                            headers={"Authorization": f"Bearer {kgc.token()}"})
    except httpx.HTTPError:
        return {"error": "keyguard недоступен"}
    if r.status_code != 200:
        try:
            err = r.json().get("error") or r.text
        except ValueError:
            err = r.text
        out = {"error": err[:500]}
        if r.status_code == 403:
            out["allowed_domains"] = await domains()
        return out
    ctype = r.headers.get("content-type", "")
    body = r.text
    text = html_text(body) if "html" in ctype else body
    cut = len(text) > TEXT_MAX
    return {"url": r.headers.get("x-final-url", url), "status": int(r.headers.get("x-upstream-status") or 0),
            "content_type": ctype.split(";")[0], "text": text[:TEXT_MAX] + ("\n…[обрезано]" if cut else "")}
