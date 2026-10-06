import type { Config, SponsorTerms } from "../api";
import { Seg } from "./ui";

/** Средняя цена токена для пересчёта «токены ⇄ деньги»: агент в основном читает (≈80% вход, 20% выход). */
export function tokenPrice(config: Config, model: string): number | null {
  const p = config.pricing[model];
  return p ? (0.8 * p[0] + 0.2 * p[1]) / 1_000_000 : null;
}

export const fmtTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);

const pad = (n: number) => String(n).padStart(2, "0");
/** YYYY-MM-DD в локальном времени */
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
/** Спонсорство действует до конца выбранного дня (по времени телефона). */
export const endOfDay = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d, 23, 59, 59).getTime() / 1000; };

export function termsText(t: { limit_usd?: number | null; limit_tokens?: number | null; days?: number | null; until?: number | null }) {
  const parts: string[] = [];
  if (t.limit_usd != null) parts.push(`до $${t.limit_usd}`);
  if (t.limit_tokens != null) parts.push(`до ${fmtTokens(t.limit_tokens)} токенов`);
  if (t.until) {
    const end = new Date(t.until * 1000);
    const left = (end.getTime() - Date.now()) / 86_400_000;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const endDay = new Date(end); endDay.setHours(0, 0, 0, 0);
    const days = Math.round((endDay.getTime() - today.getTime()) / 86_400_000); // календарных дней
    parts.push(left <= 0 ? "срок истёк" : `до ${end.toLocaleDateString("ru-RU")} (${days < 1 ? `${Math.max(1, Math.round(left * 24))} ч` : `${days} дн.`})`);
  } else if (t.days) parts.push(`на ${t.days} дн.`);
  return parts.join(", ") || "без ограничений";
}

/** date: "YYYY-MM-DD" — дата окончания; "keep" — оставить текущую; "" — без срока */
export type TermsDraft = { mode: "usd" | "tokens"; amount: string; date: string; dateTouched: boolean };

export const draftFrom = (t?: { limit_usd?: number | null; limit_tokens?: number | null; until?: number | null } | null): TermsDraft => ({
  mode: t?.limit_tokens != null && t?.limit_usd == null ? "tokens" : "usd",
  amount: t?.limit_tokens != null && t?.limit_usd == null ? String(t.limit_tokens) : t?.limit_usd != null ? String(t.limit_usd) : "",
  date: t?.until ? "keep" : t ? "" : ymd(addDays(7)), // новое спонсорство: по умолчанию неделя
  dateTouched: !t,
});

/** Ограничение обязательно: сумма ($ или токены) или срок. */
export function termsValid(d: TermsDraft, hasUntil = false): boolean {
  const n = Number(d.amount.replace(",", ".").replace(/\s/g, ""));
  const money = d.amount.trim() !== "" && isFinite(n) && n > 0;
  const term = d.date === "keep" ? hasUntil : d.date !== "" && endOfDay(d.date) > Date.now() / 1000;
  return money || term;
}

/** В API: сумма либо в $, либо в токенах (второе снимается); срок — только если его меняли. */
export function draftToTerms(d: TermsDraft, includeDate: boolean): SponsorTerms {
  const n = d.amount.trim() === "" ? null : Number(d.amount.replace(",", ".").replace(/\s/g, ""));
  const val = n != null && isFinite(n) && n > 0 ? n : null;
  const out: SponsorTerms = d.mode === "usd"
    ? { limit_usd: val, limit_tokens: null }
    : { limit_tokens: val != null ? Math.max(1000, Math.round(val)) : null, limit_usd: null };
  if ((includeDate || d.dateTouched) && d.date !== "keep") out.until = d.date ? endOfDay(d.date) : null;
  return out;
}

const QUICK: [number, string][] = [[1, "завтра"], [7, "неделя"], [14, "2 недели"], [30, "месяц"]];

export function TermsEditor(props: { config: Config; model: string; value: TermsDraft; onChange: (d: TermsDraft) => void; currentUntil?: number | null }) {
  const { value: d, onChange } = props;
  const tp = tokenPrice(props.config, props.model);
  const n = Number(d.amount.replace(",", ".").replace(/\s/g, ""));
  const hint = !d.amount.trim() || !isFinite(n) || n <= 0 || !tp ? "" :
    d.mode === "usd" ? `≈ ${fmtTokens(Math.round(n / tp))} токенов` : `≈ $${(n * tp).toFixed(n * tp < 1 ? 3 : 2)}`;
  const setDate = (date: string) => onChange({ ...d, date, dateTouched: true });
  const shown = d.date === "keep" && props.currentUntil ? ymd(new Date(props.currentUntil * 1000)) : d.date === "keep" ? "" : d.date;
  return (
    <div className="terms">
      <div className="terms-row">
        <Seg value={d.mode} onChange={(mode) => onChange({ ...d, mode, amount: "" })}
          options={[["usd", "$"], ["tokens", "токены"]]} />
        <input className="input slim" inputMode="decimal"
          placeholder={d.mode === "usd" ? "лимит, $" : "лимит, токенов (напр. 2000000)"}
          value={d.amount} onChange={(e) => onChange({ ...d, amount: e.target.value })} />
      </div>
      {hint && <div className="terms-hint">{hint} <span className="dim">· оценка по цене модели</span></div>}
      <div className="terms-row">
        <span className="label">до</span>
        <input className="input slim date" type="date" min={ymd(addDays(1))} max={ymd(addDays(365))}
          value={shown} onChange={(e) => setDate(e.target.value)} />
        {d.date !== "" && <button type="button" className="btn slim ghost" title="без срока" onClick={() => setDate("")}>×</button>}
      </div>
      <div className="quick">
        {QUICK.map(([n, l]) => (
          <button type="button" key={n} className={`chip ${d.date === ymd(addDays(n)) ? "accent" : ""}`} onClick={() => setDate(ymd(addDays(n)))}>{l}</button>
        ))}
        {props.currentUntil && d.date !== "keep" && (
          <button type="button" className="chip" onClick={() => onChange({ ...d, date: "keep", dateTouched: false })}>оставить текущий</button>
        )}
      </div>
      {d.date === "" && <div className="terms-hint dim">без срока — нужен лимит суммы</div>}
      {!termsValid(d, !!props.currentUntil) && <div className="err-line">нужно ограничение: сумма или дата окончания</div>}
    </div>
  );
}
