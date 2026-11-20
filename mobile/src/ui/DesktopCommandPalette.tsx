import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";

import { appModulesPath, appSectionPath, SECTION_LABELS, type AppSection } from "@/core/navigation";
import { clusterOfSid, parseSid } from "@/state/cluster";
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
      { title: "Главное меню", hint: "Подключения, вход и регистрация", path: "/" },
      { title: "Модули", hint: "Каталог, конструктор и E2EE", path: appModulesPath() },
      { title: SECTION_LABELS.parameters, hint: "Тема и локальные параметры", path: "/settings" },
    ];
    if (sid) {
      const cluster = clusterOfSid(sid);
      const kind = parseSid(sid)?.team ? "team" : cluster ? "cluster" : "standalone";
      for (const id of ["chats", "projects", "models", "servers", "access", "permissions"] as AppSection[]) {
        out.push({ title: SECTION_LABELS[id], hint: "Раздел текущего пространства", path: appSectionPath(id, { sid, cluster, kind }) });
      }
      out.push(
        { title: "Workspace", hint: "Файлы · diff · CI · SSH", path: `/s/${sid}/workspace` },
        { title: "Запуски и задачи", hint: "Активные и завершённые задания", path: `/s/${sid}/tasks` },
        { title: "Расходы", hint: "Модели, участники и стоимость", path: `/s/${sid}/usage` },
      );
      if (cluster) out.push(
        { title: "Все интеграции", hint: "Ключи · Drive · MCP · домены", path: `/cluster/${cluster}` },
        { title: "MCP", hint: "Подключённые MCP-серверы", path: `/mcp/${cluster}` },
        { title: "Разрешённые домены", hint: "Сетевой доступ агента", path: `/egress/${cluster}` },
      );
    }
    for (const server of servers) out.push({ title: server.name, hint: server.device ? "Запустить пространство" : "Войти", path: server.device ? `/launch/${server.id}` : `/s/${server.id}/login` });
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
