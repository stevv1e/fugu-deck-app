/**
 * Программные ключи — резерв, когда нет аппаратного модуля (Expo Go, веб, старые телефоны).
 * Секреты лежат в защищённом хранилище ОС (Keychain / Keystore-шифрование через expo-secure-store),
 * секрет ключа подтверждения — с обязательной биометрией на каждое чтение, если ОС это умеет.
 * Сервер видит key_storage = "software" и может такие устройства ограничивать.
 */
import { b64u, unb64 } from "./bytes";
import { jwkFromPoint, softKeygen, softPoint, softSign, type Jwk } from "./crypto";
import { makeKey, type DeviceKeys, type KeyProvider } from "./keys";

export interface SecretStore {
  get(key: string, opts?: { requireAuth?: boolean; prompt?: string }): Promise<string | null>;
  set(key: string, value: string, opts?: { requireAuth?: boolean; prompt?: string }): Promise<void>;
  del(key: string): Promise<void>;
}

type Meta = { session: Jwk; confirm: Jwk; storeAuth: boolean };

export type SoftDeps = {
  store: SecretStore;
  /** Спросить биометрию/код телефона, если хранилище само этого не делает. */
  gate(reason: string): Promise<void>;
  /** Хранилище умеет требовать биометрию на чтение (iOS/Android сборка, не веб). */
  storeAuth: boolean;
  biometry: boolean;
  note?: string;
};

const k = (alias: string, part: string) => `${alias}.${part}`;

export function softwareProvider(d: SoftDeps): KeyProvider {
  const sessionCache = new Map<string, Uint8Array>();

  function build(alias: string, meta: Meta): DeviceKeys {
    const session = makeKey(meta.session, async (data) => {
      let sk = sessionCache.get(alias);
      if (!sk) {
        const v = await d.store.get(k(alias, "s"));
        if (!v) throw new Error("Ключ сессии не найден — зарегистрируйте устройство заново");
        sk = unb64(v);
        sessionCache.set(alias, sk);
      }
      return softSign(sk, data);
    });
    const confirm = makeKey(meta.confirm, async (data, reason) => {
      const prompt = reason || "Подтвердите действие";
      if (!meta.storeAuth) await d.gate(prompt);
      const v = await d.store.get(k(alias, "c"), { requireAuth: meta.storeAuth, prompt });
      if (!v) throw new Error("Ключ подтверждения недоступен (изменилась биометрия?) — зарегистрируйте устройство заново");
      return softSign(unb64(v), data);
    });
    return { alias, storage: "software", session, confirm, attestation: null };
  }

  return {
    async create(alias) {
      const s = softKeygen();
      const c = softKeygen();
      const meta: Meta = { session: jwkFromPoint(s.point), confirm: jwkFromPoint(c.point), storeAuth: d.storeAuth };
      await d.store.set(k(alias, "s"), b64u(s.secret));
      await d.store.set(k(alias, "c"), b64u(c.secret), { requireAuth: d.storeAuth, prompt: "Создание ключа подтверждения" });
      await d.store.set(k(alias, "meta"), JSON.stringify(meta));
      sessionCache.set(alias, s.secret);
      return build(alias, meta);
    },
    async load(alias) {
      const raw = await d.store.get(k(alias, "meta"));
      if (!raw) return null;
      const meta = JSON.parse(raw) as Meta;
      // проверка целостности: открытый ключ сессии соответствует секрету
      const sv = await d.store.get(k(alias, "s"));
      if (!sv || jwkFromPoint(softPoint(unb64(sv))).x !== meta.session.x) return null;
      return build(alias, meta);
    },
    async remove(alias) {
      sessionCache.delete(alias);
      for (const p of ["s", "c", "meta"]) await d.store.del(k(alias, p)).catch(() => {});
    },
    async describe() {
      return { storage: "software", biometry: d.biometry, mtls: false, note: d.note };
    },
  };
}

/** Хранилище в памяти — для тестов. */
export function memoryStore(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(key) {
      return data.get(key) ?? null;
    },
    async set(key, value) {
      data.set(key, value);
    },
    async del(key) {
      data.delete(key);
    },
  };
}
