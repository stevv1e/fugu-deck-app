/**
 * Серверы пользователя: куда агент может ходить и что ему там можно без спроса.
 * Сервер добавляется подписью: адрес, пользователь и отпечаток ключа — ровно то, что на экране. Пароли и личные
 * ключи не принимаются: агент входит по сертификату на 10 минут, а изменения на сервере подтверждаются подписью
 * каждой команды.
 */
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";

import { addServer, AGENT, removeServer, serverProblem, setRights, setupScript, sshState, type SshState } from "@/core/ssh";
import { keyProvider } from "@/platform/keys";
import { getCluster, type ClusterRecord } from "@/state/cluster";
import { openClusterSession } from "@/state/clusterSession";
import { Btn, Card, Chip, Empty, errText, Field, Loading, Notice, Row, Screen, Txt } from "@/ui/kit";
import { useTheme } from "@/ui/theme";

export default function Servers() {
  const { cid } = useLocalSearchParams<{ cid: string }>();
  const { p } = useTheme();
  const [rec, setRec] = useState<ClusterRecord | null>(null);
  const [st, setSt] = useState<SshState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [f, setF] = useState({ id: "", host: "", port: "22", user: "deck-agent", hostKey: "" });

  const load = useCallback(async (r: ClusterRecord) => {
    try {
      setSt(await sshState(await openClusterSession(r, r.api)));
    } catch (e) {
      setMsg({ kind: "error", text: errText(e) });
    }
  }, []);

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

  const rights = st?.rights.find((x) => x.agent === AGENT) ?? { agent: AGENT, servers: [], read_without_confirm: false };
  const input = { id: f.id.trim(), host: f.host.trim(), port: Number(f.port), user: f.user.trim(), hostKey: f.hostKey.trim() };
  const bad = f.id || f.host || f.hostKey ? serverProblem(input) : null;

  const add = () => run("add", `Сервер ${input.id} добавлен. Теперь разрешите агенту ходить на него.`, async (r) => {
    await addServer(await openClusterSession(r, r.api), await keysOf(r), r.user, input);
    setF({ id: "", host: "", port: "22", user: "deck-agent", hostKey: "" });
  });
  const grant = (servers: string[], read: boolean, done: string) => run("rights", done, async (r) => {
    await setRights(await openClusterSession(r, r.api), await keysOf(r), r.user, servers, read);
  });
  const drop = (id: string) => run(`rm:${id}`, `Сервер ${id} убран`, async (r) => {
    await removeServer(await openClusterSession(r, r.api), id);
  });

  if (!rec || (!st && !msg)) return <Screen title="Серверы"><Loading /></Screen>;
  return (
    <Screen title="Серверы">
      {msg ? <Notice kind={msg.kind} text={msg.text} /> : null}
      <Txt kind="dim">
        Агент вашего пространства может выполнять команды на ваших серверах. Смотреть (журналы, состояние) — без
        подтверждения, если вы это разрешите; любое изменение — только после вашей подписи именно этой команды.
      </Txt>
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
            <Txt kind="h2">Подготовить сервер</Txt>
            <Txt kind="dim">
              Один раз выполните на сервере команды ниже. Они заводят отдельного пользователя и разрешают вход только по
              сертификатам этого кластера. Права пользователя на сервере (sudo) задаёте вы — это и есть настоящая граница
              того, что агент может.
            </Txt>
            {showSetup ? (
              <>
                <Txt kind="mono" selectable>{st.ca_public_key ? setupScript(st, f.user.trim() || "deck-agent") : "Ключ кластера сейчас недоступен — откройте экран позже."}</Txt>
                {st.ca_public_key ? <Btn title="Скопировать команды" small kind="ghost" onPress={() => Clipboard.setStringAsync(setupScript(st, f.user.trim() || "deck-agent"))} /> : null}
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
