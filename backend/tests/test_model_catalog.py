import json

from app.config import Settings
from app.llm import get_provider
from app.model_catalog import CatalogError, ModelCatalog
from tests.test_devices import client, main  # noqa: F401
from tests.test_api_extra import login


def test_custom_endpoint_roundtrip_without_secret_on_disk(tmp_path):
    settings = Settings(data_dir=tmp_path)
    catalog = ModelCatalog(settings)
    endpoint = catalog.add_endpoint("local-ai", {
        "name": "My API", "base_url": "https://ai.example.com/v1", "models": ["model-a", "model-b"],
    })
    assert endpoint["name"] == "My API"
    assert "custom-local-ai:model-a" in catalog.models
    assert get_provider("custom-local-ai", settings).base_url == "https://ai.example.com/v1"
    assert "api_key" not in json.loads(catalog.path.read_text())
    again = ModelCatalog(settings)
    assert again.models == catalog.models
    again.remove_endpoint("local-ai")
    assert not any(m.startswith("custom-local-ai:") for m in again.models)


def test_catalog_rejects_invalid_endpoint(tmp_path):
    catalog = ModelCatalog(Settings(data_dir=tmp_path))
    for cid, base in (("bad id", "https://ai.example.com"), ("ok", "file:///etc/passwd")):
        try:
            catalog.add_endpoint(cid, {"name": "x", "base_url": base, "models": ["m"]})
            raise AssertionError("invalid endpoint accepted")
        except CatalogError:
            pass


async def test_dynamic_models_and_custom_endpoint_api(client, monkeypatch):
    login(client)
    me = await main.db().get_user_by_name("owner")

    class Provider:
        async def list_models(self, key, headers=None):
            assert key == "secret"
            return ["gpt-dynamic", "gpt-dynamic", "bad model with spaces"]

    monkeypatch.setattr(main, "get_provider", lambda *a: Provider())
    main.vault().set(me["id"], "openai", "secret")
    r = client.post("/api/models/refresh", params={"provider": "openai"})
    assert r.status_code == 200, r.text
    assert r.json()["models"] == ["openai:gpt-dynamic"]
    assert "openai:gpt-dynamic" in client.get("/api/config").json()["models"]

    r = client.post("/api/models/endpoints", json={
        "id": "my-api", "name": "My API", "base_url": "https://ai.example.com/v1",
        "models": ["model-x"], "api_key": "custom-secret",
    })
    assert r.status_code == 200, r.text
    cfg = client.get("/api/config").json()
    assert "custom-my-api:model-x" in cfg["models"] and "custom-my-api" in cfg["llm_ready"]
    assert "custom-secret" not in json.dumps(cfg)
    main.vault().put(me["id"], {"openai": "replacement"})
    assert main.vault().get(me["id"])["custom-my-api"] == "custom-secret"
    main.vault().set(me["id"], "custom-my-api", "")
    assert "custom-my-api" not in client.get("/api/config").json()["llm_ready"]
    assert client.delete("/api/models/endpoints/my-api").json()["ok"] is True
