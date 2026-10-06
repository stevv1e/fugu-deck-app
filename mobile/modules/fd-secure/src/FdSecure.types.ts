export type NativeStorage = "secure_enclave" | "strongbox" | "tee" | "software";

export type NativeKeyInfo = {
  /** Несжатая точка P-256 (0x04‖X‖Y), base64url. */
  publicKey: string;
  storage: NativeStorage;
  /** Android Key Attestation: { format: "android-key", chain: [DER base64…] }. */
  attestation?: Record<string, unknown> | null;
};

export type Capabilities = {
  platform: "ios" | "android";
  hardware: boolean;
  strongbox: boolean;
  biometry: boolean;
  mtls: boolean;
  appAttest: boolean;
};

export type NativeHttpRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | null;
  /** Псевдоним ключа сессии — с ним и сертификатом устройства выполняется mTLS. */
  certAlias?: string | null;
  timeoutMs?: number;
};

export type FdSecureEvents = {
  onStreamOpen: (e: { id: string; status: number }) => void;
  onStreamChunk: (e: { id: string; text: string }) => void;
  onStreamEnd: (e: { id: string; status?: number; error?: string | null }) => void;
};
