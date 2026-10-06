/** DPoP (RFC 9449): к каждому запросу — свежее доказательство владения ключом сессии. */
import { b64u, randomId, utf8 } from "./bytes";
import { sha256b64u } from "./crypto";
import type { DeviceKey } from "./keys";

export type ProofInput = {
  key: DeviceKey;
  method: string;
  url: string;
  accessToken?: string;
  /** Секунды по часам сервера (с поправкой на расхождение). */
  now: number;
};

export async function dpopProof({ key, method, url, accessToken, now }: ProofInput): Promise<string> {
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: key.jwk };
  const htu = url.split("#")[0].split("?")[0];
  const payload: Record<string, unknown> = { jti: randomId(18), htm: method.toUpperCase(), htu, iat: Math.floor(now) };
  if (accessToken) payload.ath = sha256b64u(accessToken);
  const signingInput = b64u(utf8(JSON.stringify(header))) + "." + b64u(utf8(JSON.stringify(payload)));
  const sig = await key.sign(utf8(signingInput));
  return signingInput + "." + b64u(sig);
}
