/** Что открыто в рабочей области компьютера — по адресу экрана. Без зависимостей: проверяется тестами под Node. */

// expo-router на вебе держит адрес экрана в URL
export type Place = { sid: string | null; pid: string | null; chat: string | null; cluster: string | null; section: string | null };

const CLUSTER_SCREENS = new Set(["cluster", "keys", "mcp", "servers", "devices", "teams"]);

export function placeOf(path: string): Place {
  const parts = path.split("?")[0].split("/").filter(Boolean).map((x) => {
    try {
      return decodeURIComponent(x);
    } catch {
      return x;
    }
  });
  const out: Place = { sid: null, pid: null, chat: null, cluster: null, section: null };
  if (parts[0] === "s" && parts[1]) {
    out.sid = parts[1];
    out.section = parts[2] ?? "";
    if (parts[2] === "c" && parts[3]) out.chat = parts[3];
    if ((parts[2] === "p" || parts[2] === "kb" || parts[2] === "sched") && parts[3]) out.pid = parts[3];
  } else if (parts[0] === "team" && parts[1]) {
    out.sid = parts[1];
    out.section = "team";
  } else if (parts[0] && CLUSTER_SCREENS.has(parts[0]) && parts[1]) {
    out.cluster = parts[1];
    out.section = parts[0];
  } else {
    out.section = parts[0] ?? "";
  }
  return out;
}
