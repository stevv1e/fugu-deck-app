import { router, usePathname } from "expo-router";
import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { mobileSection, mobileSectionPath, showMobileNavigation, type MobileSection } from "@/core/mobileNavigation";
import { appModulesPath, appSectionPath, SECTION_LABELS } from "@/core/navigation";
import { clusterOfSid, parseSid } from "@/state/cluster";
import { useServers } from "@/state/servers";

import { BrandMark } from "./BrandMark";
import { Chip, IconBtn, Row, Txt } from "./kit";
import { alpha, useTheme } from "./theme";
import { useDesktopLayout } from "./useDesktopLayout";

const TABS: { id: Exclude<MobileSection, "more">; title: string; glyph: string }[] = [
  { id: "chats", title: "Чаты", glyph: "◫" },
  { id: "projects", title: "Проекты", glyph: "▤" },
  { id: "models", title: "Модели", glyph: "◇" },
];

function MenuLink({ title, text, onPress, accent }: { title: string; text?: string; onPress(): void; accent?: boolean }) {
  const { p } = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [styles.menuLink, { backgroundColor: pressed ? p.panel2 : p.panel, borderColor: accent ? alpha(p.accent, 0.45) : p.line }]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Txt style={{ fontWeight: "600", color: accent ? p.accent : p.text }}>{title}</Txt>
        {text ? <Txt kind="small">{text}</Txt> : null}
      </View>
      <Txt color={p.dim}>›</Txt>
    </Pressable>
  );
}

export function MobileShell({ children }: { children: ReactNode }) {
  const desktop = useDesktopLayout();
  const pathname = usePathname();
  const { p } = useTheme();
  const { servers, get } = useServers();
  const [more, setMore] = useState(false);
  const [lastSid, setLastSid] = useState("");
  const sid = /^\/s\/([^/]+)/.exec(pathname)?.[1];
  const activeSid = sid || lastSid || servers.find((server) => server.device)?.id;
  const current = activeSid ? get(activeSid) : undefined;
  const section = mobileSection(pathname);
  const projectId = /^\/s\/[^/]+\/(?:p|kb|sched)\/([^/]+)/.exec(pathname)?.[1];
  const cluster = activeSid ? clusterOfSid(activeSid) : null;
  const kind = activeSid && parseSid(activeSid)?.team ? "team" : cluster ? "cluster" : "standalone";

  if (desktop || !showMobileNavigation(pathname)) return children;

  const go = (path: string) => {
    if (activeSid) setLastSid(activeSid);
    setMore(false);
    router.push(path as never);
  };
  const sectionPath = (id: Parameters<typeof appSectionPath>[0]) => appSectionPath(id, { sid: activeSid, cluster, kind });

  return (
    <View style={[styles.window, { backgroundColor: p.bg }]}>
      <View style={styles.content}>{children}</View>
      <SafeAreaView edges={["bottom"]} style={[styles.barSafe, { backgroundColor: p.bg2, borderTopColor: p.line }]}>
        <View style={styles.bar}>
          {TABS.map((tab) => {
            const active = section === tab.id;
            return (
              <Pressable key={tab.id} onPress={() => go(mobileSectionPath(tab.id, activeSid) || "/")} accessibilityRole="button" accessibilityLabel={tab.title} accessibilityState={{ selected: active }} style={({ pressed }) => [styles.tab, pressed && { backgroundColor: p.panel2 }]}>
                <Text style={[styles.glyph, { color: active ? p.accent : p.dim }]}>{tab.glyph}</Text>
                <Text numberOfLines={1} style={[styles.tabText, { color: active ? p.accent : p.dim }]}>{tab.title}</Text>
              </Pressable>
            );
          })}
          <Pressable onPress={() => setMore(true)} accessibilityRole="button" accessibilityLabel="Ещё" accessibilityState={{ selected: section === "more" }} style={({ pressed }) => [styles.tab, pressed && { backgroundColor: p.panel2 }]}>
            <Text style={[styles.glyph, { color: section === "more" ? p.accent : p.dim }]}>•••</Text>
            <Text style={[styles.tabText, { color: section === "more" ? p.accent : p.dim }]}>Ещё</Text>
          </Pressable>
        </View>
      </SafeAreaView>
      {more ? (
        <View style={styles.overlay}>
          <Pressable style={styles.backdrop} onPress={() => setMore(false)} accessibilityLabel="Закрыть меню" />
          <SafeAreaView edges={["bottom"]} style={[styles.sheet, { backgroundColor: p.bg2, borderColor: p.line2 }]}>
            <View style={styles.sheetHeader}>
              <Row>
                <BrandMark size={34} />
                <View style={{ flex: 1 }}>
                  <Txt kind="h2">Fugu Deck</Txt>
                  <Txt kind="small" numberOfLines={1}>{current?.name || "Главное меню и возможности"}</Txt>
                </View>
              </Row>
              <IconBtn glyph="⌂" label="В главное меню" onPress={() => go("/")} />
              <IconBtn glyph="×" label="Закрыть меню" onPress={() => setMore(false)} />
            </View>
            <ScrollView contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
              <MenuLink title="Главное меню" text="Подключения, вход и регистрация" onPress={() => go("/")} accent />
              {current ? (
                <>
                  <Row style={{ justifyContent: "space-between" }}>
                    <Txt kind="label">текущее пространство</Txt>
                    <Chip text={current.device ? "подключено" : "нужен вход"} color={current.device ? p.ok : p.warn} />
                  </Row>
                  <MenuLink title={SECTION_LABELS.projects} text="Обзор, режимы, чаты и память" onPress={() => go(sectionPath("projects"))} />
                  <MenuLink title="Workspace" text="Файлы, Git diff, CI и SSH" onPress={() => go(`/s/${activeSid}/workspace`)} />
                  {projectId ? (
                    <>
                      <MenuLink title="Чаты проекта" onPress={() => go(`/s/${activeSid}/p/${projectId}`)} />
                      <MenuLink title="База знаний проекта" onPress={() => go(`/s/${activeSid}/kb/${projectId}`)} />
                      <MenuLink title="Расписание проекта" onPress={() => go(`/s/${activeSid}/sched/${projectId}`)} />
                    </>
                  ) : null}
                  <MenuLink title="Запуски и задачи" onPress={() => go(`/s/${activeSid}/tasks`)} />
                  <MenuLink title="Репозитории" onPress={() => go(`/s/${activeSid}/prefs?tab=repos`)} />
                  <MenuLink title={SECTION_LABELS.servers} text="SSH, устройства сервера и журнал" onPress={() => go(sectionPath("servers"))} />
                  <MenuLink title={SECTION_LABELS.access} text="AI/Git ключи, Drive, MCP и домены" onPress={() => go(sectionPath("access"))} />
                  {cluster ? (
                    <>
                      <MenuLink title="Все интеграции кластера" text="Ключи, Drive, MCP и сетевой доступ" onPress={() => go(`/cluster/${cluster}`)} />
                      <MenuLink title="MCP" onPress={() => go(`/mcp/${cluster}`)} />
                      <MenuLink title="Разрешённые домены" onPress={() => go(`/egress/${cluster}`)} />
                    </>
                  ) : null}
                  <MenuLink title={SECTION_LABELS.permissions} text="Агенты, участники, устройства и подтверждения" onPress={() => go(sectionPath("permissions"))} />
                  <MenuLink title="Скилы агента" onPress={() => go(`/s/${activeSid}/skills`)} />
                  <MenuLink title="Расходы" onPress={() => go(`/s/${activeSid}/usage`)} />
                </>
              ) : <MenuLink title="Подключить пространство" onPress={() => go("/add")} />}
              <Txt kind="label">приложение</Txt>
              <Row gap={8}>
                <View style={{ flex: 1 }}><MenuLink title="Сканировать QR" onPress={() => go("/scan")} /></View>
                <View style={{ flex: 1 }}><MenuLink title="Добавить ссылку" onPress={() => go("/add")} /></View>
              </Row>
              <MenuLink title="Модули" text="Каталог, конструктор, безопасность и E2EE" onPress={() => go(appModulesPath())} />
              <MenuLink title={SECTION_LABELS.parameters} text="Темы, уведомления, устройство и сборка" onPress={() => go("/settings")} />
            </ScrollView>
          </SafeAreaView>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  window: { flex: 1 },
  content: { flex: 1, minHeight: 0 },
  barSafe: { borderTopWidth: 1 },
  bar: { height: 61, flexDirection: "row", alignItems: "stretch", paddingHorizontal: 3 },
  tab: { flex: 1, minWidth: 0, alignItems: "center", justifyContent: "center", gap: 3, marginVertical: 5, borderRadius: 9 },
  glyph: { fontSize: 20, lineHeight: 23, fontWeight: "600" },
  tabText: { fontSize: 10, lineHeight: 13, fontWeight: "600" },
  overlay: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, justifyContent: "flex-end", zIndex: 20 },
  backdrop: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(0,0,0,0.62)" },
  sheet: { maxHeight: "84%", borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, borderBottomWidth: 0 },
  sheetHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 18, paddingTop: 17, paddingBottom: 12 },
  sheetContent: { paddingHorizontal: 16, paddingBottom: 24, gap: 10 },
  menuLink: { minHeight: 51, borderWidth: 1, borderRadius: 11, paddingHorizontal: 13, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 10 },
});
