import type { PickedFile } from "@/core/attachments";
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
  pickFiles(limit: number): Promise<PickedFile[]>;
  dropFiles(files: FileList | File[], limit: number): Promise<PickedFile[]>;
  readFile(id: string, position: number, length: number): Promise<string>;
  saveFile(name: string, temporary: boolean): Promise<string | null>;
  writeFile(id: string, data: string): Promise<void>;
  finishFile(id: string): Promise<string>;
  cancelFile(id: string): Promise<void>;
  openFile(id: string): Promise<void>;
};

const bridge = () => (globalThis as unknown as { fuguDesktop?: DesktopBridge }).fuguDesktop;
export const desktopAvailable = () => !!bridge();
export const desktopAuth = async (url: string) => ({ type: "success" as const, url: await bridge()!.openAuth(url) });
export const desktopPickFiles = async (limit: number) => bridge()!.pickFiles(limit);
export const desktopDropFiles = async (files: FileList | File[], limit: number) => bridge()!.dropFiles(files, limit);

function desktopId(uri: string): string | null {
  return uri.startsWith("desktop-file://") ? uri.slice("desktop-file://".length) : null;
}

export async function desktopRead(uri: string, position: number, length: number): Promise<string | null> {
  const id = desktopId(uri);
  return id === null ? null : bridge()!.readFile(id, position, length);
}

export const desktopSaveStart = (name: string, temporary: boolean) => bridge()!.saveFile(name, temporary);
export const desktopWrite = (id: string, data: string) => bridge()!.writeFile(id, data);
export const desktopFinish = (id: string) => bridge()!.finishFile(id);
export const desktopCancel = (id: string) => bridge()!.cancelFile(id);
export const desktopOpen = (id: string) => bridge()!.openFile(id);

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
