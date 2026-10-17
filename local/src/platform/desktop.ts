import { Linking } from "react-native";

/** Windows-версия — то же веб-приложение в окне Tauri. Внутри Tauri есть __TAURI_INTERNALS__. */
export const isDesktop = () => typeof globalThis !== "undefined" && "__TAURI_INTERNALS__" in globalThis;

export async function desk<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** Ссылка — в браузере по умолчанию (в окне Tauri window.open внешние адреса не открывает). */
export async function openLink(url: string): Promise<void> {
  if (isDesktop()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    return openUrl(url);
  }
  await Linking.openURL(url);
}
