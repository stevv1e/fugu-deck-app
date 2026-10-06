/**
 * Как сервер попадает в приложение:
 *  • QR-приглашение владельца: fugudeck://add?url=…&fp=…&name=… — адрес и отпечаток ключа сервера сразу;
 *  • адрес вручную — приложение покажет отпечаток, человек сверит его с тем, что сообщил владелец.
 * Свой разбор URL: URL в React Native реализован не полностью.
 */
import { normFp } from "./crypto";

export type Invite = { url: string; fp?: string; name?: string; source: "qr" | "manual" };

export class InviteError extends Error {}

function decode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

function query(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split("&")) {
    if (!part) continue;
    const i = part.indexOf("=");
    out[decode(i < 0 ? part : part.slice(0, i))] = i < 0 ? "" : decode(part.slice(i + 1));
  }
  return out;
}

const PRIVATE = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\]|[^.]+\.local|[^.]+\.lan|10\.0\.2\.2)$/i;

/** Привести адрес к виду https://host[:port][/path] без хвостового слэша. http — только для локальной сети. */
export function normalizeServerUrl(input: string): string {
  let s = input.trim();
  if (!s) throw new InviteError("Введите адрес сервера");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "https://" + s;
  const m = /^(https?):\/\/(\[[0-9a-f:.]+\]|[^/?#:@\s]+)(?::(\d{1,5}))?(\/[^?#\s]*)?(?:[?#].*)?$/i.exec(s);
  if (!m) throw new InviteError("Не похоже на адрес сервера");
  const scheme = m[1].toLowerCase();
  const host = m[2].toLowerCase();
  const port = m[3] && !((scheme === "https" && m[3] === "443") || (scheme === "http" && m[3] === "80")) ? ":" + m[3] : "";
  const path = (m[4] || "").replace(/\/+$/, "");
  if (scheme === "http" && !PRIVATE.test(host)) {
    throw new InviteError("Без HTTPS можно подключаться только к серверу в локальной сети");
  }
  return `${scheme}://${host}${port}${path}`;
}

export const isInsecure = (url: string) => url.startsWith("http://");

/** Разобрать QR, ссылку-приглашение или введённый адрес. */
export function parseInvite(text: string): Invite {
  const s = text.trim();
  const m = /^fugudeck:\/\/add\/?\?(.*)$/i.exec(s);
  if (m) {
    const q = query(m[1]);
    if (!q.url) throw new InviteError("В приглашении нет адреса сервера");
    const fp = q.fp ? normFp(q.fp) : undefined;
    if (fp && !/^[A-Z2-7]{52}$/.test(fp)) throw new InviteError("Отпечаток в приглашении повреждён");
    return { url: normalizeServerUrl(q.url), fp, name: q.name || undefined, source: "qr" };
  }
  if (/^fugudeck:/i.test(s)) throw new InviteError("Неизвестная ссылка fugudeck://");
  return { url: normalizeServerUrl(s), source: "manual" };
}

/** Отпечаток для глаз: 13 групп по 4 символа. */
export function formatFp(fp: string): string {
  return normFp(fp).match(/.{1,4}/g)?.join(" ") ?? "";
}

/** Короткая форма для сверки голосом: первые и последние группы. */
export function shortFp(fp: string): string {
  const g = formatFp(fp).split(" ");
  return g.length > 4 ? `${g.slice(0, 2).join(" ")} … ${g.slice(-2).join(" ")}` : g.join(" ");
}

export function inviteLink(url: string, fp: string, name?: string): string {
  const q = [`url=${encodeURIComponent(url)}`, `fp=${normFp(fp)}`];
  if (name) q.push(`name=${encodeURIComponent(name)}`);
  return `fugudeck://add?${q.join("&")}`;
}
