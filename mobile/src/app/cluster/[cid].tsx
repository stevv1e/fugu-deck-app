/**
 * Устройство в кластере: ожидание подтверждения → сертификат mTLS → ввод ключей API.
 * Ключ шифруется на телефоне для keyguard (HPKE) и подписывается биометрией; посредники видят только шифротекст.
 */
import { FdSecure } from "fd-secure";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";

import { fetchStatus, type ClusterInvite } from "@/core/cluster";
import { nativeMtlsAvailable, plainHttp } from "@/platform/http";
import { enablePush, pushStatus, type PushStatus } from "@/platform/push";
import { keyProvider } from "@/platform/keys";
import { getCluster, saveCluster, spaceSid, type ClusterRecord } from "@/state/cluster";
import { requestAccountDelete, requestSpaceDelete, restoreSpace, spaceState, type SpaceState } from "@/state/clusterSession";
import { useServers } from "@/state/servers";
import { Btn, Card, Chip, errText, Loading, Notice, Row, Screen, Txt } from "@/ui/kit";
import { useTheme } from "@/ui/theme";

export default function ClusterDevice() {
  const { cid } = useLocalSearchParams<{ cid: string }>();
  const { p } = useTheme();
  const [rec, setRec] = useState<ClusterRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "ok" | "info"; text: string } | null>(null);
  const [space, setSpace] = useState<SpaceState | null>(null);
  const [spaceBusy, setSpaceBusy] = useState(false);
  const [armDelete, setArmDelete] = useState(false); // удаление — в два нажатия, затем биометрия
  const [armAccount, setArmAccount] = useState(false);
  const [push, setPush] = useState<PushStatus | null>(null);
  useEffect(() => { pushStatus().then(setPush, () => setPush("unavailable")); }, []);
  const turnOnPush = async () => {
    setMsg(null);
    try {
      const st = await enablePush(true);
      setPush(st);
      if (st === "denied") setMsg({ kind: "error", text: "Уведомления запрещены в настройках телефона: Настройки → Приложения → Fugu Deck → Уведомления" });
    } catch (e) {
      setMsg({ kind: "error", text: errText(e) });
    }
  };
  const { reloadClusters } = useServers();

  useEffect(() => { getCluster(cid).then(setRec); }, [cid]);

  const keys = useCallback(async () => {
    const k = await (await keyProvider()).load(rec!.alias);
    if (!k) throw new Error("Ключи устройства не найдены — зарегистрируйтесь заново по приглашению");
    return k;
  }, [rec]);

  // Подтверждённое устройство без сертификата: забираем его сами, как только экран открыт.
  const autoChecked = useRef(false);
  useEffect(() => {
    if (rec && rec.status === "active" && !rec.certPem && !autoChecked.current) {
      autoChecked.current = true;
      void check();
    }
  });

  const check = async () => {
    if (!rec) return;
    setBusy(true);
    setMsg(null);
    try {
      const st = await fetchStatus(plainHttp(), rec as unknown as ClusterInvite, await keys(), Date.now() / 1000);
      if (st.status === "active" && st.cert_pem) {
        if (FdSecure) await FdSecure.setClientCertificate(rec.alias + ".s", st.cert_pem);
        const next = { ...rec, status: st.status, certPem: st.cert_pem };
        await saveCluster(next);
        setRec(next);
        setMsg({ kind: "ok", text: "Устройство подтверждено, сертификат получен" });
      } else {
        await saveCluster({ ...rec, status: st.status });
        setRec({ ...rec, status: st.status });
        setMsg({ kind: st.status === "revoked" ? "error" : "info", text: st.status === "revoked" ? "Устройство отозвано" : "Ещё не подтверждено" });
      }
    } catch (e) {
      setMsg({ kind: "error", text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  // Личное пространство: место в кластере, где работает агент. Создаёт его space-operator по запросу control-plane;
  // пока агент запускается, состояние опрашиваем раз в 3 секунды (не дольше двух минут).
  const openSpace = async () => {
    if (!rec) return;
    setSpaceBusy(true);
    setMsg(null);
    try {
      let st = await spaceState(rec, false);
      // Нет пространства — создаём; спит — тем же запросом будим (просмотр состояния его не будит).
      if (st.phase === "Deleting") {
        setSpace(st);
        throw new Error("Пространство ждёт удаления — отмените удаление, чтобы открыть его");
      }
      if (!st.exists || st.phase === "Sleeping") st = await spaceState(rec, true);
      setSpace(st);
      for (let i = 0; i < 40 && st.phase !== "Ready" && st.phase !== "Failed"; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        st = await spaceState(rec, false);
        setSpace(st);
      }
      if (st.phase !== "Ready") throw new Error(st.phase === "Failed" ? `Пространство не создано: ${st.message || "ошибка"}` : "Пространство ещё запускается — попробуйте через минуту");
      await reloadClusters();
      router.push(`/s/${spaceSid(rec.id)}`);
    } catch (e) {
      setMsg({ kind: "error", text: errText(e) });
    } finally {
      setSpaceBusy(false);
    }
  };

  // Состояние пространства показываем сразу (просмотр его не будит): спит ли оно, не ждёт ли удаления.
  const spaceLoaded = useRef(false);
  useEffect(() => {
    if (rec && rec.status === "active" && rec.certPem && !spaceLoaded.current) {
      spaceLoaded.current = true;
      spaceState(rec, false).then(setSpace).catch(() => {});
    }
  });

  const deleteSpace = async () => {
    if (!rec) return;
    setSpaceBusy(true);
    setMsg(null);
    setArmDelete(false);
    try {
      let st = await requestSpaceDelete(rec);
      // Подпись проверяет оператор (проход раз в 15 с): ждём, пока он примет запрос или отклонит. Человеку
      // говорим, чего ждём: без этого кнопка просто «крутится» четверть минуты.
      setMsg({ kind: "info", text: "Запрос отправлен. Сервер проверяет подпись — это занимает до 20 секунд." });
      for (let i = 0; i < 20 && st.exists && !st.delete_at && !st.delete_error; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        st = await spaceState(rec, false);
      }
      setSpace(st);
      if (st.delete_error) throw new Error(`Запрос удаления отклонён: ${st.delete_error}`);
      if (!st.delete_at) throw new Error("Запрос удаления записан, но ещё не подтверждён сервером — проверьте позже");
      setMsg({ kind: "info", text: "Пространство остановлено и будет удалено. До этого срока удаление можно отменить." });
    } catch (e) {
      setMsg({ kind: "error", text: errText(e) });
    } finally {
      setSpaceBusy(false);
    }
  };

  const deleteAccount = async () => {
    if (!rec) return;
    setSpaceBusy(true);
    setMsg(null);
    setArmAccount(false);
    try {
      let st = await requestAccountDelete(rec);
      setMsg({ kind: "info", text: "Запрос отправлен. Сервер проверяет подпись — это занимает до 20 секунд." });
      for (let i = 0; i < 20 && !st.delete_at && !st.delete_error; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        st = await spaceState(rec, false);
      }
      setSpace(st);
      if (st.delete_error) throw new Error(`Запрос удаления отклонён: ${st.delete_error}`);
      if (!st.delete_at) throw new Error("Запрос записан, но ещё не подтверждён сервером — проверьте позже");
      setMsg({ kind: "info", text: "Аккаунт будет удалён через сутки. До этого удаление можно отменить." });
    } catch (e) {
      setMsg({ kind: "error", text: errText(e) });
    } finally {
      setSpaceBusy(false);
    }
  };

  const undelete = async () => {
    if (!rec) return;
    setSpaceBusy(true);
    setMsg(null);
    try {
      setSpace(await restoreSpace(rec));
      setMsg({ kind: "ok", text: "Удаление отменено" });
    } catch (e) {
      setMsg({ kind: "error", text: errText(e) });
    } finally {
      setSpaceBusy(false);
    }
  };

  if (!rec) return <Screen title="Кластер"><Loading /></Screen>;
  // Сертификат для mTLS приходит отдельным запросом статуса. У первого устройства администратора статус «активно»
  // приходит сразу в ответе на регистрацию, и без этой проверки сертификат не был бы получен никогда.
  const needCert = rec.status === "active" && !rec.certPem;
  const active = rec.status === "active" && !needCert;

  return (
    <Screen title={new URL(rec.api).host}>
      <Card>
        <Row><Txt>{rec.name}</Txt><Chip text={rec.status === "active" ? "подтверждено" : rec.status === "revoked" ? "отозвано" : "ждёт подтверждения"} /></Row>
        <Txt kind="dim">Пользователь {rec.user} · устройство</Txt>
        <Txt selectable>{rec.deviceId}</Txt>
      </Card>
      {!active ? (
        <>
          <Txt kind="dim">{needCert
            ? "Устройство подтверждено. Осталось получить сертификат для защищённого соединения."
            : "Попросите пригласившего подтвердить устройство с этим кодом. Затем нажмите «Проверить»."}</Txt>
          <Btn title={needCert ? "Получить сертификат" : "Проверить"} onPress={check} busy={busy} />
        </>
      ) : (
        <>
          <Card>
            <Row style={{ justifyContent: "space-between" }}>
              <Txt kind="h2">Пространство</Txt>
              {space?.exists ? <Chip text={space.phase === "Ready" ? "готово" : space.phase === "Failed" ? "ошибка" : space.phase === "Sleeping" ? "спит" : space.phase === "Deleting" ? "удаляется" : "запускается"} /> : null}
            </Row>
            <Txt kind="dim">Проекты и чаты с агентом. Он работает в вашем отдельном окружении в кластере; ключи API к нему не попадают.</Txt>
            {space?.delete_at ? (
              <>
                <Notice kind="warn" text={space.delete_account
                  ? `Аккаунт будет удалён ${new Date(space.delete_at).toLocaleString()}: пространство с копиями, ключи API, устройства и вход. Сейчас пространство остановлено.`
                  : `Будет удалено ${new Date(space.delete_at).toLocaleString()}: проекты, чаты и память агента. Сейчас пространство остановлено.`} />
                <Btn title="Отменить удаление" onPress={undelete} busy={spaceBusy} />
              </>
            ) : (
              <>
                <Btn title="Открыть пространство" onPress={openSpace} busy={spaceBusy} />
                {space?.exists ? (
                  armDelete ? (
                    <Row>
                      <Btn title="Да, удалить" small kind="danger" onPress={deleteSpace} disabled={spaceBusy} />
                      <Btn title="Отмена" small kind="ghost" onPress={() => setArmDelete(false)} />
                    </Row>
                  ) : (
                    <Btn title="Удалить пространство" small kind="ghost" onPress={() => setArmDelete(true)} disabled={spaceBusy} />
                  )
                ) : null}
              </>
            )}
          </Card>
          <Btn title="Серверы для агента" kind="ghost" onPress={() => router.push({ pathname: "/servers/[cid]", params: { cid: rec.id } })} />
          <Btn title="Общие пространства" kind="ghost" onPress={() => router.push({ pathname: "/teams/[cid]", params: { cid: rec.id } })} />
          <Btn title="Устройства и приглашения" kind="ghost" onPress={() => router.push(`/devices/${rec.id}`)} />
          {push && push !== "unavailable" ? (
            <Card>
              <Row style={{ justifyContent: "space-between" }}>
                <Txt style={{ fontWeight: "600" }}>Уведомления</Txt>
                <Chip text={push === "on" ? "включены" : push === "denied" ? "запрещены" : "выключены"} color={push === "on" ? p.ok : undefined} />
              </Row>
              <Txt kind="small">Агент ждёт подтверждения, агент ответил, новое устройство. В уведомлении нет текста переписки — только куда открыть.</Txt>
              {push !== "on" ? <Btn small title="Включить уведомления" onPress={turnOnPush} style={{ alignSelf: "flex-start" }} /> : null}
            </Card>
          ) : null}
          <Row gap={8}>
            <Btn title="Токены моделей" onPress={() => router.push({ pathname: "/keys/[cid]", params: { cid: rec.id, kind: "llm" } })} style={{ flex: 1 }} />
            <Btn title="Git-токены" onPress={() => router.push({ pathname: "/keys/[cid]", params: { cid: rec.id, kind: "git" } })} style={{ flex: 1 }} />
          </Row>
          <Btn title="MCP-серверы" kind="ghost" onPress={() => router.push({ pathname: "/mcp/[cid]", params: { cid: rec.id } })} />
          <Btn title="Домены для агента" kind="ghost" onPress={() => router.push({ pathname: "/egress/[cid]", params: { cid: rec.id } })} />
          {!space?.delete_requested ? (
            armAccount ? (
              <Card accent={p.accent2}>
                <Txt kind="h2">Удалить аккаунт?</Txt>
                <Txt kind="dim">Через сутки удалятся личное пространство (проекты, чаты, файлы, память) и его копии, ключи API, все устройства и вход в кластер. До этого удаление можно отменить. Общие пространства, где вы владелец, останутся участникам.</Txt>
                <Row>
                  <Btn title="Удалить аккаунт ⌁" small kind="danger" onPress={deleteAccount} disabled={spaceBusy} />
                  <Btn title="Отмена" small kind="ghost" onPress={() => setArmAccount(false)} />
                </Row>
              </Card>
            ) : (
              <Btn title="Удалить аккаунт" small kind="ghost" onPress={() => setArmAccount(true)} disabled={spaceBusy} style={{ alignSelf: "flex-start" }} />
            )
          ) : null}
          {!nativeMtlsAvailable() ? <Notice kind="warn" text="Сборка без модуля fd-secure: mTLS недоступен, сервер с обязательным mTLS запрос не примет." /> : null}
        </>
      )}
      {msg ? <Notice kind={msg.kind} text={msg.text} /> : null}
    </Screen>
  );
}
