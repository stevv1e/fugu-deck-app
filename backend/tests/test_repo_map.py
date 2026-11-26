from types import SimpleNamespace

from app.tools.repo_map import directory_summary, eligible, extract_symbols, selected_files, symbol_range
from app.tools.repo_tools import read_symbol, repo_map


SOURCE = """import os

class Agent:
    def start(self):
        return True

async def main():
    value = Agent()
    return value
"""


def test_repo_map_selects_source_and_never_reads_secrets():
    files = ["README.md", ".env", "node_modules/pkg/index.js", "backend/app/agent.py", "backend/app/db.py",
             "desktop/update.ts", "package-lock.json", "assets/logo.png"]
    assert not eligible(".env") and not eligible(".ENV.production") and not eligible("keys/private.PEM")
    assert not eligible("node_modules/pkg/index.js")
    selected = selected_files(files, "agent", 4)
    assert selected[0] == "backend/app/agent.py"
    assert directory_summary(files)[0]["path"] == "backend/app"


def test_extract_python_typescript_and_symbol_range():
    symbols = extract_symbols("agent.py", SOURCE)
    assert [(item["name"], item["line"]) for item in symbols] == [("Agent", 3), ("start", 4), ("main", 7)]
    _, result = symbol_range("agent.py", SOURCE, "start")
    assert result["start_line"] == 4 and result["end_line"] == 5
    assert "return True" in result["content"] and "async def main" not in result["content"]
    _, class_result = symbol_range("agent.py", SOURCE, "Agent")
    assert class_result["end_line"] == 5 and "def start" in class_result["content"]
    ts = "export class Deck {}\nexport async function loadDeck() {}\nconst answer = async () => 42\n"
    assert [item["name"] for item in extract_symbols("deck.ts", ts)] == ["Deck", "loadDeck", "answer"]


async def test_repo_map_and_read_symbol_tools_use_narrow_ranges():
    provider = SimpleNamespace(reads=[])
    provider.list_files = lambda repo, ref, path: _files()
    provider.read_file = _read(provider)
    ctx = SimpleNamespace(providers={"github": provider})
    args = {"provider": "github", "repo": "owner/repo", "max_files": 3}
    result = await repo_map(ctx, args)
    assert result["ref"] == "main"
    assert all(item["path"] != ".env" for item in result["files"])
    agent = next(item for item in result["files"] if item["path"] == "backend/app/agent.py")
    assert agent["symbols"][0]["name"] == "Agent"
    symbol = await read_symbol(ctx, {**args, "path": "backend/app/agent.py", "symbol": "main"})
    assert symbol["start_line"] == 7 and symbol["content"].startswith("async def main")


async def _files():
    return {"ref": "main", "files": ["README.md", ".env", "backend/app/agent.py"], "truncated": False}


def _read(provider):
    async def read(repo, path, ref):
        provider.reads.append(path)
        return SOURCE.encode() if path.endswith(".py") else b"# Demo\n"
    return read
