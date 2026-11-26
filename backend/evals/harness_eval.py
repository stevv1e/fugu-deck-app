from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import time
from pathlib import Path

from app.agent import Agent
from app.config import Settings
from app.llm import Usage, get_provider, split_model
from app.model_router import route_model
from app.tools.repo_map import directory_summary, extract_symbols, symbol_range

TASKS = Path(__file__).with_name("tasks.json")
DEFAULT_ROUTES = {
    "simple": "google:gemini-3.5-flash-lite",
    "code": "kimi:kimi-for-coding",
    "complex": "anthropic:claude-sonnet-5-5",
    "media": "google:gemini-3.8-flash",
}
FIXTURE = """class Repository:
    def load(self, key):
        return self.data[key]

    def save(self, key, value):
        self.data[key] = value
        return value
""" + "\n\n" + "\n\n".join(f"""def transform_{index}(value):
    total = 0
    for item in value:
        if item is None:
            continue
        number = int(item)
        total += number * {index + 1}
        total = max(0, total)
        total = min(total, 100000)
        print('step', total)
    return total
""" for index in range(20))


def load_tasks() -> list[dict]:
    data = json.loads(TASKS.read_text("utf-8"))
    if data.get("version") != 1 or not isinstance(data.get("tasks"), list):
        raise ValueError("Некорректный набор evals")
    return data["tasks"]


async def offline() -> dict:
    started = time.perf_counter()
    checks = []
    for task in load_tasks():
        route = route_model(task["prompt"], DEFAULT_ROUTES, task["project_id"], task.get("attachments"))
        checks.append({"id": task["id"], "expected": task["category"], "actual": route["category"],
                       "model": route["model"], "pass": route["category"] == task["category"]})
    paths = [f"module_{index}.py" for index in range(20)]
    mapped = [{"path": path, "symbols": extract_symbols(path, FIXTURE, 12)} for path in paths]
    _, fragment = symbol_range("module_0.py", FIXTURE, "save")
    full_chars = len(FIXTURE) * 20
    map_payload = {"directories": directory_summary(paths), "files": mapped}
    map_chars = len(json.dumps(map_payload, ensure_ascii=False))
    return {"mode": "offline", "routing": {"passed": sum(item["pass"] for item in checks), "total": len(checks),
            "accuracy": sum(item["pass"] for item in checks) / len(checks), "checks": checks},
            "context_fixture": {"kind": "synthetic", "files": 20, "full_chars": full_chars, "map_chars": map_chars,
                                "symbol_chars": len(fragment["content"]),
                                "map_reduction": 1 - map_chars / full_chars,
                                "symbol_reduction": 1 - len(fragment["content"]) / full_chars},
            "elapsed_ms": (time.perf_counter() - started) * 1000}


def cost_of(settings: Settings, model: str, usage: Usage | None) -> float:
    if not usage:
        return 0.0
    engine = Agent.__new__(Agent)
    engine.settings = settings
    price = engine.price(model, usage.prompt_tokens)
    if not price:
        return 0.0
    pin, pout = price[0], price[1]
    cached = price[2] if len(price) > 2 else pin
    cache_write = price[3] if len(price) > 3 else pin
    return ((usage.prompt_tokens - usage.cached_tokens - usage.cache_write_tokens) * pin +
            usage.cached_tokens * cached + usage.cache_write_tokens * cache_write +
            usage.completion_tokens * pout) / 1_000_000


async def live(models: list[str]) -> dict:
    settings = Settings()
    tasks = [task for task in load_tasks() if task.get("live")]
    results = []
    for full in models:
        provider_name, model = split_model(full)
        key = getattr(settings, f"{provider_name}_api_key", "")
        if not key:
            raise ValueError(f"Нет ключа {provider_name} в окружении для live eval")
        provider = get_provider(provider_name, settings)
        for task in tasks:
            async def nothing(*args):
                return None
            started = time.perf_counter()
            response = await asyncio.wait_for(provider.stream(
                key, model,
                [{"role": "system", "content": "Выполни короткую проверочную задачу точно."},
                 {"role": "user", "content": task["prompt"]}],
                [], nothing, nothing), settings.llm_timeout_seconds)
            latency = time.perf_counter() - started
            text = (response.text or "").lower()
            passed = all(expected.lower() in text for expected in task["expect"])
            results.append({"id": task["id"], "model": full, "pass": passed, "latency_seconds": latency,
                            "prompt_tokens": response.usage.prompt_tokens if response.usage else 0,
                            "completion_tokens": response.usage.completion_tokens if response.usage else 0,
                            "cached_tokens": response.usage.cached_tokens if response.usage else 0,
                            "cost_usd": cost_of(settings, full, response.usage),
                            "response_sha256": hashlib.sha256((response.text or "").encode()).hexdigest()})
    return {"mode": "live", "results": results,
            "summary": {"requests": len(results), "passed": sum(item["pass"] for item in results),
                        "quality_rate": sum(item["pass"] for item in results) / len(results) if results else 0,
                        "total_cost_usd": sum(item["cost_usd"] for item in results),
                        "mean_latency_seconds": sum(item["latency_seconds"] for item in results) / len(results) if results else 0}}


async def main() -> None:
    parser = argparse.ArgumentParser(description="Fugu Deck Harness quality/cost/latency baseline")
    parser.add_argument("mode", choices=("offline", "live"))
    parser.add_argument("--model", action="append", default=[], help="provider:model; повторять для сравнения")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.mode == "live" and not args.model:
        parser.error("для live нужен хотя бы один --model")
    report = await offline() if args.mode == "offline" else await live(args.model)
    text = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(text, "utf-8")
    print(text, end="")


if __name__ == "__main__":
    asyncio.run(main())
