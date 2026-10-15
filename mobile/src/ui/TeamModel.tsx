/**
 * Модель общего чата. Её оплачивает спонсор — участник, который подписал разрешение пользоваться своим ключом
 * в заданных пределах (лимит в долларах, срок, кто допущен). Сменить модель — предложить свою и оплатить её;
 * остальные голосуют. Подпись — на телефоне (биометрия), проверяет её keyguard.
 */
import { useState } from "react";

import type { DeckApi } from "@/core/api";
import { proposeModel, termsProblem, vote, withdrawSponsorship, type TeamChatState } from "@/core/teams";
import { getCluster, parseSid } from "@/state/cluster";
import { openClusterSession, spaceKey } from "@/state/clusterSession";

import { Btn, Card, errText, Field, Notice, Row, Txt } from "./kit";
import { useTheme } from "./theme";

const short = (m: string) => m.split(":").pop() || m;
const money = (v: number | null | undefined) => (v == null ? "—" : `$${(Math.round(v * 100) / 100).toString()}`);

export function TeamModel({ sid, cid, api, state, model, meId, canWrite, onChanged }: {
  sid: string; cid: string; api: DeckApi; state: TeamChatState; model: string; meId?: string; canWrite: boolean; onChanged(): void;
}) {
  const { p } = useTheme();
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<string[] | null>(null);
  const [pick, setPick] = useState("");
  const [limit, setLimit] = useState("20");
  const [days, setDays] = useState("7");
  const [perDay, setPerDay] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const sponsor = state.sponsor ?? null;
  const prop = state.proposal ?? null;

  const run = async (tag: string, f: () => Promise<unknown>) => {
    setBusy(tag);
    setErr(null);
    try {
      await f();
      onChanged();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
      setArmed(false);
    }
  };

  const cluster = async () => {
    const sp = parseSid(sid);
    const rec = sp && (await getCluster(sp.cluster));
    if (!sp || !rec) throw new Error("Кластер не найден");
    return { session: await openClusterSession(rec, rec.api), key: spaceKey(rec, sp.team) };
  };

  const showForm = async () => {
    setOpen(true);
    if (!models) {
      try {
        const m = (await api.config()).models;
        setModels(m);
        setPick(m.find((x) => x !== model) || m[0] || "");
      } catch (e) {
        setErr(errText(e));
      }
    }
  };

  const terms = { limitUsd: Number(limit.replace(",", ".")), days: Number(days), perMemberUsdDay: perDay.trim() ? Number(perDay.replace(",", ".")) : null };
  const bad = open ? termsProblem(terms) : null;

  const propose = () => run("propose", async () => {
    const c = await cluster();
    const r = await proposeModel(api.s, c.session, api.s.keys, cid, { model: pick, ...terms });
    setOpen(false);
    if (r.status === "rejected") throw new Error("Предложение не принято — подробности в ленте чата");
  });

  const stop = () => run("stop", async () => {
    const c = await cluster();
    await withdrawSponsorship(api.s, c.session, api.s.keys, c.key, cid, sponsor?.proposal_id);
  });

  return (
    <Card accent={sponsor ? (sponsor.blocked ? p.warn : p.ok) : p.warn}>
      {sponsor ? (
        <>
          <Txt>
            Модель {short(model)} оплачивает {sponsor.id === meId ? "вы" : sponsor.name}
          </Txt>
          <Txt kind="dim">
            Потрачено около {money(sponsor.spent_usd)} из {money(sponsor.limit_usd)}
            {sponsor.until ? ` · до ${new Date(sponsor.until * 1000).toLocaleDateString()}` : ""}
          </Txt>
          {sponsor.blocked ? <Notice kind="warn" text={sponsor.blocked} /> : null}
          {state.by_member?.length ? (
            <Txt kind="small">Расход по участникам: {state.by_member.map((m) => `${m.name} ${money(m.usd)}`).join(" · ")}</Txt>
          ) : null}
        </>
      ) : (
        <Txt>У этого чата пока нет модели. Выберите модель и оплатите её своим ключом — тогда агент сможет отвечать.</Txt>
      )}

      {prop ? (
        <>
          <Txt kind="label">предложение</Txt>
          <Txt>
            {prop.proposer_id === meId ? "Вы предлагаете" : `${prop.proposer_name || prop.proposer_id} предлагает`} {short(prop.model)}
            {prop.limit_usd ? ` · лимит ${money(prop.limit_usd)}` : ""}
          </Txt>
          {prop.grant_id ? (
            <Txt kind="dim">За: {prop.yes.join(", ") || "—"} · нужно {prop.need}{prop.voters ? ` из ${prop.voters}` : ""}{prop.no.length ? ` · против: ${prop.no.join(", ")}` : ""}</Txt>
          ) : (
            <Txt kind="dim">Ждёт подписи спонсора — голосование ещё не началось.</Txt>
          )}
          {canWrite ? (
            prop.proposer_id === meId ? (
              <Btn title="Отменить предложение" small kind="ghost" onPress={() => run("vote", () => vote(api.s, prop.id, false))} busy={busy === "vote"} disabled={!!busy} />
            ) : prop.grant_id && prop.my_vote === null ? (
              <Row>
                <Btn title="За" small kind="ok" onPress={() => run("vote", () => vote(api.s, prop.id, true))} busy={busy === "vote"} disabled={!!busy} />
                <Btn title="Против" small kind="ghost" onPress={() => run("vote", () => vote(api.s, prop.id, false))} disabled={!!busy} />
              </Row>
            ) : prop.my_vote !== null ? (
              <Txt kind="small">Ваш голос: {prop.my_vote ? "за" : "против"}</Txt>
            ) : null
          ) : null}
        </>
      ) : null}

      {err ? <Notice text={err} /> : null}

      {canWrite && !open ? (
        <Row>
          <Btn title={sponsor ? "Предложить другую модель" : "Выбрать модель"} small kind={sponsor ? "ghost" : "primary"} onPress={showForm} disabled={!!busy} />
          {sponsor && sponsor.id === meId ? (
            armed ? (
              <Btn title="Да, перестать" small kind="danger" onPress={stop} busy={busy === "stop"} disabled={!!busy} />
            ) : (
              <Btn title="Перестать оплачивать" small kind="ghost" onPress={() => setArmed(true)} disabled={!!busy} />
            )
          ) : null}
        </Row>
      ) : null}

      {open ? (
        <>
          <Txt kind="dim">
            Вы станете спонсором: чат будет пользоваться вашим ключом в этих пределах, даже когда вы не в сети.
            Ваш ключ никто не увидит; отозвать разрешение можно в любой момент.
          </Txt>
          <Row gap={6} style={{ flexWrap: "wrap" }}>
            {(models ?? []).map((m) => (
              <Btn key={m} small title={short(m)} kind={m === pick ? "primary" : "ghost"} onPress={() => setPick(m)} />
            ))}
          </Row>
          <Field label="Лимит, долларов" value={limit} onChangeText={setLimit} keyboardType="decimal-pad" />
          <Field label="Срок, дней" value={days} onChangeText={setDays} keyboardType="number-pad" />
          <Field label="На одного участника в день, долларов (необязательно)" value={perDay} onChangeText={setPerDay} keyboardType="decimal-pad" hint={bad ?? undefined} />
          <Row>
            <Btn title="Подписать и предложить ⌁" onPress={propose} busy={busy === "propose"} disabled={!!busy || !pick || !!bad} style={{ flex: 1.6 }} />
            <Btn title="Отмена" kind="ghost" onPress={() => setOpen(false)} disabled={!!busy} style={{ flex: 1 }} />
          </Row>
        </>
      ) : null}
    </Card>
  );
}
