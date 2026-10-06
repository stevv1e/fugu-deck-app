/**
 * PKCS#10 CSR для сертификата устройства (mTLS). Ключ — ключ сессии, подпись — тем же ключом
 * (закрытый ключ не покидает чип). Сервер проверяет, что ключ в CSR совпадает с ключом сессии.
 */
import { b64, concat, utf8 } from "./bytes";
import { pointFromJwk, rawToDer } from "./crypto";
import type { DeviceKey } from "./keys";

function len(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

const tlv = (tag: number, ...body: Uint8Array[]) => {
  const b = concat(...body);
  return concat(Uint8Array.of(tag), len(b.length), b);
};
const seq = (...b: Uint8Array[]) => tlv(0x30, ...b);
const set = (...b: Uint8Array[]) => tlv(0x31, ...b);

function oid(dotted: string): Uint8Array {
  const p = dotted.split(".").map(Number);
  const out = [40 * p[0] + p[1]];
  for (const v of p.slice(2)) {
    const chunk: number[] = [v & 0x7f];
    let x = v >> 7;
    while (x > 0) {
      chunk.unshift(0x80 | (x & 0x7f));
      x >>= 7;
    }
    out.push(...chunk);
  }
  return tlv(0x06, Uint8Array.from(out));
}

const OID_CN = "2.5.4.3";
const OID_EC_PUBLIC_KEY = "1.2.840.10045.2.1";
const OID_P256 = "1.2.840.10045.3.1.7";
const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2";

export async function buildCsr(key: DeviceKey, commonName: string): Promise<string> {
  const subject = seq(set(seq(oid(OID_CN), tlv(0x0c, utf8(commonName)))));
  const spki = seq(seq(oid(OID_EC_PUBLIC_KEY), oid(OID_P256)), tlv(0x03, Uint8Array.of(0), pointFromJwk(key.jwk)));
  const info = seq(tlv(0x02, Uint8Array.of(0)), subject, spki, Uint8Array.of(0xa0, 0x00));
  const sig = rawToDer(await key.sign(info));
  const der = seq(info, seq(oid(OID_ECDSA_SHA256)), tlv(0x03, Uint8Array.of(0), sig));
  const body = b64(der).match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN CERTIFICATE REQUEST-----\n${body}\n-----END CERTIFICATE REQUEST-----\n`;
}
