/**
 * Сквозная проверка ядра приложения против настоящего сервера (backend + mock LLM/GitHub).
 *   API=http://127.0.0.1:8000 npm run itest
 * Сервер должен быть запущен с APP_PASSWORD=test-pass и MTLS_MODE=optional (см. mobile/README.md).
 */
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";

import { DeckApi } from "../src/core/api";
import { enroll } from "../src/core/enroll";
import { ApiError, fetchHttp, type Http } from "../src/core/http";
import { parseInvite } from "../src/core/invite";
import { DeviceSession } from "../src/core/session";
import { checkExpected, checkPinned, fetchServerInfo, TrustError } from "../src/core/server";
import { memoryStore, softwareProvider } from "../src/core/softkeys";
import type { RunEvent, ServerRecord } from "../src/core/types";

const API = process.env.API || "http://127.0.0.1:8000";
const http = fetchHttp();
const prov = softwareProvider({ store: memoryStore(), gate: async () => {}, storeAuth: false, biometry: false });
let step = 0;
const ok = (msg: string) => console.log(`  ✓ ${++step}. ${msg}`);

async function addServer(): Promise<ServerRecord> {
  const inv = parseInvite(API);
  const info = await fetchServerInfo(http, inv.url);
  return {
    id: "srv1", url: inv.url, name: info.name, identityKey: info.identity.key,
    fingerprint: info.identity.fingerprint.replace(/ /g, ""), verifiedBy: "manual", addedAt: Date.now(), mtls: info.devices.mtls,
  };
}

async function enrolled(rec: ServerRecord, alias: string, name: string, withCert = false) {
  const r = await enroll({
    http, server: rec, makeKeys: () => prov.create(alias), username: "", password: "test-pass",
    deviceName: name, platform: "node-test", withCert,
  });
  const server: ServerRecord = { ...rec, device: r.device };
  const revoked: string[] = [];
  const s = new DeviceSession(http, server, r.keys, { onRevoked: (m) => revoked.push(m) });
  s.seed(r.accessToken, r.expiresIn, r.clockOffset);
  return { s, api: new DeckApi(s), device: r.device, revoked, keys: r.keys, server };
}

function runUntilDone(api: DeckApi, rid: string, onEvent: (e: RunEvent) => void | Promise<void>): Promise<RunEvent[]> {
  return new Promise((resolve, reject) => {
    const evs: RunEvent[] = [];
    const t = setTimeout(() => reject(new Error("запуск не завершился за 60 с")), 60000);
    api.followRun(rid, (e) => {
      evs.push(e);
      Promise.resolve(onEvent(e)).catch(reject);
    }, {
      onEnd: (err) => {
        clearTimeout(t);
        err ? reject(err) : resolve(evs);
      },
    });
  });
}

async function main() {
  console.log(`Fugu Deck: проверка приложения против ${API}`);
  const rec = await addServer();
  ok(`сервер «${rec.name}», отпечаток ${rec.fingerprint.slice(0, 8)}…, mTLS: ${rec.mtls}`);

  // QR с чужим отпечатком — отказ; закреплённый ключ изменился — отказ
  const info = await fetchServerInfo(http, rec.url);
  assert.throws(() => checkExpected(info, "A".repeat(52)), (e: any) => e instanceof TrustError && e.kind === "mismatch");
  checkExpected(info, rec.fingerprint);
  assert.throws(() => checkPinned(info, { ...rec, identityKey: "AAAA" }), (e: any) => e.kind === "changed");
  ok("подмена отпечатка в QR и смена ключа сервера распознаются");

  // неверный пароль
  await assert.rejects(
    enroll({ http, server: rec, makeKeys: () => prov.create("bad"), username: "", password: "nope", deviceName: "x", platform: "t", withCert: false }),
    (e: any) => e instanceof ApiError && e.status === 401,
  );
  await prov.remove("bad");
  ok("неверный пароль при регистрации — 401");

  const a = await enrolled(rec, "fd.a", "Телефон A", true);
  assert.ok(a.device.certPem && a.device.caPem, "сертификат устройства выдан");
  const cert = new X509Certificate(a.device.certPem!);
  assert.ok(cert.verify(new X509Certificate(a.device.caPem!).publicKey), "сертификат подписан CA сервера");
  ok(`устройство A зарегистрировано (${a.device.id}), квитанция проверена ключом сервера, mTLS-сертификат до ${cert.validTo}`);

  const cfg = await a.api.config();
  assert.equal(cfg.me.username, a.device.user.username);
  ok(`запросы по DPoP: вошли как ${cfg.me.display_name}`);

  // mTLS через прокси: сервер сверяет серийный номер сертификата
  if (rec.mtls !== "off") {
    const url = rec.url + "/api/config";
    const good = { ...(await a.s.authHeaders("GET", url)), "x-client-cert-serial": cert.serialNumber.toLowerCase() };
    assert.equal((await http.request({ method: "GET", url, headers: good })).status, 200);
    const bad = { ...(await a.s.authHeaders("GET", url)), "x-client-cert-serial": "deadbeef" };
    assert.equal((await http.request({ method: "GET", url, headers: bad })).status, 401);
    ok("чужой сертификат при mTLS отвергается, свой — принимается");
  }

  // повтор доказательства
  const url = rec.url + "/api/config";
  const h = await a.s.authHeaders("GET", url);
  assert.equal((await http.request({ method: "GET", url, headers: h })).status, 200);
  assert.equal((await http.request({ method: "GET", url, headers: h })).status, 401);
  ok("повтор перехваченного запроса отвергается (DPoP jti)");

  // новый токен без пароля и новая сессия с синхронизацией часов
  await a.s.accessToken(true);
  const fresh = new DeviceSession(http, a.server, a.keys);
  assert.ok((await new DeckApi(fresh).projects()).length > 0);
  ok("токен обновляется подписью ключа сессии, пароль не нужен");

  // чат с подтверждениями
  const conv = await a.api.createConversation("general");
  const { run_id } = await a.api.send(conv.id, "Создай hello.py в demo");
  let unsignedRejected = false;
  let approvals = 0;
  const evs = await runUntilDone(a.api, run_id, async (e) => {
    if (e.type !== "approval_request") return;
    if (!unsignedRejected) {
      await assert.rejects(a.s.request("POST", `/api/approvals/${e.approval_id}`, { approve: true }), (x: any) => x.status === 403);
      const tampered = { ...e, args: { ...e.args, repo: "evil/repo" } };
      await assert.rejects(a.api.approve(tampered, true), (x: any) => x.status === 403 && /args_sha256/.test(x.message));
      unsignedRejected = true;
    }
    await a.api.approve(e, true);
    approvals++;
  });
  const types = evs.map((e) => e.type);
  assert.ok(types.includes("done"), types.join(","));
  assert.ok(evs.some((e) => e.type === "tool_end" && e.name === "commit_files" && e.ok));
  ok(`агент выполнил коммит; ${approvals} подтверждения подписаны ключом подтверждения; без подписи и с подменой аргументов — 403`);

  // переподключение: поток с начала после завершения отдаёт все события и закрывается
  const replay = await runUntilDone(a.api, run_id, () => {});
  assert.equal(replay.length, evs.length);
  ok(`повторное чтение потока: ${replay.length} событий`);

  const full = await a.api.conversation(conv.id);
  assert.ok(full.messages.some((m) => m.role === "tool"));
  ok(`история чата: ${full.messages.length} сообщений`);

  // второе устройство, отзыв с подписью
  const b = await enrolled(rec, "fd.b", "Телефон B");
  const list = await a.api.devices();
  assert.ok(list.find((d) => d.id === a.device.id)?.current);
  assert.ok(list.find((d) => d.id === b.device.id));
  await assert.rejects(a.s.request("POST", `/api/devices/${b.device.id}/revoke`, {}), (x: any) => x.status === 403);
  await a.api.revokeDevice(b.device.id, "Телефон B");
  await assert.rejects(b.api.projects(), (x: any) => x.status === 401);
  assert.ok(b.revoked.length > 0, "приложение узнало, что устройство отозвано");
  ok("устройство B отозвано с A (подпись ключом подтверждения), B сразу теряет доступ");

  const inv = await a.api.invite();
  const parsed = parseInvite(inv.link);
  assert.equal(parsed.fp, rec.fingerprint);
  ok(`приглашение владельца: ${inv.link.slice(0, 60)}…`);

  console.log(`\nВсё прошло: ${step} проверок.`);
}

main().catch((e) => {
  console.error("\n✗ ОШИБКА:", e?.message || e, e?.body ?? "");
  process.exit(1);
});

export type { Http };
