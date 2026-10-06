"""Пространства в Kubernetes: server-side apply манифестов, удаление namespace целиком."""
from __future__ import annotations

import asyncio

from . import Orchestrator
from .manifests import LABEL, namespace_of, space_manifests

FIELD_MANAGER = "deck-control-plane"


class KubeOrchestrator(Orchestrator):
    kind = "kubernetes"

    def __init__(self, settings, keys):
        super().__init__(settings, keys)
        from kubernetes import client, config, dynamic
        try:
            config.load_incluster_config()
        except config.ConfigException:
            config.load_kube_config()
        self.api = client.ApiClient()
        self.dyn = dynamic.DynamicClient(self.api)
        self.core = client.CoreV1Api(self.api)
        self.apps = client.AppsV1Api(self.api)

    def _apply(self, obj: dict) -> None:
        res = self.dyn.resources.get(api_version=obj["apiVersion"], kind=obj["kind"])
        name = obj["metadata"]["name"]
        ns = obj["metadata"].get("namespace")
        res.server_side_apply(body=obj, name=name, namespace=ns, field_manager=FIELD_MANAGER, force_conflicts=True)

    async def ensure(self, space: dict) -> str:
        objs = space_manifests(space, self.space_env(space), self.settings)
        # сначала namespace, потом остальное; ретраи на случай, если namespace ещё создаётся
        for obj in objs:
            for attempt in range(5):
                try:
                    await asyncio.to_thread(self._apply, obj)
                    break
                except Exception:
                    if attempt == 4:
                        raise
                    await asyncio.sleep(1 + attempt)
        return await self.status(space)

    async def status(self, space: dict) -> str:
        from kubernetes.client.rest import ApiException
        try:
            d = await asyncio.to_thread(self.apps.read_namespaced_deployment, "space", namespace_of(space["id"]))
        except ApiException as e:
            return "missing" if e.status == 404 else "error"
        return "ready" if (d.status.ready_replicas or 0) >= 1 else "starting"

    async def delete(self, space: dict) -> None:
        from kubernetes.client.rest import ApiException
        try:
            await asyncio.to_thread(self.core.delete_namespace, namespace_of(space["id"]))
        except ApiException as e:
            if e.status != 404:
                raise

    def internal_url(self, space: dict) -> str:
        return f"http://space.{namespace_of(space['id'])}.svc.cluster.local:8000"

    async def list_namespaces(self) -> list[str]:
        r = await asyncio.to_thread(self.core.list_namespace, label_selector=LABEL)
        return [n.metadata.labels[LABEL] for n in r.items]
