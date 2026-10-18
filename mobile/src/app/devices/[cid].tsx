/**
 * Устройства и приглашения кластера. Каждое действие здесь — подписанное: телефон спрашивает биометрию,
 * а сервер без этой подписи ничего не подтвердит, не отзовёт и приглашения не выпустит.
 */
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Share } from "react-native";

import { confirmDevice, createInvite, listDevices, nickProblem, revokeDevice, sortDevices, type ClusterDevice, type DeviceList, type IssuedInvite } from "@/core/devices";
import { keyProvider } from "@/platform/keys";
import { getCluster, type ClusterRecord } from "@/state/cluster";
import { openClusterSession } from "@/state/clusterSession";
import { Btn, Card, Chip, errText, Field, Loading, Notice, QrCode, Row, Screen, Txt } from "@/ui/kit";
import { useTheme } from "@/ui/theme";

const STATUS = { pending: "ждёт подтверждения", active: "действует", revoked: "отозвано" } as const;
const STORAGE: Record<string, string> = { strongbox: "StrongBox", tee: "TEE", secure_enclave: "Secure Enclave", software: "программный ключ" };

export default function ClusterDevices() {
  const { cid } = useLocalSearchParams<{ cid: string }>();
  const { p } = useTheme();
  const [rec, setRec] = useState<ClusterRecord | null>(null);
  const [list, setList] = useState<DeviceList | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const [armed, setArmed] = useState<string | null>(null); // отзыв — в два нажатия
  const [nick, setNick] = useState("");
  const [invite, setInvite] = useState<IssuedInvite | null>(null);

  const load = useCallback(async (r: ClusterRecord) => {
    try {
      setList(await listDevices(await openClusterSession(r, r.api)));
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

  const run = async (tag: string, done: string, f: (r: ClusterRecord) => Promise<void>) => {
    if (!rec) return;
    setBusy(tag);
    setMsg(null);
    try {
      await f(rec);
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

  const act = (kind: "confirm" | "revoke", d: ClusterDevice) =>
    run(`${kind}:${d.id}`, kind === "confirm" ? `Устройство «${d.name}» подтверждено` : `Устройство «${d.name}» отозвано`, async (r) => {
      const s = await openClusterSession(r, r.api);
      await (kind === "confirm" ? confirmDevice : revokeDevice)(s, await keysOf(r), d);
      await load(r);
    });

  const issue = (who: string) =>
    run("invite", `Приглашение для ${who} выпущено`, async (r) => {
      setInvite(null);
      setInvite(await createInvite(await openClusterSession(r, r.api), await keysOf(r), who));
      setNick("");
    });

  if (!rec || (!list && !msg)) return <Screen title="Устройства"><Loading /></Screen>;
  const nickBad = nick ? nickProblem(nick) : null;

  return (
    <Screen title="Устройства">
      {msg ? <Notice kind={msg.kind} text={msg.text} /> : null}
      {list ? sortDevices(list).map((d) => {
        const mine = d.id === list.device_id;
        return (
          <Card key={d.id} accent={d.status === "pending" ? p.warn : undefined}>
            <Row style={{ justifyContent: "space-between" }}>
              <Txt style={{ flex: 1 }} numberOfLines={1}>{d.name || "Без имени"}{mine ? " · это устройство" : ""}</Txt>
              <Chip text={STATUS[d.status]} color={d.status === "active" ? p.ok : d.status === "pending" ? p.warn : p.faint} />
            </Row>
            <Txt kind="dim">
              {list.admin || d.user !== list.user ? `Пользователь ${d.user} · ` : ""}{STORAGE[d.key_storage ?? ""] ?? "хранилище ключа неизвестно"}
              {d.attested ? " · проверено аттестацией" : ""}
            </Txt>
            <Txt kind="mono" selectable>{d.id}</Txt>
            {d.status === "pending" ? (
              <>
                <Txt kind="dim">Сверьте этот код с экраном нового устройства и только потом подтверждайте.</Txt>
                {!d.attested ? (
                  <Txt kind="small" color={p.warn}>
                    Без аттестации (ключи не подтверждены чипом телефона): подтвердить его может только устройство, прошедшее аттестацию.
                  </Txt>
                ) : null}
                <Row>
                  <Btn title="Подтвердить" small onPress={() => act("confirm", d)} busy={busy === `confirm:${d.id}`} disabled={!!busy} />
                  <Btn title="Отклонить" small kind="danger" onPress={() => act("revoke", d)} busy={busy === `revoke:${d.id}`} disabled={!!busy} />
                </Row>
              </>
            ) : d.status === "active" && !mine ? (
              armed === d.id ? (
                <Row>
                  <Btn title="Да, отозвать" small kind="danger" onPress={() => act("revoke", d)} busy={busy === `revoke:${d.id}`} disabled={!!busy} />
                  <Btn title="Отмена" small kind="ghost" onPress={() => setArmed(null)} />
                </Row>
              ) : (
                <Btn title="Отозвать" small kind="ghost" onPress={() => setArmed(d.id)} disabled={!!busy} />
              )
            ) : null}
          </Card>
        );
      }) : null}
      {list ? (
        <Card>
          <Txt kind="h2">Пригласить</Txt>
          <Txt kind="dim">Ссылка действует 24 часа и подключает одно устройство. Новое устройство начнёт работать после подтверждения здесь.</Txt>
          <Btn title="Ещё одно моё устройство" kind="ghost" onPress={() => issue(list.user)} busy={busy === "invite" && !nick} disabled={!!busy} />
          {list.admin ? (
            <>
              <Field label="Ник нового пользователя" value={nick} onChangeText={(t) => setNick(t.trim().toLowerCase())} autoCapitalize="none" autoCorrect={false}
                hint={nickBad ?? undefined} />
              <Btn title="Пригласить пользователя" onPress={() => issue(nick)} busy={busy === "invite" && !!nick} disabled={!!busy || !nick || !!nickBad} />
            </>
          ) : null}
          {invite ? (
            <>
              <Txt>Приглашение для {invite.nick} — до {new Date(invite.expires).toLocaleString()}</Txt>
              <QrCode value={invite.link} />
              <Row>
                <Btn title="Скопировать" kind="ghost" small onPress={() => Clipboard.setStringAsync(invite.link)} />
                <Btn title="Поделиться" kind="ghost" small onPress={() => Share.share({ message: invite.link })} />
              </Row>
              <Txt kind="dim">Ссылка даёт вход в кластер: передавайте её только тому, кого приглашаете.</Txt>
            </>
          ) : null}
        </Card>
      ) : null}
    </Screen>
  );
}
