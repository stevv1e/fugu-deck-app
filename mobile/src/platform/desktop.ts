/**
 * Fugu Deck для Windows: приложение работает в WebView2 (Tauri), а всё системное делает Rust-часть
 * (fugu-deck-app/desktop). Здесь — вызовы её команд и ссылки fugudeck:// (вход из браузера, приглашения).
 */
import { desktopInvoke } from "fd-secure";

export const isDesktop = !!desktopInvoke;

export function desk<R>(cmd: string, args?: Record<string, unknown>): Promise<R> {
  if (!desktopInvoke) return Promise.reject(new Error("только в приложении для Windows"));
  return desktopInvoke<R>(cmd, args);
}

type LinkHandler = (url: string) => void;
const linkHandlers = new Set<LinkHandler>();
let linksStarted = false;

/** Ссылки fugudeck://, которые Windows передала приложению (из браузера или по приглашению). */
export function onDeepLink(h: LinkHandler): () => void {
  linkHandlers.add(h);
  if (isDesktop && !linksStarted) {
    linksStarted = true;
    const fire = (urls: string[]) => urls.forEach((u) => linkHandlers.forEach((x) => x(u)));
    void import("@tauri-apps/api/event").then(({ listen }) => listen<string[]>("fd-link", ({ payload }) => fire(payload)));
    void desk<string[]>("take_links").then(fire, () => {});
  }
  return () => linkHandlers.delete(h);
}

/**
 * Вход в системном браузере: открыть адрес и дождаться возврата на fugudeck://oauth… (Windows запустит приложение по
 * схеме, второй экземпляр передаст ссылку первому). Аналог WebBrowser.openAuthSessionAsync.
 */
export function browserAuth(url: string, redirect: string, timeoutMs = 10 * 60_000): Promise<{ type: "success"; url: string } | { type: "cancel" }> {
  return new Promise((resolve, reject) => {
    let off = () => {};
    const timer = setTimeout(() => {
      off();
      resolve({ type: "cancel" });
    }, timeoutMs);
    off = onDeepLink((u) => {
      if (!u.startsWith(redirect)) return;
      clearTimeout(timer);
      off();
      resolve({ type: "success", url: u });
    });
    desk("open_url", { url }).catch((e) => {
      clearTimeout(timer);
      off();
      reject(e);
    });
  });
}
