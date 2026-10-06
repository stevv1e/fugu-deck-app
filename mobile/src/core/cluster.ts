/**
 * Вход в кластер v2 (architecture.md 3.3, infra docs/decisions.md D2/D3):
 *   1. QR-приглашение: fugudeck://join?api=…&iss=…&join=…&invite=…
 *   2. Системный браузер: join/start?invite=… ставит короткую cookie приглашения и ведёт в Keycloak (passkey);
 *      Keycloak возвращает в приложение fugudeck://oauth?code=…&state=… (PKCE S256 — перехваченный код бесполезен).
 *   3. Обмен кода на токены С DPoP (ключ сессии): токен доступа привязан к ключу в чипе (cnf.jkt).
 *      Если сервер вернул обычный Bearer — отказ: непривязанный токен можно украсть и использовать.
 *   4. Регистрация: токен + DPoP на этот запрос + действие device_enroll (JWS), подписанное ключом подтверждения (биометрия).
 *      keyguard проверяет все три и создаёт устройство «ожидает подтверждения» (подтверждает пригласивший или своё устройство).
 */
import { p256 } from "@noble/curves/nist.js";

import { b64u, randomBytes, randomId, unb64, utf8, fromUtf8 } from "./bytes";
import { canonical } from "./canonical";
import { sha256b64u } from "./crypto";
import { buildCsr } from "./csr";
import { dpopProof } from "./dpop";
import { errorFrom, type Http } from "./http";
import type { DeviceKeys } from "./keys";

export const REDIRECT_URI = "fugudeck://oauth";
export const CLIENT_ID = "deck-app";

/** hpke — публичный ключ HPKE keyguard (base64url, несжатая точка P-256): на него телефон шифрует ключи API.
 *  Едет в QR от доверенного человека вместе с адресами — отдельного неподписанного запроса за ключом нет. */
export type ClusterInvite = { api: string; issuer: string; join: string; invite: string; hpke: string };

const isLocal = (u: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);

function httpsUrl(raw: string | null, what: string): string {
  if (!raw) throw new Error(`В приглашении нет адреса ${what}`);
  const u = new URL(raw);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocal(u))) throw new Error(`${what}: нужен https`);
  if (u.username || u.password) throw new Error(`${what}: логин в адресе недопустим`);
  return u.toString().replace(/\/$/, "");
}

/** Разбор QR-приглашения кластера. Все адреса — https (кроме локальных для разработки). */
export function parseClusterInvite(link: string): ClusterInvite {
  const u = new URL(link);
  if (u.protocol !== "fugudeck:" || (u.hostname || u.pathname.replace(/^\/+/, "")) !== "join") throw new Error("Это не приглашение в кластер");
  const p = u.searchParams;
  const invite = p.get("invite") ?? "";
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(invite)) throw new Error("Повреждённый токен приглашения");
  const hpke = p.get("hpke") ?? "";
  try {
    const pt = unb64(hpke);
    if (pt.length !== 65 || pt[0] !== 4) throw new Error();
    p256.Point.fromBytes(pt).assertValidity();
  } catch {
    throw new Error("В приглашении нет корректного ключа keyguard");
  }
  const c = { api: httpsUrl(p.get("api"), "api"), issuer: httpsUrl(p.get("iss"), "Keycloak"), join: httpsUrl(p.get("join"), "join"), invite, hpke };
  // Все три адреса — одного кластера: общий родительский домен (защита от подставного Keycloak в QR).
  const parent = (h: string) => h.split(".").slice(1).join(".");
  const hosts = [c.api, c.issuer, c.join].map((x) => new URL(x).hostname);
  if (!hosts.every(isLocalHost) && new Set(hosts.map(parent)).size !== 1) throw new Error("Адреса приглашения из разных доменов");
  return c;
}
const isLocalHost = (h: string) => ["localhost", "127.0.0.1", "[::1]"].includes(h);

export type Pkce = { verifier: string; challenge: string; state: string };

export function newPkce(): Pkce {
  const verifier = b64u(randomBytes(32)); // 43 символа, RFC 7636
  return { verifier, challenge: sha256b64u(verifier), state: randomId(16) };
}

export function authorizeUrl(c: ClusterInvite, p: Pkce): string {
  const q = new URLSearchParams({
    client_id: CLIENT_ID, response_type: "code", redirect_uri: REDIRECT_URI, scope: "openid",
    code_challenge: p.challenge, code_challenge_method: "S256", state: p.state,
  });
  return `${c.issuer}/protocol/openid-connect/auth?${q}`;
}

/** Куда открыть системный браузер: join проверит приглашение, поставит cookie и уведёт в Keycloak. */
export function browserStartUrl(c: ClusterInvite, p: Pkce): string {
  return `${c.join}/start?${new URLSearchParams({ invite: c.invite, next: authorizeUrl(c, p) })}`;
}

/** Возврат из браузера: fugudeck://oauth?code=…&state=… Чужой state — отказ (CSRF/подмена ответа). */
export function parseRedirect(url: string, p: Pkce): string {
  const u = new URL(url);
  if (`${u.protocol}//${u.host}${u.pathname}`.replace(/\/$/, "") !== REDIRECT_URI) throw new Error("Чужой адрес возврата");
  const q = u.searchParams;
  if (q.get("error")) throw new Error(`Вход отклонён: ${q.get("error_description") ?? q.get("error")}`);
  if (q.get("state") !== p.state) throw new Error("Ответ входа не от этого запроса (state)");
  const code = q.get("code");
  if (!code) throw new Error("Нет кода входа");
  return code;
}

export type Tokens = { accessToken: string; refreshToken?: string; expiresIn: number; tokenType: string };

const tokenUrl = (c: ClusterInvite) => `${c.issuer}/protocol/openid-connect/token`;

async function tokenRequest(http: Http, c: ClusterInvite, keys: DeviceKeys, form: Record<string, string>, now: number): Promise<Tokens> {
  const url = tokenUrl(c);
  const proof = await dpopProof({ key: keys.session, method: "POST", url, now });
  const r = await http.request({
    method: "POST", url, body: new URLSearchParams(form).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded", DPoP: proof },
  });
  if (r.status !== 200) throw errorFrom(r.status, r.text);
  const j = JSON.parse(r.text);
  if (String(j.token_type).toLowerCase() !== "dpop") throw new Error("Сервер выдал непривязанный токен (не DPoP) — вход прерван");
  if (claims(j.access_token).cnf?.jkt !== keys.session.jkt) throw new Error("Токен привязан не к ключу этого устройства");
  return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresIn: j.expires_in, tokenType: j.token_type };
}

export function exchangeCode(http: Http, c: ClusterInvite, keys: DeviceKeys, code: string, p: Pkce, now: number) {
  return tokenRequest(http, c, keys, { grant_type: "authorization_code", client_id: CLIENT_ID, code, code_verifier: p.verifier, redirect_uri: REDIRECT_URI }, now);
}

export function refresh(http: Http, c: ClusterInvite, keys: DeviceKeys, refreshToken: string, now: number) {
  return tokenRequest(http, c, keys, { grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refreshToken }, now);
}

/** Полезная нагрузка JWT без проверки подписи — только чтобы сверить привязку; проверяет keyguard. */
export function claims(jwt: string): Record<string, any> {
  const p = jwt.split(".")[1];
  if (!p) throw new Error("Не JWT");
  return JSON.parse(fromUtf8(unb64(p)));
}

/** ID устройства в keyguard — как DeviceIDFor: d- + 16 символов отпечатка ключа подтверждения. */
export const clusterDeviceId = (keys: DeviceKeys) => "d-" + keys.confirm.jkt.slice(0, 16);

/** Подписанное действие для keyguard (actions.go): компактный JWS, ключ подтверждения, подпись r‖s. */
export type ClusterSigned = { jws: string };

export type ClusterEnrollRequest = {
  access_token: string; dpop: string; session_jwk: unknown; confirm_jwk: unknown; csr: string;
  enroll: ClusterSigned; key_storage: string; attestation?: unknown;
};

/**
 * JWS действия — тот же формат, что у модуля deck-security (fugu-deck-stage0, deck.ts signAction):
 *   заголовок {"alg":"ES256","typ":"deck-action+jws","kid":<device_id>}
 *   payload   канонический JSON: поля действия + device_id, nonce, ts (секунды)
 */
async function actionJws(keys: DeviceKeys, fields: Record<string, unknown>, reason: string, nonce: string, nowSec: number): Promise<ClusterSigned> {
  const deviceId = clusterDeviceId(keys);
  const header = b64u(canonical({ alg: "ES256", typ: "deck-action+jws", kid: deviceId }));
  const payload = b64u(canonical({ ...fields, device_id: deviceId, nonce, ts: Math.floor(nowSec) }));
  const sig = await keys.confirm.sign(utf8(`${header}.${payload}`), reason);
  return { jws: `${header}.${payload}.${b64u(sig)}` };
}

/** Тело join/v1/enroll: control-plane проверит приглашение и передаст в keyguard как есть. */
export async function buildEnroll(c: ClusterInvite, keys: DeviceKeys, tokens: Tokens, deviceName: string, now: number): Promise<ClusterEnrollRequest> {
  const enrollUrl = `${c.join}/v1/enroll`;
  const dpop = await dpopProof({ key: keys.session, method: "POST", url: enrollUrl, accessToken: tokens.accessToken, now });
  const enroll = await actionJws(
    keys,
    { type: "device_enroll", session_jkt: keys.session.jkt, confirm_jkt: keys.confirm.jkt, name: deviceName },
    `Зарегистрировать «${deviceName}» в кластере`, randomId(16), now,
  );
  // CSR подписан ключом сессии: keyguard сверит ключ с токеном и выпустит сертификат mTLS после подтверждения.
  const csr = await buildCsr(keys.session, clusterDeviceId(keys));
  return {
    access_token: tokens.accessToken, dpop, session_jwk: keys.session.jwk, confirm_jwk: keys.confirm.jwk, csr,
    enroll, key_storage: keys.storage, attestation: keys.attestation ?? undefined,
  };
}

export type DeviceStatus = { device_id: string; status: "pending" | "active" | "revoked"; cert_pem?: string };

/** Тело join/v1/enroll/status: доказательство владения ключом сессии ЭТОГО устройства (как DPoP). */
export async function statusRequest(c: ClusterInvite, keys: DeviceKeys, now: number) {
  const proof = await dpopProof({ key: keys.session, method: "POST", url: `${c.join}/v1/enroll/status`, now });
  return { device_id: clusterDeviceId(keys), proof };
}

/** Опрос статуса: pending → (подтвердил пригласивший) → active + сертификат для mTLS на api. */
export async function fetchStatus(http: Http, c: ClusterInvite, keys: DeviceKeys, now: number): Promise<DeviceStatus> {
  const r = await http.request({ method: "POST", url: `${c.join}/v1/enroll/status`, headers: { "Content-Type": "application/json" },
    body: JSON.stringify(await statusRequest(c, keys, now)) });
  if (r.status !== 200) throw errorFrom(r.status, r.text);
  return JSON.parse(r.text) as DeviceStatus;
}

/** Подписанное действие от устройства кластера (key_put, grant, device_approve, …) — JWS для keyguard. */
export function signClusterAction(keys: DeviceKeys, fields: Record<string, unknown>, reason: string, nonce = randomId(16), nowMs = Date.now()) {
  return actionJws(keys, fields, reason, nonce, nowMs / 1000);
}

export const _test = { utf8 };
