import * as Crypto from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import { createDownloadResumable } from "expo-file-system/legacy";

import { isNewer } from "@/core/version";
import { verifyUpdateManifest } from "@/core/updateManifest";
import { FdSecure } from "fd-secure";

let active: ReturnType<typeof createDownloadResumable> | null = null;

export async function downloadAndroidUpdate(version: string, current: string, onProgress: (done: number, total: number) => void): Promise<{ id: string; version: string; size: number }> {
  if (active) throw new Error("Обновление уже скачивается");
  const manifestUrl = `https://github.com/stevv1e/fugu-deck-app/releases/download/v${version}/update-android.json`;
  const response = await fetch(manifestUrl);
  if (!response.ok) throw new Error(`Манифест обновления недоступен: HTTP ${response.status}`);
  const manifest = verifyUpdateManifest(await response.text(), "android");
  if (manifest.version !== version || !isNewer(manifest.version, current)) throw new Error("Эта версия не новее установленной");
  const dir = new Directory(Paths.cache, "updates");
  if (!dir.exists) dir.create({ intermediates: true });
  const target = new File(dir, `Fugu-Deck-Android-${version}-arm64.apk`);
  if (target.exists) target.delete();
  const task = createDownloadResumable(manifest.url, target.uri, {}, (progress) => onProgress(progress.totalBytesWritten, manifest.size));
  active = task;
  try {
    const result = await task.downloadAsync();
    if (!result?.uri) throw new Error("Загрузка обновления отменена");
    const downloaded = new File(result.uri);
    if (!downloaded.exists || downloaded.size !== manifest.size) throw new Error("Размер APK не совпал с подписанным манифестом");
    const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, await downloaded.bytes());
    const hash = Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, "0")).join("");
    if (hash !== manifest.sha256) throw new Error("APK не прошёл проверку целостности");
    onProgress(manifest.size, manifest.size);
    return { id: downloaded.uri, version, size: downloaded.size };
  } catch (e) {
    if (target.exists) target.delete();
    throw e;
  } finally {
    active = null;
  }
}

export async function cancelAndroidUpdate(): Promise<void> {
  await active?.pauseAsync();
}

export function installAndroidUpdate(uri: string): boolean {
  if (!FdSecure) throw new Error("Системный установщик доступен только в собранном Android-приложении");
  return FdSecure.installApk(uri);
}
