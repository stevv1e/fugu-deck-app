/** Passkey (WebAuthn) + расширение PRF: из passkey получаем секрет для шифрования ключей на устройстве.
 *  PRF-результат НИКОГДА не отправляется на сервер. */

export const b64u = {
  enc(buf: ArrayBuffer | Uint8Array): string {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = "";
    b.forEach((x) => (s += String.fromCharCode(x)));
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(s: string): Uint8Array {
    const p = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
    return Uint8Array.from(atob(p), (c) => c.charCodeAt(0));
  },
};

let saltCache: Uint8Array | null = null;
export async function prfSalt(): Promise<Uint8Array> {
  if (!saltCache) {
    saltCache = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("fugu-deck-vault-v1")));
  }
  return saltCache;
}

export function webauthnSupported() {
  return typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials;
}

function publicCredentialToJSON(cred: PublicKeyCredential) {
  const r: any = cred.response;
  const response: any = { clientDataJSON: b64u.enc(r.clientDataJSON) };
  if (r.attestationObject) {
    response.attestationObject = b64u.enc(r.attestationObject);
    response.transports = r.getTransports ? r.getTransports() : [];
  }
  if (r.authenticatorData) response.authenticatorData = b64u.enc(r.authenticatorData);
  if (r.signature) response.signature = b64u.enc(r.signature);
  if (r.userHandle) response.userHandle = b64u.enc(r.userHandle);
  // clientExtensionResults (в т.ч. PRF) на сервер не отправляем
  return { id: cred.id, rawId: b64u.enc(cred.rawId), type: cred.type, response, clientExtensionResults: {} };
}

export type PasskeyResult = { credential: any; prf: Uint8Array | null; prfEnabled: boolean };

export async function createPasskey(options: any): Promise<PasskeyResult> {
  const salt = await prfSalt();
  const pk: PublicKeyCredentialCreationOptions = {
    ...options,
    challenge: b64u.dec(options.challenge),
    user: { ...options.user, id: b64u.dec(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map((c: any) => ({ ...c, id: b64u.dec(c.id) })),
    extensions: { ...(options.extensions || {}), prf: { eval: { first: salt } } } as any,
  };
  const cred = (await navigator.credentials.create({ publicKey: pk })) as PublicKeyCredential;
  const ext: any = cred.getClientExtensionResults();
  const first = ext?.prf?.results?.first;
  return {
    credential: publicCredentialToJSON(cred),
    prf: first ? new Uint8Array(first) : null,
    prfEnabled: !!ext?.prf?.enabled || !!first,
  };
}

export async function getPasskey(options: any): Promise<PasskeyResult> {
  const salt = await prfSalt();
  const pk: PublicKeyCredentialRequestOptions = {
    ...options,
    challenge: b64u.dec(options.challenge),
    allowCredentials: (options.allowCredentials || []).map((c: any) => ({ ...c, id: b64u.dec(c.id) })),
    extensions: { prf: { eval: { first: salt } } } as any,
  };
  const cred = (await navigator.credentials.get({ publicKey: pk })) as PublicKeyCredential;
  const ext: any = cred.getClientExtensionResults();
  const first = ext?.prf?.results?.first;
  return { credential: publicCredentialToJSON(cred), prf: first ? new Uint8Array(first) : null, prfEnabled: !!first };
}
