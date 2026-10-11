/**
 * Вход в кластер v2 кодом приложения. Без внешних зависимостей — разбор приглашения и защита от непривязанного токена.
 * С KC_URL (настоящий Keycloak, realm deck как в кластере) и KGCHECK (обработчики keyguard) — полный путь:
 * вход → PKCE → токен с DPoP → регистрация в keyguard → подтверждение администратором → ввод ключа.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { test } from "node:test";
import { p256 } from "@noble/curves/nist.js";

import { buildKeyPut } from "../src/core/apikeys";
import { b64u, randomId } from "../src/core/bytes";
import {
  authorizeUrl, buildEnroll, claims, clusterDeviceId, exchangeCode, fetchChallenge, newPkce, parseClusterInvite, parseRedirect, refresh, signClusterAction, statusRequest,
  type ClusterInvite,
} from "../src/core/cluster";
import { jwkFromPoint, softKeygen, softSign } from "../src/core/crypto";
import { dpopProof } from "../src/core/dpop";
import { fetchHttp, type Http } from "../src/core/http";
import { makeKey, type DeviceKeys } from "../src/core/keys";

function softKeys(): DeviceKeys & { confSecret: Uint8Array } {
  const s = softKeygen(), c = softKeygen();
  return {
    alias: "t", storage: "software", attestation: null, confSecret: c.secret,
    session: makeKey(jwkFromPoint(s.point), async (d) => softSign(s.secret, d)),
    confirm: makeKey(jwkFromPoint(c.point), async (d) => softSign(c.secret, d)),
  };
}

// ---------------- без внешних зависимостей ----------------

const HPKE = b64u(p256.getPublicKey(p256.utils.randomSecretKey(), false));
test("приглашение: только https, один домен, валидный токен, ключ keyguard на кривой", () => {
  const ok = parseClusterInvite("fugudeck://join?api=https://api.deck.acme.kz&iss=https://id.deck.acme.kz/realms/deck&join=https://join.deck.acme.kz&hpke=" + HPKE + "&invite=" + "a".repeat(32));
  assert.equal(ok.issuer, "https://id.deck.acme.kz/realms/deck");
  const base = "fugudeck://join?api=https://api.deck.acme.kz&join=https://join.deck.acme.kz&hpke=" + HPKE + "&invite=" + "a".repeat(32);
  const notOnCurve = b64u(Uint8Array.from([4, ...new Uint8Array(63), 1]));
  assert.throws(() => parseClusterInvite(base.replace(HPKE, notOnCurve) + "&iss=https://id.deck.acme.kz/realms/deck"), /ключа keyguard/, "ключ HPKE не на кривой");
  assert.throws(() => parseClusterInvite(base.replace("&hpke=" + HPKE, "") + "&iss=https://id.deck.acme.kz/realms/deck"), /ключа keyguard/, "без ключа HPKE");
  assert.throws(() => parseClusterInvite(base + "&iss=http://id.deck.acme.kz/realms/deck"), /https/, "http для Keycloak");
  assert.throws(() => parseClusterInvite(base + "&iss=https://id.evil.example/realms/deck"), /разных доменов/, "подставной Keycloak в QR");
  assert.throws(() => parseClusterInvite(base.replace("a".repeat(32), "short") + "&iss=https://id.deck.acme.kz/realms/deck"), /токен/);
  assert.throws(() => parseClusterInvite("https://join.deck.acme.kz/?invite=x"), /не приглашение/);
  assert.throws(() => parseClusterInvite(base + "&iss=https://user:pw@id.deck.acme.kz/realms/deck"), /логин/);
});

test("ответ входа: чужой state и ошибка отвергаются", () => {
  const p = newPkce();
  assert.equal(parseRedirect(`fugudeck://oauth?code=abc&state=${p.state}`, p), "abc");
  assert.throws(() => parseRedirect(`fugudeck://oauth?code=abc&state=forged`, p), /state/);
  assert.throws(() => parseRedirect(`fugudeck://oauth?error=access_denied&state=${p.state}`, p), /отклонён/);
  assert.throws(() => parseRedirect(`fugudeck://evil?code=abc&state=${p.state}`, p), /Чужой адрес/);
});

test("сервер выдал непривязанный Bearer — приложение прерывает вход", async () => {
  const keys = softKeys();
  const fake = (tokenType: string, jkt: string): Http => ({
    request: async () => ({ status: 200, text: JSON.stringify({ token_type: tokenType, expires_in: 300,
      access_token: "e30." + b64u(new TextEncoder().encode(JSON.stringify({ cnf: { jkt } }))) + ".x" }) }),
    stream: () => ({ close() {} }),
  });
  const c: ClusterInvite = { api: "https://api.x", issuer: "https://id.x/realms/deck", join: "https://join.x", invite: "i".repeat(20), hpke: HPKE };
  await assert.rejects(exchangeCode(fake("Bearer", keys.session.jkt), c, keys, "code", newPkce(), Date.now() / 1000), /непривязанный/);
  await assert.rejects(exchangeCode(fake("DPoP", "чужой"), c, keys, "code", newPkce(), Date.now() / 1000), /не к ключу/);
});

// ---------------- настоящий Keycloak + keyguard ----------------

const KC = process.env.KC_URL, KG = process.env.KGCHECK;
const skip = KC && KG ? false : "нужны KC_URL (Keycloak с realm deck) и KGCHECK";

/** «Системный браузер»: страница входа Keycloak, форма, редирект в приложение. */
async function browserLogin(url: string, user: string, password: string): Promise<string> {
  const jar = new Map<string, string>();
  const keep = (r: Response) => r.headers.getSetCookie().forEach((c) => { const [kv] = c.split(";"); const i = kv.indexOf("="); jar.set(kv.slice(0, i), kv.slice(i + 1)); });
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const r1 = await fetch(url, { redirect: "manual" });
  keep(r1);
  const html = await r1.text();
  const action = html.match(/id="kc-form-login"[^>]*action="([^"]+)"/)?.[1]?.replaceAll("&amp;", "&");
  if (!action) throw new Error("нет формы входа: " + html.slice(0, 200));
  const r2 = await fetch(action, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie() },
    body: new URLSearchParams({ username: user, password, credentialId: "" }) });
  const loc = r2.headers.get("location");
  if (!loc) throw new Error(`вход не удался: ${r2.status} ${(await r2.text()).slice(0, 200)}`);
  return loc;
}

function kgScript(input: Record<string, unknown>): string[] {
  const r = spawnSync(KG!, { input: JSON.stringify({ op: "script", ...input }) + "\n", encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trimEnd().split("\n");
}

test("Keycloak: вход кодом приложения — токен привязан к ключу сессии; атаки на выдачу токена отвергаются", { skip }, async () => {
  const http = fetchHttp(fetch);
  const c: ClusterInvite = { api: "http://localhost:9", issuer: `${KC}/realms/deck`, join: "http://localhost:9", invite: "i".repeat(20), hpke: HPKE };
  const keys = softKeys();
  const now = () => Date.now() / 1000;

  const p = newPkce();
  const code = parseRedirect(await browserLogin(authorizeUrl(c, p), "anna", "anna-pass"), p);
  const t = await exchangeCode(http, c, keys, code, p, now());
  const cl = claims(t.accessToken);
  assert.equal(t.tokenType, "DPoP");
  assert.equal(cl.cnf.jkt, keys.session.jkt, "Keycloak привязал токен к ключу сессии телефона");
  assert.equal(cl.azp, "deck-app");
  assert.equal(cl.preferred_username, "anna");

  const tokenEp = `${c.issuer}/protocol/openid-connect/token`;
  const raw = async (form: Record<string, string>, dpop?: string) => {
    const r = await fetch(tokenEp, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...(dpop ? { DPoP: dpop } : {}) }, body: new URLSearchParams(form) });
    return { status: r.status, body: await r.json() as Record<string, string> };
  };
  // K1 код без DPoP
  const p1 = newPkce();
  const code1 = parseRedirect(await browserLogin(authorizeUrl(c, p1), "anna", "anna-pass"), p1);
  const r1 = await raw({ grant_type: "authorization_code", client_id: "deck-app", code: code1, code_verifier: p1.verifier, redirect_uri: "fugudeck://oauth" });
  assert.notEqual(r1.status, 200, "обмен кода без DPoP");
  // K2 чужой code_verifier (перехваченный код без секрета PKCE)
  const p2 = newPkce();
  const code2 = parseRedirect(await browserLogin(authorizeUrl(c, p2), "anna", "anna-pass"), p2);
  const r2 = await raw({ grant_type: "authorization_code", client_id: "deck-app", code: code2, code_verifier: newPkce().verifier, redirect_uri: "fugudeck://oauth" },
    await dpopProof({ key: keys.session, method: "POST", url: tokenEp, now: now() }));
  assert.equal(r2.body.error, "invalid_grant", "перехваченный код без верного code_verifier");
  // K4 украденный refresh-токен с ДРУГИМ ключом; свой ключ — работает
  const thief = softKeys();
  await assert.rejects(refresh(http, c, thief, t.refreshToken!, now()), /./, "refresh чужим ключом");
  const again = await refresh(http, c, keys, t.refreshToken!, now());
  assert.equal(claims(again.accessToken).cnf.jkt, keys.session.jkt, "своим ключом refresh работает");
  // K3 повтор уже использованного кода
  const r3 = await raw({ grant_type: "authorization_code", client_id: "deck-app", code, code_verifier: p.verifier, redirect_uri: "fugudeck://oauth" },
    await dpopProof({ key: keys.session, method: "POST", url: tokenEp, now: now() }));
  assert.notEqual(r3.status, 200, "повтор кода");
  // Keycloak на повтор кода отзывает сессию, выпущенную по нему (OAuth 2.0): перехваченный и повторённый код
  // гасит и токены владельца — refresh больше не работает
  await assert.rejects(refresh(http, c, keys, again.refreshToken!, now()), (e: any) => e.status === 400, "после повтора кода сессия отозвана");
  // K5 вход паролем в обход браузера (password grant)
  const r5 = await raw({ grant_type: "password", client_id: "deck-app", username: "anna", password: "anna-pass" },
    await dpopProof({ key: keys.session, method: "POST", url: tokenEp, now: now() }));
  assert.notEqual(r5.status, 200, "password grant запрещён");
});

test("Keycloak → keyguard: регистрация, ожидание, подтверждение администратором, ввод ключа", { skip }, async () => {
  const http = fetchHttp(fetch);
  const c: ClusterInvite = { api: "http://localhost:9", issuer: `${KC}/realms/deck`, join: "https://join.deck.test", invite: "i".repeat(20), hpke: HPKE };
  const now = () => Date.now() / 1000;
  const login = async (user: string, keys: DeviceKeys) => {
    const p = newPkce();
    return exchangeCode(http, c, keys, parseRedirect(await browserLogin(authorizeUrl(c, p), user, `${user}-pass`), p), p, now());
  };
  const admin = softKeys(), anna = softKeys(), annaThief = softKeys();
  const tAdmin = await login("admin", admin), tAnna = await login("anna", anna);
  const sk = p256.utils.randomSecretKey(), hpkePub = p256.getPublicKey(sk, false);
  const signAs = (keys: DeviceKeys) => (body: Record<string, unknown>, nonce?: string) => signClusterAction(keys, body, { nonce });
  const annaId = clusterDeviceId(anna);
  const stolen = await buildEnroll(c, annaThief, tAnna, "чужой телефон", now()); // токен Анны, ключи вора
  const out = kgScript({
    sk_hex: Buffer.from(sk).toString("hex"), issuer: claims(tAnna.accessToken).iss,
    jwks_url: `${c.issuer}/protocol/openid-connect/certs`, enroll_url: `${c.join}/v1/enroll`,
    steps: [
      { path: "/v1/devices", body: await buildEnroll(c, admin, tAdmin, "ноутбук админа", now()) },
      { path: "/v1/devices", body: await buildEnroll(c, anna, tAnna, "iPhone Анны", now()) },
      { path: "/v1/devices/status", body: await statusRequest(c, anna, now()) },
      { path: "/v1/keys", body: await buildKeyPut(signAs(anna), { hpkePub, deviceId: annaId, provider: "anthropic", apiKey: "sk-ant-api03-ANNA-REAL" }) },
      { path: "/v1/devices/confirm", body: await signAs(admin)({ type: "device_approve", user: "anna", target: annaId, name: "iPhone Анны" }) },
      { path: "/v1/keys", body: await buildKeyPut(signAs(anna), { hpkePub, deviceId: annaId, provider: "anthropic", apiKey: "sk-ant-api03-ANNA-REAL" }) },
      { path: "/v1/devices/status", body: await statusRequest(c, anna, now()) },
      { path: "/v1/devices/status", body: await statusRequest(c, annaThief, now()).then((r) => ({ ...r, device_id: annaId })) },
      { path: "/v1/devices", body: stolen },
    ],
  });
  const [, , st1, , , , st2, stThief] = out;
  assert.match(st1, /^200 .*"status":"pending"/, "статус до подтверждения");
  assert.doesNotMatch(st1, /CERTIFICATE/, "до подтверждения сертификата нет");
  const cert = JSON.parse(st2.slice(4)).cert_pem as string;
  const x = new X509Certificate(cert);
  assert.match(x.subject, new RegExp(`CN=${annaId}`), "CN — ID устройства от keyguard");
  const spki = x.publicKey.export({ format: "jwk" }) as { x: string; y: string };
  assert.equal(spki.x, anna.session.jwk.x, "в сертификате ключ сессии телефона");
  assert.match(stThief, /^403/, "сертификат Анны чужим ключом не забрать");
  assert.match(out[0], /^200 .*"status":"active"/, "первое устройство bootstrap-администратора");
  assert.match(out[1], new RegExp(`^200 .*"device_id":"${annaId}".*"status":"pending"`), "устройство Анны ждёт подтверждения");
  assert.match(out[3], /^403 .*не подтверждено/, "до подтверждения ключ ввести нельзя");
  assert.match(out[4], /^200/, "администратор подтвердил");
  assert.match(out[5], /^200 .*…/, "после подтверждения ключ принят, в ответе маска");
  assert.match(out[8], /^403 .*cnf\.jkt/, "токен Анны с ключами другого телефона не регистрируется");
});

test("вызов для аттестации: берётся до создания ключей и уходит в регистрацию только вместе с аттестацией", async () => {
  const c: ClusterInvite = { api: "https://api.d.test", issuer: "https://id.d.test/realms/deck", join: "https://join.d.test", invite: "i".repeat(20), hpke: HPKE };
  const ch = b64u(new Uint8Array(40).fill(7));
  const http = (status: number, text: string): Http => ({ request: async (r: { url: string }) => { assert.equal(r.url, "https://join.d.test/v1/enroll/challenge"); return { status, text, headers: {} }; } }) as unknown as Http;
  assert.equal(await fetchChallenge(http(200, JSON.stringify({ challenge: ch, expires_in: 900 })), c), ch);
  assert.equal(await fetchChallenge(http(404, "{}"), c), null, "сервер без аттестации — регистрация без неё");
  await assert.rejects(fetchChallenge(http(200, JSON.stringify({ challenge: "a b" })), c), /повреждённый вызов/);
  await assert.rejects(fetchChallenge(http(500, "boom"), c));
  const keys = softKeys();
  const tokens = { accessToken: "t", refreshToken: "r", expiresIn: 60, tokenType: "DPoP" };
  const soft = await buildEnroll(c, keys, tokens, "Телефон", Date.now() / 1000, ch);
  assert.equal(soft.challenge, undefined, "программные ключи без аттестации — вызов не отправляется");
  const att = { session: { format: "android-key", chain: ["x"] }, confirm: { format: "android-key", chain: ["y"] } };
  const hard = await buildEnroll(c, { ...keys, attestation: att }, tokens, "Телефон", Date.now() / 1000, ch);
  assert.equal(hard.challenge, ch);
  assert.deepEqual(hard.attestation, att);
});
