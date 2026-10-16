/**
 * Выбор хранилища ключей: модуль fd-secure (Secure Enclave / StrongBox / TEE) — если он есть в сборке,
 * иначе программные ключи в Keychain/Keystore (Expo Go, веб).
 */
import { FdSecure } from "fd-secure";

import { b64u, concat, unb64, utf8 } from "@/core/bytes";
import { derToRaw, jwkFromPoint, sha256 } from "@/core/crypto";
import { makeKey, type DeviceKeys, type KeyProvider } from "@/core/keys";
import { softwareProvider } from "@/core/softkeys";
import type { KeyStorage } from "@/core/types";

import { isDesktop } from "./desktop";
import { biometryAvailable, gate, isWeb, secrets, storeCanRequireAuth } from "./storage";

const RANK: Record<KeyStorage, number> = { secure_enclave: 3, strongbox: 3, tee: 2, tpm: 2, software: 1 };

function nativeProvider(mod: NonNullable<typeof FdSecure>): KeyProvider {
  const caps = mod.capabilities();

  const key = (alias: string, publicKey: string, confirm: boolean) =>
    makeKey(jwkFromPoint(unb64(publicKey)), async (data, reason) => {
      const der = await mod.sign(alias, b64u(data), confirm ? reason || "Подтвердите действие" : null);
      return derToRaw(unb64(der));
    });

  const build = (alias: string, s: { publicKey: string; storage: KeyStorage }, c: { publicKey: string; storage: KeyStorage }, att?: Record<string, unknown> | null): DeviceKeys => ({
    alias,
    storage: RANK[s.storage] <= RANK[c.storage] ? s.storage : c.storage,
    session: key(alias + ".s", s.publicKey, false),
    confirm: key(alias + ".c", c.publicKey, true),
    attestation: att ?? null,
  });

  return {
    async create(alias, challenge) {
      const ch = challenge ? b64u(challenge) : null;
      const s = await mod.generateKey(alias + ".s", false, ch);
      const c = await mod.generateKey(alias + ".c", true, ch);
      let att: Record<string, unknown> | null = s.attestation || c.attestation ? { session: s.attestation, confirm: c.attestation } : null;
      const keys = build(alias, s, c, att);
      if (challenge && caps.appAttest && mod.appAttest) {
        // App Attest привязываем к вызову сервера и обоим ключам устройства
        const hash = sha256(concat(challenge, utf8(keys.session.jkt + "." + keys.confirm.jkt)));
        const app = await mod.appAttest(b64u(hash)).catch(() => null);
        if (app) att = { ...(att || {}), app };
      }
      return { ...keys, attestation: att };
    },
    async load(alias) {
      const [s, c] = await Promise.all([mod.publicKey(alias + ".s"), mod.publicKey(alias + ".c")]);
      return s && c ? build(alias, s, c) : null;
    },
    async remove(alias) {
      await Promise.all([mod.deleteKey(alias + ".s"), mod.deleteKey(alias + ".c")]).catch(() => {});
    },
    async describe() {
      return {
        storage: caps.platform === "ios" ? (caps.hardware ? "secure_enclave" : "software")
          : caps.platform === "windows" ? (caps.hardware ? "tpm" : "software") : caps.strongbox ? "strongbox" : "tee",
        biometry: caps.biometry,
        mtls: caps.mtls,
      };
    },
  };
}

let provider: KeyProvider | null = null;

export async function keyProvider(): Promise<KeyProvider> {
  if (provider) return provider;
  if (FdSecure && (!isWeb || isDesktop)) {
    if (isDesktop) await (FdSecure as unknown as { ready?: Promise<unknown> }).ready; // возможности TPM и Hello
    provider = nativeProvider(FdSecure);
  } else {
    const storeAuth = storeCanRequireAuth();
    provider = softwareProvider({
      store: secrets,
      gate,
      storeAuth,
      biometry: await biometryAvailable(),
      note: isWeb
        ? "Веб-версия для разработки: ключи в памяти браузера, без биометрии."
        : "Сборка без модуля fd-secure: ключи программные, в Keychain/Keystore. Для ключей в чипе нужна dev-сборка.",
    });
  }
  return provider;
}

export const hasNativeKeys = () => !!FdSecure && (!isWeb || isDesktop);
