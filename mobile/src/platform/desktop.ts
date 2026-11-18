import { randomId } from "@/core/bytes";
import { ApiError, errorFrom, type Http, type HttpRequest } from "@/core/http";

import { secrets } from "./storage";

type DesktopRequest = HttpRequest & { certPem?: string; keyJwk?: Record<string, string> };
type StreamEvent = { type: "open"; status: number } | { type: "chunk"; text: string } | { type: "end"; status: number; error?: string };
type DesktopBridge = {
  request(req: DesktopRequest): Promise<{ status: number; text: string }>;
  stream(id: string, req: DesktopRequest): void;
  closeStream(id: string): void;
  onStream(id: string, callback: (event: StreamEvent) => void): () => void;
  openAuth(url: string): Promise<string>;
};

const bridge = () => (globalThis as unknown as { fuguDesktop?: DesktopBridge }).fuguDesktop;
export const desktopAvailable = () => !!bridge();
export const desktopAuth = async (url: string) => ({ type: "success" as const, url: await bridge()!.openAuth(url) });

async function credentials(alias?: string, certPem?: string): Promise<Pick<DesktopRequest, "certPem" | "keyJwk">> {
  if (!alias || !certPem) return {};
  const base = alias.endsWith(".s") ? alias.slice(0, -2) : alias;
  const [secret, rawMeta] = await Promise.all([secrets.get(`${base}.s`), secrets.get(`${base}.meta`)]);
  if (!secret || !rawMeta) throw new Error("Локальный ключ устройства не найден — зарегистрируйтесь заново");
  const meta = JSON.parse(rawMeta) as { session?: Record<string, string> };
  if (!meta.session) throw new Error("Локальный ключ устройства повреждён — зарегистрируйтесь заново");
  return { certPem, keyJwk: { ...meta.session, d: secret } };
}

export function desktopHttp(alias?: string, certPem?: string): Http {
  return {
    async request(req) {
      try {
        return await bridge()!.request({ ...req, ...await credentials(alias, certPem) });
      } catch (e: any) {
        throw new ApiError(0, "Сервер недоступен: " + (e?.message || e));
      }
    },
    stream(req, on) {
      const id = randomId(12);
      let closed = false;
      let status = 0;
      let errorText = "";
      const unsubscribe = bridge()!.onStream(id, (event) => {
        if (closed) return;
        if (event.type === "open") {
          status = event.status;
          on.onOpen?.(status);
        } else if (event.type === "chunk") {
          if (status === 200) on.onChunk(event.text);
          else errorText += event.text;
        } else {
          closed = true;
          unsubscribe();
          if (event.error) on.onEnd(new ApiError(0, event.error), event.status);
          else on.onEnd(status === 200 ? undefined : errorFrom(status, errorText), status);
        }
      });
      void credentials(alias, certPem).then((cert) => {
        if (!closed) bridge()!.stream(id, { ...req, ...cert });
      }, (e) => {
        if (closed) return;
        closed = true;
        unsubscribe();
        on.onEnd(e instanceof Error ? e : new Error(String(e)));
      });
      return {
        close() {
          if (closed) return;
          closed = true;
          unsubscribe();
          bridge()!.closeStream(id);
        },
      };
    },
  };
}
