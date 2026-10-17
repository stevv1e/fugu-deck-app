"""MCP-серверы владельца (Streamable HTTP) — через keyguard.

Пространство в интернет не выходит: каждый запрос идёт на keyguard /mcp/<id> с токеном пространства, keyguard
подставляет токен MCP-сервера (его здесь нет) и пересылает. Инструменты серверов становятся инструментами агента
с именами mcp_<сервер>_<инструмент>; вызов, который сервер не пометил «только чтение», подтверждает человек.
Только личные пространства (keyguard отказывает общим).
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import Any

import httpx

from . import keyguard_client as kgc
from .tools.registry import Tool

log = logging.getLogger("fugu.deck")

PROTOCOL = "2025-06-18"
SERVERS_TTL = 30
TOOLS_TTL = 300
RESULT_MAX = 20000

_servers: tuple[float, list[dict]] | None = None
_sessions: dict[str, str] = {}               # id сервера → Mcp-Session-Id
_tools: dict[str, tuple[float, list[dict]]] = {}
_rpc_id = 0


def enabled() -> bool:
    return kgc.enabled()


def _base() -> str:
    return kgc._s().keyguard_url.rstrip("/")


def forget() -> None:
    """Список серверов изменился (добавили или удалили в приложении) — спросить keyguard заново."""
    global _servers
    _servers = None
    _tools.clear()
    _sessions.clear()


async def servers() -> list[dict]:
    """MCP-серверы владельца: [{id, name, url, has_token}]. Нет keyguard или общее пространство — пусто."""
    global _servers
    if not enabled():
        return []
    if _servers and time.monotonic() - _servers[0] < SERVERS_TTL:
        return _servers[1]
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            r = await c.get(f"{_base()}/v1/mcp/mine", headers={"Authorization": f"Bearer {kgc.token()}"})
        got = r.json().get("servers") or [] if r.status_code == 200 else []
    except Exception:
        got = []
    _servers = (time.monotonic(), got)
    return got


def _sse_messages(text: str) -> list[dict]:
    out = []
    for ev in re.split(r"\r?\n\r?\n", text):
        data = "\n".join(line[5:].lstrip() for line in ev.splitlines() if line.startswith("data:"))
        if data:
            try:
                out.append(json.loads(data))
            except ValueError:
                pass
    return out


async def _rpc(sid: str, method: str, params: dict | None = None, *, notify: bool = False, timeout: float = 60) -> Any:
    """Один запрос JSON-RPC к серверу sid через keyguard. Ответ — JSON или поток SSE с сообщением нужного id."""
    global _rpc_id
    msg: dict = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        msg["params"] = params
    if not notify:
        _rpc_id += 1
        msg["id"] = _rpc_id
    headers = {"Authorization": f"Bearer {kgc.token()}", "Content-Type": "application/json",
               "Accept": "application/json, text/event-stream", "Mcp-Protocol-Version": PROTOCOL}
    if _sessions.get(sid):
        headers["Mcp-Session-Id"] = _sessions[sid]
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.post(f"{_base()}/mcp/{sid}", headers=headers, content=json.dumps(msg))
    if r.headers.get("mcp-session-id"):
        _sessions[sid] = r.headers["mcp-session-id"]
    if notify:
        return None
    if r.status_code == 404 and _sessions.get(sid) and method != "initialize":  # сессия истекла на стороне сервера
        _sessions.pop(sid, None)
        raise ConnectionResetError("сессия MCP истекла")
    if r.status_code >= 400:
        try:
            err = r.json().get("error")
        except ValueError:
            err = r.text[:300]
        raise RuntimeError(f"MCP {sid}: {r.status_code} {err}")
    msgs = _sse_messages(r.text) if "text/event-stream" in r.headers.get("content-type", "") else [r.json()]
    for m in msgs:
        if m.get("id") == msg["id"]:
            if "error" in m:
                raise RuntimeError(f"MCP {sid}: {m['error'].get('message', m['error'])}")
            return m.get("result")
    raise RuntimeError(f"MCP {sid}: нет ответа на {method}")


async def _ensure_session(sid: str) -> None:
    if sid in _sessions:
        return
    await _rpc(sid, "initialize", {"protocolVersion": PROTOCOL, "capabilities": {},
                                   "clientInfo": {"name": "fugu-deck", "version": "1"}})
    await _rpc(sid, "notifications/initialized", notify=True)
    _sessions.setdefault(sid, "")  # сервер без сессий: заголовок не нужен, но инициализация пройдена


async def _call(sid: str, method: str, params: dict | None = None) -> Any:
    await _ensure_session(sid)
    try:
        return await _rpc(sid, method, params)
    except ConnectionResetError:
        _sessions.pop(sid, None)
        await _ensure_session(sid)
        return await _rpc(sid, method, params)


async def list_tools(sid: str) -> list[dict]:
    hit = _tools.get(sid)
    if hit and time.monotonic() - hit[0] < TOOLS_TTL:
        return hit[1]
    out: list[dict] = []
    cursor = None
    for _ in range(10):  # не больше 10 страниц
        res = await _call(sid, "tools/list", {"cursor": cursor} if cursor else {}) or {}
        out += res.get("tools") or []
        cursor = res.get("nextCursor")
        if not cursor:
            break
    _tools[sid] = (time.monotonic(), out)
    return out


def tool_name(sid: str, name: str) -> str:
    n = re.sub(r"[^A-Za-z0-9_-]", "_", f"mcp_{sid}_{name}")
    return n[:64]


def result_text(res: dict) -> str:
    parts = []
    for c in res.get("content") or []:
        if c.get("type") == "text":
            parts.append(c.get("text") or "")
        elif c.get("type") == "resource" and isinstance(c.get("resource"), dict):
            parts.append(c["resource"].get("text") or f"[ресурс {c['resource'].get('uri', '')}]")
        else:
            parts.append(f"[{c.get('type')}: не показывается]")
    if not parts and res.get("structuredContent") is not None:
        parts.append(json.dumps(res["structuredContent"], ensure_ascii=False))
    text = "\n".join(parts)
    return text[:RESULT_MAX] + ("\n…[обрезано]" if len(text) > RESULT_MAX else "")


def _make_tool(srv: dict, t: dict) -> Tool:
    sid, name = srv["id"], t["name"]
    ann = t.get("annotations") or {}
    read_only = ann.get("readOnlyHint") is True

    async def handler(ctx, args):
        res = await _call(sid, "tools/call", {"name": name, "arguments": args}) or {}
        text = result_text(res)
        if res.get("isError"):
            raise ValueError(text or "инструмент MCP вернул ошибку")
        return {"server": srv.get("name") or sid, "tool": name, "result": text}

    async def risk(ctx, args):
        return "read" if read_only else "write"

    schema = t.get("inputSchema") if isinstance(t.get("inputSchema"), dict) else {}
    params = {"type": "object", "properties": schema.get("properties") or {}}
    if schema.get("required"):
        params["required"] = schema["required"]
    desc = f"[MCP «{srv.get('name') or sid}»] {(t.get('description') or ann.get('title') or name)[:900]}"
    return Tool(name=tool_name(sid, name), description=desc, parameters=params, handler=handler, risk=risk,
                group="mcp", title=f"MCP {srv.get('name') or sid}: {t.get('title') or name}")


async def tools() -> dict[str, Tool]:
    """Инструменты всех MCP-серверов владельца. Недоступный сервер пропускается (в журнал — почему)."""
    out: dict[str, Tool] = {}
    for srv in await servers():
        try:
            for t in await asyncio.wait_for(list_tools(srv["id"]), 20):
                if isinstance(t, dict) and t.get("name"):
                    tl = _make_tool(srv, t)
                    out.setdefault(tl.name, tl)
        except Exception as e:
            log.warning("event=mcp.tools server=%s error=%s", srv.get("id"), e)
    return out
