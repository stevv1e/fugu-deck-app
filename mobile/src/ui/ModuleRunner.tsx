import { useCallback, useEffect, useMemo, useRef } from "react";
import { Platform, View } from "react-native";
import { WebView } from "react-native-webview";

import { moduleHtml } from "@/core/moduleHtml";
import { readResponseText, type InstalledModule } from "@/core/modules";
import { prefs } from "@/platform/storage";
import { recordModuleEvent } from "@/platform/moduleAudit";
import { Notice, Txt } from "@/ui/kit";
import { useTheme } from "@/ui/theme";

type Rpc = { type: string; id: string; method: string; payload?: any };

export function ModuleRunner({ module, onError }: { module: InstalledModule; onError?(message: string): void }) {
  const { p } = useTheme();
  const html = useMemo(() => moduleHtml(module.code), [module.code]);
  const webFrame = useRef<HTMLIFrameElement | null>(null);
  const webContainer = useRef<View>(null);
  const nativeFrame = useRef<WebView | null>(null);
  const rpcTimes = useRef<number[]>([]);
  const send = useCallback((message: unknown) => {
    if (Platform.OS === "web") webFrame.current?.contentWindow?.postMessage(message, "*");
    else nativeFrame.current?.injectJavaScript(`window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(message)}}));true;`);
  }, []);
  const handle = useCallback(async (rpc: Rpc) => {
    const respond = (result?: unknown, error = "") => send({ type: "fugu-rpc-response", id: rpc.id, result, error });
    try {
      if (!rpc.id || typeof rpc.method !== "string") return;
      if (rpc.method === "storage.get" || rpc.method === "storage.set") {
        if (!module.manifest.permissions.storage) throw new Error("Разрешение storage не выдано");
        const key = String(rpc.payload?.key || "");
        if (!/^[A-Za-z0-9_.-]{1,100}$/.test(key)) throw new Error("Некорректный ключ хранилища");
        const storageKey = `fd:module:${module.manifest.id}:${key}`;
        if (rpc.method === "storage.get") {
          const value = await prefs.get(storageKey, null);
          await recordModuleEvent({ module: module.manifest.id, action: "storage.get", ok: true, details: key });
          return respond(value);
        }
        if (JSON.stringify(rpc.payload?.value).length > 50_000) throw new Error("Слишком большое значение");
        await prefs.set(storageKey, rpc.payload?.value ?? null);
        await recordModuleEvent({ module: module.manifest.id, action: "storage.set", ok: true, details: key });
        return respond({ ok: true });
      }
      if (rpc.method === "network.get") {
        const url = new URL(String(rpc.payload?.url || ""));
        if (url.protocol !== "https:" || !(module.manifest.permissions.network || []).includes(url.host)) throw new Error("Домен не входит в разрешения модуля");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        try {
          const response = await fetch(url, { method: "GET", redirect: "error", signal: controller.signal });
          const text = await readResponseText(response, 100_000);
          await recordModuleEvent({ module: module.manifest.id, action: "network.get", ok: true, details: `${url.host} · HTTP ${response.status}` });
          return respond({ status: response.status, text });
        } finally { clearTimeout(timer); }
      }
      throw new Error("Неизвестный RPC метод");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (["storage.get", "storage.set", "network.get"].includes(rpc.method)) {
        await recordModuleEvent({ module: module.manifest.id, action: rpc.method as "storage.get" | "storage.set" | "network.get", ok: false, details: message });
      }
      respond(undefined, message);
    }
  }, [module, send]);
  const receive = useCallback((data: unknown) => {
    try {
      const rpc = typeof data === "string" ? JSON.parse(data) : data;
      if (rpc?.type !== "fugu-rpc") return;
      const now = Date.now();
      rpcTimes.current = rpcTimes.current.filter((time) => now - time < 60_000);
      if (rpcTimes.current.length >= 60) {
        void recordModuleEvent({ module: module.manifest.id, action: "rate_limit", ok: false, details: "60 RPC в минуту" });
        return onError?.("Превышен лимит: 60 RPC в минуту");
      }
      rpcTimes.current.push(now);
      void handle(rpc);
    } catch { onError?.("Модуль отправил некорректное сообщение"); }
  }, [handle, module.manifest.id, onError]);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const host = webContainer.current as unknown as HTMLDivElement | null;
    if (!host) return;
    const frame = document.createElement("iframe");
    frame.title = module.manifest.name;
    frame.srcdoc = html;
    frame.setAttribute("sandbox", "allow-scripts");
    frame.style.cssText = "width:100%;height:430px;border:0;background:#101513";
    host.appendChild(frame);
    webFrame.current = frame;
    const listener = (event: MessageEvent) => {
      if (event.source === frame.contentWindow) receive(event.data);
    };
    globalThis.addEventListener("message", listener);
    return () => {
      globalThis.removeEventListener("message", listener);
      frame.remove();
      webFrame.current = null;
    };
  }, [html, module.manifest.name, receive]);

  return <View style={{ minHeight: 260, borderWidth: 1, borderColor: p.line2, borderRadius: 12, overflow: "hidden", backgroundColor: p.panel }}>
    <View style={{ padding: 9, borderBottomWidth: 1, borderBottomColor: p.line }}><Txt kind="small">Песочница · {module.manifest.id}@{module.manifest.version} · commit {module.commit.slice(0, 8)}</Txt></View>
    {Platform.OS === "web" ? <View ref={webContainer} /> : <WebView ref={nativeFrame} source={{ html }} onMessage={(event) => receive(event.nativeEvent.data)}
      javaScriptEnabled domStorageEnabled={false} allowFileAccess={false} allowsInlineMediaPlayback={false}
      setSupportMultipleWindows={false} mixedContentMode="never" originWhitelist={["about:blank"]}
      onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
      onError={(event) => onError?.(event.nativeEvent.description)} style={{ height: 430, backgroundColor: p.panel }} />}
    {!module.enabled ? <Notice kind="info" text="Модуль отключён. Код не запускается." /> : null}
  </View>;
}
