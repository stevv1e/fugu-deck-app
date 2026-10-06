import { useState } from "react";
import { api, type Config, type ConversationFull, type ModelPolicy } from "../api";
import { IconX } from "./icons";
import { modelLabel, providerOf, usd } from "./Sidebar";
import { draftFrom, draftToTerms, fmtTokens, termsText, TermsEditor, termsValid, type TermsDraft } from "./SponsorTerms";

const PROVIDER: Record<string, string> = { anthropic: "Claude", sakana: "Sakana", openai: "OpenAI", xai: "Grok" };

/** Модель общего чата: одна на чат, меняется предложением, платит спонсор. */
export function ModelSheet(props: {
  config: Config;
  conv: ConversationFull;
  meId: string;
  fresh?: boolean; // новый чат: выбор модели без голосования
  onClose: () => void;
  onChanged: () => void;
  toast: (m: string) => void;
}) {
  const { conv, config } = props;
  const ready = config.llm_ready || [];
  const mine = config.models.filter((m) => ready.includes(providerOf(m)));
  const iAmSponsor = conv.sponsor?.id === props.meId;
  const [mineTerms, setMineTerms] = useState<TermsDraft>(draftFrom(iAmSponsor ? conv.sponsor : null));
  const [newTerms, setNewTerms] = useState<TermsDraft>(draftFrom(null));
  const [pick, setPick] = useState<string>(props.fresh ? (mine.includes(conv.model) ? conv.model : mine[0] || "") : mine.find((m) => m !== conv.model) || "");
  const [busy, setBusy] = useState(false);
  const [policy, setPolicy] = useState<ModelPolicy>(conv.model_policy || "vote");
  const open = conv.model_policy === "open";
  const canPolicy = conv.created_by === props.meId || conv.my_role === "owner";
  const hours = conv.proposal_ttl_hours || 24;

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) props.toast(ok);
      props.onChanged();
      props.onClose();
    } catch (e: any) {
      props.toast(e.message);
    } finally {
      setBusy(false);
    }
  };

  const price = (m: string) => {
    const p = config.pricing[m];
    return p ? `$${p[0]}/$${p[1]}` : "";
  };

  return (
    <div className="modal">
      <div className="scrim" style={{ display: "block" }} onClick={props.onClose} />
      <div className="modal-card">
        <div className="modal-head">
          <h3>// модель чата</h3>
          <button className="icon-btn" onClick={props.onClose}><IconX /></button>
        </div>
        <div className="modal-body">
          <div className="card model-now">
            <div className="label">{props.fresh ? "общий чат" : "сейчас"}</div>
            <b className="mono">{PROVIDER[providerOf(conv.model)]} · {modelLabel(conv.model)}</b>
            {conv.sponsor ? (
              <>
                <span className="dim">платит {iAmSponsor ? "вы" : conv.sponsor.name}{conv.sponsor.online ? "" : " · не в сети"}</span>
                <span className="dim">
                  потрачено {usd(conv.sponsor.spent_usd)} · {fmtTokens(conv.sponsor.spent_tokens)} токенов
                </span>
                <span className="dim">условия: {termsText(conv.sponsor)}</span>
                {conv.sponsor.blocked && <span className="err-line">✕ {conv.sponsor.blocked}</span>}
              </>
            ) : <span className="err-line">нет спонсора — агент не запустится, пока кто-то не предложит модель</span>}
          </div>

          {!props.fresh && (
            <div className="card policy-card">
              <span className="grow">
                <span className="label">смена модели</span>{" "}
                <b>{open ? "разрешена коллегам" : `по голосованию (${hours} ч)`}</b>
              </span>
              {canPolicy && (
                <button className="btn slim" disabled={busy}
                  onClick={() => run(() => api.setPolicy(conv.id, open ? "vote" : "open"), "Правило изменено")}>
                  {open ? "→ голосование" : "→ свободно"}
                </button>
              )}
            </div>
          )}

          {iAmSponsor && (
            <div className="card">
              <div className="label">вы оплачиваете этот чат своим ключом — условия</div>
              <TermsEditor config={config} model={conv.model} value={mineTerms} onChange={setMineTerms}
                currentUntil={conv.sponsor?.until} />
              <div className="row-end">
                <button className="btn slim primary" disabled={busy || !termsValid(mineTerms, !!conv.sponsor?.until)}
                  onClick={() => run(() => api.patchSponsor(conv.id, draftToTerms(mineTerms, false)), "Условия сохранены")}>сохранить</button>
                <button className="btn slim danger" disabled={busy}
                  onClick={() => confirm("Перестать оплачивать этот чат? Агент остановится, пока кто-то не предложит модель.") &&
                    run(() => api.patchSponsor(conv.id, { withdraw: true }))}>перестать оплачивать</button>
              </div>
            </div>
          )}

          <div className="card">
            <div className="label">{props.fresh ? "модель нового чата" : open ? "сменить модель" : "предложить другую модель"}</div>
            <p className="hint" style={{ margin: "6px 0 10px" }}>
              {props.fresh
                ? "В общем чате работает одна модель, и её оплачивает спонсор. Выберите модель, для которой у вас есть ключ, и ограничение: сумму или срок."
                : open
                  ? "В этом чате модель может сменить любой редактор. Смена происходит сразу, и вы становитесь спонсором: запросы всех участников оплачиваются вашим ключом."
                  : `Смена модели — голосованием: нужно большинство редакторов и владельцев, голосование длится ${hours} ч. Вы голосуете «за» автоматически и после перехода становитесь спонсором.`}
            </p>
            {mine.length ? (
              <>
                <div className="model-list">
                  {mine.map((m) => (
                    <label key={m} className={`check ${m === conv.model && !props.fresh ? "dim" : ""}`}>
                      <input type="radio" name="m" checked={pick === m} disabled={m === conv.model && iAmSponsor}
                        onChange={() => setPick(m)} />
                      <span>{PROVIDER[providerOf(m)]} · {modelLabel(m)}</span>
                      <small>{price(m)}</small>
                    </label>
                  ))}
                </div>
                {pick && (
                  <>
                    <div className="label" style={{ marginTop: 10 }}>ваши условия оплаты</div>
                    <TermsEditor config={config} model={pick} value={newTerms} onChange={setNewTerms} />
                  </>
                )}
                {props.fresh && (
                  <>
                    <div className="label" style={{ marginTop: 10 }}>смена модели в этом чате</div>
                    <div className="model-list">
                      <label className="check">
                        <input type="radio" name="pol" checked={policy === "vote"} onChange={() => setPolicy("vote")} />
                        <span>по голосованию</span><small>большинство, {hours} ч</small>
                      </label>
                      <label className="check">
                        <input type="radio" name="pol" checked={policy === "open"} onChange={() => setPolicy("open")} />
                        <span>разрешена коллегам</span><small>любой редактор, сразу</small>
                      </label>
                    </div>
                  </>
                )}
                <div className="row-end">
                  <button className="btn primary" disabled={busy || !pick || (pick === conv.model && iAmSponsor) || !termsValid(newTerms)}
                    onClick={() => run(async () => {
                      const r = await api.proposeModel(conv.id, pick, draftToTerms(newTerms, true), props.fresh ? policy : undefined);
                      props.toast(r.applied ? (props.fresh ? "Модель и условия оплаты выбраны" : "Модель сменена") : `Голосование началось (${hours} ч)`);
                    })}>{props.fresh ? "выбрать" : open ? "сменить" : "предложить"}</button>
                </div>
              </>
            ) : (
              <div className="notice">// у вас нет ключей ИИ — добавьте их в «Настройки → Ключи API»</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
