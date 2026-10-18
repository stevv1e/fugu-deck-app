"""Инструмент web_fetch против мока keyguard: страница текстом, отказ по домену со списком, тип ответа."""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

import pytest

from app.tools import web_tools


class KG(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        assert self.headers["Authorization"] == "Bearer space-token"
        u = urlparse(self.path)
        if u.path == "/v1/egress/mine":
            body, ctype, code, extra = json.dumps({"domains": ["docs.example.com"]}), "application/json", 200, {}
        else:
            target = parse_qs(u.query)["url"][0]
            if "docs.example.com" not in target:
                body, ctype, code, extra = json.dumps({"error": "домена evil.example нет в списке владельца"}), "application/json", 403, {}
            elif target.endswith(".json"):
                body, ctype, code, extra = '{"a": 1}', "application/json", 200, {"X-Upstream-Status": "200", "X-Final-Url": target}
            else:
                body = ("<html><head><style>p{}</style><script>alert(1)</script></head><body><h1>Заголовок</h1>"
                        "<p>Первый&nbsp;абзац &amp; ещё</p><!-- скрыто --><ul><li>раз</li><li>два</li></ul></body></html>")
                ctype, code, extra = "text/html; charset=utf-8", 200, {"X-Upstream-Status": "200", "X-Final-Url": target + "/"}
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        for k, v in extra.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body.encode())


@pytest.fixture()
def kg(monkeypatch):
    srv = HTTPServer(("127.0.0.1", 0), KG)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    monkeypatch.setattr(web_tools, "_base", lambda: f"http://127.0.0.1:{srv.server_port}")
    monkeypatch.setattr(web_tools.kgc, "token", lambda: "space-token")
    web_tools.forget()
    yield srv
    srv.shutdown()
    web_tools.forget()


async def test_web_fetch_html_as_text(kg):
    r = await web_tools.web_fetch(None, {"url": "https://docs.example.com/page"})
    assert r["status"] == 200 and r["url"] == "https://docs.example.com/page/" and r["content_type"] == "text/html"
    assert r["text"] == "Заголовок\n\nПервый абзац & ещё\n\nраз\n\nдва", r["text"]
    j = await web_tools.web_fetch(None, {"url": "https://docs.example.com/data.json"})
    assert j["text"] == '{"a": 1}' and j["content_type"] == "application/json"


async def test_web_fetch_denied_lists_domains(kg):
    r = await web_tools.web_fetch(None, {"url": "https://evil.example/x"})
    assert "нет в списке" in r["error"] and r["allowed_domains"] == ["docs.example.com"]
    assert (await web_tools.web_fetch(None, {"url": "http://docs.example.com"}))["error"].startswith("нужен адрес")


def test_web_enabled_only_personal(monkeypatch):
    monkeypatch.setattr(web_tools.kgc, "enabled", lambda: True)
    assert web_tools.enabled(type("S", (), {"space_kind": "personal"})())
    assert not web_tools.enabled(type("S", (), {"space_kind": "team"})())
