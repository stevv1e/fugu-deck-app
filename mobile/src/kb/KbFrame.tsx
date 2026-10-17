/**
 * Страница базы знаний на вебе и в Windows-сборке: react-native-webview там нет — та же страница в iframe (srcdoc).
 * Сообщения страницы (window.ReactNativeWebView.postMessage) приходят сюда через postMessage родителю.
 */
import { createElement, useEffect, useState } from "react";

export function KbFrame({ html, injected, onMessage }: { html: string; injected: string; onMessage(data: string): void }) {
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  useEffect(() => {
    const h = (e: MessageEvent) => {
      if (frame && e.source === frame.contentWindow && e.data && typeof e.data.fdkb === "string") onMessage(e.data.fdkb);
    };
    window.addEventListener("message", h);
    return () => window.removeEventListener("message", h);
  }, [frame, onMessage]);
  const bridge = `<script>window.ReactNativeWebView={postMessage:function(m){parent.postMessage({fdkb:String(m)},"*")}};${injected}</script>`;
  return createElement("iframe", {
    ref: setFrame, srcDoc: bridge + html, sandbox: "allow-scripts", title: "База знаний",
    style: { flex: 1, border: 0, width: "100%", height: "100%", background: "#07060e" },
  });
}
