/**
 * Сессия устройства на одном сервере.
 *  • Токен доступа живёт 10 минут и только в памяти. Новый — по DPoP-доказательству ключом сессии.
 *  • Каждый запрос несёт свежее DPoP-доказательство (метод + путь + хэш токена), повтор сервер отвергает.
 *  • Важные действия подписываются ключом подтверждения (биометрия) — signAction.
 *  • Часы: подстраиваемся под время сервера, чтобы доказательства не считались просроченными.
 */
import { b64u, randomId } from "./bytes";
import { canonical } from "./canonical";
import { signClusterAction } from "./cluster";
import { dpopProof } from "./dpop";
import { ApiError, errorFrom, type Http, type StreamHandle } from "./http";
import type { DeviceKeys } from "./keys";
import { getJson } from "./server";
import { SseParser, type SseMessage } from "./sse";
import type { ServerRecord } from "./types";

export type Token = { value: string; exp: number };

export type SessionEvents = {
  /** Сервер больше не принимает это устройство (отозвано, удалено, пользователь отключён). */
  onRevoked?(reason: string): void;
};

export type SignedAction = { action: Record<string, unknown>; sig: string };

const REVOKED = /отозван|не зарегистрировано|отключён/i;

export class DeviceSession {
  protected token: Token | null = null;
  private refreshing: Promise<Token> | null = null;
  protected offset = 0;
  protected clockSynced = false;

  constructor(
    readonly http: Http,
    readonly server: ServerRecord,
    readonly keys: DeviceKeys,
    protected events: SessionEvents = {},
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

  protected async newToken(): Promise<Token> {
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
   * Подписать разрешение агенту выполнить действие инструмента (биометрия). Подписывается то, что человек видит
   * на карточке: инструмент и хеш его аргументов. Возвращает поля для тела POST /api/approvals/<id>.
   */
  async signApproval(a: { approvalId: string; tool: string; argsHash: string; title: string }): Promise<Record<string, unknown>> {
    return this.signAction(
      { type: "approve_tool", approval_id: a.approvalId, tool: a.tool, args_sha256: a.argsHash, approve: true },
      `Разрешить: ${a.title}`,
    );
  }

  /** Подписать команду для сервера (ssh_write / ssh_danger). На одиночном сервере серверов пользователя нет. */
  async signCommand(_c: { type: "ssh_write" | "ssh_danger"; agent: string; server: string; command: string }, _typedServer?: string): Promise<Record<string, unknown>> {
    throw new Error("Команды на серверах доступны только в кластере");
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

/** То, чем сессия кластера отличается от сессии одиночного сервера. */
export type ClusterAuth = {
  deviceId: string;
  /** Пространство, для которого подписываются действия (u-<ник>); у сессии самого api.<домен> его нет. */
  space?: string;
  /** Новый токен доступа Keycloak (обновление по refresh-токену с DPoP); now — секунды. */
  token(now: number): Promise<{ accessToken: string; expiresIn: number }>;
};

/**
 * Сессия устройства в кластере: адрес api.<домен> (или пространство за ним — api/s/<ник>).
 * Отличия от одиночного сервера:
 *  • токен выпускает Keycloak, а не сам сервер; обновление — по refresh-токену с DPoP, без браузера;
 *  • соединение — mTLS сертификатом устройства (его задаёт http), и control-plane сверяет сертификат,
 *    токен и DPoP-доказательство: все три относятся к одному ключу сессии;
 *  • отдельной сверки часов нет — берём часы телефона.
 * Запросы, поток и подпись действий — общие с DeviceSession.
 */
export class ClusterSession extends DeviceSession {
  constructor(http: Http, server: ServerRecord, keys: DeviceKeys, private auth: ClusterAuth, events: SessionEvents = {}) {
    super(http, server, keys, events);
    this.clockSynced = true;
  }

  /** Повторы при 503: 36 × 2,5 с = полторы минуты — хватает на запуск пода после сна. */
  static retries = 36;
  static retryMs = 2500;

  override get deviceId(): string {
    return this.auth.deviceId;
  }

  override async syncClock(): Promise<void> {
    this.clockSynced = true;
  }

  protected override async newToken(): Promise<Token> {
    const t = await this.auth.token(this.now());
    return { value: t.accessToken, exp: this.now() + (t.expiresIn || 300) };
  }

  /**
   * В кластере разрешение агенту — подписанное действие tool_approve (компактный JWS) для ЭТОГО пространства.
   * Агент пространства сам подписи не проверяет: он отдаёт её keyguard, а тот сверяет с реестром устройств.
   */
  override async signApproval(a: { approvalId: string; tool: string; argsHash: string; title: string }): Promise<Record<string, unknown>> {
    if (!this.auth.space) throw new Error("Сессия не привязана к пространству");
    const signed = await signClusterAction(
      this.keys,
      { type: "tool_approve", approval: a.approvalId, tool: a.tool, args_sha256: a.argsHash },
      { space: this.auth.space, nowMs: this.now() * 1000 },
    );
    return { jws: signed.jws };
  }

  /**
   * Команда агента на сервере: подписывается сама команда — сервер, агент и текст байт в байт. Для опасной команды
   * в подпись входит имя сервера, которое человек ввёл руками; шлюз сверит его с настоящим.
   */
  override async signCommand(c: { type: "ssh_write" | "ssh_danger"; agent: string; server: string; command: string }, typedServer?: string): Promise<Record<string, unknown>> {
    if (!this.auth.space) throw new Error("Сессия не привязана к пространству");
    const body = c.type === "ssh_danger"
      ? { type: c.type, agent: c.agent, server: c.server, command: c.command, typed_server: typedServer ?? "" }
      : { type: c.type, agent: c.agent, server: c.server, command: c.command };
    const signed = await signClusterAction(this.keys, body, { space: this.auth.space, nowMs: this.now() * 1000 });
    return { jws: signed.jws };
  }

  /**
   * 503 от кластера значит «пространство запускается»: обновление агента, новый ключ — секунды; пробуждение
   * после сна (первый запрос сам его будит) — до минуты. Повторяем сами, чтобы экран не показывал ошибку
   * на ровном месте; потоки переподключаются своим механизмом.
   */
  override async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await super.request<T>(method, path, body);
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 503 || attempt >= ClusterSession.retries) throw e;
        await new Promise((r) => setTimeout(r, ClusterSession.retryMs));
      }
    }
  }
}
