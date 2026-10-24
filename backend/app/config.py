"""Настройки приложения. Всё берётся из переменных окружения (или файла .env)."""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # --- Sakana / LLM ---
    sakana_api_key: str = ""
    sakana_base_url: str = "https://api.sakana.ai/v1"
    # Модели через запятую; первая — модель по умолчанию
    # провайдер:модель через запятую; первая — по умолчанию
    # Sakana — все модели с console.sakana.ai/models (версии и псевдонимы текущих версий)
    models: str = ("sakana:fugu-max-v1.0,sakana:fugu-ultra-v2.0,sakana:sakana-namazu-v1.0,sakana:fugu,"
                   "sakana:fugu-ultra-v1.1,sakana:fugu-ultra-v1.0,sakana:fugu-cyber-v1.0,"
                   "sakana:fugu-max,sakana:fugu-ultra,sakana:sakana-namazu,sakana:fugu-cyber,"
                   "anthropic:claude-sonnet-5,anthropic:claude-opus-5-5,anthropic:claude-haiku-4-5,"
                   "deepseek:deepseek-flash,deepseek:deepseek-v4-pro")
    # Цена за 1M токенов: {"модель": [input, output, cached_input]}
    pricing_json: str = (
        '{"sakana:fugu-max-v1.0": [2, 6, 0.25], "sakana:fugu-ultra-v2.0": [5, 30, 0.5], "sakana:sakana-namazu-v1.0": [0.95, 4, 0.15],'
        ' "sakana:fugu-max": [2, 6, 0.25], "sakana:fugu-ultra": [5, 30, 0.5], "sakana:sakana-namazu": [0.95, 4, 0.15],'
        ' "sakana:fugu-ultra-v1.0": [5, 30, 0.5], "sakana:fugu-ultra-v1.1": [5, 30, 0.5],'
        # у этих моделей опубликованной цены нет: расход показывается по верхней известной ставке Sakana (оценка сверху)
        ' "sakana:fugu": [10, 45, 1], "sakana:fugu-cyber": [10, 45, 1], "sakana:fugu-cyber-v1.0": [10, 45, 1],'
        ' "anthropic:claude-sonnet-5": [2, 10, 0.2, 2.5], "anthropic:claude-opus-5-5": [4, 20, 0.2, 5],'
        ' "anthropic:claude-haiku-4-5": [1, 5, 0.1, 1.25], "anthropic:claude-fable-5-1": [10, 50, 0.25, 12.5],'
        # DeepSeek: днём вдвое дороже, чем ночью, — показываем по дневной цене (оценка сверху)
        ' "deepseek:deepseek-flash": [0.3, 1.2, 0.006], "deepseek:deepseek-v4-pro": [1.32, 3.96, 0.044]}'
    )
    # Тариф длинного контекста: {"модель": [порог токенов входа, input, output, cached_input]} — запрос со входом
    # длиннее порога считается целиком по этим ставкам (Sakana Ultra: больше 272K — $10/$45, кэш $1)
    pricing_long_json: str = (
        '{"sakana:fugu-ultra-v2.0": [272000, 10, 45, 1], "sakana:fugu-ultra": [272000, 10, 45, 1],'
        ' "sakana:fugu-ultra-v1.0": [272000, 10, 45, 1], "sakana:fugu-ultra-v1.1": [272000, 10, 45, 1]}'
    )
    deepseek_api_key: str = ""   # только для одиночного режима
    deepseek_base_url: str = "https://api.deepseek.com"
    anthropic_api_key: str = ""  # только для одиночного режима; в кластере ключи приходят с телефона
    anthropic_base_url: str = ""
    anthropic_max_tokens: int = 32000
    # модель для независимой проверки команд на серверах ("" — та же, что у агента в этом чате)
    review_model: str = ""
    sakana_max_tokens: int = 16000          # keyguard требует max_tokens: без него расход не ограничить
    # Кластер v2: модели и Git только через keyguard; ключей в пространстве нет.
    keyguard_url: str = ""                  # http://keyguard.deck-keys.svc.cluster.local:8080
    keyguard_token_path: str = "/var/run/secrets/keyguard/token"
    # Кластер v2: серверы пользователя — только через ssh-gateway, со своим токеном (audience=ssh-gateway)
    ssh_gateway_url: str = ""               # http://ssh-gateway.deck-ssh.svc.cluster.local:8080
    ssh_gateway_token_path: str = "/var/run/secrets/ssh-gateway/token"
    llm_timeout_seconds: int = 900  # Ultra может думать несколько минут
    max_agent_steps: int = 30
    # свёртка истории длинного чата (экономия токенов): модель-сводчик ("" — модель чата; дешёвая экономит больше),
    # порог объёма живой истории (символы) для свёртки и сколько последних символов оставить дословно
    summary_model: str = ""
    compact_history_chars: int = 60000
    compact_keep_chars: int = 20000

    # --- Режим работы ---
    #   standalone — одиночный сервер (пароль владельца, ключи из .env)
    #   space      — пространство в кластере: вход по токену control-plane, ключи с телефона
    deck_mode: Literal["standalone", "space"] = "standalone"
    space_id: str = ""
    space_kind: Literal["personal", "team"] = "personal"
    space_name: str = ""
    cp_public_key: str = ""        # PEM публичного ключа control-plane (ES256)
    cp_issuer: str = "deck-control-plane"
    key_ttl_seconds: int = 1800
    display_tz: str = "Europe/Moscow"
    proposal_ttl_seconds: int = 86400  # срок голосования за смену модели общего чата (24 ч)  # часовой пояс для дат в служебных отметках чата

    # --- Доступ к приложению ---
    owner_username: str = "owner"
    app_password: str = ""
    totp_secret: str = ""  # необязательно: второй фактор (Google Authenticator и т.п.)
    jwt_secret: str = ""
    session_days: int = 30
    cookie_secure: bool = True
    # --- Нативное приложение (устройства) ---
    server_name: str = "Fugu Deck"     # как сервер называется в приложении
    public_url: str = ""               # https://deck.example.kz — попадает в QR-приглашение
    # mTLS с сертификатом устройства: off — не проверяем; optional — проверяем, если прокси передал серийный номер;
    # required — без сертификата устройства запросы по DPoP отклоняются (прокси должен требовать сертификат)
    mtls_mode: Literal["off", "optional", "required"] = "off"
    mtls_serial_header: str = "x-client-cert-serial"

    # --- Git-провайдеры ---
    github_token: str = ""
    github_api_url: str = "https://api.github.com"
    gitlab_token: str = ""
    gitlab_url: str = "https://gitlab.com"

    # Какие действия требуют подтверждения в приложении:
    #   all      — любое изменяющее действие (по умолчанию, безопаснее всего)
    #   dangerous — только удаление файлов, запись в основную ветку, создание репо
    #   none     — ничего (не рекомендуется)
    approval_mode: Literal["all", "dangerous", "none"] = "all"
    approval_timeout_seconds: int = 1800

    # --- Хранилище ---
    data_dir: Path = Path("./data")
    # Кластер v2: файл с токеном, по которому space-operator забирает снимок базы (app/backup.py). Пусто — выключено.
    backup_token_file: str = ""
    # Папка скилов. По умолчанию внутри data_dir; можно смонтировать отдельный git-репозиторий.
    skills_dir: Path | None = None
    max_upload_mb: int = 25

    cors_origins: str = Field(default="", description="Только для локальной разработки")

    @field_validator("data_dir")
    @classmethod
    def _mkdir(cls, v: Path) -> Path:
        v.mkdir(parents=True, exist_ok=True)
        (v / "attachments").mkdir(exist_ok=True)
        return v

    @property
    def model_list(self) -> list[str]:
        out = []
        for m in self.models.split(","):
            m = m.strip()
            if m:
                out.append(m if ":" in m else f"sakana:{m}")
        return out

    @property
    def is_space(self) -> bool:
        return self.deck_mode == "space"

    @property
    def pricing(self) -> dict[str, list[float]]:
        try:
            return json.loads(self.pricing_json)
        except json.JSONDecodeError:
            return {}

    @property
    def pricing_long(self) -> dict[str, list[float]]:
        try:
            return json.loads(self.pricing_long_json)
        except json.JSONDecodeError:
            return {}

    @property
    def skills_path(self) -> Path:
        return self.skills_dir or (self.data_dir / "skills")

    @property
    def db_path(self) -> Path:
        return self.data_dir / "fugu-deck.sqlite3"


@lru_cache
def get_settings() -> Settings:
    return Settings()
