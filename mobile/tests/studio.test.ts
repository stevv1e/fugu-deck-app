import assert from "node:assert/strict";
import { test } from "node:test";

import { draftFromTemplate, draftModule, makeDraft, publishDraft } from "../src/core/moduleStudio";
import { parseGitSource } from "../src/core/modules";

test("module studio templates produce valid local modules with automatic hashes", () => {
  for (const template of ["tool", "panel", "schedule", "prompts"] as const) {
    const draft = draftFromTemplate(template);
    assert.equal(draft.manifest.sha256.length, 64);
    assert.equal(draft.manifest.entry, "module.js");
    assert.equal(draftModule(draft).commit, "local");
  }
  const draft = draftFromTemplate("tool");
  assert.notEqual(makeDraft({ ...draft.manifest, version: "0.2.0" }, "document.getElementById('app').textContent='new'").manifest.sha256, draft.manifest.sha256);
  assert.throws(() => makeDraft({ ...draft.manifest, id: "BAD" }, draft.code), /ID/);
});

test("module publishing creates one atomic non-force commit", async () => {
  const parent = "b".repeat(40);
  const created = "a".repeat(40);
  const calls: { method: string; url: string; body?: any }[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (method === "GET" && url.includes("/git/refs/")) return Response.json({ object: { sha: parent } });
    if (method === "GET" && url.includes("/git/commits/")) return Response.json({ tree: { sha: "c".repeat(40) } });
    if (method === "POST" && url.endsWith("/git/trees")) {
      assert.equal(body.base_tree, "c".repeat(40));
      assert.deepEqual(body.tree.map((item: any) => item.path), ["modules/demo/module.json", "modules/demo/module.js"]);
      return Response.json({ sha: "d".repeat(40) });
    }
    if (method === "POST" && url.endsWith("/git/commits")) return Response.json({ sha: created });
    if (method === "PATCH") {
      assert.deepEqual(body, { sha: created, force: false });
      return Response.json({});
    }
    return new Response("missing", { status: 404 });
  };
  const source = parseGitSource("https://github.com/acme/tools", "main", "modules/demo");
  const got = await publishDraft(source, "token", draftFromTemplate("tool"), fetcher as typeof fetch);
  assert.equal(got.commit, created);
  assert.deepEqual(calls.map((call) => call.method), ["GET", "GET", "POST", "POST", "PATCH"]);
  await assert.rejects(publishDraft(source, "", draftFromTemplate("tool"), fetcher as typeof fetch), /token/);
});
