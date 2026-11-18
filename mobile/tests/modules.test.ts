import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256 } from "@noble/hashes/sha2.js";

import { utf8 } from "../src/core/bytes";
import { moduleHtml } from "../src/core/moduleHtml";
import { installModule, loadOfficialCatalog, modulePermissions, parseGitSource } from "../src/core/modules";

const hex = (text: string) => Buffer.from(sha256(utf8(text))).toString("hex");
const commit = "a".repeat(40);

function installerFetch(code: string, mutateManifest: (manifest: any) => void = () => {}) {
  return async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.github.com")) return new Response(JSON.stringify({ sha: commit }));
    if (url.endsWith("module.json")) {
      const manifest: any = {
        format: "fugu-module/1", id: "text-tools", name: "Text Tools", version: "1.0.0",
        description: "Tools", entry: "dist/module.js", sha256: hex(code), min_app: "0.1.0", permissions: {},
      };
      mutateManifest(manifest);
      return new Response(JSON.stringify(manifest));
    }
    if (url.endsWith("dist/module.js")) return new Response(code);
    return new Response("missing", { status: 404 });
  };
}

test("Git module source is pinned to a commit and checked by SHA-256", async () => {
  const source = parseGitSource("https://github.com/acme/tools/tree/main/modules/text-tools");
  assert.deepEqual(source, { owner: "acme", repo: "tools", ref: "main", path: "modules/text-tools", repository: "https://github.com/acme/tools" });
  const code = "document.getElementById('app').textContent='ok'";
  const installed = await installModule(source, "", installerFetch(code) as typeof fetch);
  assert.equal(installed.commit, commit);
  assert.equal(installed.manifest.id, "text-tools");
  assert.deepEqual(modulePermissions(installed.manifest), ["только интерфейс, без сети и хранилища"]);
  await assert.rejects(installModule(source, "", installerFetch(code, (m) => { m.sha256 = "0".repeat(64); }) as typeof fetch), /SHA-256/);
  await assert.rejects(installModule(source, "", installerFetch(code, (m) => { m.permissions = { ssh: true }; }) as typeof fetch), /разрешения/);
  await assert.rejects(installModule(source, "", installerFetch(code, (m) => { m.min_app = "99.0.0"; }) as typeof fetch), /min_app|нужен Fugu Deck/);
});

test("official catalog resolves index at one commit", async () => {
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.github.com")) return new Response(JSON.stringify({ sha: commit }));
    return new Response(JSON.stringify({ format: "fugu-modules/1", modules: [
      { id: "text-tools", path: "modules/text-tools", name: "Text", description: "Tools", version: "1.0.0" },
    ] }));
  };
  const catalog = await loadOfficialCatalog(fetcher as typeof fetch);
  assert.equal(catalog.sources["text-tools"].ref, commit);
  assert.equal(catalog.entries.length, 1);
});

test("module sandbox has no direct network and cannot close the script early", () => {
  const html = moduleHtml("const x='</script><script>bad()<\\/script>'; fetch('https://evil')");
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /default-src 'none'/);
  assert.ok(!html.includes("</script><script>bad()"));
});
