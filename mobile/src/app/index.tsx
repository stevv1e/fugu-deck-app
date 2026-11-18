import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { isInsecure, shortFp } from "@/core/invite";
import type { ServerRecord } from "@/core/types";
import { listClusters, type ClusterRecord } from "@/state/cluster";
import { useServers } from "@/state/servers";
import { BrandMark } from "@/ui/BrandMark";
import { Btn, Card, Chip, Empty, IconBtn, Loading, Notice, Row, Screen, Txt } from "@/ui/kit";
import { SectionHeading } from "@/ui/SectionHeading";
import { alpha, MONO, useTheme } from "@/ui/theme";
import { useDesktopLayout } from "@/ui/useDesktopLayout";
import { UpdateBanner } from "@/ui/UpdateBanner";

const STORAGE: Record<string, string> = {
  secure_enclave: "Secure Enclave",
  strongbox: "StrongBox",
  tee: "TEE",
  software: "программные ключи",
};

const CLUSTER_STATUS: Record<ClusterRecord["status"], string> = { active: "подтверждено", pending: "ждёт подтверждения", revoked: "отозвано" };

function ServerIcon({ name, active }: { name: string; active: boolean }) {
  const { p } = useTheme();
  const initials = name.split(/\s+/).map((x) => x[0]).join("").slice(0, 2).toUpperCase();
  return (
    <View style={{ width: 42, height: 42, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: alpha(active ? p.accent : p.dim, 0.09), borderWidth: 1, borderColor: alpha(active ? p.accent : p.line2, 0.35) }}>
      <Text style={{ color: active ? p.accent : p.dim, fontFamily: MONO, fontWeight: "700", fontSize: 13 }}>{initials}</Text>
    </View>
  );
}

function ServerCard({ server, desktop = false }: { server: ServerRecord; desktop?: boolean }) {
  const { p } = useTheme();
  const open = () => router.push(server.device ? `/s/${server.id}` : `/s/${server.id}/login`);
  return (
    <Card accent={server.device ? p.accent : p.line2} onPress={open} style={desktop ? { minWidth: 300 } : undefined}>
      <Row style={{ alignItems: "flex-start", justifyContent: "space-between" }}>
        <Row style={{ flex: 1, alignItems: "flex-start" }}>
          <ServerIcon name={server.name} active={!!server.device} />
          <View style={{ flex: 1, gap: 3 }}>
            <Txt kind="h2" numberOfLines={1}>{server.name}</Txt>
            <Txt kind="small" numberOfLines={1}>{new URL(server.url).host}</Txt>
          </View>
        </Row>
        <Chip text={server.device ? "онлайн" : "нужен вход"} color={server.device ? p.ok : p.warn} />
      </Row>
      {server.device ? (
        <Txt kind="dim">{server.device.user.display_name || server.device.user.username} · {STORAGE[server.device.keyStorage]}</Txt>
      ) : (
        <Txt kind="dim">Сервер проверен. Войдите, чтобы открыть проекты и чаты.</Txt>
      )}
      <Row gap={6} style={{ flexWrap: "wrap" }}>
        <Chip text={server.verifiedBy === "qr" ? "QR-проверка" : "ключ сверен"} />
        {server.device?.certPem ? <Chip text="mTLS" color={p.ok} /> : null}
        {isInsecure(server.url) ? <Chip text="без HTTPS" color={p.accent2} /> : null}
      </Row>
      <Row style={{ justifyContent: "space-between", borderTopWidth: 1, borderTopColor: p.line, paddingTop: 9 }}>
        <Txt kind="small">ключ {shortFp(server.fingerprint)}</Txt>
        <Txt kind="small" color={p.accent}>Открыть →</Txt>
      </Row>
    </Card>
  );
}

function ClusterCard({ cluster }: { cluster: ClusterRecord }) {
  const { p } = useTheme();
  return (
    <Card accent={cluster.status === "active" ? p.ok : p.line2} onPress={() => router.push({ pathname: "/cluster/[cid]", params: { cid: cluster.id } })}>
      <Row style={{ alignItems: "flex-start", justifyContent: "space-between" }}>
        <Row style={{ flex: 1 }}>
          <ServerIcon name={cluster.name} active={cluster.status === "active"} />
          <View style={{ flex: 1, gap: 3 }}>
            <Txt kind="h2" numberOfLines={1}>{new URL(cluster.api).host}</Txt>
            <Txt kind="small" numberOfLines={1}>{cluster.user ? `${cluster.user} · ` : ""}{cluster.name}</Txt>
          </View>
        </Row>
        <Chip text={CLUSTER_STATUS[cluster.status]} color={cluster.status === "active" ? p.ok : cluster.status === "revoked" ? p.accent2 : p.warn} />
      </Row>
      <Row gap={6}><Chip text="кластер" color={p.accent} />{cluster.certPem ? <Chip text="mTLS" color={p.ok} /> : null}</Row>
    </Card>
  );
}

function ConnectActions({ desktop = false }: { desktop?: boolean }) {
  return (
    <Row gap={9} style={{ flexWrap: "wrap" }}>
      <Btn title="+  Сканировать QR" onPress={() => router.push("/scan")} style={desktop ? undefined : { flex: 1, minWidth: 155 }} />
      <Btn title="Ввести адрес" kind="ghost" onPress={() => router.push("/add")} style={desktop ? undefined : { flex: 1, minWidth: 130 }} />
    </Row>
  );
}

function MobileHome({ servers, clusters, ready }: { servers: ServerRecord[]; clusters: ClusterRecord[]; ready: boolean }) {
  const { p } = useTheme();
  const connected = servers.filter((s) => s.device).length + clusters.filter((c) => c.status === "active").length;
  return (
    <Screen>
      <Row style={{ justifyContent: "space-between", marginTop: 4, marginBottom: 4 }}>
        <Row>
          <BrandMark size={43} />
          <View>
            <Txt kind="h2" style={{ letterSpacing: 1.2 }}>FUGU DECK</Txt>
            <Txt kind="small">AI · КОД · ИНФРАСТРУКТУРА</Txt>
          </View>
        </Row>
        <IconBtn glyph="⚙" label="Настройки приложения" onPress={() => router.push("/settings")} />
      </Row>
      <UpdateBanner clusters={clusters} />
      <SectionHeading
        eyebrow="рабочий стол"
        title="Ваши пространства"
        text="Проекты, чаты с моделями и инфраструктура — в одном защищённом приложении."
      />
      <ConnectActions />
      {ready && (servers.length > 0 || clusters.length > 0) ? (
        <Row gap={7} style={{ flexWrap: "wrap" }}>
          <Chip text={`${connected} подключено`} color={connected ? p.ok : p.dim} />
          <Chip text={`${servers.length + clusters.length} всего`} />
          <Chip text="E2E-подписи" color={p.accent} />
        </Row>
      ) : null}
      {!ready ? <Loading /> : null}
      {ready && servers.length === 0 && clusters.length === 0 ? (
        <Card accent={p.accent} style={{ padding: 20, marginTop: 4 }}>
          <BrandMark size={56} />
          <Empty title="Начните с подключения" text="Отсканируйте QR-приглашение владельца или добавьте адрес сервера. Перед входом приложение покажет отпечаток ключа для проверки." />
          <Notice kind="info" text="Для ответов моделей используется облачный API. На телефон не загружаются и не запускаются локальные модели." />
        </Card>
      ) : null}
      {clusters.length ? <Txt kind="label">кластеры</Txt> : null}
      {clusters.map((c) => <ClusterCard key={c.id} cluster={c} />)}
      {servers.length ? <Txt kind="label">серверы и пространства</Txt> : null}
      {servers.map((s) => <ServerCard key={s.id} server={s} />)}
      {ready && (servers.length > 0 || clusters.length > 0) ? <Txt kind="small" style={{ textAlign: "center", marginTop: 8 }}>Ключи устройства защищены системным хранилищем. Опасные действия подтверждаются вами.</Txt> : null}
    </Screen>
  );
}

function DesktopHome({ servers, clusters, ready }: { servers: ServerRecord[]; clusters: ClusterRecord[]; ready: boolean }) {
  const { p } = useTheme();
  const connected = servers.filter((s) => s.device).length + clusters.filter((c) => c.status === "active").length;
  return (
    <Screen scroll={false}>
      <View style={{ flex: 1, flexDirection: "row", minHeight: 0 }}>
        <View style={{ width: 250, backgroundColor: p.bg2, borderRightWidth: 1, borderRightColor: p.line }}>
          <View style={{ padding: 16, gap: 12 }}>
            <Row style={{ justifyContent: "space-between" }}><Txt kind="label">пространства</Txt><IconBtn glyph="+" label="Добавить сервер" onPress={() => router.push("/add")} /></Row>
            <View style={{ borderWidth: 1, borderColor: p.line, backgroundColor: p.bg, padding: 9, borderRadius: 8 }}><Txt kind="small">⌕  Поиск по пространствам</Txt></View>
          </View>
          <ScrollView contentContainerStyle={{ padding: 8, gap: 5 }}>
            {servers.map((s) => (
              <Pressable key={s.id} onPress={() => router.push(s.device ? `/s/${s.id}` : `/s/${s.id}/login`)} style={({ pressed }) => ({ padding: 10, borderRadius: 8, backgroundColor: pressed ? p.panel2 : "transparent", flexDirection: "row", alignItems: "center", gap: 10 })}>
                <ServerIcon name={s.name} active={!!s.device} />
                <View style={{ flex: 1 }}><Txt numberOfLines={1} style={{ fontSize: 13 }}>{s.name}</Txt><Txt kind="small" numberOfLines={1}>{s.device ? "Подключено" : "Нужен вход"}</Txt></View>
              </Pressable>
            ))}
            {clusters.map((c) => <ClusterCard key={c.id} cluster={c} />)}
            {ready && !servers.length && !clusters.length ? <Txt kind="small" style={{ padding: 10 }}>Здесь появятся ваши серверы.</Txt> : null}
          </ScrollView>
          <View style={{ marginTop: "auto", margin: 12, padding: 11, borderWidth: 1, borderColor: p.line, borderRadius: 9, backgroundColor: p.panel }}>
            <Row gap={6}><View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: connected ? p.ok : p.faint }} /><Txt kind="small">{connected ? "Соединения активны" : "Ожидает подключения"}</Txt></Row>
            <Txt kind="small" style={{ marginTop: 5 }}>{connected} из {servers.length + clusters.length} пространств</Txt>
          </View>
        </View>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 32, gap: 22, maxWidth: 1050, width: "100%", alignSelf: "center" }}>
          <UpdateBanner clusters={clusters} />
          <SectionHeading eyebrow="рабочий стол" title="Добро пожаловать в Fugu Deck" text="Выберите пространство или подключите новое. Чаты, модели и инструменты используют существующие защищённые сессии." right={<BrandMark size={52} />} />
          <ConnectActions desktop />
          {!ready ? <Loading /> : null}
          {ready && servers.length === 0 && clusters.length === 0 ? (
            <Card accent={p.accent} style={{ padding: 28, alignItems: "flex-start" }}>
              <Txt kind="h2" style={{ fontSize: 22 }}>Первое пространство — за пару минут</Txt>
              <Txt kind="dim">QR-код автоматически проверит адрес и ключ сервера. После входа здесь появятся проекты, чаты и каталог доступных моделей.</Txt>
            </Card>
          ) : null}
          {servers.length ? <><Txt kind="label">ваши серверы</Txt><View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>{servers.map((s) => <View key={s.id} style={{ flexBasis: 310, flexGrow: 1 }}><ServerCard server={s} desktop /></View>)}</View></> : null}
          {clusters.map((c) => <ClusterCard key={c.id} cluster={c} />)}
        </ScrollView>
        <View style={{ width: 275, borderLeftWidth: 1, borderLeftColor: p.line, backgroundColor: p.bg2, padding: 18, gap: 20 }}>
          <View><Txt kind="label">сводка</Txt><View style={{ marginTop: 12, gap: 12 }}><Row style={{ justifyContent: "space-between" }}><Txt kind="dim">Подключено</Txt><Txt color={p.ok}>{connected}</Txt></Row><Row style={{ justifyContent: "space-between" }}><Txt kind="dim">Пространств</Txt><Txt>{servers.length + clusters.length}</Txt></Row><Row style={{ justifyContent: "space-between" }}><Txt kind="dim">Модели</Txt><Txt>Облачные API</Txt></Row></View></View>
          <Card><Txt kind="label">безопасность</Txt><Txt kind="small">✓ Проверка ключа сервера</Txt><Txt kind="small">✓ DPoP-сессии устройства</Txt><Txt kind="small">✓ Подтверждение действий</Txt></Card>
          <Card onPress={() => router.push("/modules")} accent={p.accent}><Txt kind="label">расширения</Txt><Txt kind="h2">Git-модули</Txt><Txt kind="small">Каталог возможностей для приложения без обновления всего клиента.</Txt><Txt color={p.accent}>Открыть концепт →</Txt></Card>
        </View>
      </View>
    </Screen>
  );
}

export default function Servers() {
  const desktop = useDesktopLayout();
  const { ready, servers } = useServers();
  const [clusters, setClusters] = useState<ClusterRecord[]>([]);
  useFocusEffect(useCallback(() => { void listClusters().then(setClusters); }, []));
  return desktop
    ? <DesktopHome servers={servers} clusters={clusters} ready={ready} />
    : <MobileHome servers={servers} clusters={clusters} ready={ready} />;
}
