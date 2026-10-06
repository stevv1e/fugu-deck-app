/**
 * Регистрация телефона на сервере. Пароль (и код) нужен один раз; дальше — только ключи устройства.
 * Оба ключа подписывают одно и то же заявление (в нём отпечаток сервера и вызов),
 * сервер отвечает квитанцией, подписанной ключом идентичности — проверяем её закреплённым ключом.
 */
import { b64u, unb64 } from "./bytes";
import { canonical } from "./canonical";
import { verifyServerSig } from "./crypto";
import { buildCsr } from "./csr";
import { errorFrom, type Http } from "./http";
import { formatFp } from "./invite";
import type { DeviceKeys } from "./keys";
import { getJson } from "./server";
import type { EnrolledDevice, EnrollResult, ServerRecord } from "./types";

export type EnrollInput = {
  http: Http;
  server: ServerRecord;
  /** Создаёт ключи; получает вызов сервера, чтобы вписать его в аттестацию. */
  makeKeys: (challenge: Uint8Array) => Promise<DeviceKeys>;
  username: string;
  password: string;
  totp?: string;
  deviceName: string;
  platform: string;
  /** Запросить сертификат устройства для mTLS. */
  withCert: boolean;
};

export type Enrolled = { device: EnrolledDevice; keys: DeviceKeys; accessToken: string; expiresIn: number; clockOffset: number };

export async function enroll(inp: EnrollInput): Promise<Enrolled> {
  const { http, server } = inp;
  const ch = await getJson<{ challenge: string; server_time: number }>(http, server.url + "/api/devices/challenge");
  const clockOffset = ch.server_time / 1000 - Date.now() / 1000;
  const keys = await inp.makeKeys(unb64(ch.challenge));
  const stmt = canonical({
    type: "enroll",
    challenge: ch.challenge,
    server: formatFp(server.fingerprint),
    session_jkt: keys.session.jkt,
    confirm_jkt: keys.confirm.jkt,
  });
  const sessionSig = await keys.session.sign(stmt);
  const confirmSig = await keys.confirm.sign(stmt, `Регистрация на «${server.name}»`);
  const body: Record<string, unknown> = {
    username: inp.username,
    password: inp.password,
    totp: inp.totp || null,
    name: inp.deviceName.slice(0, 80) || "Телефон",
    platform: inp.platform,
    session_jwk: keys.session.jwk,
    confirm_jwk: keys.confirm.jwk,
    key_storage: keys.storage,
    attestation: keys.attestation ?? null,
    challenge: ch.challenge,
    session_sig: b64u(sessionSig),
    confirm_sig: b64u(confirmSig),
  };
  if (inp.withCert) body.csr = await buildCsr(keys.session, "fugu-deck device");
  const r = await http.request({
    method: "POST",
    url: server.url + "/api/devices/enroll",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (r.status !== 200) throw errorFrom(r.status, r.text);
  const res = JSON.parse(r.text) as EnrollResult;
  const rc = res.receipt as Record<string, unknown>;
  if (
    !verifyServerSig(server.identityKey, rc, res.server_sig) ||
    rc.type !== "enrolled" ||
    rc.challenge !== ch.challenge ||
    rc.session_jkt !== keys.session.jkt ||
    rc.confirm_jkt !== keys.confirm.jkt ||
    rc.device_id !== res.device_id
  ) {
    throw new Error("Квитанция регистрации подписана не тем сервером — подключение прервано");
  }
  return {
    keys,
    clockOffset,
    accessToken: res.access_token,
    expiresIn: res.expires_in,
    device: {
      id: res.device_id,
      user: res.user,
      keyAlias: keys.alias,
      keyStorage: keys.storage,
      enrolledAt: Date.now(),
      certPem: res.cert_pem,
      caPem: res.ca_pem,
      certExpires: res.cert_pem ? Date.now() / 1000 + 30 * 86400 : null,
    },
  };
}
