/**
 * Ключи провайдеров — только на этом устройстве.
 *  - Android/iOS: expo-secure-store (Android Keystore / Keychain);
 *  - Windows: диспетчер учётных данных Windows через команду Tauri (src-tauri/src/main.rs);
 *  - веб (разработка): localStorage — не для настоящих ключей.
 */
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import type { Provider } from "@/core/providers";

import { desk, isDesktop } from "./desktop";

const name = (p: Provider) => `fl.key.${p}`;

export const secretsWeak = () => Platform.OS === "web" && !isDesktop();

export async function getKey(p: Provider): Promise<string | null> {
  if (Platform.OS !== "web") return SecureStore.getItemAsync(name(p));
  if (isDesktop()) return desk<string | null>("secret_get", { name: name(p) });
  return globalThis.localStorage?.getItem(name(p)) ?? null;
}

export async function setKey(p: Provider, v: string): Promise<void> {
  if (Platform.OS !== "web") return SecureStore.setItemAsync(name(p), v);
  if (isDesktop()) return desk<void>("secret_set", { name: name(p), value: v });
  globalThis.localStorage?.setItem(name(p), v);
}

export async function delKey(p: Provider): Promise<void> {
  if (Platform.OS !== "web") return SecureStore.deleteItemAsync(name(p));
  if (isDesktop()) return desk<void>("secret_del", { name: name(p) });
  globalThis.localStorage?.removeItem(name(p));
}
