/** Один ответ модели: запрос провайдеру и сборка потока в текст. Сеть передаётся снаружи — так это тестируется. */
import { buildRequest, errorText, parseEvent, PROVIDERS, splitModel, SseParser, type Msg, type Usage } from "./providers";

export type StreamFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal },
  onChunk: (text: string) => void,
) => Promise<{ status: number; text: string }>; // text — тело целиком, только при ошибке (status ≥ 400)

export type Answer = { text: string; reasoning: string; usage: Usage };

export async function ask(net: StreamFetch, model: string, msgs: Msg[], system: string, key: string,
  onUpdate: (a: Answer) => void, signal?: AbortSignal): Promise<Answer> {
  const style = PROVIDERS[splitModel(model)[0]].style;
  const req = buildRequest(model, msgs, system, key);
  const a: Answer = { text: "", reasoning: "", usage: { input: 0, output: 0 } };
  const sse = new SseParser();
  let failed: string | null = null;
  const take = (events: string[]) => {
    for (const ev of events) {
      const d = parseEvent(style, ev);
      if (d.error) failed = d.error;
      if (d.text) a.text += d.text;
      if (d.reasoning) a.reasoning += d.reasoning;
      if (d.usage) a.usage = { input: d.usage.input ?? a.usage.input, output: d.usage.output ?? a.usage.output };
    }
  };
  const r = await net(req.url, { method: "POST", headers: req.headers, body: req.body, signal }, (chunk) => {
    take(sse.push(chunk));
    onUpdate({ ...a });
  });
  if (r.status >= 400) throw new Error(errorText(r.status, r.text, key));
  take(sse.flush());
  if (failed) throw new Error(failed);
  if (!a.text && !a.reasoning) throw new Error("Модель вернула пустой ответ");
  return a;
}

/** Заголовок чата из первого сообщения. */
export function titleOf(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  return line.length > 60 ? line.slice(0, 60) + "…" : line || "Новый чат";
}
