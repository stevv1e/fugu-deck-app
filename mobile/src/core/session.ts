/**
 * Сессия устройства на одном сервере.
 *  • Токен доступа живёт 10 минут и только в памяти. Новый — по DPoP-доказательству ключом сессии.
 *  • Каждый запрос несёт свежее DPoP-доказательство (метод + путь + хэш токена), повтор сервер отвергает.
 *  • Важные действия подписываются ключом подтверждения (биометрия) — signAction.
 *  • Часы: подстраиваемся под время сервера, чтобы доказательства не считались просроченными.
 */
import { b64u, randomId } from "./bytes";
import { canonical } from "./canonical";
import { dpopProof } from "./dpop";
import { ApiError, errorFrom, type Http, type StreamHandle } from "./http";
import type { DeviceKeys } from "./keys";
import { getJson } from "./server";
import { SseParser, type SseMessage } from "./sse";
import type { ServerRecord } from "./types";

type Token = { value: string; exp: number };

export type SessionEvents = {
  /** Сервер больше не принимает это устройство (отозвано, удалено, пользователь отключён). */
  onRevoked?(reason: string): void;
};

export type SignedAction = { action: Record<string, unknown>; sig: string };

const REVOKED = /отозван|не зарегистрировано|отключён/i;

export class DeviceSession {
  private token: Token | null = null;
  private refreshing: Promise<Token> | null = null;
  private offset = 0;
  private clockSynced = false;

  constructor(
    readonly http: Http,
    readonly server: ServerRecord,
    readonly keys: DeviceKeys,
    private events: SessionEvents = {},
  ) {}

  get deviceId(): string {
    if (!this.server.device) throw new Error("Устройство не зарегистрировано на этом сервере");
    return this.server.device.id;
  }

  /** После регистрации токен и поправка часов уже есть — не тратим лишний запрос. */
  seed(accessToken: string, expiresIn: number, clockOffset: number) {
    this.offset = clockOffset;
    this.clockSynced = true;
    this.token = { value: accessToken, exp: this.now() + expiresIn };
  }

  now(): number {
    return Date.now() / 1000 + this.offset;
  }

  async syncClock(): Promise<void> {
    const t0 = Date.now();
    const r = await getJson<{ server_time: number }>(this.http, this.server.url + "/api/devices/challenge");
    const rtt = Date.now() - t0;
    this.offset = (r.server_time + rtt / 2 - Date.now()) / 1000;
    this.clockSynced = true;
  }

  private async newToken(): Promise<Token> {
    if (!this.clockSynced) await this.syncClock();
    const url = this.server.url + "/api/devices/token";
    const proof = await dpopProof({ key: this.keys.session, method: "POST", url, now: this.now() });
    const r = await this.http.request({
      method: "POST",
      url,
      headers: { "content-type": "application/json", accept: "application/json", DPoP: proof },
      body: JSON.stringify({ device_id: this.deviceId }),
    });
    if (r.status !== 200) {
      const err = errorFrom(r.status, r.text);
      if (r.status === 401 && REVOKED.test(err.message)) this.events.onRevoked?.(err.message);
      throw err;
    }
    const t = JSON.parse(r.text) as { access_token: string; expires_in: number };
    return { value: t.access_token, exp: this.now() + t.expires_in };
  }

  async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.exp - this.now() > 30) return this.token.value;
    if (!this.refreshing) {
      this.refreshing = this.newToken().finally(() => {
        this.refreshing = null;
      });
    }
    this.token = await this.refreshing;
    return this.token.value;
  }

  async authHeaders(method: string, url: string, force = false): Promise<Record<string, string>> {
    const at = await this.accessToken(force);
    const proof = await dpopProof({ key: this.keys.session, method, url, accessToken: at, now: this.now() });
    return { Authorization: `DPoP ${at}`, DPoP: proof };
  }

  async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const url = this.server.url + path;
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { accept: "application/json", ...(await this.authHeaders(method, url, attempt > 0)) };
      if (body !== undefined) headers["content-type"] = "application/json";
      const r = await this.http.request({ method, url, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      if (r.status === 401 && attempt === 0) {
        const err = errorFrom(r.status, r.text);
        if (REVOKED.test(err.message)) {
          this.events.onRevoked?.(err.message);
          throw err;
        }
        if (/время|часы/i.test(err.message)) await this.syncClock();
        continue; // токен истёк или часы разошлись — новый токен и новое доказательство
      }
      if (r.status < 200 || r.status >= 300) throw errorFrom(r.status, r.text);
      return (r.text ? JSON.parse(r.text) : null) as T;
    }
  }

  /** Подписать действие ключом подтверждения — телефон спросит биометрию. */
  async signAction(fields: Record<string, unknown>, reason: string, nonce = randomId(16)): Promise<SignedAction> {
    const action = { ...fields, device_id: this.deviceId, nonce, ts: Math.round(this.now() * 1000) };
    const sig = await this.keys.confirm.sign(canonical(action), reason);
    return { action, sig: b64u(sig) };
  }

  /**
   * Поток SSE с переподключением. Каждое подключение — с новым DPoP-доказательством
   * (повтор старого сервер отверг бы), поэтому стандартный EventSource не годится.
   */
  sse(
    pathFor: () => string,
    on: { onMessage(m: SseMessage): void; onEnd?(err?: Error): void; onState?(s: "connecting" | "open" | "retry"): void },
    opts: { retryMs?: number; maxRetries?: number } = {},
  ): { close(): void } {
    let handle: StreamHandle | null = null;
    let stopped = false;
    let retries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (err?: Error) => {
      if (stopped) return;
      stopped = true;
      on.onEnd?.(err);
    };

    const open = async () => {
      if (stopped) return;
      on.onState?.("connecting");
      const url = this.server.url + pathFor();
      let headers: Record<string, string>;
      try {
        headers = { accept: "text/event-stream", ...(await this.authHeaders("GET", url, retries > 0 && retries % 3 === 0)) };
      } catch (e: any) {
        if (e instanceof ApiError && e.status === 401) return finish(e);
        return retry();
      }
      if (stopped) return;
      const parser = new SseParser();
      let ended = false;
      handle = this.http.stream(
        { method: "GET", url, headers },
        {
          onOpen: (status) => {
            if (status === 200) {
              retries = 0;
              on.onState?.("open");
            }
          },
          onChunk: (text) => {
            for (const m of parser.feed(text)) {
              if (m.event === "end") {
                ended = true;
                handle?.close();
                return finish();
              }
              on.onMessage(m);
            }
          },
          onEnd: (err, status) => {
            if (ended || stopped) return;
            if (status && status >= 400 && status !== 401 && status < 500) return finish(err);
            retry();
          },
        },
      );
    };

    const retry = () => {
      if (stopped) return;
      retries++;
      if (opts.maxRetries !== undefined && retries > opts.maxRetries) return finish(new Error("Поток прерван"));
      on.onState?.("retry");
      const delay = Math.min(15000, (opts.retryMs ?? 1500) * Math.min(retries, 6));
      timer = setTimeout(open, delay);
    };

    open();
    return {
      close() {
        stopped = true;
        if (timer) clearTimeout(timer);
        handle?.close();
      },
    };
  }
}
