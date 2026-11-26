from __future__ import annotations

import re
from pathlib import PurePosixPath

SOURCE_SUFFIXES = {
    ".py", ".pyi", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".go", ".rs", ".java", ".kt", ".kts",
    ".cs", ".cpp", ".cc", ".c", ".h", ".hpp", ".rb", ".php", ".swift", ".scala", ".sh", ".sql",
}
MANIFESTS = {
    "package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml", "pom.xml", "build.gradle",
    "build.gradle.kts", "Dockerfile", "docker-compose.yml", "docker-compose.yaml", "README.md", "AGENTS.md",
}
SKIP_DIRS = {
    ".git", ".idea", ".vscode", "node_modules", "vendor", "dist", "build", "target", "coverage", "__pycache__",
    ".pytest_cache", ".next", ".expo", "generated", "gen", "minified",
}
SECRET_NAMES = {".env", "id_rsa", "id_ed25519", "credentials.json", "service-account.json"}
SECRET_SUFFIXES = {".pfx", ".p12", ".key", ".keystore", ".jks", ".pem", ".p8"}

PATTERNS = {
    ".py": [("class", re.compile(r"^\s*class\s+([A-Za-z_]\w*)")), ("function", re.compile(r"^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)"))],
    ".go": [("type", re.compile(r"^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)")), ("function", re.compile(r"^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)"))],
    ".rs": [("type", re.compile(r"^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)")), ("function", re.compile(r"^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)"))],
    ".rb": [("class", re.compile(r"^\s*class\s+([A-Za-z_]\w*)")), ("function", re.compile(r"^\s*def\s+([A-Za-z_]\w*)"))],
    ".java": [("type", re.compile(r"^\s*(?:public\s+|private\s+|protected\s+)?(?:final\s+|abstract\s+)?(?:class|interface|record|enum)\s+([A-Za-z_]\w*)"))],
    ".sh": [("function", re.compile(r"^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{"))],
}
for suffix in (".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"):
    PATTERNS[suffix] = [
        ("class", re.compile(r"^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)")),
        ("function", re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)")),
        ("function", re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>")),
    ]
for suffix in (".java", ".kt", ".kts", ".cs", ".cpp", ".cc", ".c", ".h", ".hpp", ".php", ".swift", ".scala"):
    PATTERNS.setdefault(suffix, PATTERNS[".java"])


def eligible(path: str) -> bool:
    pure = PurePosixPath(path)
    if any(part in SKIP_DIRS for part in pure.parts):
        return False
    name = pure.name
    lower = name.lower()
    if lower in SECRET_NAMES or lower.startswith(".env.") or pure.suffix.lower() in SECRET_SUFFIXES:
        return False
    if lower.endswith((".lock", ".min.js", ".map", ".snap")):
        return False
    return pure.suffix.lower() in SOURCE_SUFFIXES or name in MANIFESTS


def selected_files(files: list[str], query: str = "", limit: int = 24) -> list[str]:
    candidates = [path for path in files if eligible(path)]
    needle = query.strip().lower()

    def rank(path: str) -> tuple:
        pure = PurePosixPath(path)
        name = pure.name
        return (
            0 if needle and needle in path.lower() else 1 if needle else 0,
            0 if name in MANIFESTS else 1,
            0 if pure.suffix.lower() in SOURCE_SUFFIXES else 2,
            len(pure.parts), path,
        )

    return sorted(candidates, key=rank)[:limit]


def directory_summary(files: list[str], limit: int = 80) -> list[dict]:
    counts: dict[str, int] = {}
    for path in files:
        pure = PurePosixPath(path)
        if not eligible(path):
            continue
        parts = pure.parts[:-1]
        directory = "/".join(parts[:2]) if parts else "."
        counts[directory] = counts.get(directory, 0) + 1
    return [{"path": path, "files": count} for path, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:limit]]


def extract_symbols(path: str, text: str, limit: int = 40) -> list[dict]:
    patterns = PATTERNS.get(PurePosixPath(path).suffix.lower(), [])
    symbols = []
    for number, line in enumerate(text.splitlines(), 1):
        for kind, pattern in patterns:
            match = pattern.match(line)
            if match:
                symbols.append({"name": match.group(1), "kind": kind, "line": number,
                                "indent": len(line) - len(line.lstrip()), "signature": line.strip()[:180]})
                break
        if len(symbols) >= limit:
            break
    return symbols


def symbol_range(path: str, text: str, name: str, max_lines: int = 240) -> tuple[list[dict], dict]:
    symbols = extract_symbols(path, text, 500)
    match = next((item for item in symbols if item["name"] == name), None)
    if not match:
        raise ValueError("Символ не найден: " + name)
    start = match["line"]
    following = next((item["line"] for item in symbols
                      if item["line"] > start and item["indent"] <= match["indent"]), len(text.splitlines()) + 1)
    end = min(len(text.splitlines()), max(start, following - 1), start + max_lines - 1)
    lines = text.splitlines()
    while end > start and not lines[end - 1].strip():
        end -= 1
    return symbols, {"name": name, "kind": match["kind"], "start_line": start, "end_line": end,
                     "content": "\n".join(text.splitlines()[start - 1:end])}
