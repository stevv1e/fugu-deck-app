import time

import jwt
import pytest

from cp.db import DB
from cp.events import Notifier
from cp.keys import Keys
from cp.orchestrator.manifests import space_manifests
from cp.reaper import run_once


class FakeOrch:
    kind = "fake"

    def __init__(self):
        self.deleted = []

    async def ensure(self, sp):
        return "ready"

    async def status(self, sp):
        return "ready"

    async def delete(self, sp):
        self.deleted.append(sp["id"])

    def internal_url(self, sp):
        return ""


class S:
    warn_after_hours = 48
    purge_after_hours = 72


@pytest.mark.asyncio
async def test_reaper_warns_purges_and_transfers_ownership(tmp_path):
    db = DB(str(tmp_path / "cp.sqlite3"))
    await db.connect()
    now = time.time()
    anna = await db.create_user("a", "anna", "Анна", False)
    bob = await db.create_user("b", "bob", "Боб", False)
    vika = await db.create_user("v", "vika", "Вика", False)
    for u in (anna, bob, vika):
        await db.create_space("personal", "Личное", u["id"])
    team = await db.create_space("team", "Shop", anna["id"])
    await db.add_member(team["id"], bob["id"], "editor")
    await db.add_member(team["id"], vika["id"], "viewer")
    # Анна неактивна 73 ч, Вика — 50 ч, Боб активен
    await db.exec("UPDATE users SET last_seen=? WHERE id='a'", (now - 73 * 3600,))
    await db.exec("UPDATE users SET last_seen=? WHERE id='v'", (now - 50 * 3600,))
    orch, revoked = FakeOrch(), []

    async def revoke(sp, uid):
        revoked.append((sp["id"], uid))

    res = await run_once(db, orch, Notifier(), S, revoke, now)
    assert res["warned"] == ["vika"]
    assert [p["user"] for p in res["purged"]] == ["anna"]
    assert (await db.personal_space("a")) is None
    assert await db.role(team["id"], "b") == "owner"  # владение перешло редактору, а не читателю
    assert await db.role(team["id"], "a") is None
    assert (team["id"], "a") in revoked
    # второй прогон не предупреждает повторно
    res2 = await run_once(db, orch, Notifier(), S, revoke, now + 60)
    assert res2 == {"warned": [], "purged": []}
    # все неактивны → общий проект удаляется вместе с последним участником
    await db.exec("UPDATE users SET last_seen=?, warned_at=NULL", (now - 100 * 3600,))
    await run_once(db, orch, Notifier(), S, revoke, now)
    assert await db.space(team["id"]) is None
    assert team["id"] in orch.deleted
    await db.close()


def test_space_token_claims(tmp_path):
    k = Keys(tmp_path)
    tok = k.space_token("t-1", {"id": "u1", "nick": "bob", "display_name": "Боб"}, "editor", 600)
    cl = jwt.decode(tok, k.public_pem, algorithms=["ES256"], audience="space:t-1", issuer="deck-control-plane")
    assert cl["role"] == "editor" and cl["sub"] == "u1" and cl["exp"] - cl["iat"] == 600
    with pytest.raises(jwt.InvalidAudienceError):
        jwt.decode(tok, k.public_pem, algorithms=["ES256"], audience="space:t-2", issuer="deck-control-plane")
    # ключи переживают перезапуск
    assert Keys(tmp_path).public_pem == k.public_pem


def test_manifests_isolation():
    from cp.config import Settings
    s = Settings(ingress_host="deck.example.kz")
    objs = space_manifests({"id": "t-abc", "kind": "team", "name": "Shop"}, {"CP_PUBLIC_KEY": "PEM", "SPACE_ID": "t-abc"}, s)
    kinds = [o["kind"] for o in objs]
    assert kinds[0] == "Namespace" and "NetworkPolicy" in kinds and "IngressRoute" in kinds
    np = next(o for o in objs if o["kind"] == "NetworkPolicy")
    assert set(np["spec"]["policyTypes"]) == {"Ingress", "Egress"}
    dep = next(o for o in objs if o["kind"] == "Deployment")
    c = dep["spec"]["template"]["spec"]["containers"][0]
    assert c["securityContext"]["readOnlyRootFilesystem"] is True
    assert not any(e.get("value") == "PEM" for e in c["env"])  # ключ идёт из ConfigMap
    ir = next(o for o in objs if o["kind"] == "IngressRoute")
    assert "/s/t-abc/" in ir["spec"]["routes"][0]["match"]
