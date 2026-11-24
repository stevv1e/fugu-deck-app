import { ed25519 } from "@noble/curves/ed25519.js";

import { fromUtf8, unb64 } from "./bytes";

export const UPDATE_PUBLIC_KEY = "nLtRi9S68m8927EbNYQZ0EZ5DEKPenOL8PjvivWYRRI=";
export type UpdatePlatform = "android" | "windows";
export type UpdatePayload = {
  format: "fugu-deck-update/1";
  platform: UpdatePlatform;
  channel: "stable";
  version: string;
  url: string;
  size: number;
  sha256: string;
};

export function verifyUpdateManifest(raw: string, platform: UpdatePlatform, publicKey = UPDATE_PUBLIC_KEY): UpdatePayload {
  const envelope = JSON.parse(raw) as { payload?: string; signature?: string };
  if (!envelope.payload || !envelope.signature) throw new Error("Манифест обновления неполный");
  const payload = unb64(envelope.payload);
  if (!ed25519.verify(unb64(envelope.signature), payload, unb64(publicKey))) throw new Error("Подпись обновления недействительна");
  const value = JSON.parse(fromUtf8(payload)) as UpdatePayload;
  const expected = platform === "android" ? `Fugu-Deck-Android-${value.version}-arm64.apk` : `Fugu-Deck-Setup-${value.version}.exe`;
  const url = `https://github.com/stevv1e/fugu-deck-app/releases/download/v${value.version}/${expected}`;
  if (value.format !== "fugu-deck-update/1" || value.platform !== platform || value.channel !== "stable" || !/^\d+\.\d+\.\d+$/.test(value.version) ||
    value.url !== url || !Number.isSafeInteger(value.size) || value.size <= 0 || value.size > 512 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error("Манифест обновления не соответствует приложению");
  }
  return value;
}
