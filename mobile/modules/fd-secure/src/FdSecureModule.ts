import { NativeModule, requireOptionalNativeModule } from "expo";

import type { Capabilities, FdSecureEvents, NativeHttpRequest, NativeKeyInfo } from "./FdSecure.types";

declare class FdSecureModule extends NativeModule<FdSecureEvents> {
  capabilities(): Capabilities;
  generateKey(alias: string, requireBiometry: boolean, attestationChallenge: string | null): Promise<NativeKeyInfo>;
  publicKey(alias: string): Promise<NativeKeyInfo | null>;
  /** Подпись ES256 (SHA-256 внутри). data — base64url. Возвращает DER в base64. */
  sign(alias: string, data: string, prompt: string | null): Promise<string>;
  deleteKey(alias: string): Promise<void>;
  /** Только iOS: App Attest. clientDataHash — base64url SHA-256. */
  appAttest?(clientDataHash: string): Promise<Record<string, unknown> | null>;
  setClientCertificate(alias: string, certPem: string): Promise<boolean>;
  request(req: NativeHttpRequest): Promise<{ status: number; body: string }>;
  openStream(id: string, req: NativeHttpRequest): void;
  closeStream(id: string): void;
}

/** null — модуль не собран в это приложение (Expo Go, веб): работаем на программных ключах. */
export default requireOptionalNativeModule<FdSecureModule>("FdSecure");
