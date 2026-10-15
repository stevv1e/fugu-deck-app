/**
 * Серверы пользователя: куда агент может ходить и что ему там можно без спроса.
 * Сервер добавляется подписью: адрес, пользователь и отпечаток ключа — ровно то, что на экране. Пароли и личные
 * ключи не принимаются: агент входит по сертификату на 10 минут, а изменения на сервере подтверждаются подписью
 * каждой команды.
 */
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";

import { addServer, AGENT, removeServer, serverProblem, setPaused, setRights, setupScript, sshJournal, sshState, type JournalEntry, type SshState } from "@/core/ssh";
import { keyProvider } from "@/platform/keys";
import { getCluster, spaceSid, type ClusterRecord } from "@/state/cluster";
import { useServers } from "@/state/servers";
import { openClusterSession } from "@/state/clusterSession";
import { Btn, Card, Chip, Empty, errText, Field, Loading, Notice, Row, Screen, Txt } from "@/ui/kit";
import { useTheme } from "@/ui/theme";

export default function Servers() {
  const { cid, team: teamParam } = useLocalSearchParams<{ cid: string; team?: string }>();
  const team = teamParam || null;
  const { api: apiFor } = useServers();
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([{ id: AGENT, name: "Fugu" }]);
  const [agent, setAgent] = useState(AGENT);
  useEffect(() => {
    // агенты пространства — у каждого свои права на серверах
    apiFor(spaceSid(cid, team)).then((a) => a.agents()).then((l) => l.length && setAgents(l.map((x) => ({ id: x.id, name: x.name }))), () => {});
  }, [apiFor, cid, team]);
  const { p } = useTheme();
  const [rec, setRec] = useState<ClusterRecord | null>(null);
  const [st, setSt] = useState<SshState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [journal, setJournal] = useState<JournalEntry[] | null>(null);
  const [journalOpen, setJournalOpen] = useState(false);
  const [openEntry, setOpenEntry] = useState<number | null>(null);
  const [f, setF] = useState({ id: "", host: "", port: "22", user: "deck-agent", hostKey: "" });

  const load = useCallback(async (r: ClusterRecord) => {
    try {
      setSt(await sshState(await openClusterSession(r, r.api), team));
    } catch (e) {
      setMsg({ kind: "error", text: errText(e) });
    }
  }, [team]);

  useEffect(() => {
    getCluster(cid).then((r) => {
      setRec(r);
      if (r) void load(r);
    });
  }, [cid, load]);

  const run = async (tag: string, done: string, fn: (r: ClusterRecord) => Promise<void>) => {
    if (!rec) return;
    setBusy(tag);
    setMsg(null);
    try {
      await fn(rec);
      await load(rec);
      setMsg({ kind: "ok", text: done });
    } catch (e) {
      setMsg({ kind: "error", text: errText(e) });
    } finally {
      setBusy(null);
      setArmed(null);
    }
  };
  const keysOf = async (r: ClusterRecord) => {
    const k = await (await keyProvider()).load(r.alias);
    if (!k) throw new Error("Ключи устройства не найдены — зарегистрируйтесь заново по приглашению");
    return k;
  };

  const rights = st?.rights.find((x) => x.agent === agent) ?? { agent, servers: [], read_without_confirm: false };
  const input = { id: f.id.trim(), host: f.host.trim(), port: Number(f.port), user: f.user.trim(), hostKey: f.hostKey.trim() };
  const bad = f.id || f.host || f.hostKey ? serverProblem(input) : null;

  const add = () => run("add", `Сервер ${input.id} добавлен. Теперь разрешите агенту ходить на него.`, async (r) => {
    await addServer(await openClusterSession(r, r.api), await keysOf(r), r.user, input, team);
    setF({ id: "", host: "", port: "22", user: "deck-agent", hostKey: "" });
  });
  const grant = (servers: string[], read: boolean, done: string) => run("rights", done, async (r) => {
    await setRights(await openClusterSession(r, r.api), await keysOf(r), r.user, servers, read, team, agent);
  });
  const drop = (id: string) => run(`rm:${id}`, `Сервер ${id} убран`, async (r) => {
    await removeServer(await openClusterSession(r, r.api), id, team);
  });

  const pause = (on: boolean) => run("pause", on ? "Агент на серверах остановлен: идущие команды оборваны, новые не выполняются" : "Агент снова может работать на серверах", async (r) => {
    await setPaused(await openClusterSession(r, r.api), on, team);
  });
  const loadJournal = async () => {
    if (!rec) return;
    setJournalOpen(true);
    try {
      setJournal((await sshJournal(await openClusterSession(rec, rec.api), team)).entries);
    } catch (e) {
      setMsg({ kind: "error", text: errText(e) });
    }
  };

  if (!rec || (!st && !msg)) return <Screen title="Серверы"><Loading /></Screen>;
  return (
    <Screen title={team ? "Серверы общего пространства" : "Серверы"}>
      {msg ? <Notice kind={msg.kind} text={msg.text} /> : null}
      {st?.paused ? (
        <Card accent={p.warn}>
          <Txt kind="h2">Агент на серверах остановлен</Txt>
          <Txt kind="dim">Команды не выполняются, пока вы не возобновите. Серверы и права сохранены.</Txt>
          <Btn title="Возобновить" onPress={() => pause(false)} busy={busy === "pause"} />
        </Card>
      ) : st && st.servers.length ? (
        armed === "__pause" ? (
          <Card accent={p.accent2}>
            <Txt kind="dim">Остановить агента на всех серверах? Идущие команды оборвутся, новые не будут выполняться, пока вы не возобновите.</Txt>
            <Row>
              <Btn title="Остановить" small kind="danger" onPress={() => pause(true)} busy={busy === "pause"} />
              <Btn title="Отмена" small kind="ghost" onPress={() => setArmed(null)} />
            </Row>
          </Card>
        ) : (
          <Btn title="■ Остановить агента на серверах" kind="danger" small onPress={() => setArmed("__pause")} style={{ alignSelf: "flex-start" }} />
        )
      ) : null}
      <Txt kind="dim">
        Агент вашего пространства может выполнять команды на ваших серверах. Смотреть (журналы, состояние) — без
        подтверждения, если вы это разрешите; любое изменение — только после вашей подписи именно этой команды.
      </Txt>
      {st && agents.length > 1 ? (
        <Card>
          <Txt kind="label">права агента</Txt>
          <Row gap={6} style={{ flexWrap: "wrap" }}>
            {agents.map((a) => <Btn key={a.id} small title={a.name} kind={a.id === agent ? "primary" : "ghost"} onPress={() => setAgent(a.id)} />)}
          </Row>
          <Txt kind="small">Допуск к серверам и чтение без подтверждения — у каждого агента свои.</Txt>
        </Card>
      ) : null}
      {st ? (
        <>
          {st.servers.length === 0 ? <Empty title="Серверов нет" text="Подготовьте сервер по инструкции ниже и добавьте его." /> : null}
          {st.servers.map((s) => {
            const allowed = rights.servers.includes(s.id);
            return (
              <Card key={s.id} accent={allowed ? p.ok : undefined}>
                <Row style={{ justifyContent: "space-between" }}>
                  <Txt style={{ flex: 1, fontWeight: "600" }} numberOfLines={1}>{s.id}</Txt>
                  <Chip text={allowed ? "агент допущен" : "агент не допущен"} color={allowed ? p.ok : p.dim} />
                </Row>
                <Txt kind="mono" selectable>{s.user}@{s.host}:{s.port}</Txt>
                <Txt kind="small" selectable>{s.host_key}</Txt>
                <Row style={{ flexWrap: "wrap" }}>
                  {allowed ? (
                    <Btn title="Закрыть агенту доступ" small kind="ghost" disabled={!!busy} busy={busy === "rights"}
                      onPress={() => grant(rights.servers.filter((x) => x !== s.id), rights.read_without_confirm, `Агент больше не ходит на ${s.id}`)} />
                  ) : (
                    <Btn title="Разрешить агенту ⌁" small disabled={!!busy} busy={busy === "rights"}
                      onPress={() => grant([...rights.servers, s.id], rights.read_without_confirm, `Агент допущен на ${s.id}`)} />
                  )}
                  {armed === s.id ? (
                    <>
                      <Btn title="Да, убрать" small kind="danger" onPress={() => drop(s.id)} busy={busy === `rm:${s.id}`} disabled={!!busy} />
                      <Btn title="Отмена" small kind="ghost" onPress={() => setArmed(null)} />
                    </>
                  ) : (
                    <Btn title="Убрать сервер" small kind="ghost" onPress={() => setArmed(s.id)} disabled={!!busy} />
                  )}
                </Row>
              </Card>
            );
          })}

          {rights.servers.length > 0 ? (
            <Card>
              <Txt kind="h2">Чтение без подтверждения</Txt>
              <Txt kind="dim">
                Простые команды просмотра (ls, cat, tail, grep, df, ps, journalctl, systemctl status, docker ps и logs)
                агент выполняет сам. Всё остальное — по вашей подписи в любом случае.
              </Txt>
              <Row>
                <Chip text={rights.read_without_confirm ? "разрешено" : "каждый раз спрашивать"} color={rights.read_without_confirm ? p.ok : p.dim} />
                <Btn small kind="ghost" disabled={!!busy} busy={busy === "rights"}
                  title={rights.read_without_confirm ? "Спрашивать каждый раз ⌁" : "Разрешить ⌁"}
                  onPress={() => grant(rights.servers, !rights.read_without_confirm, rights.read_without_confirm ? "Теперь агент спрашивает перед любой командой" : "Агент читает без подтверждения")} />
              </Row>
            </Card>
          ) : null}

          <Card>
            <Row style={{ justifyContent: "space-between" }}>
              <Txt kind="h2">Журнал команд</Txt>
              <Btn small kind="ghost" title={journalOpen ? "Обновить" : "Показать"} onPress={loadJournal} />
            </Row>
            <Txt kind="small">Что агент выполнял на серверах, кто подтвердил и что вывелось. Хранится 30 дней.</Txt>
            {journalOpen && !journal ? <Loading /> : null}
            {journal && journal.length === 0 ? <Txt kind="small">Команд ещё не было.</Txt> : null}
            {journal?.slice(0, 100).map((e, i) => (
              <Card key={i} onPress={() => setOpenEntry(openEntry === i ? null : i)}
                accent={e.error || e.stopped ? p.accent2 : e.level === "danger" ? p.accent2 : e.level === "write" ? p.warn : p.line2}>
                <Row style={{ justifyContent: "space-between" }}>
                  <Txt kind="small">{new Date(e.time).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })} · {e.server}</Txt>
                  <Chip text={e.stopped ? "оборвана" : e.error ? "не выполнена" : e.preview ? "пробный прогон" : `код ${e.exit_code}`} />
                </Row>
                <Txt kind="mono" numberOfLines={openEntry === i ? undefined : 2} selectable style={{ fontSize: 12.5 }}>{e.command}</Txt>
                <Txt kind="small">{e.signer ? `подтвердил ${e.signer}` : "чтение без подтверждения"}{e.duration_ms ? ` · ${(e.duration_ms / 1000).toFixed(1)} с` : ""}</Txt>
                {openEntry === i ? (
                  <Txt kind="mono" selectable style={{ fontSize: 11.5 }}>{e.error || [e.stdout, e.stderr].filter(Boolean).join("\n") || "(вывода нет)"}</Txt>
                ) : null}
              </Card>
            ))}
          </Card>

          <Card>
            <Txt kind="h2">Подготовить сервер</Txt>
            <Txt kind="dim">
              Один раз выполните на сервере команды ниже. Они заводят отдельного пользователя и разрешают вход только по
              сертификатам этого кластера. Права пользователя на сервере (sudo) задаёте вы — это и есть настоящая граница
              того, что агент может.
            </Txt>
            {showSetup ? (
              <>
                <Txt kind="mono" selectable>{st.ca_public_key ? setupScript(st, f.user.trim() || "deck-agent", agents.map((a) => a.id)) : "Ключ кластера сейчас недоступен — откройте экран позже."}</Txt>
                {st.ca_public_key ? <Btn title="Скопировать команды" small kind="ghost" onPress={() => Clipboard.setStringAsync(setupScript(st, f.user.trim() || "deck-agent", agents.map((a) => a.id)))} /> : null}
              </>
            ) : (
              <Btn title="Показать команды" small kind="ghost" onPress={() => setShowSetup(true)} />
            )}
          </Card>

          <Card>
            <Txt kind="h2">Добавить сервер</Txt>
            <Field label="Имя (как вы его называете)" value={f.id} onChangeText={(t) => setF({ ...f, id: t.trim() })} autoCapitalize="none" autoCorrect={false} placeholder="prod-1" />
            <Field label="Адрес" value={f.host} onChangeText={(t) => setF({ ...f, host: t.trim() })} autoCapitalize="none" autoCorrect={false} placeholder="203.0.113.5 или host.example.com" />
            <Row>
              <Field label="Порт" value={f.port} onChangeText={(t) => setF({ ...f, port: t.replace(/\D/g, "") })} keyboardType="number-pad" />
              <Field label="Пользователь" value={f.user} onChangeText={(t) => setF({ ...f, user: t.trim() })} autoCapitalize="none" autoCorrect={false} />
            </Row>
            <Field label="Отпечаток ключа сервера" value={f.hostKey} onChangeText={(t) => setF({ ...f, hostKey: t.trim() })} autoCapitalize="none" autoCorrect={false}
              placeholder="SHA256:…" hint={bad ?? "Последняя команда из инструкции печатает его. Агент подключится только к серверу с этим ключом."} />
            <Btn title="Подписать и добавить ⌁" onPress={add} busy={busy === "add"} disabled={!!busy || !f.id || !f.host || !f.hostKey || !!bad} />
          </Card>
        </>
      ) : null}
    </Screen>
  );
}
