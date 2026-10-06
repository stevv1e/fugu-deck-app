/**
 * Два хранилища:
 *  • prefs — несекретное (список серверов, тема): AsyncStorage;
 *  • secrets — секреты программных ключей: Keychain / Keystore через expo-secure-store.
 * На вебе (только для разработки и скриншотов) секреты — в localStorage, и приложение это честно показывает.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import type { SecretStore } from "@/core/softkeys";

export const isWeb = Platform.OS === "web";

export const prefs = {
  async get<T>(key: string, fallback: T): Promise<T> {
    try {
      const v = await AsyncStorage.getItem(key);
      return v ? (JSON.parse(v) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  async set(key: string, value: unknown): Promise<void> {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  },
};

const webSecrets: SecretStore = {
  async get(key) {
    try {
      return globalThis.localStorage?.getItem("fd.secret." + key) ?? null;
    } catch {
      return null;
    }
  },
  async set(key, value) {
    globalThis.localStorage?.setItem("fd.secret." + key, value);
  },
  async del(key) {
    globalThis.localStorage?.removeItem("fd.secret." + key);
  },
};

const nativeSecrets: SecretStore = {
  async get(key, opts) {
    return SecureStore.getItemAsync(key, {
      requireAuthentication: !!opts?.requireAuth,
      authenticationPrompt: opts?.prompt || " ",
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },
  async set(key, value, opts) {
    await SecureStore.setItemAsync(key, value, {
      requireAuthentication: !!opts?.requireAuth,
      authenticationPrompt: opts?.prompt || " ",
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },
  async del(key) {
    await SecureStore.deleteItemAsync(key);
  },
};

export const secrets: SecretStore = isWeb ? webSecrets : nativeSecrets;

/** Хранилище само спросит биометрию при чтении секрета ключа подтверждения. */
export function storeCanRequireAuth(): boolean {
  if (isWeb) return false;
  try {
    return SecureStore.canUseBiometricAuthentication();
  } catch {
    return false;
  }
}

export async function biometryAvailable(): Promise<boolean> {
  if (isWeb) return false;
  try {
    return (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync());
  } catch {
    return false;
  }
}

/** Запасной путь: спросить биометрию или код телефона перед использованием программного ключа подтверждения. */
export async function gate(reason: string): Promise<void> {
  if (isWeb) {
    if (typeof globalThis.confirm === "function" && !globalThis.confirm(reason + "\n\n(веб-версия для разработки: биометрии нет)")) {
      throw new Error("Подтверждение отменено");
    }
    return;
  }
  const r = await LocalAuthentication.authenticateAsync({ promptMessage: reason, cancelLabel: "Отмена" });
  if (!r.success) throw new Error(r.error === "user_cancel" || r.error === "system_cancel" ? "Подтверждение отменено" : "Биометрия не прошла");
}
