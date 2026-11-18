"""Динамический каталог моделей и пользовательские OpenAI-совместимые endpoint."""
from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.parse import urlparse

from .llm.catalog import PROVIDER_TITLES

MODEL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:/+@=-]{0,159}$")
CUSTOM_ID = re.compile(r"^[a-z][a-z0-9-]{1,30}$")


class CatalogError(ValueError):
    pass


def clean_models(values, prefix: str = "") -> list[str]:
    out: list[str] = []
    for value in values:
        model = str(value).strip()
        full = model if prefix and model.startswith(prefix + ":") else f"{prefix}:{model}" if prefix else model
        if MODEL_ID.fullmatch(model) and full not in out:
            out.append(full)
        if len(out) >= 200:
            break
    return out


class ModelCatalog:
    def __init__(self, settings):
        self.settings = settings
        self.path: Path = settings.data_dir / "model-catalog.json"
        self.discovered: dict[str, list[str]] = {}
        self.custom: dict[str, dict] = {}
        self._load()

    def _load(self) -> None:
        try:
            data = json.loads(self.path.read_text("utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            data = {}
        raw_custom = data.get("custom") or {}
        if isinstance(raw_custom, dict):
            for cid, item in raw_custom.items():
                try:
                    self.custom[cid] = self._endpoint(cid, item)
                except CatalogError:
                    continue
        for provider, values in (data.get("discovered") or {}).items():
            if provider in PROVIDER_TITLES and isinstance(values, list):
                self.discovered[provider] = clean_models(values, provider)
        self._sync_settings()

    def _sync_settings(self) -> None:
        self.settings.custom_llm_json = json.dumps(self.custom, ensure_ascii=False)

    def _save(self) -> None:
        self._sync_settings()
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"discovered": self.discovered, "custom": self.custom},
                                  ensure_ascii=False, indent=2) + "\n", "utf-8")
        tmp.replace(self.path)

    @staticmethod
    def _endpoint(cid: str, item: dict) -> dict:
        if not CUSTOM_ID.fullmatch(cid):
            raise CatalogError("ID endpoint: строчные латинские буквы, цифры и дефис")
        base_url = str(item.get("base_url") or "").strip().rstrip("/")
        parsed = urlparse(base_url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
            raise CatalogError("Нужен корректный HTTP(S) base URL без логина и пароля")
        models = clean_models(item.get("models") or [], f"custom-{cid}")
        if not models:
            raise CatalogError("Добавьте хотя бы один ID модели")
        return {"name": str(item.get("name") or cid).strip()[:60] or cid,
                "base_url": base_url, "models": models, "auth_required": bool(item.get("auth_required"))}

    @property
    def models(self) -> list[str]:
        out = list(self.settings.model_list)
        for values in self.discovered.values():
            out.extend(values)
        for endpoint in self.custom.values():
            out.extend(endpoint["models"])
        return list(dict.fromkeys(out))

    @property
    def provider_titles(self) -> dict[str, str]:
        return {**PROVIDER_TITLES, **{f"custom-{cid}": item["name"] for cid, item in self.custom.items()}}

    def endpoints(self) -> list[dict]:
        return [{"id": cid, **item, "api_key_required": True} for cid, item in self.custom.items()]

    def add_endpoint(self, cid: str, item: dict) -> dict:
        if self.settings.is_space:
            raise CatalogError("Пользовательские endpoint доступны только в standalone: кластер ходит в сеть через Keyguard")
        self.custom[cid] = self._endpoint(cid, item)
        self._save()
        return {"id": cid, **self.custom[cid]}

    def remove_endpoint(self, cid: str) -> None:
        if cid not in self.custom:
            raise CatalogError("Endpoint не найден")
        del self.custom[cid]
        self._save()

    def discover(self, provider: str, model_ids: list[str]) -> list[str]:
        if provider not in PROVIDER_TITLES:
            raise CatalogError("Динамическое обнаружение поддерживается только для встроенных провайдеров")
        values = clean_models(model_ids, provider)
        self.discovered[provider] = values
        self._save()
        return values
