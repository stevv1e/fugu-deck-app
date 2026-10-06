"""Настройки control-plane (переменные окружения с префиксом CP_)."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CP_", env_file=".env", extra="ignore")

    # --- WebAuthn / адрес приложения ---
    rp_id: str = "localhost"                 # домен приложения, например deck.example.kz
    rp_name: str = "Fugu Deck"
    origin: str = "http://localhost:8080"    # https://deck.example.kz

    # --- доступ ---
    bootstrap_code: str = ""   # код первого (админского) входа; дальше коды выдаёт админ
    session_hours: int = 24 * 7
    space_token_ttl: int = 600
    cookie_secure: bool = True
    test_mode: bool = False    # ТОЛЬКО для автотестов: вход без passkey. В проде всегда false

    # --- правило неактивности ---
    warn_after_hours: float = 48
    purge_after_hours: float = 72
    reaper_interval: int = 3600  # как часто проверять (секунды)

    # --- хранилище ---
    data_dir: Path = Path("./cp-data")
    static_dir: Path | None = None   # собранный PWA

    # --- оркестратор пространств ---
    orchestrator: Literal["local", "kubernetes"] = "local"
    # local: пространства запускаются процессами (разработка и тесты)
    space_backend_dir: Path = Path("../backend")
    local_space_env: str = ""  # доп. переменные для локальных пространств: "K=V;K2=V2"
    # kubernetes
    space_image: str = "ghcr.io/example/fugu-deck-space:latest"
    space_image_pull_secret: str = ""
    space_storage: str = "2Gi"
    space_storage_class: str = ""
    space_cpu_limit: str = "500m"
    space_memory_limit: str = "512Mi"
    space_egress_proxy: str = "http://egress-proxy.deck-egress.svc.cluster.local:3128"
    space_models: str = ""        # переопределить список моделей в пространствах
    ingress_host: str = "deck.example.kz"
    ingress_entrypoint: str = "websecure"
    ingress_cert_secret: str = "deck-tls"
    control_plane_namespace: str = "deck-system"

    @property
    def db_path(self) -> Path:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        return self.data_dir / "control-plane.sqlite3"


@lru_cache
def get_settings() -> Settings:
    return Settings()
