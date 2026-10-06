"""Клиенты GitHub и GitLab с единым интерфейсом.

Всё сделано на чистом REST через httpx: так проще добавлять новые методы
и не зависеть от тяжёлых SDK.
"""
from __future__ import annotations

import base64
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx


class ProviderError(Exception):
    pass


@dataclass
class FileChange:
    path: str
    content: bytes | None  # None = удалить файл


class GitProvider(ABC):
    name: str

    def __init__(self, client: httpx.AsyncClient):
        self.http = client
        self._me: dict | None = None

    async def _req(self, method: str, url: str, *, ok404: bool = False, **kw: Any) -> httpx.Response:
        try:
            r = await self.http.request(method, url, **kw)
        except httpx.HTTPError as e:
            raise ProviderError(f"{self.name}: сетевая ошибка: {e}") from e
        if r.status_code == 404 and ok404:
            return r
        if r.status_code >= 400:
            try:
                body = r.json()
                msg = body.get("message") or body.get("error") or body
                if isinstance(body, dict) and body.get("errors"):
                    msg = f"{msg} {body['errors']}"
            except Exception:
                msg = r.text[:500]
            raise ProviderError(f"{self.name} {r.status_code}: {msg}")
        return r

    async def whoami(self) -> dict:
        if self._me is None:
            self._me = await self._whoami()
        return self._me

    @abstractmethod
    async def _whoami(self) -> dict: ...
    @abstractmethod
    async def list_repos(self, query: str | None, limit: int) -> list[dict]: ...
    @abstractmethod
    async def create_repo(self, name: str, description: str, private: bool) -> dict: ...
    @abstractmethod
    async def repo_info(self, repo: str) -> dict: ...
    @abstractmethod
    async def list_files(self, repo: str, ref: str | None, path: str | None) -> dict: ...
    @abstractmethod
    async def read_file(self, repo: str, path: str, ref: str | None) -> bytes: ...
    @abstractmethod
    async def commit_files(
        self, repo: str, branch: str, message: str, changes: list[FileChange], start_from: str | None
    ) -> dict: ...
    @abstractmethod
    async def create_branch(self, repo: str, branch: str, from_ref: str | None) -> dict: ...
    @abstractmethod
    async def create_pull_request(self, repo: str, source: str, target: str | None, title: str, body: str) -> dict: ...
    @abstractmethod
    async def ci_status(self, repo: str, ref: str | None) -> list[dict]: ...


# ---------------------------------------------------------------- GitHub
class GitHubProvider(GitProvider):
    name = "github"

    def __init__(self, token: str, api_url: str = "https://api.github.com"):
        super().__init__(
            httpx.AsyncClient(
                base_url=api_url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
                timeout=60,
            )
        )

    async def _whoami(self) -> dict:
        u = (await self._req("GET", "/user")).json()
        return {"login": u["login"], "name": u.get("name"), "url": u.get("html_url")}

    @staticmethod
    def _repo(d: dict) -> dict:
        return {
            "full_name": d["full_name"],
            "private": d.get("private"),
            "default_branch": d.get("default_branch"),
            "description": d.get("description"),
            "url": d.get("html_url"),
            "updated_at": d.get("pushed_at") or d.get("updated_at"),
        }

    async def list_repos(self, query, limit):
        if query:
            me = await self.whoami()
            r = await self._req("GET", "/search/repositories",
                                params={"q": f"{query} user:{me['login']} fork:true", "per_page": limit})
            items = r.json().get("items", [])
            if not items:  # поиск по всем доступным (в т.ч. организации)
                r = await self._req("GET", "/user/repos", params={"sort": "pushed", "per_page": 100})
                items = [x for x in r.json() if query.lower() in x["full_name"].lower()][:limit]
        else:
            items = (await self._req("GET", "/user/repos", params={"sort": "pushed", "per_page": limit})).json()
        return [self._repo(x) for x in items]

    async def create_repo(self, name, description, private):
        me = await self.whoami()
        payload = {"description": description, "private": private, "auto_init": True}
        if "/" in name:
            owner, repo_name = name.split("/", 1)
            payload["name"] = repo_name
            url = "/user/repos" if owner == me["login"] else f"/orgs/{owner}/repos"
        else:
            payload["name"] = name
            url = "/user/repos"
        return self._repo((await self._req("POST", url, json=payload)).json())

    async def repo_info(self, repo):
        d = (await self._req("GET", f"/repos/{repo}")).json()
        br = (await self._req("GET", f"/repos/{repo}/branches", params={"per_page": 100})).json()
        info = self._repo(d)
        info["branches"] = [b["name"] for b in br]
        info["language"] = d.get("language")
        return info

    async def _default_branch(self, repo: str) -> str:
        return (await self._req("GET", f"/repos/{repo}")).json()["default_branch"]

    async def list_files(self, repo, ref, path):
        ref = ref or await self._default_branch(repo)
        r = await self._req("GET", f"/repos/{repo}/git/trees/{quote(ref, safe='')}",
                            params={"recursive": "1"}, ok404=True)
        if r.status_code == 404 or r.status_code == 409:
            return {"ref": ref, "files": [], "truncated": False, "note": "репозиторий пуст или ветка не найдена"}
        data = r.json()
        files = [e["path"] for e in data.get("tree", []) if e["type"] == "blob"]
        if path:
            p = path.strip("/") + "/"
            files = [f for f in files if f.startswith(p)]
        return {"ref": ref, "files": files, "truncated": data.get("truncated", False)}

    async def read_file(self, repo, path, ref):
        params = {"ref": ref} if ref else {}
        r = await self._req("GET", f"/repos/{repo}/contents/{quote(path)}", params=params,
                            headers={"Accept": "application/vnd.github.raw+json"})
        return r.content

    async def _branch_sha(self, repo: str, branch: str) -> str | None:
        r = await self.http.get(f"/repos/{repo}/git/ref/heads/{quote(branch, safe='/')}")
        if r.status_code in (404, 409):
            return None
        if r.status_code >= 400:
            raise ProviderError(f"github {r.status_code}: {r.text[:300]}")
        return r.json()["object"]["sha"]

    async def _resolve_sha(self, repo: str, ref: str) -> str:
        sha = await self._branch_sha(repo, ref)
        if sha:
            return sha
        return (await self._req("GET", f"/repos/{repo}/commits/{quote(ref, safe='')}")).json()["sha"]

    async def commit_files(self, repo, branch, message, changes, start_from):
        head = await self._branch_sha(repo, branch)
        if head is None and start_from:
            await self.create_branch(repo, branch, start_from)
            head = await self._branch_sha(repo, branch)
        if head is None:
            # Пустой репозиторий: Git Data API не работает, пишем через Contents API
            return await self._commit_via_contents(repo, branch, message, changes)

        base_tree = (await self._req("GET", f"/repos/{repo}/git/commits/{head}")).json()["tree"]["sha"]
        tree = []
        for ch in changes:
            if ch.content is None:
                tree.append({"path": ch.path, "mode": "100644", "type": "blob", "sha": None})
            else:
                blob = (await self._req("POST", f"/repos/{repo}/git/blobs", json={
                    "content": base64.b64encode(ch.content).decode(), "encoding": "base64"})).json()
                tree.append({"path": ch.path, "mode": "100644", "type": "blob", "sha": blob["sha"]})
        new_tree = (await self._req("POST", f"/repos/{repo}/git/trees",
                                    json={"base_tree": base_tree, "tree": tree})).json()["sha"]
        commit = (await self._req("POST", f"/repos/{repo}/git/commits",
                                  json={"message": message, "tree": new_tree, "parents": [head]})).json()
        await self._req("PATCH", f"/repos/{repo}/git/refs/heads/{quote(branch, safe='/')}",
                        json={"sha": commit["sha"]})
        return {"sha": commit["sha"], "branch": branch,
                "url": f"https://github.com/{repo}/commit/{commit['sha']}"}

    async def _commit_via_contents(self, repo, branch, message, changes):
        sha = None
        for ch in changes:
            if ch.content is None:
                continue
            r = await self._req("PUT", f"/repos/{repo}/contents/{quote(ch.path)}", json={
                "message": message, "content": base64.b64encode(ch.content).decode()})
            sha = r.json()["commit"]["sha"]
        return {"sha": sha, "branch": branch, "url": f"https://github.com/{repo}/commit/{sha}",
                "note": "репозиторий был пуст — файлы добавлены в ветку по умолчанию"}

    async def create_branch(self, repo, branch, from_ref):
        from_ref = from_ref or await self._default_branch(repo)
        sha = await self._resolve_sha(repo, from_ref)
        await self._req("POST", f"/repos/{repo}/git/refs", json={"ref": f"refs/heads/{branch}", "sha": sha})
        return {"branch": branch, "from": from_ref, "sha": sha}

    async def create_pull_request(self, repo, source, target, title, body):
        target = target or await self._default_branch(repo)
        d = (await self._req("POST", f"/repos/{repo}/pulls",
                             json={"head": source, "base": target, "title": title, "body": body})).json()
        return {"number": d["number"], "url": d["html_url"], "source": source, "target": target}

    async def ci_status(self, repo, ref):
        params: dict = {"per_page": 5}
        if ref:
            params["branch"] = ref
        runs = (await self._req("GET", f"/repos/{repo}/actions/runs", params=params)).json().get("workflow_runs", [])
        return [{"name": r["name"], "status": r["status"], "conclusion": r.get("conclusion"),
                 "branch": r.get("head_branch"), "url": r["html_url"], "created_at": r["created_at"]} for r in runs]


# ---------------------------------------------------------------- GitLab
class GitLabProvider(GitProvider):
    name = "gitlab"

    def __init__(self, token: str, base_url: str = "https://gitlab.com"):
        self.web_url = base_url.rstrip("/")
        super().__init__(
            httpx.AsyncClient(base_url=f"{self.web_url}/api/v4", headers={"PRIVATE-TOKEN": token}, timeout=60)
        )

    @staticmethod
    def _pid(repo: str) -> str:
        return quote(repo, safe="")

    async def _whoami(self) -> dict:
        u = (await self._req("GET", "/user")).json()
        return {"login": u["username"], "name": u.get("name"), "url": u.get("web_url")}

    @staticmethod
    def _repo(d: dict) -> dict:
        return {
            "full_name": d["path_with_namespace"],
            "private": d.get("visibility") != "public",
            "default_branch": d.get("default_branch"),
            "description": d.get("description"),
            "url": d.get("web_url"),
            "updated_at": d.get("last_activity_at"),
        }

    async def list_repos(self, query, limit):
        params: dict = {"membership": "true", "order_by": "last_activity_at", "per_page": limit}
        if query:
            params["search"] = query
        return [self._repo(x) for x in (await self._req("GET", "/projects", params=params)).json()]

    async def create_repo(self, name, description, private):
        payload: dict = {"description": description, "visibility": "private" if private else "public",
                         "initialize_with_readme": True}
        if "/" in name:
            ns, repo_name = name.rsplit("/", 1)
            nsd = (await self._req("GET", f"/namespaces/{quote(ns, safe='')}")).json()
            payload.update({"name": repo_name, "path": repo_name, "namespace_id": nsd["id"]})
        else:
            payload.update({"name": name, "path": name})
        return self._repo((await self._req("POST", "/projects", json=payload)).json())

    async def repo_info(self, repo):
        d = (await self._req("GET", f"/projects/{self._pid(repo)}")).json()
        br = (await self._req("GET", f"/projects/{self._pid(repo)}/repository/branches",
                              params={"per_page": 100})).json()
        info = self._repo(d)
        info["branches"] = [b["name"] for b in br]
        return info

    async def _default_branch(self, repo: str) -> str:
        return (await self._req("GET", f"/projects/{self._pid(repo)}")).json().get("default_branch") or "main"

    async def list_files(self, repo, ref, path):
        ref = ref or await self._default_branch(repo)
        files: list[str] = []
        truncated = False
        for page in range(1, 31):
            params: dict = {"recursive": "true", "ref": ref, "per_page": 100, "page": page}
            if path:
                params["path"] = path.strip("/")
            r = await self._req("GET", f"/projects/{self._pid(repo)}/repository/tree", params=params, ok404=True)
            if r.status_code == 404:
                return {"ref": ref, "files": [], "truncated": False, "note": "репозиторий пуст или ветка не найдена"}
            batch = r.json()
            files += [e["path"] for e in batch if e["type"] == "blob"]
            if len(batch) < 100:
                break
        else:
            truncated = True
        return {"ref": ref, "files": files, "truncated": truncated}

    async def read_file(self, repo, path, ref):
        ref = ref or await self._default_branch(repo)
        r = await self._req("GET", f"/projects/{self._pid(repo)}/repository/files/{quote(path, safe='')}/raw",
                            params={"ref": ref})
        return r.content

    async def _file_exists(self, repo: str, path: str, ref: str) -> bool:
        r = await self.http.head(f"/projects/{self._pid(repo)}/repository/files/{quote(path, safe='')}",
                                 params={"ref": ref})
        return r.status_code == 200

    async def _branch_exists(self, repo: str, branch: str) -> bool:
        r = await self.http.get(f"/projects/{self._pid(repo)}/repository/branches/{quote(branch, safe='')}")
        return r.status_code == 200

    async def commit_files(self, repo, branch, message, changes, start_from):
        payload: dict = {"branch": branch, "commit_message": message, "actions": []}
        exists = await self._branch_exists(repo, branch)
        check_ref = branch
        if not exists and start_from:
            payload["start_branch"] = start_from
            check_ref = start_from
        for ch in changes:
            if ch.content is None:
                payload["actions"].append({"action": "delete", "file_path": ch.path})
                continue
            present = (exists or start_from) and await self._file_exists(repo, ch.path, check_ref)
            payload["actions"].append({
                "action": "update" if present else "create",
                "file_path": ch.path,
                "content": base64.b64encode(ch.content).decode(),
                "encoding": "base64",
            })
        d = (await self._req("POST", f"/projects/{self._pid(repo)}/repository/commits", json=payload)).json()
        return {"sha": d["id"], "branch": branch, "url": d.get("web_url")}

    async def create_branch(self, repo, branch, from_ref):
        from_ref = from_ref or await self._default_branch(repo)
        d = (await self._req("POST", f"/projects/{self._pid(repo)}/repository/branches",
                             params={"branch": branch, "ref": from_ref})).json()
        return {"branch": d["name"], "from": from_ref, "sha": d["commit"]["id"]}

    async def create_pull_request(self, repo, source, target, title, body):
        target = target or await self._default_branch(repo)
        d = (await self._req("POST", f"/projects/{self._pid(repo)}/merge_requests", json={
            "source_branch": source, "target_branch": target, "title": title, "description": body})).json()
        return {"number": d["iid"], "url": d["web_url"], "source": source, "target": target}

    async def ci_status(self, repo, ref):
        params: dict = {"per_page": 5}
        if ref:
            params["ref"] = ref
        pipes = (await self._req("GET", f"/projects/{self._pid(repo)}/pipelines", params=params)).json()
        return [{"name": f"pipeline #{p['id']}", "status": p["status"], "branch": p.get("ref"),
                 "url": p.get("web_url"), "created_at": p.get("created_at")} for p in pipes]
