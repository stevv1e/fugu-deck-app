"""MCP-клиент пространства против мока keyguard+MCP: список серверов, инструменты, вызов, сессия, ошибки."""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from app import mcp_client

STATE = {"sessions": set(), "calls": [], "expire_next": False, "n": 0}


class KG(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj=None, sse=False, session=None):
        self.send_response(code)
        if session:
            self.send_header("Mcp-Session-Id", session)
        self.send_header("Content-Type", "text/event-stream" if sse else "application/json")
        self.end_headers()
        if obj is not None:
            body = json.dumps(obj, ensure_ascii=False)
            self.wfile.write((f"event: message\ndata: {body}\n\n" if sse else body).encode())

    def do_GET(self):
        assert self.headers["Authorization"] == "Bearer space-token"
        if self.path == "/v1/mcp/mine":
            return self._send(200, {"servers": [{"id": "docs", "name": "Документы", "url": "https://x", "has_token": True},
                                                {"id": "dead", "name": "Сломан", "url": "https://y", "has_token": False}]})
        self._send(404, {"error": "нет"})

    def do_POST(self):
        assert self.headers["Authorization"] == "Bearer space-token"
        msg = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path == "/mcp/dead":
            return self._send(502, {"error": "MCP-сервер недоступен"})
        sess = self.headers.get("Mcp-Session-Id")
        m = msg["method"]
        STATE["calls"].append((m, sess))
        if m == "initialize":
            STATE["n"] += 1
            sid = f"s{STATE['n']}"
            STATE["sessions"].add(sid)
            return self._send(200, {"jsonrpc": "2.0", "id": msg["id"], "result": {"protocolVersion": "2025-06-18", "capabilities": {}}}, session=sid)
        if m == "notifications/initialized":
            return self._send(202)
        if sess not in STATE["sessions"] or STATE["expire_next"]:
            STATE["expire_next"] = False
            STATE["sessions"].discard(sess)
            return self._send(404, {"error": "сессия не найдена"})
        if m == "tools/list":
            return self._send(200, {"jsonrpc": "2.0", "id": msg["id"], "result": {"tools": [
                {"name": "search", "description": "Поиск по документам", "annotations": {"readOnlyHint": True},
                 "inputSchema": {"type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]}},
                {"name": "create.page", "description": "Создать страницу", "inputSchema": {"type": "object", "properties": {"title": {"type": "string"}}}},
            ]}}, sse=True)
        if m == "tools/call":
            p = msg["params"]
            if p["name"] == "create.page" and not p["arguments"].get("title"):
                return self._send(200, {"jsonrpc": "2.0", "id": msg["id"], "result": {"isError": True, "content": [{"type": "text", "text": "нужен title"}]}}, sse=True)
            return self._send(200, {"jsonrpc": "2.0", "id": msg["id"], "result": {"content": [
                {"type": "text", "text": f"нашёл: {p['arguments']}"}, {"type": "image", "data": "..."}]}}, sse=True)
        self._send(200, {"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": "нет метода"}})


@pytest.fixture()
def kg(monkeypatch):
    srv = HTTPServer(("127.0.0.1", 0), KG)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    monkeypatch.setattr(mcp_client, "_base", lambda: f"http://127.0.0.1:{srv.server_port}")
    monkeypatch.setattr(mcp_client, "enabled", lambda: True)
    monkeypatch.setattr(mcp_client.kgc, "token", lambda: "space-token")
    mcp_client.forget()
    STATE.update(sessions=set(), calls=[], expire_next=False, n=0)
    yield srv
    srv.shutdown()
    mcp_client.forget()


async def test_mcp_tools_and_calls(kg):
    tools = await mcp_client.tools()
    assert set(tools) == {"mcp_docs_search", "mcp_docs_create_page"}, "недоступный сервер пропущен, точка в имени заменена"
    search, create = tools["mcp_docs_search"], tools["mcp_docs_create_page"]
    assert search.group == "mcp" and "Документы" in search.description
    assert search.parameters["required"] == ["q"]
    assert await search.risk(None, {}) == "read" and await create.risk(None, {}) == "write"

    r = await search.handler(None, {"q": "отпуск"})
    assert r["result"].startswith("нашёл: {'q': 'отпуск'}") and "[image: не показывается]" in r["result"]
    with pytest.raises(ValueError, match="нужен title"):
        await create.handler(None, {})
    # одна инициализация на сервер, дальше — с выданной сессией
    assert [c for c in STATE["calls"] if c[0] == "initialize"] == [("initialize", None)]
    assert all(s == "s1" for m, s in STATE["calls"] if m == "tools/call")

    STATE["expire_next"] = True  # сервер забыл сессию — клиент инициализируется заново и повторяет вызов
    r = await search.handler(None, {"q": "снова"})
    assert "снова" in r["result"] and ("tools/call", "s2") in STATE["calls"]


async def test_mcp_disabled(monkeypatch):
    monkeypatch.setattr(mcp_client, "enabled", lambda: False)
    mcp_client.forget()
    assert await mcp_client.servers() == [] and await mcp_client.tools() == {}


def test_tool_name_and_result():
    assert mcp_client.tool_name("docs", "a.b c") == "mcp_docs_a_b_c"
    assert len(mcp_client.tool_name("x" * 40, "y" * 60)) == 64
    assert mcp_client.result_text({"structuredContent": {"a": 1}}) == '{"a": 1}'
    assert mcp_client.result_text({"content": [{"type": "text", "text": "z" * 30000}]}).endswith("…[обрезано]")
