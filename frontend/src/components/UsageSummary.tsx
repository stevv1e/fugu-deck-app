import { useEffect, useState } from "react";
import { api, type UsageReport } from "../api";
import { modelLabel, providerOf, usd } from "./Sidebar";
import { fmtTokens } from "./SponsorTerms";
import { Avatar, Seg } from "./ui";

const PERIODS: [string, string][] = [["today", "сегодня"], ["week", "7 дней"], ["month", "30 дней"], ["all", "всё"]];
const PROV: Record<string, string> = { anthropic: "Claude", sakana: "Sakana", openai: "OpenAI", xai: "Grok" };

/** Сводка расходов по участникам: кто сколько запускал и чей ключ сколько оплатил. */
export function UsageSummary({ team, signal }: { team: boolean; signal?: number }) {
  const [period, setPeriod] = useState("month");
  const [rep, setRep] = useState<UsageReport | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    api.usageMembers(period).then((r) => { setRep(r); setErr(""); }).catch((e) => setErr(e.message));
  }, [period, signal]);

  const max = Math.max(0.000001, ...(rep?.members || []).map((m) => Math.max(m.paid_usd, m.launched_usd)));

  return (
    <div className="usage">
      <div className="usage-head">
        <Seg value={period} onChange={setPeriod} options={PERIODS} />
        {rep && <span className="usage-total"><b>{usd(rep.total_usd)}</b> · {fmtTokens(rep.total_tokens)} токенов</span>}
      </div>
      {err && <div className="err-line">✕ {err}</div>}
      {rep && !rep.members.length && <div className="empty-note">за этот период расходов нет</div>}
      {rep?.members.map((m) => (
        <div className={`usage-row ${m.me ? "me" : ""}`} key={m.user_id || "none"}>
          <div className="usage-who">
            <Avatar name={m.name} size={22} />
            <b>{m.name}{m.me ? " · вы" : ""}</b>
          </div>
          {team ? (
            <>
              <div className="usage-bar" title="запустил">
                <span className="lbl">запустил</span>
                <i style={{ width: `${(m.launched_usd / max) * 100}%` }} className="launch" />
                <span className="val">{usd(m.launched_usd)} · {fmtTokens(m.launched_tokens)} · {m.requests} запр.</span>
              </div>
              <div className="usage-bar" title="оплачено его ключом">
                <span className="lbl">оплатил</span>
                <i style={{ width: `${(m.paid_usd / max) * 100}%` }} className="paid" />
                <span className="val">
                  {usd(m.paid_usd)}{m.paid_for_others_usd > 0 ? ` · за других ${usd(m.paid_for_others_usd)}` : ""}
                </span>
              </div>
            </>
          ) : (
            <div className="usage-bar">
              <span className="lbl">всего</span>
              <i style={{ width: `${(m.paid_usd / max) * 100}%` }} className="paid" />
              <span className="val">{usd(m.paid_usd)} · {fmtTokens(m.paid_tokens)} · {m.requests} запр.</span>
            </div>
          )}
        </div>
      ))}
      {!!rep?.models.length && (
        <div className="usage-models">
          {rep.models.map((x) => (
            <span className="chip" key={x.model}>{PROV[providerOf(x.model)] || providerOf(x.model)} · {modelLabel(x.model)}: <b>{usd(x.usd)}</b></span>
          ))}
        </div>
      )}
      {team && <p className="hint">«Запустил» — стоимость запросов, отправленных участником. «Оплатил» — сколько списано с его ключа как спонсора чата, в том числе за запросы других.</p>}
    </div>
  );
}
