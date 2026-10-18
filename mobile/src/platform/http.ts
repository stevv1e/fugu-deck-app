/**
 * Транспорт приложения.
 *  • обычный: fetch для запросов, XMLHttpRequest для потоков (fetch в React Native не умеет читать тело по кускам);
 *  • с mTLS: нативный модуль fd-secure — TLS-рукопожатие подписывает ключ сессии в чипе.
 */
import { FdSecure } from "fd-secure";

import { randomId } from "@/core/bytes";
import { ApiError, errorFrom, fetchHttp, type Http } from "@/core/http";

function xhrStream(): Http["stream"] {
  return (req, on) => {
    const xhr = new XMLHttpRequest();
    let seen = 0;
    let opened = false;
    let done = false;
    const flush = () => {
      const t = xhr.responseText || "";
      if (t.length > seen) {
        const chunk = t.slice(seen);
        seen = t.length;
        if (xhr.status === 200) on.onChunk(chunk);
      }
    };
    xhr.open(req.method, req.url);
    for (const [k, v] of Object.entries(req.headers)) xhr.setRequestHeader(k, v);
    xhr.onreadystatechange = () => {
      if (xhr.readyState >= 2 && !opened) {
        opened = true;
        on.onOpen?.(xhr.status);
      }
      if (xhr.readyState === 3) flush();
      if (xhr.readyState === 4 && !done) {
        done = true;
        if (xhr.status === 200) {
          flush();
          on.onEnd(undefined, 200);
        } else {
          on.onEnd(xhr.status ? errorFrom(xhr.status, xhr.responseText) : new ApiError(0, "Сервер недоступен"), xhr.status);
        }
      }
    };
    xhr.onprogress = flush;
    xhr.onerror = () => {
      if (!done) {
        done = true;
        on.onEnd(new ApiError(0, "Сеть недоступна"));
      }
    };
    xhr.send();
    return {
      close() {
        done = true;
        xhr.abort();
      },
    };
  };
}

export function plainHttp(): Http {
  const base = fetchHttp((...a) => fetch(...a));
  return { request: base.request, stream: xhrStream() };
}

/** Транспорт с клиентским сертификатом: certAlias — псевдоним ключа сессии в чипе. */
export function mtlsHttp(certAlias: string): Http {
  const mod = FdSecure;
  if (!mod) throw new Error("mTLS доступен только в сборке с модулем fd-secure");
  return {
    async request(req) {
      try {
        const r = await mod.request({ ...req, body: req.body ?? null, certAlias, timeoutMs: req.timeoutMs ?? 30000 });
        return { status: r.status, text: r.body };
      } catch (e: any) {
        throw new ApiError(0, "Сервер недоступен: " + (e?.message || e));
      }
    },
    stream(req, on) {
      const id = randomId(9);
      let buf = "";
      let status = 0;
      const subs = [
        mod.addListener("onStreamOpen", (e) => {
          if (e.id !== id) return;
          status = e.status;
          on.onOpen?.(e.status);
        }),
        mod.addListener("onStreamChunk", (e) => {
          if (e.id !== id) return;
          if (status === 200) on.onChunk(e.text);
          else buf += e.text;
        }),
        mod.addListener("onStreamEnd", (e) => {
          if (e.id !== id) return;
          subs.forEach((s) => s.remove());
          const st = e.status ?? status;
          if (e.error) on.onEnd(new ApiError(0, e.error), st);
          else on.onEnd(st === 200 ? undefined : errorFrom(st, buf), st);
        }),
      ];
      mod.openStream(id, { ...req, body: null, certAlias, timeoutMs: 3600_000 });
      return {
        close() {
          subs.forEach((s) => s.remove());
          mod.closeStream(id);
        },
      };
    },
  };
}

export const nativeMtlsAvailable = () => !!FdSecure;
