/**
 * Перекрёстная проверка с keyguard (Go): подписи действий и канонический JSON.
 * Нужен собранный cmd/kgcheck: KGCHECK=/путь/kgcheck (иначе тест пропускается).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { b64u, fromUtf8, randomId, unb64 } from "../src/core/bytes";
import { canonical, canonicalString } from "../src/core/canonical";
import { clusterDeviceId, signClusterAction } from "../src/core/cluster";
import { jwkFromPoint, softKeygen, softSign } from "../src/core/crypto";
import { makeKey, type DeviceKeys } from "../src/core/keys";

const KG = process.env.KGCHECK;
const skip = KG ? false : "нет KGCHECK (cmd/kgcheck из fugu-deck-keyguard)";

function kg(lines: unknown[]): string[] {
  const r = spawnSync(KG!, { input: lines.map((l) => JSON.stringify(l)).join("\n") + "\n", encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trimEnd().split("\n");
}

const WEIRD: unknown[] = [
  "<script>&amp;</script>", "\u2028\u2029", "строка с «ёлками»", "😀 emoji 𝄞", "\u0000\u0001\u001f\b\f\n\r\t",
  'кавычки " и \\ обратная', { "𝄞": 1, "z": 2, "é": 3, "a": 4, "A": 5, "\u00ff": 6, "\uffff": 7 },
  [1, -1, 0, 9007199254740991, -9007199254740991, true, false, null, [], {}], { nested: { b: [{ y: 1, x: 2 }] } },
];

test("канонический JSON совпадает с keyguard байт в байт", { skip }, () => {
  const got = kg(WEIRD.map((value) => ({ op: "canon", value })));
  WEIRD.forEach((v, i) => assert.equal(got[i], canonicalString(v), `значение #${i}`));
});

/** Программные ключи устройства для тестов: подпись r‖s, как отдаёт чип. */
function softKeys(): DeviceKeys {
  const s = softKeygen(), c = softKeygen();
  return {
    alias: "t", storage: "software", attestation: null,
    session: makeKey(jwkFromPoint(s.point), async (d) => softSign(s.secret, d)),
    confirm: makeKey(jwkFromPoint(c.point), async (d) => softSign(c.secret, d)),
  };
}

test("подпись действия приложения (JWS) принимает keyguard; подмены отвергает", { skip }, async () => {
  const keys = softKeys(), other = softKeys();
  const device_id = clusterDeviceId(keys), jwk = keys.confirm.jwk;
  const now = Date.now();
  const fields = { type: "key_put", provider: "sakana", key_hint: "abcd", ct_sha256: "ab".repeat(32) };
  const ok = await signClusterAction(keys, { ...fields, note: "<&>\u2028😀" }, "", randomId(16), now);
  const [h, p, sg] = ok.jws.split(".");
  const payload = JSON.parse(fromUtf8(unb64(p)));
  const tampered = { jws: `${h}.${b64u(canonical({ ...payload, provider: "anthropic" }))}.${sg}` };
  // чужой ключ подписал действие от имени этого устройства (kid и device_id — жертвы)
  const foreign = { jws: `${h}.${p}.${b64u(await other.confirm.sign(utf8(`${h}.${p}`)))}` };
  // подпись ключом СЕССИИ вместо ключа подтверждения (без биометрии)
  const bySession = { jws: `${h}.${p}.${b64u(await keys.session.sign(utf8(`${h}.${p}`)))}` };
  const old = await signClusterAction(keys, fields, "", randomId(16), now);
  const res = kg([
    { op: "verify", jwk, device_id, signed: ok, now_ms: now, type: "key_put" },
    { op: "verify", jwk, device_id, signed: tampered, now_ms: now, type: "key_put" },
    { op: "verify", jwk, device_id, signed: foreign, now_ms: now, type: "key_put" },
    { op: "verify", jwk, device_id, signed: bySession, now_ms: now, type: "key_put" },
    { op: "verify", jwk, device_id, signed: old, now_ms: now + 6 * 60_000, type: "key_put" },
    { op: "verify", jwk, device_id, signed: old, now_ms: now, type: "grant" },
    { op: "verify", jwk, device_id, signed: { action: payload, sig: sg }, now_ms: now, type: "key_put" },
  ]);
  assert.equal(res[0], "ok", "JWS приложения (r‖s, секунды) принят");
  assert.match(res[1], /подпись неверна/, "подмена поля после подписи");
  assert.match(res[2], /подпись неверна/, "чужой ключ");
  assert.match(res[3], /подпись неверна/, "ключ сессии вместо ключа подтверждения");
  assert.match(res[4], /устарело/, "старше 5 минут");
  assert.match(res[5], /неверное действие/, "другой тип действия");
  assert.match(res[6], /неверное действие/, "прежний формат {action, sig} больше не принимается");
});

// ---------------- HPKE и ввод ключа ----------------
import { readFileSync } from "node:fs";
import { p256 } from "@noble/curves/nist.js";
import { buildKeyPut } from "../src/core/apikeys";
import { b64, utf8 } from "../src/core/bytes";
import { HPKE_INFO, hpkeOpen, hpkeSeal, keySchedule } from "../src/core/hpke";

const hx = (s: string) => Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

test("HPKE приложения совпадает с официальными векторами RFC 9180", () => {
  const vs = JSON.parse(readFileSync(new URL("./fixtures/hpke-p256-base.json", import.meta.url), "utf8"));
  for (const v of vs) {
    const ks = keySchedule(hx(v.shared_secret), hx(v.info));
    assert.equal(toHex(ks.key), v.key);
    assert.equal(toHex(ks.baseNonce), v.base_nonce);
    const e0 = v.encryptions[0];
    const { enc, ct } = hpkeSeal(hx(v.pkRm), hx(v.info), hx(e0.aad), hx(e0.pt), hx(v.skEm));
    assert.equal(toHex(enc), v.enc, "enc");
    assert.equal(toHex(ct), e0.ct, "шифротекст");
    assert.equal(toHex(hpkeOpen(hx(v.skRm), hx(v.enc), hx(v.info), hx(e0.aad), hx(e0.ct))), e0.pt);
  }
});

test("HPKE: точка не на кривой отвергается", () => {
  const bad = new Uint8Array(65); bad[0] = 4; bad[64] = 1;
  assert.throws(() => hpkeSeal(bad, utf8("i"), utf8("a"), utf8("x")));
});

test("телефон шифрует — keyguard расшифровывает; key_put из кода приложения принимает настоящий обработчик", { skip }, async () => {
  const sk = p256.utils.randomSecretKey();
  const pub = p256.getPublicKey(sk, false);
  const { enc, ct } = hpkeSeal(pub, utf8(HPKE_INFO), utf8("aad-1"), utf8("sk-ant-секрет"));
  assert.equal(kg([{ op: "hpke-open", sk_hex: toHex(sk), enc: b64(enc), ct: b64(ct), aad: "aad-1" }])[0], "sk-ant-секрет");
  assert.match(kg([{ op: "hpke-open", sk_hex: toHex(sk), enc: b64(enc), ct: b64(ct), aad: "aad-2" }])[0], /ERR/, "чужой AAD");

  const keys = softKeys(), device_id = clusterDeviceId(keys), jwk = keys.confirm.jwk;
  const now = Date.now();
  // подпись — ровно как на экране кластера: signClusterAction (JWS, секунды, r‖s)
  const sign = (fields: Record<string, unknown>, r: string, nonce: string) => signClusterAction(keys, fields, r, nonce, now);
  const put = (req: unknown) => kg([{ op: "keyput", sk_hex: toHex(sk), jwk, device_id, req, now_ms: now }]);
  const req = await buildKeyPut(sign, { hpkePub: pub, deviceId: device_id, provider: "anthropic", apiKey: "  sk-ant-api03-REAL-KEY  " });
  const [first, replay] = put(req);
  assert.match(first, /^200\|anthropic=sk-ant-api03-REAL-KEY\|.*…/, "ключ сохранён, в ответе только маска");
  assert.doesNotMatch(first.split("|")[2], /REAL-KEY/, "ключа нет в ответе");
  assert.match(replay, /^403\|.*nonce/, "повтор того же запроса");

  const swapped = { ...req, ct: (await buildKeyPut(sign, { hpkePub: pub, deviceId: device_id, provider: "anthropic", apiKey: "sk-ant-EVIL-0000" })).ct };
  assert.match(put(swapped)[0], /^403\|\|.*шифротекст/, "посредник подменил шифротекст");
  // шифротекст, собранный для ДРУГОГО устройства (AAD), в слот этого устройства не встаёт
  const foreignCt = await buildKeyPut(sign, { hpkePub: pub, deviceId: "d-0000000000000000", provider: "anthropic", apiKey: "sk-ant-x-12345678" });
  assert.match(put(foreignCt)[0], /^403\|\|.*расшифровать/, "шифротекст для чужого устройства");
  const gh = await buildKeyPut(sign, { hpkePub: pub, deviceId: device_id, provider: "github", apiKey: "ghp_REALTOKEN0123" });
  assert.match(put(gh)[0], /^200\|github=ghp_REALTOKEN0123/, "токен GitHub");
  await assert.rejects(buildKeyPut(sign, { hpkePub: pub, deviceId: device_id, provider: "anthropic", apiKey: "sk-ant\r\nX-Evil: 1" }), /пробелов/);
});
