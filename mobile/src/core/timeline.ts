import type { Attachment, RunEvent, StoredMessage } from "./types";

export type ToolStatus = "pending" | "running" | "ok" | "error" | "denied";

export type Item =
  | { kind: "user"; key: string; content: string; attachments?: Attachment[]; author?: string; mine?: boolean }
  | { kind: "assistant"; key: string; content: string; streaming?: boolean; model?: string }
  | {
      kind: "tool";
      key: string;
      callId: string;
      name: string;
      title?: string;
      args: any;
      status: ToolStatus;
      risk?: string;
      approvalId?: string;
      /** Исходный запрос на подтверждение — по нему телефон считает хэш и подписывает. */
      approval?: Extract<RunEvent, { type: "approval_request" }>;
      result?: any;
      error?: string;
    }
  | { kind: "notice"; key: string; level: "info" | "error"; text: string };

let n = 0;
const k = () => `i${++n}`;

/** Лента из сохранённых сообщений чата. */
export function fromStored(messages: StoredMessage[], meId?: string): Item[] {
  const items: Item[] = [];
  const byCall = new Map<string, Extract<Item, { kind: "tool" }>>();
  for (const m of messages) {
    if (m.role === "user") {
      items.push({
        kind: "user", key: k(), content: m.content || "", attachments: m.meta?.attachments,
        author: m.meta?.author, mine: !m.meta?.author_id || m.meta.author_id === meId,
      });
    } else if (m.role === "assistant") {
      if (m.content) items.push({ kind: "assistant", key: k(), content: m.content, model: m.meta?.model });
      for (const tc of m.tool_calls || []) {
        const t: Extract<Item, { kind: "tool" }> = {
          kind: "tool", key: k(), callId: tc.id, name: tc.name, args: tc.args, status: "error",
          error: "не выполнено",
        };
        byCall.set(tc.id, t);
        items.push(t);
      }
    } else if (m.role === "note") {
      items.push({ kind: "notice", key: k(), level: "info", text: m.content || "" });
    } else if (m.role === "tool" && m.tool_call_id) {
      const t = byCall.get(m.tool_call_id);
      if (!t) continue;
      let parsed: any = m.content;
      try {
        parsed = JSON.parse(m.content || "null");
      } catch {}
      if (m.ok) {
        t.status = "ok";
        t.result = parsed;
        t.error = undefined;
      } else {
        const err = parsed?.error || "ошибка";
        t.status = /отклонил|истекло/.test(err) ? "denied" : "error";
        t.error = err;
      }
    }
  }
  return items;
}

/** Применить событие запуска к ленте. Возвращает новый массив (иммутабельно). */
export function applyEvent(items: Item[], e: RunEvent): Item[] {
  const out = items.slice();
  const last = out[out.length - 1];
  const findTool = (callId: string) =>
    out.findIndex((i) => i.kind === "tool" && i.callId === callId);

  switch (e.type) {
    case "text": {
      if (last && last.kind === "assistant" && last.streaming) {
        out[out.length - 1] = { ...last, content: last.content + e.delta };
      } else {
        out.push({ kind: "assistant", key: k(), content: e.delta, streaming: true });
      }
      break;
    }
    case "message_saved": {
      return out.map((i) => (i.kind === "assistant" && i.streaming ? { ...i, streaming: false } : i));
    }
    case "approval_request":
    case "tool_start": {
      const idx = findTool(e.call_id);
      const base = {
        kind: "tool" as const, key: idx >= 0 ? out[idx].key : k(), callId: e.call_id, name: e.name,
        title: e.title, args: e.args, risk: e.risk,
      };
      const next =
        e.type === "approval_request"
          ? { ...base, status: "pending" as ToolStatus, approvalId: e.approval_id, approval: e }
          : { ...base, status: "running" as ToolStatus };
      if (idx >= 0) out[idx] = { ...(out[idx] as any), ...next };
      else out.push(next);
      break;
    }
    case "approval_resolved": {
      const idx = findTool(e.call_id);
      if (idx >= 0) {
        const t = out[idx] as Extract<Item, { kind: "tool" }>;
        out[idx] = { ...t, approvalId: undefined, approval: undefined, status: e.approved ? "running" : "denied" };
      }
      break;
    }
    case "tool_end": {
      const idx = findTool(e.call_id);
      const patch = e.ok ? { status: "ok" as ToolStatus, result: e.result } : { status: "error" as ToolStatus, error: e.error };
      if (idx >= 0) out[idx] = { ...(out[idx] as any), ...patch };
      else out.push({ kind: "tool", key: k(), callId: e.call_id, name: e.name, args: {}, ...patch });
      break;
    }
    case "error":
      out.push({ kind: "notice", key: k(), level: "error", text: e.message });
      break;
    case "notice":
      out.push({ kind: "notice", key: k(), level: "info", text: e.text });
      break;
    case "cancelled":
      out.push({ kind: "notice", key: k(), level: "info", text: "Остановлено" });
      return out.map((i) =>
        i.kind === "assistant" && i.streaming
          ? { ...i, streaming: false }
          : i.kind === "tool" && (i.status === "pending" || i.status === "running")
          ? { ...i, status: "error" as ToolStatus, error: "прервано", approvalId: undefined, approval: undefined }
          : i,
      );
  }
  return out;
}
