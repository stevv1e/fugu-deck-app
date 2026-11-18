import { router, usePathname } from "expo-router";
import { useEffect, type ReactNode } from "react";
import { Image, Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";

import { useServers } from "@/state/servers";

import { alpha, MONO, useTheme } from "./theme";
import { DesktopConversationContext, DesktopConversationSidebar } from "./DesktopChatPanels";
import { useDesktopLayout } from "./useDesktopLayout";

type DesktopBridge = {
  minimize(): void;
  maximize(): void;
  close(): void;
};

function desktopBridge(): DesktopBridge | undefined {
  return (globalThis as typeof globalThis & { fuguDesktop?: DesktopBridge }).fuguDesktop;
}

const draggable = { WebkitAppRegion: "drag" } as ViewStyle;
const notDraggable = { WebkitAppRegion: "no-drag" } as ViewStyle;

function RailButton({ glyph, label, active, onPress, bottom }: {
  glyph: string;
  label: string;
  active?: boolean;
  onPress(): void;
  bottom?: boolean;
}) {
  const { p } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [
        styles.railButton,
        bottom ? styles.railBottom : null,
        active ? { backgroundColor: alpha(p.accent, 0.1), borderColor: alpha(p.accent, 0.4) } : null,
        hovered || pressed ? { backgroundColor: p.panel2 } : null,
      ]}
    >
      {active ? <View style={[styles.railMarker, { backgroundColor: p.accent }]} /> : null}
      <Text style={[styles.railGlyph, { color: active ? p.accent : p.dim }]}>{glyph}</Text>
    </Pressable>
  );
}

function WindowButton({ glyph, label, action, danger }: { glyph: string; label: string; action?: () => void; danger?: boolean }) {
  const { p } = useTheme();
  return (
    <Pressable
      onPress={action}
      disabled={!action}
      accessibilityLabel={label}
      style={({ pressed }) => [styles.windowButton, pressed && action ? { backgroundColor: danger ? "#c42b1c" : p.panel2 } : null]}
    >
      <Text style={{ color: p.dim, fontSize: 16 }}>{glyph}</Text>
    </Pressable>
  );
}

export function DesktopShell({ children }: { children: ReactNode }) {
  const desktop = useDesktopLayout();
  const pathname = usePathname();
  const { p } = useTheme();
  const { servers, get } = useServers();
  const sid = /^\/s\/([^/]+)/.exec(pathname)?.[1];
  const chatMatch = /^\/s\/([^/]+)\/c\/([^/]+)/.exec(pathname);
  const current = sid ? get(sid) : undefined;
  const bridge = desktopBridge();
  const go = (path: string) => router.push(path as never);
  useEffect(() => {
    if (!desktop) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        router.push("/");
      }
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [desktop]);

  if (!desktop) return children;

  const modelsPath = sid ? `/s/${sid}/prefs` : servers.find((s) => s.device) ? `/s/${servers.find((s) => s.device)!.id}/prefs` : "/";
  const serverPath = sid ? `/s/${sid}/settings` : "/settings";
  const workspace = current?.name || "Fugu Deck";

  return (
    <View style={[styles.window, { backgroundColor: p.bg }]}>
      <View style={[styles.titlebar, draggable, { backgroundColor: p.bg2, borderColor: p.line }]}>
        <View style={styles.brand}>
          <Image source={require("../../assets/icon.png")} style={styles.logo} />
          <Text style={{ color: p.text, fontSize: 13, fontWeight: "600" }}>Fugu Deck</Text>
          <View style={[styles.alpha, { borderColor: p.line2 }]}><Text style={{ color: p.dim, fontSize: 9 }}>ALPHA</Text></View>
        </View>
        <Text style={[styles.titleCenter, { color: p.dim }]}>{workspace}{current?.device ? ` · ${current.device.user.display_name || current.device.user.username}` : ""}</Text>
        <View style={[styles.windowControls, notDraggable]}>
          <WindowButton glyph="—" label="Свернуть" action={bridge?.minimize} />
          <WindowButton glyph="□" label="Развернуть" action={bridge?.maximize} />
          <WindowButton glyph="×" label="Закрыть" action={bridge?.close} danger />
        </View>
      </View>
      <View style={[styles.menubar, { borderColor: p.line }]}>
        <Text style={[styles.menuText, { color: p.dim }]}>Файл</Text>
        <Text style={[styles.menuText, { color: p.dim }]}>Правка</Text>
        <Text style={[styles.menuText, { color: p.dim }]}>Вид</Text>
        <Text style={[styles.menuText, { color: p.dim }]}>Пространство</Text>
        <Pressable onPress={() => go("/")} style={[styles.command, { backgroundColor: p.panel, borderColor: p.line }]}>
          <Text style={{ color: p.dim, fontSize: 11 }}>Перейти к пространству…</Text>
          <Text style={{ color: p.faint, fontFamily: MONO, fontSize: 10 }}>Ctrl K</Text>
        </Pressable>
      </View>
      <View style={styles.workspace}>
        <View style={[styles.rail, { backgroundColor: p.bg2, borderColor: p.line }]}>
          <RailButton glyph="▤" label="Пространства и чаты" active={!pathname.includes("/prefs") && pathname !== "/settings" && pathname !== "/modules"} onPress={() => go(sid ? `/s/${sid}` : "/")} />
          <RailButton glyph="◇" label="Модели и провайдеры" active={pathname.includes("/prefs")} onPress={() => go(modelsPath)} />
          <RailButton glyph="▦" label="Git-модули" active={pathname === "/modules"} onPress={() => go("/modules")} />
          <RailButton glyph="⌁" label="Сервер и устройства" onPress={() => go(serverPath)} />
          <RailButton glyph="⚙" label="Настройки" active={pathname === "/settings"} onPress={() => go("/settings")} bottom />
        </View>
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
  menubar: { height: 34, flexDirection: "row", alignItems: "center", gap: 22, paddingHorizontal: 15, borderBottomWidth: 1 },
  menuText: { fontSize: 11 },
  command: { marginLeft: "auto", minWidth: 245, borderWidth: 1, paddingHorizontal: 9, paddingVertical: 4, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  workspace: { flex: 1, flexDirection: "row", minHeight: 0 },
  rail: { width: 58, alignItems: "center", paddingVertical: 11, gap: 7, borderRightWidth: 1 },
  railButton: { width: 39, height: 39, borderWidth: 1, borderColor: "transparent", alignItems: "center", justifyContent: "center", position: "relative" },
  railBottom: { marginTop: "auto" },
  railGlyph: { fontSize: 21, lineHeight: 24 },
  railMarker: { position: "absolute", left: -10, width: 2, height: 22 },
  content: { flex: 1, minWidth: 0, minHeight: 0 },
  statusbar: { height: 25, borderTopWidth: 1, flexDirection: "row", alignItems: "center", paddingHorizontal: 12, gap: 8 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontFamily: MONO, fontSize: 10 },
  statusRight: { marginLeft: "auto" },
});
