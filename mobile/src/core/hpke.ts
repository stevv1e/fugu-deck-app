/**
 * HPKE, RFC 9180: mode_base, DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-128-GCM — тот же набор, что в keyguard.
 * Телефон шифрует ключ API на публичный ключ keyguard; посредники (Traefik, control-plane) видят только шифротекст.
 * Проверено официальными векторами RFC 9180 и перекрёстно с keyguard (tests/keyguard.cross.test.ts).
 */
import { gcm } from "@noble/ciphers/aes.js";
import { p256 } from "@noble/curves/nist.js";
import { extract as hkdfExtract, expand as hkdfExpand } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { concat, randomBytes, utf8 } from "./bytes";

const i2osp = (v: number, n: number) => {
  const b = new Uint8Array(n);
  for (let i = n - 1; i >= 0; i--, v >>>= 8) b[i] = v & 0xff;
  return b;
};
const KEM = concat(utf8("KEM"), i2osp(0x0010, 2));
const SUITE = concat(utf8("HPKE"), i2osp(0x0010, 2), i2osp(0x0001, 2), i2osp(0x0001, 2));
const V1 = utf8("HPKE-v1");

const labeledExtract = (suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array) =>
  hkdfExtract(sha256, concat(V1, suite, utf8(label), ikm), salt.length ? salt : new Uint8Array(32));
const labeledExpand = (suite: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, l: number) =>
  hkdfExpand(sha256, prk, concat(i2osp(l, 2), V1, suite, utf8(label), info), l);

const dh = (sk: Uint8Array, pk: Uint8Array) => p256.getSharedSecret(sk, pk, true).slice(1); // x-координата

function sharedSecret(dhOut: Uint8Array, enc: Uint8Array, pkR: Uint8Array): Uint8Array {
  const prk = labeledExtract(KEM, new Uint8Array(), "eae_prk", dhOut);
  return labeledExpand(KEM, prk, "shared_secret", concat(enc, pkR), 32);
}

export function keySchedule(ss: Uint8Array, info: Uint8Array): { key: Uint8Array; baseNonce: Uint8Array } {
  const empty = new Uint8Array();
  const ctx = concat(new Uint8Array([0]), labeledExtract(SUITE, empty, "psk_id_hash", empty), labeledExtract(SUITE, empty, "info_hash", info));
  const secret = labeledExtract(SUITE, ss, "secret", empty);
  return { key: labeledExpand(SUITE, secret, "key", ctx, 16), baseNonce: labeledExpand(SUITE, secret, "base_nonce", ctx, 12) };
}

/** Шифрование одним сообщением. pkR — несжатая точка P-256 (65 байт). skE — только для тест-векторов. */
export function hpkeSeal(pkR: Uint8Array, info: Uint8Array, aad: Uint8Array, pt: Uint8Array, skE?: Uint8Array) {
  if (pkR.length !== 65 || pkR[0] !== 4) throw new Error("HPKE: ожидалась несжатая точка P-256");
  p256.Point.fromBytes(pkR).assertValidity(); // точка на кривой — иначе отказ, а не утечка
  const sk = skE ?? p256.utils.randomSecretKey(randomBytes(48));
  const enc = p256.getPublicKey(sk, false);
  const { key, baseNonce } = keySchedule(sharedSecret(dh(sk, pkR), enc, pkR), info);
  return { enc, ct: gcm(key, baseNonce, aad).encrypt(pt) };
}

/** Только для тестов (на телефоне расшифровывать нечего). */
export function hpkeOpen(skR: Uint8Array, enc: Uint8Array, info: Uint8Array, aad: Uint8Array, ct: Uint8Array): Uint8Array {
  const pkR = p256.getPublicKey(skR, false);
  const { key, baseNonce } = keySchedule(sharedSecret(dh(skR, enc), enc, pkR), info);
  return gcm(key, baseNonce, aad).decrypt(ct);
}

export const HPKE_INFO = "fugu-deck key-intake v1";
