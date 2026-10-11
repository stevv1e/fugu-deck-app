/**
 * Транспорт: ядро не знает, чем делаются запросы. В приложении — fetch/XHR или нативный
 * транспорт с клиентским сертификатом (mTLS), в тестах — fetch из Node.
 */
export type HttpRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
};

export type HttpResponse = { status: number; text: string };

export interface StreamHandle {
  close(): void;
}

export interface Http {
  request(req: HttpRequest): Promise<HttpResponse>;
  /** Потоковый GET (SSE). onChunk получает текст по мере прихода, onEnd — когда поток закрыт. */
  stream(
    req: HttpRequest,
    on: { onOpen?(status: number): void; onChunk(text: string): void; onEnd(err?: Error, status?: number): void },
  ): StreamHandle;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

export function errorFrom(status: number, text: string): ApiError {
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {}
  // Три формата: агент отдаёт {detail}, control-plane и keyguard — {error: "текст"}, Keycloak — {error, error_description}.
  // Без двух последних экран показывал бы «Ошибка 403» вместо причины, которую сервер назвал.
  const detail = body?.detail;
  const named = typeof body?.error_description === "string" ? body.error_description : typeof body?.error === "string" ? body.error : null;
  const msg =
    typeof detail === "string"
      ? detail
      : Array.isArray(detail)
        ? detail.map((d: any) => d?.msg).filter(Boolean).join("; ")
        : named
          ? named
          : status === 0
            ? "Сервер недоступен"
            : `Ошибка ${status}`;
  return new ApiError(status, msg, body);
}

/** Реализация на fetch: Node 18+, браузер, React Native (для запросов; поток — см. platform/http). */
export function fetchHttp(f: typeof fetch = fetch): Http {
  return {
    async request(req) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), req.timeoutMs ?? 30000);
      try {
        const r = await f(req.url, { method: req.method, headers: req.headers, body: req.body, signal: ctl.signal });
        return { status: r.status, text: await r.text() };
      } catch (e: any) {
        throw new ApiError(0, e?.name === "AbortError" ? "Сервер не ответил вовремя" : "Сервер недоступен: " + (e?.message || e));
      } finally {
        clearTimeout(t);
      }
    },
    stream(req, on) {
      const ctl = new AbortController();
      let closed = false;
      (async () => {
        try {
          const r = await f(req.url, { method: req.method, headers: req.headers, signal: ctl.signal });
          on.onOpen?.(r.status);
          if (r.status !== 200 || !r.body) {
            const text = await r.text();
            on.onEnd(errorFrom(r.status, text), r.status);
            return;
          }
          const reader = r.body.getReader();
          const dec = new TextDecoder();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            on.onChunk(dec.decode(value, { stream: true }));
          }
          on.onEnd(undefined, 200);
        } catch (e: any) {
          if (!closed) on.onEnd(e instanceof Error ? e : new Error(String(e)));
        }
      })();
      return {
        close() {
          closed = true;
          ctl.abort();
        },
      };
    },
  };
}
