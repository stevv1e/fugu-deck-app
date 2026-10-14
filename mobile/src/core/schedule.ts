/** Форма задания по расписанию: проверка ввода и сборка запроса (сервер проверяет то же самое). */
import type { Schedule, ScheduleInput, ScheduleKind } from "./api";

export const WEEKDAYS = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
export const KIND_TITLES: Record<ScheduleKind, string> = { daily: "каждый день", weekly: "по дням недели", hourly: "каждый час", once: "один раз" };

export type ScheduleForm = {
  title: string; prompt: string; kind: ScheduleKind; time: string; weekdays: number[]; date: string; model: string; tz: string;
};

/** Часовой пояс телефона: в нём человек и задаёт время. */
export function deviceTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

export function emptyForm(model: string): ScheduleForm {
  const d = new Date(Date.now() + 3600_000);
  return { title: "", prompt: "", kind: "daily", time: "09:00", weekdays: [0, 1, 2, 3, 4], date: `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`, model, tz: deviceTz() };
}

export function formOf(s: Schedule): ScheduleForm {
  const d = s.run_at ? new Date(s.run_at * 1000) : new Date();
  return {
    title: s.title, prompt: s.prompt, kind: s.kind, weekdays: s.weekdays, model: s.model, tz: s.tz,
    time: s.kind === "once" ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : s.at_time,
    date: `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`,
  };
}

/** Время «ЧЧ:ММ» (для «каждый час» — минуты, «:15» или «15»). */
export function normTime(kind: ScheduleKind, t: string): string | null {
  const v = t.trim();
  if (kind === "hourly") {
    const m = /^:?(\d{1,2})$/.exec(v) ?? /^\d{1,2}:(\d{2})$/.exec(v); // «:15», «15» или «09:15»
    const mm = m ? Number(m[1]) : NaN;
    return mm >= 0 && mm < 60 ? `00:${pad(mm)}` : null;
  }
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(v);
  if (!m) return null;
  const h = Number(m[1]), mm = Number(m[2]);
  return h < 24 && mm < 60 ? `${pad(h)}:${pad(mm)}` : null;
}

/** Ввод формы → запрос; строка — что исправить. Дата разового задания — по часам телефона. */
export function buildSchedule(f: ScheduleForm, now = Date.now()): ScheduleInput | string {
  if (!f.title.trim()) return "Нужно название";
  if (!f.prompt.trim()) return "Нужно, что поручить агенту";
  const t = normTime(f.kind, f.time);
  if (!t) return f.kind === "hourly" ? "Минуты — от 0 до 59" : "Время — в виде ЧЧ:ММ";
  const base: ScheduleInput = { title: f.title.trim(), prompt: f.prompt.trim(), kind: f.kind, at_time: t, weekdays: [], tz: f.tz, model: f.model || undefined, run_at: null };
  if (f.kind === "weekly") {
    if (!f.weekdays.length) return "Выберите хотя бы один день недели";
    return { ...base, weekdays: [...f.weekdays].sort() };
  }
  if (f.kind === "once") {
    const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(f.date.trim());
    if (!m) return "Дата — в виде ДД.ММ.ГГГГ";
    const [h, mm] = t.split(":").map(Number);
    const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), h, mm);
    if (d.getDate() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1) return "Такой даты нет";
    if (d.getTime() <= now) return "Это время уже прошло";
    return { ...base, run_at: Math.floor(d.getTime() / 1000) };
  }
  return base;
}

export function whenText(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString("ru-RU", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
