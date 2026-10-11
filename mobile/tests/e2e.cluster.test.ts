/**
 * Сквозной тест: код приложения (src/core) против настоящих Keycloak, keyguard и control-plane.
 * Стенд поднимает scripts/e2e_test.sh; без его переменных окружения тест пропускается.
 *
 * Роль Traefik играет сам тест: адреса id/join/api.<домен> ведут на локальные порты, а перед api стоит TLS-сервер,
 * который требует сертификат устройства, проверяет его по CA устройств и передаёт control-plane в заголовке —
 * так же, как middleware device-cert-pem в кластере.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { after, before, test } from "node:test";

import { buildKeyPut } from "../src/core/apikeys";
import { b64u, unb64 } from "../src/core/bytes";
import {
  browserStartUrl, buildEnroll, clusterDeviceId, exchangeCode, fetchChallenge, fetchStatus, joinHeaders, newPkce, parseClusterInvite,
  parseRedirect, refresh, signClusterAction, type ClusterInvite, type Tokens,
} from "../src/core/cluster";
import { jwkFromPoint, softKeygen, softSign } from "../src/core/crypto";
import { dpopProof } from "../src/core/dpop";
import { ApiError, fetchHttp, type Http } from "../src/core/http";
import { makeKey, type DeviceKeys } from "../src/core/keys";

const E = process.env;
const skip = E.E2E_CP ? false : "нужен стенд: scripts/e2e_test.sh";
const DOMAIN = E.E2E_DOMAIN ?? "", KC = E.E2E_KC ?? "", CP = E.E2E_CP ?? "", CP_ADMIN = E.E2E_CP_ADMIN ?? "";

// ---------------- «сеть»: имена кластера → локальные порты ----------------

const routes = (): Record<string, string> => ({ [`https://id.${DOMAIN}`]: KC, [`https://join.${DOMAIN}`]: CP });
const route = (url: string) => {
  for (const [from, to] of Object.entries(routes())) if (url.startsWith(from)) return to + url.slice(from.length);
  throw new Error("тест: запрос на неизвестный адрес " + url);
};
/** fetch приложения: адреса кластера ведут на стенд. Заголовки прокси — как их ставит Traefik для Keycloak. */
const net: typeof fetch = (input, init) => {
  const h = new Headers(init?.headers);
  h.set("X-Forwarded-Proto", "https");
  h.set("X-Forwarded-Host", new URL(String(input)).host); // Keycloak сверяет адрес в DPoP с тем, по которому к нему пришли
  return fetch(route(String(input)), { ...init, headers: h });
};
const plain0 = fetchHttp(net);
/** То же, но с печатью отказов сервера при E2E_DEBUG=1 — чтобы упавший шаг было видно без отладчика. */
const plain: Http = {
  ...plain0,
  request: async (req) => {
    const r = await plain0.request(req);
    if (E.E2E_DEBUG && r.status >= 400) console.error(`[e2e] ${req.method} ${req.url} → ${r.status} ${r.text.slice(0, 300)}`);
    return r;
  },
};

type SoftKeys = DeviceKeys & { sessionPem: string };
function softKeys(): SoftKeys {
  const s = softKeygen(), c = softKeygen();
  const jwk = jwkFromPoint(s.point);
  const sessionPem = createPrivateKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: b64u(s.secret) } })
    .export({ type: "pkcs8", format: "pem" }) as string;
  return {
    alias: "e2e", storage: "software", attestation: null, sessionPem,
    session: makeKey(jwk, async (d) => softSign(s.secret, d)),
    confirm: makeKey(jwkFromPoint(c.point), async (d) => softSign(c.secret, d)),
  };
}

// ---------------- «Traefik» перед api: mTLS сертификатом устройства ----------------

let edge: https.Server, edgePort = 0, edgeCert = "";

before(() => {
  if (skip) return;
  const dir = mkdtempSync(pjoin(tmpdir(), "deck-e2e-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1",
    "-subj", `/CN=api.${DOMAIN}`, "-addext", `subjectAltName=DNS:api.${DOMAIN}`, "-keyout", pjoin(dir, "k.pem"), "-out", pjoin(dir, "c.pem")], { stdio: "ignore" });
  edgeCert = readFileSync(pjoin(dir, "c.pem"), "utf8");
  edge = https.createServer(
    { key: readFileSync(pjoin(dir, "k.pem")), cert: edgeCert, ca: readFileSync(E.E2E_DEVICE_CA!), requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3" },
    (req, res) => {
      const cert = (req.socket as import("node:tls").TLSSocket).getPeerCertificate();
      const headers: http.OutgoingHttpHeaders = { ...req.headers, host: `api.${DOMAIN}` };
      delete headers["x-forwarded-tls-client-cert"]; // клиентский заголовок не проходит — как у Traefik
      headers["x-forwarded-tls-client-cert"] = encodeURIComponent(cert.raw.toString("base64"));
      const up = http.request(CP + req.url, { method: req.method, headers }, (r) => { res.writeHead(r.statusCode!, r.headers); r.pipe(res); });
      up.on("error", () => { res.writeHead(502); res.end(); });
      req.pipe(up);
    });
  return new Promise<void>((ok) => edge.listen(0, "127.0.0.1", () => { edgePort = (edge.address() as AddressInfo).port; ok(); }));
});
after(() => { edge?.close(); });

/** Транспорт приложения к api.<домен>: TLS 1.3, сертификат устройства и ключ сессии (в телефоне — из чипа). */
function apiHttp(client?: { key: string; cert: string }): Http {
  const base = `https://api.${DOMAIN}`;
  return {
    request: (req) => new Promise((ok, fail) => {
      if (!req.url.startsWith(base)) return fail(new Error("тест: не api: " + req.url));
      const r = https.request({ host: "127.0.0.1", port: edgePort, servername: `api.${DOMAIN}`, path: req.url.slice(base.length), method: req.method,
        headers: req.headers, ca: edgeCert, ...(client ?? {}) }, (res) => {
        let text = ""; res.setEncoding("utf8"); res.on("data", (d) => (text += d)); res.on("end", () => ok({ status: res.statusCode!, text }));
      });
      r.on("error", (e) => fail(new ApiError(0, "Сервер недоступен: " + e.message)));
      r.end(req.body);
    }),
    stream: () => { throw new Error("тест: поток не используется"); },
  };
}

// ---------------- помощники стенда ----------------

async function kcAdmin(): Promise<string> {
  const r = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, { method: "POST",
    body: new URLSearchParams({ client_id: "admin-cli", grant_type: "password", username: "admin", password: "admin-pass" }) });
  return (await r.json()).access_token;
}
/** Вместо регистрации passkey в браузере: администратор стенда ставит приглашённому пароль. */
async function setPassword(user: string, password: string) {
  const h = { Authorization: `Bearer ${await kcAdmin()}`, "Content-Type": "application/json" };
  const [u] = await (await fetch(`${KC}/admin/realms/deck/users?exact=true&username=${user}`, { headers: h })).json();
  assert.ok(u, `пользователь ${user} создан control-plane при выпуске приглашения`);
  assert.deepEqual(u.requiredActions, ["webauthn-register-passwordless"], "новому пользователю назначена регистрация passkey");
  await fetch(`${KC}/admin/realms/deck/users/${u.id}`, { method: "PUT", headers: h, body: JSON.stringify({ requiredActions: [], email: `${user}@${DOMAIN}`, emailVerified: true, firstName: user, lastName: "E2E" }) });
  const r = await fetch(`${KC}/admin/realms/deck/users/${u.id}/reset-password`, { method: "PUT", headers: h, body: JSON.stringify({ type: "password", value: password, temporary: false }) });
  assert.equal(r.status, 204, "пароль стенда установлен");
}
async function invite(nick: string): Promise<ClusterInvite> {
  const r = await fetch(`${CP_ADMIN}/admin/v1/invites`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nick }) });
  assert.equal(r.status, 200, "приглашение выпущено");
  return parseClusterInvite((await r.json()).link); // разбор — кодом приложения: адреса одного домена, ключ keyguard на кривой
}
/** «Системный браузер»: join/start → страница входа Keycloak → форма → возврат в приложение. */
async function browserLogin(startUrl: string, user: string, password: string): Promise<string> {
  const jar = new Map<string, string>();
  const keep = (r: Response) => r.headers.getSetCookie().forEach((c) => { const [kv] = c.split(";"); const i = kv.indexOf("="); jar.set(kv.slice(0, i), kv.slice(i + 1)); });
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const r0 = await net(startUrl, { redirect: "manual" });
  if (r0.status !== 302) throw new ApiError(r0.status, (await r0.text()).slice(0, 200));
  keep(r0);
  assert.match(jar.get("deck_invite") ?? "", /^[a-z0-9-]+\.\d+\./, "join/start поставил cookie приглашения");
  const r1 = await net(r0.headers.get("location")!, { redirect: "manual", headers: { Cookie: cookie() } });
  keep(r1);
  const html = await r1.text();
  const action = html.match(/id="kc-form-login"[^>]*action="([^"]+)"/)?.[1]?.replaceAll("&amp;", "&");
  if (!action) throw new Error("нет формы входа: " + html.slice(0, 300));
  const r2 = await net(action, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie() },
    body: new URLSearchParams({ username: user, password, credentialId: "" }) });
  const loc = r2.headers.get("location");
  if (!loc) throw new Error(`вход не удался: ${r2.status} ${(await r2.text()).slice(0, 300)}`);
  return loc;
}

const now = () => Date.now() / 1000;

/** Путь нового устройства до ответа сервера на регистрацию — те же вызовы, что в src/app/join.tsx. */
async function join(inv: ClusterInvite, user: string, deviceName: string) {
  const challenge = await fetchChallenge(plain, inv);
  const keys = softKeys();
  const pkce = newPkce();
  const code = parseRedirect(await browserLogin(browserStartUrl(inv, pkce), user, `${user}-pass`), pkce);
  const tokens = await exchangeCode(plain, inv, keys, code, pkce, now());
  const body = await buildEnroll(inv, keys, tokens, deviceName, now(), challenge);
  const r = await plain.request({ method: "POST", url: `${inv.join}/v1/enroll`, headers: joinHeaders(inv), body: JSON.stringify(body) });
  return { keys, tokens, status: r.status, out: JSON.parse(r.text) as { device_id?: string; user?: string; status?: string; error?: string } };
}

async function apiCall(h: Http, inv: ClusterInvite, keys: DeviceKeys, tokens: Tokens, method: string, path: string, body?: unknown) {
  const url = inv.api + path;
  const proof = await dpopProof({ key: keys.session, method, url, accessToken: tokens.accessToken, now: now() });
  return h.request({ method, url, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json", Authorization: `DPoP ${tokens.accessToken}`, DPoP: proof } });
}

// ---------------- сценарий ----------------

test("приглашение → регистрация → сертификат → mTLS на api → ключ API; повторная привязка и второй пользователь", { skip }, async () => {
  // 1. Первый пользователь — он же администратор кластера: его первое устройство активируется само.
  const inv = await invite("anna");
  assert.equal(inv.api, `https://api.${DOMAIN}`);
  await setPassword("anna", "anna-pass");
  const a = await join(inv, "anna", "Телефон Анны");
  assert.equal(a.status, 200, JSON.stringify(a.out));
  assert.equal(a.out.device_id, clusterDeviceId(a.keys), "ID устройства сервер вычислил так же, как приложение");
  assert.equal(a.out.user, "anna");
  assert.equal(a.out.status, "active", "первое устройство администратора активно сразу");

  // 2. Сертификат приходит запросом статуса — БЕЗ приглашения (оно уже использовано), по подписи ключом сессии.
  const st = await fetchStatus(plain, inv, a.keys, now());
  assert.equal(st.status, "active");
  assert.ok(st.cert_pem, "активному устройству выдан сертификат");
  const cert = new X509Certificate(st.cert_pem!);
  assert.match(cert.subject, new RegExp(`CN=${a.out.device_id}`), "имя в сертификате задал keyguard");
  const spki = cert.publicKey.export({ format: "jwk" }) as { x: string };
  assert.equal(spki.x, a.keys.session.jwk.x, "сертификат выпущен на ключ сессии");

  // 3. Использованное приглашение не годится ни для одного шага: приложение не должно начать создавать ключи.
  await assert.rejects(fetchChallenge(plain, inv), /уже использовано/, "вызов для аттестации по использованному приглашению");
  await assert.rejects(browserLogin(browserStartUrl(inv, newPkce()), "anna", "anna-pass"), /использовано/, "join/start с использованным приглашением");

  // 4. api: без сертификата TLS не устанавливается; с сертификатом, токеном и DPoP — пускает.
  const mtls = apiHttp({ key: a.keys.sessionPem, cert: st.cert_pem! });
  await assert.rejects(apiCall(apiHttp(), inv, a.keys, a.tokens, "GET", "/v1/me"), /недоступен/, "api без сертификата устройства");
  const me = await apiCall(mtls, inv, a.keys, a.tokens, "GET", "/v1/me");
  assert.equal(me.status, 200, me.text);
  assert.deepEqual(JSON.parse(me.text), { user: "anna", device_id: a.out.device_id });

  // 5. Токен обновляется без браузера (как при каждом открытии приложения), и новый токен принимается api.
  const t2 = await refresh(plain, inv, a.keys, a.tokens.refreshToken!, now());
  assert.equal((await apiCall(mtls, inv, a.keys, t2, "GET", "/v1/me")).status, 200, "обновлённый токен");

  // 6. Ключ API: шифруется для keyguard, подписывается ключом подтверждения, control-plane видит только шифротекст.
  const hpkePub = unb64(inv.hpke);
  const put = await buildKeyPut((b, n) => signClusterAction(a.keys, b, { nonce: n }), { hpkePub, deviceId: a.out.device_id!, provider: "sakana", apiKey: "sk-sakana-E2E-KEY-12345678" });
  const kr = await apiCall(mtls, inv, a.keys, t2, "POST", "/v1/keys", put);
  assert.equal(kr.status, 200, kr.text);
  assert.match(JSON.parse(kr.text).masked, /5678$/, "в ответе маска ключа");
  // тот же подписанный запрос второй раз не проходит (одноразовый nonce действия)
  assert.notEqual((await apiCall(mtls, inv, a.keys, t2, "POST", "/v1/keys", put)).status, 200, "повтор подписанного действия");

  // 7. Чужой сертификат + свой токен: api не пускает (сертификат, токен и DPoP должны быть про один ключ).
  const inv2 = await invite("bob");
  await setPassword("bob", "bob-pass");
  const b = await join(inv2, "bob", "Телефон Боба");
  assert.equal(b.status, 200, JSON.stringify(b.out));
  assert.equal(b.out.status, "pending", "устройство обычного пользователя ждёт подтверждения");
  const stB = await fetchStatus(plain, inv2, b.keys, now());
  assert.equal(stB.status, "pending");
  assert.equal(stB.cert_pem, undefined, "до подтверждения сертификата нет");
  const stolen = await apiCall(mtls, inv, b.keys, b.tokens, "GET", "/v1/me"); // соединение Анны, токен и подпись Боба
  assert.equal(stolen.status, 401, "токен Боба на соединении с сертификатом Анны");

  // 8. Приглашение выпущено на ник: чужим токеном по нему не зарегистрироваться.
  const inv3 = await invite("carol");
  await setPassword("carol", "carol-pass");
  const bobKeys = softKeys(), pk = newPkce();
  const bobTok = await exchangeCode(plain, inv2, bobKeys, parseRedirect(await browserLogin(browserStartUrl(inv3, pk), "bob", "bob-pass"), pk), pk, now());
  const wrong = await plain.request({ method: "POST", url: `${inv3.join}/v1/enroll`, headers: joinHeaders(inv3),
    body: JSON.stringify(await buildEnroll(inv3, bobKeys, bobTok, "чужой", now(), null)) });
  assert.equal(wrong.status, 403, "приглашение Кэрол, токен Боба");
  assert.match(wrong.text, /другого пользователя/);

  // 9. Повторная привязка: новое приглашение Анне, новые ключи. Прежнее устройство остаётся рабочим,
  //    новое ждёт подтверждения (активное устройство уже есть) — регистрация не «перезаписывается».
  const inv4 = await invite("anna");
  const a2 = await join(inv4, "anna", "Второй телефон Анны");
  assert.equal(a2.status, 200, JSON.stringify(a2.out));
  assert.equal(a2.out.status, "pending", "второе устройство администратора ждёт подтверждения");
  assert.notEqual(a2.out.device_id, a.out.device_id);
  assert.equal((await fetchStatus(plain, inv, a.keys, now())).status, "active", "первое устройство по-прежнему активно");
  assert.equal((await apiCall(mtls, inv, a.keys, t2, "GET", "/v1/me")).status, 200, "и по-прежнему входит на api");

  // 10. Без приглашения шаги регистрации закрыты.
  const noInv = await plain.request({ method: "POST", url: `${inv.join}/v1/enroll/challenge`, headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(noInv.status, 401, "вызов для аттестации без приглашения");
});
