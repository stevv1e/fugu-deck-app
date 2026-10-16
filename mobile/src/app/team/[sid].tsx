/**
 * Общее пространство: состояние, участники, вход. Состав меняет владелец, и каждое изменение — подписанное:
 * телефон спрашивает биометрию, сервер без подписи никого не добавит и не исключит.
 */
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";

import { nickProblem } from "@/core/devices";
import { deleteTeam, PHASE_NAMES as PHASE, restoreTeam, ROLE_LABELS as ROLE, setMember, teamState, wakeTeam, type TeamState } from "@/core/teams";
import { keyProvider } from "@/platform/keys";
import { getCluster, parseSid, rememberSpaceTitle, type ClusterRecord } from "@/state/cluster";
import { openClusterSession } from "@/state/clusterSession";
import { useServers } from "@/state/servers";
import { Btn, Card, Chip, errText, Field, Loading, Notice, Row, Screen, Txt } from "@/ui/kit";
import { useTheme } from "@/ui/theme";


export default function Team() {
  const { sid } = useLocalSearchParams<{ sid: string }>();
  const sp = parseSid(sid);
  const { p } = useTheme();
  const { reloadClusters } = useServers();
  const [rec, setRec] = useState<ClusterRecord | null>(null);
  const [st, setSt] = useState<TeamState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "error" | "ok" | "info"; text: string } | null>(null);
  const [nick, setNick] = useState("");
  const [role, setRole] = useState<"editor" | "reader">("editor");
  const [transfer, setTransfer] = useState<string | null>(null); // кому передать владение (ждёт подтверждения)
  const [armed, setArmed] = useState<string | null>(null);
  const team = sp?.team ?? "";

  const load = useCallback(async (r: ClusterRecord) => {
    try {
      const s = await teamState(await openClusterSession(r, r.api), team);
      rememberSpaceTitle(sid, s.title);
      setSt(s);
    } catch (e) {
      setMsg({ kind: "error", text: errText(e) });
    }
  }, [sid, team]);

  useEffect(() => {
    if (!sp) return;
    getCluster(sp.cluster).then((r) => {
      setRec(r);
      if (r) void load(r);
    });
  }, [sp?.cluster, load]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!sp || !sp.team) return <Redirect href="/" />;

  const run = async (tag: string, f: (r: ClusterRecord) => Promise<string | void>) => {
    if (!rec) return;
    setBusy(tag);
    setMsg(null);
    try {
      const done = await f(rec);
      if (done) setMsg({ kind: "ok", text: done });
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

  const open = () => run("open", async (r) => {
    const s = await openClusterSession(r, r.api);
    let cur = await teamState(s, team);
    if (cur.phase === "Deleting") throw new Error("Пространство ждёт удаления — владелец может отменить удаление");
    if (cur.phase === "Sleeping") cur = await wakeTeam(s, team);
    setSt(cur);
    for (let i = 0; i < 40 && cur.phase !== "Ready" && cur.phase !== "Failed"; i++) {
      await new Promise((res) => setTimeout(res, 3000));
      cur = await teamState(s, team);
      setSt(cur);
    }
    if (cur.phase !== "Ready") throw new Error(cur.phase === "Failed" ? `Пространство не создано: ${cur.message || "ошибка"}` : "Пространство ещё запускается — попробуйте через минуту");
    await reloadClusters();
    router.push(`/s/${sid}`);
  });

  const change = (who: string, r: "editor" | "reader" | "none" | "owner") => run(`m:${who}`, async (c) => {
    setSt(await setMember(await openClusterSession(c, c.api), await keysOf(c), team, who, r));
    if (r !== "none" && who === nick) setNick("");
    setTransfer(null);
    return r === "none" ? `${who} исключён(а)` : r === "owner" ? `${who} теперь владелец; вы — редактор` : `${who}: ${ROLE[r]}`;
  });

  const remove = () => run("delete", async (c) => {
    const s = await openClusterSession(c, c.api);
    let cur = await deleteTeam(s, await keysOf(c), team);
    setMsg({ kind: "info", text: "Запрос отправлен. Сервер проверяет подпись — это занимает до 20 секунд." });
    for (let i = 0; i < 20 && !cur.delete_at && !cur.delete_error; i++) {
      await new Promise((res) => setTimeout(res, 3000));
      cur = await teamState(s, team);
    }
    await load(c);
    if (cur.delete_error) throw new Error(`Запрос удаления отклонён: ${cur.delete_error}`);
    if (!cur.delete_at) throw new Error("Запрос удаления записан, но ещё не подтверждён сервером — проверьте позже");
    return "Пространство остановлено и будет удалено. До этого срока удаление можно отменить.";
  });

  const undelete = () => run("restore", async (c) => {
    await restoreTeam(await openClusterSession(c, c.api), team);
    await load(c);
    return "Удаление отменено";
  });

  if (!rec || (!st && !msg)) return <Screen title="Общее пространство"><Loading /></Screen>;
  const owner = st?.owner === rec.user;
  const nickBad = nick ? nickProblem(nick) : null;

  return (
    <Screen title={st?.title || "Общее пространство"}>
      {msg ? <Notice kind={msg.kind} text={msg.text} /> : null}
      {st ? (
        <>
          <Card>
            <Row style={{ justifyContent: "space-between" }}>
              <Txt kind="dim">Владелец {st.owner} · вы — {ROLE[st.role] ?? st.role}</Txt>
              <Chip text={PHASE[st.phase ?? ""] ?? "создаётся"} color={st.phase === "Ready" ? p.ok : p.dim} />
            </Row>
            {st.delete_at ? (
              <>
                <Notice kind="warn" text={`Будет удалено ${new Date(st.delete_at).toLocaleString()}: проекты, чаты и память агента — у всех участников. Сейчас пространство остановлено.`} />
                {owner ? <Btn title="Отменить удаление" onPress={undelete} busy={busy === "restore"} /> : null}
              </>
            ) : (
              <Btn title="Открыть проекты и чаты" onPress={open} busy={busy === "open"} disabled={!!busy} />
            )}
          </Card>

          <Txt kind="label">участники</Txt>
          {st.members.map((m) => (
            <Card key={m.nick}>
              <Row style={{ justifyContent: "space-between" }}>
                <Txt style={{ flex: 1 }}>{m.nick}{m.nick === rec.user ? " · это вы" : ""}</Txt>
                <Chip text={ROLE[m.role] ?? m.role} color={m.role === "owner" ? p.accent : p.dim} />
              </Row>
              {owner && m.role !== "owner" && transfer === m.nick ? (
                <>
                  <Txt kind="dim">Передать владение {m.nick}? Владелец меняет состав и может удалить пространство; вы станете редактором. Вернуть владение сможет только {m.nick}.</Txt>
                  <Row>
                    <Btn title="Передать ⌁" small kind="danger" onPress={() => change(m.nick, "owner")} busy={busy === `m:${m.nick}`} disabled={!!busy} />
                    <Btn title="Отмена" small kind="ghost" onPress={() => setTransfer(null)} />
                  </Row>
                </>
              ) : owner && m.role !== "owner" ? (
                armed === m.nick ? (
                  <Row>
                    <Btn title="Да, исключить" small kind="danger" onPress={() => change(m.nick, "none")} busy={busy === `m:${m.nick}`} disabled={!!busy} />
                    <Btn title="Отмена" small kind="ghost" onPress={() => setArmed(null)} />
                  </Row>
                ) : (
                  <Row>
                    <Btn title={m.role === "editor" ? "Сделать читателем" : "Сделать редактором"} small kind="ghost"
                      onPress={() => change(m.nick, m.role === "editor" ? "reader" : "editor")} busy={busy === `m:${m.nick}`} disabled={!!busy} />
                    <Btn title="Исключить" small kind="ghost" onPress={() => setArmed(m.nick)} disabled={!!busy} />
                    <Btn title="Сделать владельцем" small kind="ghost" onPress={() => setTransfer(m.nick)} disabled={!!busy} />
                  </Row>
                )
              ) : null}
            </Card>
          ))}

          {owner ? (
            <Btn title="Серверы общего пространства" kind="ghost"
              onPress={() => router.push({ pathname: "/servers/[cid]", params: { cid: rec.id, team } })} />
          ) : null}
          {owner ? (
            <Card>
              <Txt kind="h2">Добавить участника</Txt>
              <Txt kind="dim">По нику пользователя этого кластера. Редактор пишет в чатах и голосует за модель; читатель только читает.</Txt>
              <Field label="Ник" value={nick} onChangeText={(t) => setNick(t.trim().toLowerCase())} autoCapitalize="none" autoCorrect={false} hint={nickBad ?? undefined} />
              <Row gap={6}>
                <Btn small title="Редактор" kind={role === "editor" ? "primary" : "ghost"} onPress={() => setRole("editor")} />
                <Btn small title="Читатель" kind={role === "reader" ? "primary" : "ghost"} onPress={() => setRole("reader")} />
              </Row>
              <Btn title="Добавить" onPress={() => change(nick, role)} busy={busy === `m:${nick}`} disabled={!!busy || !nick || !!nickBad} />
            </Card>
          ) : null}

          {owner && !st.delete_at ? (
            armed === "#delete" ? (
              <Row>
                <Btn title="Да, удалить пространство" small kind="danger" onPress={remove} busy={busy === "delete"} disabled={!!busy} />
                <Btn title="Отмена" small kind="ghost" onPress={() => setArmed(null)} />
              </Row>
            ) : (
              <Btn title="Удалить пространство" small kind="ghost" onPress={() => setArmed("#delete")} disabled={!!busy} />
            )
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}
