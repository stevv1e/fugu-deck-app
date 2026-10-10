/** Главный экран: кластеры и серверы пользователя. Подключиться можно к любому серверу Fugu Deck — по QR или адресу. */
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { View } from "react-native";

import { isInsecure, shortFp } from "@/core/invite";
import { listClusters, type ClusterRecord } from "@/state/cluster";
import { useServers } from "@/state/servers";
import { Btn, Card, Chip, Empty, IconBtn, Loading, Row, Screen, Txt } from "@/ui/kit";
import { useTheme } from "@/ui/theme";

const STORAGE: Record<string, string> = {
  secure_enclave: "Secure Enclave",
  strongbox: "StrongBox",
  tee: "TEE",
  software: "программные ключи",
};

export default function Servers() {
  const { p } = useTheme();
  const { ready, servers } = useServers();

  // Кластеры, в которых зарегистрировано это устройство. Перечитываем при каждом возврате на экран:
  // запись появляется после регистрации по приглашению.
  const [clusters, setClusters] = useState<ClusterRecord[]>([]);
  useFocusEffect(useCallback(() => { void listClusters().then(setClusters); }, []));
  const CLUSTER_STATUS: Record<ClusterRecord["status"], string> = { active: "подтверждено", pending: "ждёт подтверждения", revoked: "отозвано" };

  const open = (id: string, enrolled: boolean) => router.push(enrolled ? `/s/${id}` : `/s/${id}/login`);

  return (
    <Screen>
      <Row style={{ justifyContent: "space-between", marginTop: 6 }}>
        <View>
          <Txt kind="title">
            FUGU<Txt kind="title" color={p.accent}> DECK</Txt>
          </Txt>
          <Txt kind="label">ваши серверы</Txt>
        </View>
        <IconBtn glyph="⚙" label="Настройки приложения" onPress={() => router.push("/settings")} />
      </Row>

      {!ready ? (
        <Loading />
      ) : servers.length === 0 && clusters.length === 0 ? (
        <Card accent={p.accent}>
          <Empty
            title="Подключите сервер"
            text="Приложение работает с вашим собственным сервером Fugu Deck. Попросите у владельца QR-приглашение или введите адрес — приложение покажет отпечаток ключа сервера для сверки."
          />
          <Btn title="Сканировать QR" onPress={() => router.push("/scan")} />
          <Btn title="Ввести адрес" kind="ghost" onPress={() => router.push("/add")} />
        </Card>
      ) : (
        <>
          {clusters.map((c) => (
            <Card key={c.id} accent={c.status === "active" ? p.ok : p.line2} onPress={() => router.push({ pathname: "/cluster/[cid]", params: { cid: c.id } })}>
              <Row style={{ justifyContent: "space-between" }}>
                <Txt kind="h2" numberOfLines={1} style={{ flex: 1 }}>
                  {new URL(c.api).host}
                </Txt>
                <Chip text={CLUSTER_STATUS[c.status]} color={c.status === "active" ? p.ok : c.status === "revoked" ? p.accent2 : undefined} />
              </Row>
              <Txt kind="mono" color={p.dim} numberOfLines={1}>
                {c.user ? `${c.user} · ` : ""}{c.name}
              </Txt>
              <Row gap={6} style={{ flexWrap: "wrap" }}>
                <Chip text="кластер" color={p.accent} />
                {c.certPem ? <Chip text="mTLS" color={p.ok} /> : null}
              </Row>
            </Card>
          ))}
          {servers.map((s) => (
            <Card key={s.id} accent={s.device ? p.ok : p.line2} onPress={() => open(s.id, !!s.device)}>
              <Row style={{ justifyContent: "space-between" }}>
                <Txt kind="h2" numberOfLines={1} style={{ flex: 1 }}>
                  {s.name}
                </Txt>
                {s.device ? <Chip text={s.device.user.display_name || s.device.user.username} color={p.ok} /> : <Chip text="вход не выполнен" />}
              </Row>
              <Txt kind="mono" color={p.dim} numberOfLines={1}>
                {s.url}
              </Txt>
              <Row gap={6} style={{ flexWrap: "wrap" }}>
                <Chip text={s.verifiedBy === "qr" ? "проверен по QR" : "сверен вручную"} color={p.accent} />
                {s.device ? <Chip text={STORAGE[s.device.keyStorage]} color={s.device.keyStorage === "software" ? p.warn : p.ok} /> : null}
                {s.device?.certPem ? <Chip text="mTLS" color={p.ok} /> : s.mtls === "required" ? <Chip text="нужен mTLS" color={p.warn} /> : null}
                {isInsecure(s.url) ? <Chip text="без HTTPS" color={p.accent2} /> : null}
              </Row>
              <Txt kind="small">ключ сервера {shortFp(s.fingerprint)}</Txt>
            </Card>
          ))}
          <Row>
            <Btn title="＋ QR" onPress={() => router.push("/scan")} style={{ flex: 1 }} />
            <Btn title="＋ Адрес" kind="ghost" onPress={() => router.push("/add")} style={{ flex: 1 }} />
          </Row>
        </>
      )}
    </Screen>
  );
}
