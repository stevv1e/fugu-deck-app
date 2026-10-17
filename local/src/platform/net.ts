/**
 * Потоковый POST к провайдеру.
 *  - Android/iOS: expo/fetch — у встроенного fetch React Native нет потокового тела;
 *  - Windows (Tauri): fetch плагина http — запрос делает Rust, ограничений CORS нет;
 *  - веб (разработка): обычный fetch браузера.
 */
import { fetch as expoFetch } from "expo/fetch";
import { Platform } from "react-native";

import type { StreamFetch } from "@/core/chat";
import { Utf8Stream } from "@/core/providers";

import { isDesktop } from "./desktop";

type AnyFetch = (url: string, init: any) => Promise<{ status: number; body: any; text(): Promise<string> }>;

async function pickFetch(): Promise<AnyFetch> {
  if (Platform.OS !== "web") return expoFetch as unknown as AnyFetch;
  if (isDesktop()) return (await import("@tauri-apps/plugin-http")).fetch as unknown as AnyFetch;
  return globalThis.fetch.bind(globalThis) as unknown as AnyFetch;
}

export const streamFetch: StreamFetch = async (url, init, onChunk) => {
  const f = await pickFetch();
  const res = await f(url, init);
  if (res.status >= 400) return { status: res.status, text: await res.text().catch(() => "") };
  const reader = res.body?.getReader?.();
  if (!reader) {
    onChunk(await res.text()); // без потока — ответ целиком
    return { status: res.status, text: "" };
  }
  const dec = new Utf8Stream();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) onChunk(typeof value === "string" ? value : dec.push(value as Uint8Array));
  }
  return { status: res.status, text: "" };
};
