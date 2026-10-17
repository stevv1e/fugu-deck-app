/** Настройки и чаты — AsyncStorage (на Windows и в вебе — localStorage окна). Ключи моделей здесь не хранятся. */
import AsyncStorage from "@react-native-async-storage/async-storage";

export const prefs = {
  async get(key: string, fallback: string): Promise<string> {
    return (await AsyncStorage.getItem(key)) ?? fallback;
  },
  async set(key: string, value: string): Promise<void> {
    await AsyncStorage.setItem(key, value);
  },
};

export async function getJson<T>(key: string, fallback: T): Promise<T> {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export const setJson = (key: string, v: unknown) => AsyncStorage.setItem(key, JSON.stringify(v));
export const remove = (key: string) => AsyncStorage.removeItem(key);
