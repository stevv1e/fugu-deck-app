/**
 * Хранилище ключей на устройстве.
 * Ключи API (Claude, Sakana, GitHub…) шифруются AES-GCM. Ключ шифрования:
 *   - «prf»: выводится из passkey (WebAuthn PRF) — разблокировка по Face ID/отпечатку;
 *   - «pin»: из PIN-кода через PBKDF2 (600 000 итераций) — для устройств без PRF.
 * На диске телефона лежит только шифротекст; расшифрованные ключи — только в памяти вкладки.
 */
import { b64u } from "./webauthn";

export type Keys = Partial<Record<"anthropic" | "sakana" | "openai" | "xai" | "github" | "gitlab" | "gitlab_url", string>>;
type Stored = { v: 1; method: "prf" | "pin"; salt: string; iv: string; ct: string; updated: number };

const K = "fd:vault";
let kek: CryptoKey | null = null;
let keys: Keys | null = null;
const listeners = new Set<() => void>();

function load(): Stored | null {
  try {
    const s = localStorage.getItem(K);
    return s ? (JSON.parse(s) as Stored) : null;
  } catch {
    return null;
  }
}

async function kekFromPrf(prf: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", prf, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("fugu-deck-vault") },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function kekFromPin(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 600_000 },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function decrypt(k: CryptoKey, st: Stored): Promise<Keys> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64u.dec(st.iv) }, k, b64u.dec(st.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

export const vault = {
  exists: () => !!load(),
  method: () => load()?.method ?? null,
  unlocked: () => keys !== null,
  keys: (): Keys => ({ ...(keys || {}) }),
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  async unlockWithPrf(prf: Uint8Array): Promise<boolean> {
    const st = load();
    if (!st || st.method !== "prf") return false;
    try {
      const k = await kekFromPrf(prf, b64u.dec(st.salt));
      keys = await decrypt(k, st);
      kek = k;
      listeners.forEach((f) => f());
      return true;
    } catch {
      return false;
    }
  },

  async unlockWithPin(pin: string): Promise<boolean> {
    const st = load();
    if (!st || st.method !== "pin") return false;
    try {
      const k = await kekFromPin(pin, b64u.dec(st.salt));
      keys = await decrypt(k, st);
      kek = k;
      listeners.forEach((f) => f());
      return true;
    } catch {
      return false;
    }
  },

  /** Первое сохранение: задать способ защиты. */
  async create(method: "prf" | "pin", secret: Uint8Array | string, initial: Keys) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    kek = method === "prf" ? await kekFromPrf(secret as Uint8Array, salt) : await kekFromPin(secret as string, salt);
    await this._write(method, salt, initial);
  },

  async save(next: Keys) {
    const st = load();
    if (!st || !kek) throw new Error("Хранилище заблокировано");
    await this._write(st.method, b64u.dec(st.salt), next);
  },

  async _write(method: "prf" | "pin", salt: Uint8Array, data: Keys) {
    const clean: Keys = {};
    for (const [k, v] of Object.entries(data)) if (v && v.trim()) (clean as any)[k] = v.trim();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, kek!, new TextEncoder().encode(JSON.stringify(clean)));
    const st: Stored = { v: 1, method, salt: b64u.enc(salt), iv: b64u.enc(iv), ct: b64u.enc(ct), updated: Date.now() };
    localStorage.setItem(K, JSON.stringify(st));
    keys = clean;
    listeners.forEach((f) => f());
  },

  lock() {
    kek = null;
    keys = null;
    listeners.forEach((f) => f());
  },

  wipe() {
    this.lock();
    try { localStorage.removeItem(K); } catch {}
  },
};
