import { router, useLocalSearchParams, usePathname } from "expo-router";
import { useEffect, useState, type ReactNode } from "react";
import { Image, Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";

import { appModulesPath, appSection, appSectionPath, SECTION_LABELS, type AppSection } from "@/core/navigation";
import { clusterOfSid, parseSid } from "@/state/cluster";
import { useServers } from "@/state/servers";

import { alpha, MONO, useTheme } from "./theme";
import { DesktopConversationContext, DesktopConversationSidebar } from "./DesktopChatPanels";
import { DesktopCommandPalette } from "./DesktopCommandPalette";
import { SpaceSwitcher } from "./SpaceSwitcher";
import { useDesktopLayout } from "./useDesktopLayout";
import { WebScrollbarStyle } from "./WebScrollbarStyle";

type DesktopBridge = { minimize(): void; maximize(): void; close(): void };
const desktopBridge = () => (globalThis as typeof globalThis & { fuguDesktop?: DesktopBridge }).fuguDesktop;
const draggable = { WebkitAppRegion: "drag" } as ViewStyle;
const notDraggable = { WebkitAppRegion: "no-drag" } as ViewStyle;

const NAV: { id: Exclude<AppSection, "parameters">; glyph: string }[] = [
  { id: "home", glyph: "⌂" },
  { id: "chats", glyph: "◫" },
  { id: "projects", glyph: "▤" },
  { id: "models", glyph: "◇" },
  { id: "servers", glyph: "⌁" },
  { id: "access", glyph: "⚿" },
  { id: "permissions", glyph: "✓" },
];

function NavButton({ glyph, label, active, collapsed, indented, onPress }: {
  glyph: string; label: string; active?: boolean; collapsed: boolean; indented?: boolean; onPress(): void;
}) {
  const { p } = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityLabel={label} accessibilityRole="button" accessibilityState={{ selected: !!active }}
      style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [
        styles.navButton, indented && !collapsed ? styles.indented : null,
        active ? { backgroundColor: alpha(p.accent, 0.11), borderColor: alpha(p.accent, 0.35) } : null,
        hovered || pressed ? { backgroundColor: p.panel2 } : null,
      ]}>
      <Text style={[styles.navGlyph, { color: active ? p.accent : p.dim }]}>{glyph}</Text>
      {!collapsed ? <Text numberOfLines={1} style={[styles.navLabel, { color: active ? p.accent : p.text }]}>{label}</Text> : null}
    </Pressable>
  );
}

function WindowButton({ glyph, label, action, danger }: { glyph: string; label: string; action?: () => void; danger?: boolean }) {
  const { p } = useTheme();
  return (
    <Pressable onPress={action} disabled={!action} accessibilityLabel={label}
      style={({ pressed }) => [styles.windowButton, pressed && action ? { backgroundColor: danger ? "#c42b1c" : p.panel2 } : null]}>
      <Text style={{ color: p.dim, fontSize: 16 }}>{glyph}</Text>
    </Pressable>
  );
}

export function DesktopShell({ children }: { children: ReactNode }) {
  const desktop = useDesktopLayout();
  const pathname = usePathname();
  const { tab } = useLocalSearchParams<{ tab?: string }>();
  const { p } = useTheme();
  const { servers, get } = useServers();
  const [palette, setPalette] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const sid = /^\/s\/([^/]+)/.exec(pathname)?.[1];
  const [lastSid, setLastSid] = useState("");
  const activeSid = sid || lastSid || servers.find((server) => server.device)?.id;
  const chatMatch = /^\/s\/([^/]+)\/c\/([^/]+)/.exec(pathname);
  const current = activeSid ? get(activeSid) : undefined;
  const cluster = activeSid ? clusterOfSid(activeSid) : null;
  const kind = activeSid && parseSid(activeSid)?.team ? "team" : cluster ? "cluster" : "standalone";
  const bridge = desktopBridge();
  const go = (path: string) => {
    if (sid) setLastSid(sid);
    router.push(path as never);
  };
  const section = pathname.includes("/prefs") && tab === "agents" ? "permissions" : pathname.includes("/prefs") && tab === "repos" ? "projects" : appSection(pathname);
  const home = section === "home";

  useEffect(() => {
    if (!desktop) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === "k") { event.preventDefault(); setPalette(true); }
      if (event.ctrlKey && event.altKey && event.key.toLowerCase() === "t" && sid) { event.preventDefault(); router.push(`/s/${sid}/workspace`); }
      if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === "n" && sid) { event.preventDefault(); router.push(`/s/${sid}`); }
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [desktop, sid]);

  if (!desktop) return children;
  const pathFor = (id: AppSection) => appSectionPath(id, { sid: activeSid, cluster, kind });

  return (
    <View style={[styles.window, { backgroundColor: p.bg }]}>
      <WebScrollbarStyle />
      <View style={[styles.titlebar, draggable, { backgroundColor: p.bg2, borderColor: p.line }]}>
        <Pressable style={styles.brand} onPress={() => go("/")} accessibilityLabel="В главное меню">
          <Image source={require("../../assets/icon.png")} style={styles.logo} />
          <Text style={{ color: p.text, fontSize: 13, fontWeight: "600" }}>Fugu Deck</Text>
          <View style={[styles.alpha, { borderColor: p.line2 }]}><Text style={{ color: p.dim, fontSize: 9 }}>ALPHA</Text></View>
        </Pressable>
        <Text style={[styles.titleCenter, { color: p.dim }]}>{home ? "Главное меню" : current?.name || "Локальные настройки"}{!home && current?.device ? ` · ${current.device.user.display_name || current.device.user.username}` : ""}</Text>
        <View style={[styles.windowControls, notDraggable]}>
          <WindowButton glyph="—" label="Свернуть" action={bridge?.minimize} />
          <WindowButton glyph="□" label="Развернуть" action={bridge?.maximize} />
          <WindowButton glyph="×" label="Закрыть" action={bridge?.close} danger />
        </View>
      </View>
      <View style={[styles.menubar, { borderColor: p.line }]}>
        <Pressable onPress={() => go("/")}><Text style={[styles.menuText, { color: p.accent }]}>Главное меню</Text></Pressable>
        {!home ? <Text style={[styles.menuText, { color: p.faint }]}>/</Text> : null}
        {!home ? <Text style={[styles.menuText, { color: p.dim }]}>{SECTION_LABELS[section]}</Text> : null}
        {home ? <Pressable onPress={() => go("/settings")} style={{ marginLeft: "auto" }}><Text style={[styles.menuText, { color: p.dim }]}>Параметры</Text></Pressable> : null}
        <Pressable onPress={() => setPalette(true)} style={[styles.command, { backgroundColor: p.panel, borderColor: p.line, marginLeft: home ? 12 : "auto" }]}>
          <Text style={{ color: p.dim, fontSize: 11 }}>Команда, раздел или пространство…</Text>
          <Text style={{ color: p.faint, fontFamily: MONO, fontSize: 10 }}>Ctrl K</Text>
        </Pressable>
      </View>
      <View style={styles.workspace}>
        {!home ? (
          <View style={[styles.sidebar, { width: collapsed ? 58 : 216, backgroundColor: p.bg2, borderColor: p.line }]}>
            {current ? <Pressable onPress={() => setSwitcher(true)} accessibilityLabel="Сменить пространство" style={[styles.spaceSwitcher, { backgroundColor: p.panel, borderColor: p.line }]}>
              {collapsed ? <Text style={{ color: p.accent, fontSize: 18, textAlign: "center" }}>⇄</Text> : <>
                <Text numberOfLines={1} style={{ color: p.text, fontSize: 12, fontWeight: "600" }}>{current.name}</Text>
                <Text style={{ color: p.faint, fontSize: 10 }}>Сменить пространство</Text>
              </>}
            </Pressable> : null}
            <View style={styles.navList}>
              {NAV.map((item) => (
                <View key={item.id} style={{ gap: 4 }}>
                  <NavButton glyph={item.glyph} label={SECTION_LABELS[item.id]} collapsed={collapsed}
                    active={section === item.id} onPress={() => go(pathFor(item.id))} />
                  {!collapsed && activeSid && item.id === "chats" ? <NavButton glyph="◷" label="Запуски" collapsed={false} indented active={pathname.includes("/tasks")} onPress={() => go(`/s/${activeSid}/tasks`)} /> : null}
                  {!collapsed && activeSid && item.id === "projects" ? <NavButton glyph="⌘" label="Workspace" collapsed={false} indented active={pathname.includes("/workspace")} onPress={() => go(`/s/${activeSid}/workspace`)} /> : null}
                  {!collapsed && cluster && item.id === "access" ? <NavButton glyph="+" label="Все интеграции" collapsed={false} indented onPress={() => go(`/cluster/${cluster}`)} /> : null}
                </View>
              ))}
            </View>
            <View style={styles.sidebarBottom}>
              <NavButton glyph="◇" label="Модули" collapsed={collapsed} indented active={pathname === "/modules"} onPress={() => go(appModulesPath())} />
              <NavButton glyph="⚙" label={SECTION_LABELS.parameters} collapsed={collapsed} active={section === "parameters" && pathname !== "/modules"} onPress={() => go("/settings")} />
              <NavButton glyph={collapsed ? "⇥" : "⇤"} label={collapsed ? "Развернуть панель" : "Свернуть панель"} collapsed={collapsed} onPress={() => setCollapsed((v) => !v)} />
            </View>
          </View>
        ) : null}
        {chatMatch ? <DesktopConversationSidebar sid={chatMatch[1]} cid={chatMatch[2]} /> : null}
        <View style={styles.content}>{children}</View>
        {chatMatch ? <DesktopConversationContext sid={chatMatch[1]} cid={chatMatch[2]} /> : null}
      </View>
      <View style={[styles.statusbar, { backgroundColor: p.bg2, borderColor: p.line }]}>
        <View style={[styles.statusDot, { backgroundColor: current?.device || servers.some((s) => s.device) ? p.ok : p.faint }]} />
        <Text style={[styles.statusText, { color: p.dim }]}>{current?.device ? "Подключено" : servers.some((s) => s.device) ? "Готов" : "Нет подключения"}</Text>
        <Text style={[styles.statusText, { color: p.faint }]}>{current?.url || "Локальные настройки"}</Text>
        <Text style={[styles.statusText, styles.statusRight, { color: p.faint }]}>Fugu Deck · Windows</Text>
      </View>
      {palette ? <DesktopCommandPalette visible sid={sid} onClose={() => setPalette(false)} /> : null}
      <SpaceSwitcher visible={switcher} currentSid={activeSid} onClose={() => setSwitcher(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  window: { flex: 1, height: "100%" },
  titlebar: { height: 40, flexDirection: "row", alignItems: "center", borderBottomWidth: 1 },
  brand: { flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 14 },
  logo: { width: 23, height: 23, borderRadius: 5 },
  alpha: { borderWidth: 1, paddingHorizontal: 4, paddingVertical: 1 },
  titleCenter: { position: "absolute", left: "42%", fontSize: 11 },
  windowControls: { marginLeft: "auto", alignSelf: "stretch", flexDirection: "row" },
  windowButton: { width: 46, alignItems: "center", justifyContent: "center" },
  menubar: { height: 38, flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 16, borderBottomWidth: 1 },
  menuText: { fontSize: 11 },
  command: { marginLeft: "auto", minWidth: 270, borderWidth: 1, paddingHorizontal: 9, paddingVertical: 5, flexDirection: "row", justifyContent: "space-between", borderRadius: 6 },
  workspace: { flex: 1, flexDirection: "row", minHeight: 0 },
  sidebar: { paddingVertical: 10, paddingHorizontal: 8, borderRightWidth: 1 },
  spaceSwitcher: { borderWidth: 1, borderRadius: 8, padding: 10, marginBottom: 10, gap: 3 },
  navList: { gap: 4 },
  navButton: { minHeight: 40, borderWidth: 1, borderColor: "transparent", borderRadius: 7, flexDirection: "row", alignItems: "center", paddingHorizontal: 10, gap: 11 },
  navGlyph: { width: 21, fontSize: 19, lineHeight: 23, textAlign: "center" },
  navLabel: { fontSize: 12, fontWeight: "500", flex: 1 },
  indented: { marginLeft: 12 },
  sidebarBottom: { marginTop: "auto", gap: 4 },
  content: { flex: 1, minWidth: 0, minHeight: 0 },
  statusbar: { height: 25, borderTopWidth: 1, flexDirection: "row", alignItems: "center", paddingHorizontal: 12, gap: 8 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontFamily: MONO, fontSize: 10 },
  statusRight: { marginLeft: "auto" },
});
