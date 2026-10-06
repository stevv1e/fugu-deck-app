/**
 * Ключи устройства. Два ключа P-256 на каждый сервер:
 *  • session — без биометрии; подписывает DPoP к каждому запросу и CSR для mTLS;
 *  • confirm — биометрия на КАЖДУЮ подпись; подписывает подтверждения инструментов и отзыв устройств.
 * Реализации: аппаратная (модуль fd-secure: Secure Enclave / StrongBox / TEE) и программная (резерв).
 */
import type { Jwk } from "./crypto";
import { jwkThumbprint } from "./crypto";
import type { KeyStorage } from "./types";

export interface DeviceKey {
  readonly jwk: Jwk;
  readonly jkt: string;
  /** Подпись ES256 над data (SHA-256 внутри). Возвращает r‖s (64 байта). reason — текст для биометрии. */
  sign(data: Uint8Array, reason?: string): Promise<Uint8Array>;
}

export interface DeviceKeys {
  readonly alias: string;
  readonly storage: KeyStorage;
  readonly session: DeviceKey;
  readonly confirm: DeviceKey;
  /** Аттестация ключей, если платформа её дала (цепочка Android Key Attestation / App Attest). */
  readonly attestation?: Record<string, unknown> | null;
}

export interface KeyProvider {
  /** Создать новую пару ключей. challenge попадает в аттестацию (Android Key Attestation). */
  create(alias: string, challenge?: Uint8Array): Promise<DeviceKeys>;
  load(alias: string): Promise<DeviceKeys | null>;
  remove(alias: string): Promise<void>;
  /** Что умеет платформа — показываем человеку честно. */
  describe(): Promise<{ storage: KeyStorage; biometry: boolean; mtls: boolean; note?: string }>;
}

export function makeKey(jwk: Jwk, sign: DeviceKey["sign"]): DeviceKey {
  return { jwk, jkt: jwkThumbprint(jwk), sign };
}
