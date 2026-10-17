/**
 * Fugu Deck для Windows (Tauri): тот же интерфейс, что у нативного модуля, но команды выполняет Rust-часть
 * приложения (fugu-deck-app/desktop): ключи в TPM, Windows Hello, HTTP с mTLS. Не в Tauri — null.
 */
import type { Capabilities, NativeHttpRequest, NativeKeyInfo } from "./FdSecure.types";

type Internals = { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> };
const T = (globalThis as { __TAURI_INTERNALS__?: Internals }).__TAURI_INTERNALS__;

type StreamEvent = { id: string; kind: "open" | "chunk" | "end"; status?: number; text?: string; error?: string | null };
type Handler = (e: any) => void;

function make() {
  if (!T) return null;
  const invoke = <R>(cmd: string, args?: Record<string, unknown>) => T.invoke<R>(cmd, args);
  const handlers: Record<string, Set<Handler>> = { onStreamOpen: new Set(), onStreamChunk: new Set(), onStreamEnd: new Set() };
  // одна подписка на поток событий Rust-части; дальше раздаём слушателям по имени, как NativeModule
  void import("@tauri-apps/api/event").then(({ listen }) =>
    listen<StreamEvent>("fd-stream", ({ payload: e }) => {
      const name = e.kind === "open" ? "onStreamOpen" : e.kind === "chunk" ? "onStreamChunk" : "onStreamEnd";
      handlers[name].forEach((h) => h(e));
    }),
  );
  let caps: Capabilities = { platform: "windows", hardware: false, strongbox: false, biometry: false, mtls: true, appAttest: false };
  const ready = invoke<Capabilities>("capabilities").then((c) => (caps = c));
  const req = (r: NativeHttpRequest) => ({ ...r, body: r.body ?? null, certAlias: r.certAlias ?? null });
  return {
    ready,
    capabilities: () => caps,
    generateKey: (alias: string, requireBiometry: boolean, _challenge: string | null) =>
      invoke<NativeKeyInfo>("generate_key", { alias, requireBiometry }),
    publicKey: (alias: string) => invoke<NativeKeyInfo | null>("public_key", { alias }),
    sign: (alias: string, data: string, prompt: string | null) => invoke<string>("sign", { alias, data, prompt }),
    deleteKey: (alias: string) => invoke<void>("delete_key", { alias }),
    setClientCertificate: (alias: string, certPem: string) => invoke<boolean>("set_client_certificate", { alias, certPem }),
    request: (r: NativeHttpRequest) => invoke<{ status: number; body: string }>("request", { req: req(r) }),
    openStream: (id: string, r: NativeHttpRequest) => void invoke("open_stream", { id, req: req(r) }),
    closeStream: (id: string) => void invoke("close_stream", { id }),
    addListener(name: string, h: Handler) {
      handlers[name]?.add(h);
      return { remove: () => handlers[name]?.delete(h) };
    },
  };
}

export const FdSecureDesktop = make();
export const desktopInvoke = T ? <R>(cmd: string, args?: Record<string, unknown>) => T.invoke<R>(cmd, args) : null;
