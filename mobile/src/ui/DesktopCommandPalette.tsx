import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";

import { useServers } from "@/state/servers";
import { IconBtn, Row, Txt } from "@/ui/kit";
import { MONO, useTheme } from "@/ui/theme";

type Command = { title: string; hint: string; path: string };

export function DesktopCommandPalette({ visible, sid, onClose }: { visible: boolean; sid?: string; onClose(): void }) {
  const { p } = useTheme();
  const { servers } = useServers();
  const [query, setQuery] = useState("");
  const input = useRef<TextInput>(null);
  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => input.current?.focus(), 30);
    return () => clearTimeout(timer);
  }, [visible]);
  const commands = useMemo<Command[]>(() => {
    const out: Command[] = [
      { title: "Пространства и проекты", hint: "Home", path: "/" },
      { title: "Git-модули", hint: "Каталог расширений", path: "/modules" },
      { title: "Настройки приложения", hint: "Тема и локальные параметры", path: "/settings" },
    ];
    if (sid) {
      out.unshift(
        { title: "Открыть проект", hint: "Чаты и память", path: `/s/${sid}` },
        { title: "Windows Workspace", hint: "Файлы · diff · CI · SSH", path: `/s/${sid}/workspace` },
        { title: "Модели и провайдеры", hint: "Поиск · роли · fallback", path: `/s/${sid}/prefs` },
        { title: "Создать проект", hint: "Ctrl N", path: `/s/${sid}` },
      );
    }
    for (const server of servers) out.push({ title: server.name, hint: "Пространство", path: server.device ? `/s/${server.id}` : `/s/${server.id}/login` });
    return out;
  }, [sid, servers]);
  const filtered = commands.filter((item) => `${item.title} ${item.hint}`.toLowerCase().includes(query.toLowerCase()));
  const go = (path: string) => { onClose(); router.push(path as never); };
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
    <View style={{ flex: 1, backgroundColor: "#0009", alignItems: "center", paddingTop: 110, paddingHorizontal: 20 }}>
      <Pressable onPress={onClose} style={{ position: "absolute", inset: 0 }} accessibilityLabel="Закрыть command palette" />
      <View style={{ width: "100%", maxWidth: 650, maxHeight: 580, backgroundColor: p.bg2, borderWidth: 1, borderColor: p.line2, borderRadius: 14, overflow: "hidden", shadowColor: "#000", shadowOpacity: 0.5, shadowRadius: 30 }}>
        <Row style={{ padding: 12, borderBottomWidth: 1, borderBottomColor: p.line }}>
          <Txt kind="mono" color={p.accent}>⌘</Txt>
          <TextInput ref={input} value={query} onChangeText={setQuery} placeholder="Команда, проект или пространство…" placeholderTextColor={p.faint}
            onSubmitEditing={() => filtered[0] && go(filtered[0].path)}
            style={{ flex: 1, color: p.text, fontSize: 16, outlineStyle: "none", paddingVertical: 8 } as never} />
          <IconBtn glyph="×" label="Закрыть" onPress={onClose} />
        </Row>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 8, gap: 4 }}>
          {filtered.map((item, index) => <Pressable key={`${item.path}:${item.title}`} onPress={() => go(item.path)} style={({ pressed }) => ({ padding: 12, borderRadius: 8, backgroundColor: pressed || index === 0 && query ? p.panel : "transparent", flexDirection: "row", gap: 14, alignItems: "center" })}>
            <View style={{ flex: 1 }}><Txt>{item.title}</Txt><Txt kind="small">{item.hint}</Txt></View>
            <Txt kind="small" style={{ fontFamily: MONO }}>↵</Txt>
          </Pressable>)}
          {!filtered.length ? <Txt kind="dim" style={{ padding: 20, textAlign: "center" }}>Команда не найдена.</Txt> : null}
        </ScrollView>
      </View>
    </View>
  </Modal>;
}
