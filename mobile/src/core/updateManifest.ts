import { ed25519 } from "@noble/curves/ed25519.js";

import { fromUtf8, unb64 } from "./bytes";

export const UPDATE_PUBLIC_KEY = "h5JyYoZt7BKWxmCAPylZ41927mr9t6wlIAiciSwfVTw=";
export type UpdatePlatform = "android" | "windows";
export type UpdateChannel = "stable" | "beta";
export type UpdatePayload = {
  format: "fugu-deck-update/1";
  platform: UpdatePlatform;
  channel: UpdateChannel;
  version: string;
  url: string;
  size: number;
  sha256: string;
};

export function updateManifestName(platform: UpdatePlatform, channel: UpdateChannel): string {
  return `update-${platform}${channel === "beta" ? "-beta" : ""}.json`;
}

export function verifyUpdateManifest(raw: string, platform: UpdatePlatform, publicKey = UPDATE_PUBLIC_KEY, channel: UpdateChannel = "stable"): UpdatePayload {
  const envelope = JSON.parse(raw) as { payload?: string; signature?: string };
  if (!envelope.payload || !envelope.signature) throw new Error("Манифест обновления неполный");
  const payload = unb64(envelope.payload);
  if (!ed25519.verify(unb64(envelope.signature), payload, unb64(publicKey))) throw new Error("Подпись обновления недействительна");
  const value = JSON.parse(fromUtf8(payload)) as UpdatePayload;
  const expected = platform === "android" ? `Fugu-Deck-Android-${value.version}-arm64.apk` : `Fugu-Deck-Setup-${value.version}.exe`;
  const url = `https://github.com/stevv1e/fugu-deck-app/releases/download/v${value.version}/${expected}`;
  if (value.format !== "fugu-deck-update/1" || value.platform !== platform || value.channel !== channel || !/^\d+\.\d+\.\d+$/.test(value.version) ||
    value.url !== url || !Number.isSafeInteger(value.size) || value.size <= 0 || value.size > 512 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error("Манифест обновления не соответствует приложению");
  }
  return value;
}
