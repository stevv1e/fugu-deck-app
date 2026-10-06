"""Оркестратор пространств: создаёт, проверяет и удаляет изолированные экземпляры Fugu Deck.

- LocalOrchestrator — процессы на этой машине (разработка, тесты);
- KubeOrchestrator — namespace + Deployment + диск + сеть в Kubernetes.
"""
from __future__ import annotations

from abc import ABC, abstractmethod


class Orchestrator(ABC):
    kind = "abstract"

    def __init__(self, settings, keys):
        self.settings = settings
        self.keys = keys

    @abstractmethod
    async def ensure(self, space: dict) -> str:
        """Создать/обновить пространство. Возвращает статус: ready | starting | error."""

    @abstractmethod
    async def status(self, space: dict) -> str: ...

    @abstractmethod
    async def delete(self, space: dict) -> None: ...

    @abstractmethod
    def internal_url(self, space: dict) -> str: ...

    async def close(self) -> None:
        pass

    def space_env(self, space: dict) -> dict[str, str]:
        env = {
            "DECK_MODE": "space",
            "SPACE_ID": space["id"],
            "SPACE_KIND": space["kind"],
            "SPACE_NAME": space["name"],
            "CP_PUBLIC_KEY": self.keys.public_pem,
            "APPROVAL_MODE": "all",
        }
        if self.settings.space_models:
            env["MODELS"] = self.settings.space_models
        return env


def make_orchestrator(settings, keys) -> Orchestrator:
    if settings.orchestrator == "kubernetes":
        from .kube import KubeOrchestrator
        return KubeOrchestrator(settings, keys)
    from .local import LocalOrchestrator
    return LocalOrchestrator(settings, keys)
