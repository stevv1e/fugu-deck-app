/** Боковая панель компьютера: новый чат, список чатов на этом устройстве, ключи провайдеров. */
import { router, usePathname } from "expo-router";
import { useEffect, useState, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";

import { PROVIDER_IDS, PROVIDERS, type Provider } from "@/core/providers";
import { getKey } from "@/platform/secrets";
import { deleteChat, listChats, newChatHref, onChatsChanged, openChatId, type ChatMeta } from "@/state/store";
import { alpha, MONO, useTheme } from "@/ui/theme";

export const SIDEBAR_WIDTH = 290;

const short = (m: string) => m.split(":").pop() || m;

function when(ts: number): string {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "сейчас";
  if (s < 3600) return `${Math.floor(s / 60)} мин`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч`;
  return new Date(ts).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

function Hover({ onPress, active, label, children, style }: {
  onPress(): void; active?: boolean; label?: string; children: (hover: boolean) => ReactNode; style?: object;
}) {
  const { p } = useTheme();
  const [hover, setHover] = useState(false);
  return (
    <Pressable onPress={onPress} onHoverIn={() => setHover(true)} onHoverOut={() => setHover(false)} accessibilityRole="button"
      accessibilityLabel={label} style={[{ backgroundColor: active || hover ? p.panel : "transparent" }, style]}>
      {children(hover)}
    </Pressable>
  );
}

export function Sidebar() {
  const { p } = useTheme();
  const path = usePathname();
  const [chats, setChats] = useState<ChatMeta[] | null>(null);
  const [open, setOpen] = useState<string | null>(openChatId());
  const [keys, setKeys] = useState<Record<string, boolean>>({});
  const [armed, setArmed] = useState<string | null>(null);

  useEffect(() => {
    void listChats().then(setChats, () => setChats([]));
    return onChatsChanged(() => {
      void listChats().then(setChats, () => setChats([]));
      setOpen(openChatId());
    });
  }, []);
  // ключи меняются на экране настроек — перечитываем при каждом переходе
  useEffect(() => {
    Promise.all(PROVIDER_IDS.map((x) => getKey(x).then((k) => [x, !!k] as const, () => [x, false] as const))).then((r) => setKeys(Object.fromEntries(r)));
  }, [path]);

  // Ctrl+N — новый чат
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        router.push(newChatHref());
      }
    };
    // перехват: поле ввода react-native-web не пускает нажатия дальше себя
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const inChat = path.startsWith("/c/");
  const remove = async (id: string) => {
    await deleteChat(id);
    setArmed(null);
    if (inChat && open === id) router.replace("/");
  };

  return (
    <View style={{ width: SIDEBAR_WIDTH, height: "100%", backgroundColor: p.bg2, borderRightWidth: 1, borderRightColor: p.line }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingTop: 14, paddingBottom: 12 }}>
        <Pressable onPress={() => router.push("/")} style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 10 }} accessibilityLabel="Главная">
          <View style={{ width: 20, height: 20, borderWidth: 2, borderColor: p.accent, transform: [{ rotate: "45deg" }], borderRadius: p.radius ? 4 : 0 }} />
          <Text style={{ color: p.text, fontFamily: MONO, fontWeight: "700", fontSize: 15 }}>
            FUGU<Text style={{ color: p.accent }}>/</Text>LOCAL
          </Text>
        </Pressable>
        <Hover onPress={() => router.push("/settings")} active={path === "/settings"} label="Настройки"
          style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: p.line2, borderRadius: p.radius }}>
          {() => <Text style={{ color: p.dim, fontSize: 16 }}>⚙</Text>}
        </Hover>
      </View>

      <Pressable onPress={() => router.push(newChatHref())} accessibilityRole="button" accessibilityLabel="Новый чат (Ctrl+N)"
        style={({ pressed }) => ({ marginHorizontal: 14, marginBottom: 10, paddingVertical: 9, flexDirection: "row", justifyContent: "center", alignItems: "center",
          gap: 8, backgroundColor: p.accent, borderRadius: p.radius, opacity: pressed ? 0.8 : 1 })}>
        <Text style={{ color: p.onAccent, fontFamily: MONO, fontWeight: "700", fontSize: 12, letterSpacing: 1.2, textTransform: "uppercase" }}>＋ новый чат</Text>
        <Text style={{ color: alpha(p.onAccent, 0.6), fontFamily: MONO, fontSize: 10 }}>Ctrl+N</Text>
      </Pressable>

      <Text style={{ marginHorizontal: 16, marginBottom: 4, color: p.dim, fontFamily: MONO, fontSize: 10, letterSpacing: 1.6, textTransform: "uppercase" }}>
        чаты на этом устройстве
      </Text>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 8, paddingVertical: 4 }}>
        {chats?.length === 0 ? <Text style={{ color: p.dim, fontSize: 12.5, padding: 10 }}>Чатов пока нет.</Text> : null}
        {chats?.map((c) => {
          const on = inChat && open === c.id;
          return (
            <Hover key={c.id} onPress={() => { setArmed(null); router.push({ pathname: "/c/[id]", params: { id: c.id } }); }} active={on} label={c.title}
              style={{ paddingVertical: 8, paddingLeft: 10, paddingRight: 6, marginBottom: 2, borderLeftWidth: 2, borderLeftColor: on ? p.accent : "transparent", gap: 3 }}>
              {(hover) => (
                <>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Text numberOfLines={1} style={{ flex: 1, color: on ? p.text : alpha(p.text, 0.85), fontSize: 13.5, fontFamily: p.monoText ? MONO : undefined }}>
                      {c.title}
                    </Text>
                    {armed === c.id ? (
                      <Pressable onPress={() => void remove(c.id)} hitSlop={6} accessibilityLabel="Подтвердить удаление">
                        <Text style={{ color: p.accent2, fontFamily: MONO, fontSize: 10.5, fontWeight: "700" }}>УДАЛИТЬ?</Text>
                      </Pressable>
                    ) : hover ? (
                      <Pressable onPress={() => setArmed(c.id)} hitSlop={6} accessibilityLabel={`Удалить чат ${c.title}`}>
                        <Text style={{ color: p.faint, fontSize: 13 }}>✕</Text>
                      </Pressable>
                    ) : (
                      <Text style={{ color: p.faint, fontFamily: MONO, fontSize: 10.5 }}>{when(c.updated)}</Text>
                    )}
                  </View>
                  <Text numberOfLines={1} style={{ color: p.faint, fontFamily: MONO, fontSize: 10.5 }}>{short(c.model)}</Text>
                </>
              )}
            </Hover>
          );
        })}
      </ScrollView>

      {/* ключи: у кого есть — запросы идут прямо к нему */}
      <View style={{ borderTopWidth: 1, borderTopColor: p.line, paddingHorizontal: 14, paddingVertical: 10, gap: 6 }}>
        {PROVIDER_IDS.map((x: Provider) => (
          <Pressable key={x} onPress={() => router.push("/settings")} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <View style={{ width: 6, height: 6, backgroundColor: keys[x] ? p.ok : p.faint }} />
            <Text style={{ flex: 1, color: keys[x] ? p.dim : p.faint, fontFamily: MONO, fontSize: 11.5 }}>{PROVIDERS[x].title}</Text>
            <Text style={{ color: p.faint, fontFamily: MONO, fontSize: 10.5 }}>{keys[x] ? "ключ есть" : "нет ключа"}</Text>
          </Pressable>
        ))}
        <Text style={{ color: p.faint, fontFamily: MONO, fontSize: 10, letterSpacing: 0.8, marginTop: 2 }}>напрямую · без сервера</Text>
      </View>
    </View>
  );
}
