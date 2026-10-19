/**
 * Данные базы знаний для страницы в WebView. Страница получает их одним присваиванием до своей загрузки.
 * JSON вставляется в текст скрипта, поэтому всё, что могло бы выйти из строкового литерала или закрыть тег
 * <script>, заменяется на \\u-последовательности: тексты заметок пишет в том числе агент по чужим данным.
 */
export function kbInjection(data: unknown, view: string | null, all = false): string {
  // "<", ">", "&" и разделители строк U+2028 / U+2029 (заданы кодами, чтобы в исходнике не было самих символов)
  const risky = new RegExp("[<>&" + String.fromCharCode(0x2028, 0x2029) + "]", "g");
  const json = JSON.stringify(data).replace(risky, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  const v = view && /^(brain|web|tree)$/.test(view) ? view : "tree";
  // all — показать все заметки (иначе при сотнях заметок страница сворачивает менее нужные)
  return `window.KB_DATA=${json};window.KB_VIEW=${JSON.stringify(v)};window.KB_ALL=${all ? "true" : "false"};true;`;
}

/** Сообщение от страницы: только известные типы и поля. Всё остальное игнорируется. */
export type KbMessage = { type: "ready"; notes: number; edges: number } | { type: "edit"; mid: number } | { type: "view"; key: string } | { type: "error"; message: string } | { type: "all" };

export function parseKbMessage(raw: string): KbMessage | null {
  let m: any;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m !== "object") return null;
  switch (m.type) {
    case "ready":
      return { type: "ready", notes: Number(m.notes) || 0, edges: Number(m.edges) || 0 };
    case "edit":
      return Number.isInteger(m.mid) && m.mid > 0 ? { type: "edit", mid: m.mid } : null;
    case "view":
      return /^(brain|web|tree)$/.test(String(m.key)) ? { type: "view", key: m.key } : null;
    case "error":
      return { type: "error", message: String(m.message).slice(0, 300) };
    case "all":
      return { type: "all" };
    default:
      return null;
  }
}
