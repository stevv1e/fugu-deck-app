/** MCP-серверы: id из названия, проверка адреса, действие mcp_put с токеном для keyguard (HPKE) и без. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { p256 } from "@noble/curves/nist.js";

import { validateEnvelope } from "../src/core/actions";
import { b64, fromUtf8, unb64 } from "../src/core/bytes";
import { clusterDeviceId } from "../src/core/cluster";
import { jwkFromPoint, sha256, softKeygen, softSign } from "../src/core/crypto";
import { HPKE_INFO, hpkeOpen } from "../src/core/hpke";
import { makeKey, type DeviceKeys } from "../src/core/keys";
import { deleteMcp, mcpIdFrom, mcpUrlProblem, putMcp } from "../src/core/mcp";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function softKeys(): DeviceKeys {
  const s = softKeygen(), c = softKeygen();
  return {
    alias: "t", storage: "software", attestation: null,
    session: makeKey(jwkFromPoint(s.point), async (d) => softSign(s.secret, d)),
    confirm: makeKey(jwkFromPoint(c.point), async (d) => softSign(c.secret, d)),
  };
}

const payload = (jws: string) => JSON.parse(fromUtf8(unb64(jws.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))));

test("id из названия и проверка адреса", () => {
  assert.equal(mcpIdFrom("My Notion!"), "my-notion");
  assert.match(mcpIdFrom("Погода"), /^mcp-[a-z0-9x]{2,26}$/);
  assert.equal(mcpIdFrom("42 docs"), "docs");
  assert.equal(mcpUrlProblem("https://mcp.example.com/mcp"), null);
  for (const bad of ["http://mcp.example.com", "https://10.0.0.1/x", "https://mcp.example.com:8443/", "https://u:p@mcp.example.com/",
    "https://localhost/x", "не адрес", "https://mcp.example.com/#a"]) {
    assert.ok(mcpUrlProblem(bad), bad);
  }
});

test("mcp_put с токеном: шифротекст для keyguard, хеш и последние 4 знака под подписью", async () => {
  const keys = softKeys();
  const sk = p256.utils.randomSecretKey();
  const pk = b64(p256.getPublicKey(sk, false));
  let sent: any = null;
  const s = { request: async (_m: string, path: string, body: any) => { sent = { path, body }; return { ok: true }; } };
  await putMcp(s as any, keys, pk, { id: "docs", name: "Документы", url: "https://mcp.example.com/mcp", token: "tok-SECRET-1234" });
  assert.equal(sent.path, "/v1/mcp");
  const a = payload(sent.body.jws);
  validateEnvelope(a);
  assert.equal(a.type, "mcp_put");
  assert.equal(a.token_hint, "1234");
  const enc = unb64(sent.body.enc), ct = unb64(sent.body.ct);
  assert.equal(a.ct_sha256, hex(sha256(new Uint8Array([...enc, ...ct]))));
  const aad = new TextEncoder().encode(`mcp_put|${clusterDeviceId(keys)}|docs|${a.nonce}`);
  assert.equal(fromUtf8(hpkeOpen(sk, enc, new TextEncoder().encode(HPKE_INFO), aad, ct)), "tok-SECRET-1234");
  assert.ok(!JSON.stringify(sent.body).includes("SECRET"), "токен не уходит открытым");
});

test("mcp_put без токена и mcp_delete", async () => {
  const keys = softKeys();
  let sent: any = null;
  const s = { request: async (_m: string, path: string, body: any) => { sent = { path, body }; return { ok: true }; } };
  await putMcp(s as any, keys, "AA==", { id: "weather", name: "", url: "https://weather.example.org/mcp" });
  const a = payload(sent.body.jws);
  assert.equal(a.token_hint, null);
  assert.equal(a.ct_sha256, null);
  assert.equal(a.name, "weather");
  assert.equal(sent.body.enc, undefined);
  await assert.rejects(putMcp(s as any, keys, "AA==", { id: "x", name: "x", url: "https://a.b/" }), /id сервера/);
  await assert.rejects(putMcp(s as any, keys, "AA==", { id: "web", name: "x", url: "http://a.b/" }), /https/);
  await deleteMcp(s as any, keys, "weather");
  assert.equal(sent.path, "/v1/mcp/delete");
  assert.deepEqual([payload(sent.body.jws).type, payload(sent.body.jws).id], ["mcp_delete", "weather"]);
});
