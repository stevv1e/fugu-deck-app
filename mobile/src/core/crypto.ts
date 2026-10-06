/** Криптопримитивы на @noble: P-256 (ES256), Ed25519 (идентичность сервера), SHA-256. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";

import { base32, b64u, unb64, utf8 } from "./bytes";
import { canonical } from "./canonical";

export type Jwk = { kty: "EC"; crv: "P-256"; x: string; y: string };

export function sha256(data: Uint8Array | string): Uint8Array {
  return nobleSha256(typeof data === "string" ? utf8(data) : data);
}

export const sha256b64u = (data: Uint8Array | string) => b64u(sha256(data));

/** Хэш аргументов инструмента — его подписывает телефон при подтверждении. */
export const argsHash = (args: unknown) => sha256b64u(canonical(args));

/** Несжатая точка 0x04‖X‖Y → JWK. */
export function jwkFromPoint(point: Uint8Array): Jwk {
  if (point.length !== 65 || point[0] !== 4) throw new Error("Ожидается несжатая точка P-256 (65 байт)");
  return { kty: "EC", crv: "P-256", x: b64u(point.slice(1, 33)), y: b64u(point.slice(33)) };
}

export function pointFromJwk(j: Jwk): Uint8Array {
  const x = unb64(j.x);
  const y = unb64(j.y);
  const out = new Uint8Array(65);
  out[0] = 4;
  out.set(x, 1 + 32 - x.length);
  out.set(y, 33 + 32 - y.length);
  return out;
}

/** RFC 7638: отпечаток ключа (jkt), по нему сервер связывает токен с ключом. */
export function jwkThumbprint(j: Jwk): string {
  return sha256b64u(canonical({ crv: j.crv, kty: "EC", x: j.x, y: j.y }));
}

/** ECDSA DER → r‖s (64 байта): Secure Enclave и Android Keystore отдают DER, JWS и сервер ждут r‖s. */
export function derToRaw(der: Uint8Array): Uint8Array {
  return p256.Signature.fromBytes(der, "der").toBytes("compact");
}

export function rawToDer(raw: Uint8Array): Uint8Array {
  return p256.Signature.fromBytes(raw, "compact").toBytes("der");
}

export function verifyEs256(j: Jwk, data: Uint8Array, rawSig: Uint8Array): boolean {
  try {
    return p256.verify(rawSig, data, pointFromJwk(j), { lowS: false });
  } catch {
    return false;
  }
}

/** Программный ключ P-256 (резерв, когда нет аппаратного хранилища). */
export function softKeygen(): { secret: Uint8Array; point: Uint8Array } {
  const { secretKey, publicKey } = p256.keygen();
  return { secret: secretKey, point: p256.getPublicKey(secretKey, false) ?? publicKey };
}

export function softPoint(secret: Uint8Array): Uint8Array {
  return p256.getPublicKey(secret, false);
}

export function softSign(secret: Uint8Array, data: Uint8Array): Uint8Array {
  return p256.sign(data, secret); // prehash SHA-256, формат r‖s
}

// ------------------------------------------------------------------ идентичность сервера
export function fingerprintOf(identityKeyB64u: string): string {
  const s = base32(sha256(unb64(identityKeyB64u)));
  return s.match(/.{1,4}/g)!.join(" ");
}

/** Отпечаток без пробелов и в верхнем регистре — так сравниваем то, что ввёл или отсканировал человек. */
export const normFp = (fp: string) => fp.replace(/[\s-]/g, "").toUpperCase();

export function verifyServerSig(identityKeyB64u: string, obj: unknown, sigB64u: string): boolean {
  try {
    return ed25519.verify(unb64(sigB64u), canonical(obj), unb64(identityKeyB64u));
  } catch {
    return false;
  }
}
