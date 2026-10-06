"""Пространства как локальные процессы uvicorn — для разработки и автотестов."""
from __future__ import annotations

import asyncio
import os
import shutil
import socket
import sys

import httpx

from . import Orchestrator


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class LocalOrchestrator(Orchestrator):
    kind = "local"

    def __init__(self, settings, keys):
        super().__init__(settings, keys)
        self.procs: dict[str, tuple[asyncio.subprocess.Process, int]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    def _dir(self, space: dict):
        return self.settings.data_dir / "spaces" / space["id"]

    async def ensure(self, space: dict) -> str:
        lock = self._locks.setdefault(space["id"], asyncio.Lock())
        async with lock:
            p = self.procs.get(space["id"])
            if p and p[0].returncode is None:
                return "ready"
            port = _free_port()
            data = self._dir(space)
            data.mkdir(parents=True, exist_ok=True)
            env = {**os.environ, **self.space_env(space), "DATA_DIR": str(data), "COOKIE_SECURE": "false"}
            for pair in filter(None, self.settings.local_space_env.split(";")):
                k, v = pair.split("=", 1)
                env[k.strip()] = v.strip()
            log = open(data / "space.log", "ab")
            proc = await asyncio.create_subprocess_exec(
                sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port),
                cwd=str(self.settings.space_backend_dir.resolve()), env=env, stdout=log, stderr=log)
            self.procs[space["id"]] = (proc, port)
            async with httpx.AsyncClient() as c:
                for _ in range(100):
                    try:
                        if (await c.get(f"http://127.0.0.1:{port}/api/health", timeout=1)).status_code == 200:
                            return "ready"
                    except httpx.HTTPError:
                        pass
                    if proc.returncode is not None:
                        return "error"
                    await asyncio.sleep(0.1)
            return "starting"

    async def status(self, space: dict) -> str:
        p = self.procs.get(space["id"])
        return "ready" if p and p[0].returncode is None else "stopped"

    async def delete(self, space: dict) -> None:
        p = self.procs.pop(space["id"], None)
        if p and p[0].returncode is None:
            p[0].terminate()
            try:
                await asyncio.wait_for(p[0].wait(), 5)
            except asyncio.TimeoutError:
                p[0].kill()
        shutil.rmtree(self._dir(space), ignore_errors=True)

    def internal_url(self, space: dict) -> str:
        p = self.procs.get(space["id"])
        return f"http://127.0.0.1:{p[1]}" if p else ""

    async def close(self) -> None:
        for sid, (proc, _) in list(self.procs.items()):
            if proc.returncode is None:
                proc.terminate()
        self.procs.clear()
