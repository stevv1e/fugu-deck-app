/**
 * Провайдеры моделей, к которым Fugu Local обращается напрямую с устройства — без сервера Fugu Deck.
 *
 * Здесь только чистая логика: адреса, заголовки, тела запросов и разбор потоковых ответов (SSE). Сеть — в
 * platform/net.ts, ключи — в platform/secrets.ts. Ключ уходит только провайдеру, которому принадлежит.
 */

export type Provider = "sakana" | "anthropic" | "deepseek" | "openai";

export const PROVIDERS: Record<Provider, { title: string; base: string; style: "openai" | "anthropic"; keyUrl: string; keyPrefix?: string }> = {
  sakana: { title: "Sakana", base: "https://api.sakana.ai/v1", style: "openai", keyUrl: "https://console.sakana.ai" },
  anthropic: { title: "Claude", base: "https://api.anthropic.com/v1", style: "anthropic", keyUrl: "https://console.anthropic.com/settings/keys", keyPrefix: "sk-ant-" },
  deepseek: { title: "DeepSeek", base: "https://api.deepseek.com", style: "openai", keyUrl: "https://platform.deepseek.com/api_keys", keyPrefix: "sk-" },
  openai: { title: "OpenAI", base: "https://api.openai.com/v1", style: "openai", keyUrl: "https://platform.openai.com/api-keys", keyPrefix: "sk-" },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as Provider[];

/** Модели по умолчанию — те же, что на сервере Fugu Deck (backend/app/config.py). Первая — модель нового чата. */
export const DEFAULT_MODELS = [
  "sakana:fugu-max-v1.0", "sakana:fugu-ultra-v2.0", "sakana:sakana-namazu-v1.0", "sakana:fugu",
  "anthropic:claude-sonnet-5", "anthropic:claude-opus-5-5", "anthropic:claude-haiku-4-5",
  "deepseek:deepseek-flash", "deepseek:deepseek-v4-pro",
];

/** Цена за 1M токенов [вход, выход] — для оценки расхода на экране; счёт выставляет провайдер. */
export const PRICES: Record<string, [number, number]> = {
  "sakana:fugu-max-v1.0": [2, 6], "sakana:fugu-ultra-v2.0": [5, 30], "sakana:sakana-namazu-v1.0": [0.95, 4],
  "sakana:fugu": [10, 45],
  "anthropic:claude-sonnet-5": [2, 10], "anthropic:claude-opus-5-5": [4, 20], "anthropic:claude-haiku-4-5": [1, 5],
  "deepseek:deepseek-flash": [0.3, 1.2], "deepseek:deepseek-v4-pro": [1.32, 3.96],
};

export const MAX_TOKENS = 16000;

/** «anthropic:claude-opus-5-5» → ["anthropic", "claude-opus-5-5"]; без префикса — Sakana, как на сервере. */
export function splitModel(m: string): [Provider, string] {
  const i = m.indexOf(":");
  if (i < 0) return ["sakana", m];
  const p = m.slice(0, i) as Provider;
  return [p in PROVIDERS ? p : "sakana", m.slice(i + 1)];
}

export function validModel(m: string): string | null {
  const t = m.trim();
  const i = t.indexOf(":");
  if (i < 1) return "Формат: провайдер:модель, например deepseek:deepseek-flash";
  if (!(t.slice(0, i) in PROVIDERS)) return `Провайдеры: ${PROVIDER_IDS.join(", ")}`;
  if (!/^[A-Za-z0-9._\-/]{1,100}$/.test(t.slice(i + 1))) return "Имя модели: латиница, цифры, . _ - /";
  return null;
}

export type Msg = { role: "user" | "assistant"; content: string };

export type Usage = { input: number; output: number };

export function costUsd(model: string, u: Usage): number | null {
  const pr = PRICES[model];
  return pr ? (u.input * pr[0] + u.output * pr[1]) / 1e6 : null;
}

/** Запрос к провайдеру: адрес, заголовки и тело (потоковый ответ). */
export function buildRequest(model: string, msgs: Msg[], system: string, key: string) {
  const [prov, name] = splitModel(model);
  const P = PROVIDERS[prov];
  if (P.style === "anthropic") {
    return {
      url: `${P.base}/messages`,
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        // Без него API Anthropic не отвечает запросам из браузерного окружения (CORS) — ключ и так у владельца.
        "anthropic-dangerous-direct-browser-access": "true",
      } as Record<string, string>,
      body: JSON.stringify({ model: name, max_tokens: MAX_TOKENS, stream: true, ...(system.trim() ? { system } : {}), messages: msgs }),
    };
  }
  const messages = system.trim() ? [{ role: "system", content: system }, ...msgs] : msgs;
  return {
    url: `${P.base}/chat/completions`,
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` } as Record<string, string>,
    body: JSON.stringify({ model: name, messages, stream: true, max_tokens: MAX_TOKENS, stream_options: { include_usage: true } }),
  };
}

/** Разбор SSE по кускам произвольной длины: возвращает полезную нагрузку строк «data: …» каждого события. */
export class SseParser {
  private buf = "";
  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.buf);
      if (!m) break;
      const ev = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      const data = ev.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
      if (data) out.push(data);
    }
    return out;
  }
  /** Хвост без завершающей пустой строки (некоторые API так заканчивают поток). */
  flush(): string[] {
    const rest = this.buf;
    this.buf = "";
    return rest.trim() ? this.push(rest + "\n\n") : [];
  }
}

export type Delta = { text?: string; reasoning?: string; usage?: Partial<Usage>; done?: boolean; error?: string };

/** Одно событие потока → что добавить к ответу. */
export function parseEvent(style: "openai" | "anthropic", data: string): Delta {
  if (style === "openai" && data.trim() === "[DONE]") return { done: true };
  let j: any;
  try {
    j = JSON.parse(data);
  } catch {
    return {};
  }
  if (j?.error) return { error: String(j.error.message ?? j.error) };
  if (style === "anthropic") {
    switch (j.type) {
      case "message_start":
        return { usage: { input: tokensIn(j.message?.usage) } };
      case "content_block_delta":
        if (j.delta?.type === "text_delta") return { text: j.delta.text };
        if (j.delta?.type === "thinking_delta") return { reasoning: j.delta.thinking };
        return {};
      case "message_delta":
        return j.usage?.output_tokens != null ? { usage: { output: j.usage.output_tokens } } : {};
      case "message_stop":
        return { done: true };
      default:
        return {};
    }
  }
  const d: Delta = {};
  const delta = j.choices?.[0]?.delta;
  if (delta?.content) d.text = delta.content;
  if (delta?.reasoning_content) d.reasoning = delta.reasoning_content;
  if (j.usage) d.usage = { input: j.usage.prompt_tokens ?? 0, output: j.usage.completion_tokens ?? 0 };
  return d;
}

function tokensIn(u: any): number {
  if (!u) return 0;
  return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
}

/** Текст ошибки из ответа провайдера (JSON или как есть), без ключа, даже если провайдер его повторил. */
export function errorText(status: number, body: string, key: string): string {
  let msg = body;
  try {
    const j = JSON.parse(body);
    msg = j?.error?.message ?? j?.message ?? j?.error ?? body;
  } catch {
    /* не JSON */
  }
  msg = String(msg).slice(0, 400);
  if (key) msg = msg.split(key).join("[ключ]");
  const hint = status === 401 || status === 403 ? " — проверьте ключ в настройках" : status === 429 ? " — лимит запросов или баланс у провайдера" : "";
  return `${status}: ${msg}${hint}`;
}

/** Потоковый декодер UTF-8: многобайтовый символ может разрезаться между кусками сети. */
export class Utf8Stream {
  private rest: number[] = [];
  push(bytes: Uint8Array): string {
    const all = this.rest.length ? Uint8Array.from([...this.rest, ...bytes]) : bytes;
    let end = all.length;
    // откатываемся к началу незавершённого символа в конце
    for (let i = Math.max(0, all.length - 3); i < all.length; i++) {
      const b = all[i];
      const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
      if (need > 1 && i + need > all.length) {
        end = i;
        break;
      }
    }
    this.rest = Array.from(all.slice(end));
    return decodeUtf8(all.subarray(0, end));
  }
}

function decodeUtf8(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; ) {
    const c = b[i];
    let cp: number;
    if (c < 0x80) { cp = c; i += 1; }
    else if (c < 0xe0) { cp = ((c & 0x1f) << 6) | (b[i + 1] & 0x3f); i += 2; }
    else if (c < 0xf0) { cp = ((c & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f); i += 3; }
    else { cp = ((c & 0x07) << 18) | ((b[i + 1] & 0x3f) << 12) | ((b[i + 2] & 0x3f) << 6) | (b[i + 3] & 0x3f); i += 4; }
    s += String.fromCodePoint(cp);
  }
  return s;
}
