import { router } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";

import type { ConversationFull, Project } from "@/core/types";
import { useApi, useLoad } from "@/state/hooks";
import { useServers } from "@/state/servers";
import { Card, Chip, IconBtn, Loading, Row, Txt } from "@/ui/kit";
import { alpha, MONO, useTheme } from "@/ui/theme";

function timeLabel(ts?: number) {
  if (!ts) return "";
  const diff = Date.now() / 1000 - ts;
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))} мин`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} ч`;
  return new Date(ts * 1000).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

export function DesktopConversationSidebar({ sid, cid }: { sid: string; cid: string }) {
  const { p } = useTheme();
  const { get } = useServers();
  const { api } = useApi(sid);
  const conv = useLoad(useCallback(() => api?.conversation(cid) ?? null, [api, cid]));
  const projects = useLoad(useCallback(() => api?.projects() ?? null, [api]));
  const chats = useLoad(useCallback(() => api && conv.data ? api.conversations(conv.data.project_id) : null, [api, conv.data]));
  const [query, setQuery] = useState("");
  const rec = get(sid);
  const project = projects.data?.find((x) => x.id === conv.data?.project_id);
  const visible = (chats.data ?? []).filter((x) => !x.parent_id && x.title.toLowerCase().includes(query.toLowerCase()));

  return (
    <View style={{ width: 252, backgroundColor: p.bg2, borderRightWidth: 1, borderRightColor: p.line, minHeight: 0 }}>
      <View style={{ padding: 14, gap: 11 }}>
        <Row style={{ justifyContent: "space-between" }}>
          <View style={{ flex: 1 }}><Txt kind="h2" numberOfLines={1} style={{ fontSize: 15 }}>{rec?.name || "Пространство"}</Txt><Txt kind="small" numberOfLines={1}>{project?.name || "Загрузка проекта…"}</Txt></View>
          <IconBtn glyph="+" label="Новый чат" onPress={() => project && router.push(`/s/${sid}/p/${project.id}`)} />
        </Row>
        <View style={{ flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: p.line, backgroundColor: p.bg, borderRadius: 8, paddingHorizontal: 9 }}>
          <Txt kind="small">⌕</Txt>
          <TextInput value={query} onChangeText={setQuery} placeholder="Поиск по чатам" placeholderTextColor={p.faint} style={{ flex: 1, color: p.text, fontSize: 12, paddingVertical: 8, paddingHorizontal: 7, outlineStyle: "none" } as never} />
        </View>
      </View>
      <View style={{ paddingHorizontal: 14, paddingBottom: 6 }}><Txt kind="label">недавние чаты</Txt></View>
      <ScrollView contentContainerStyle={{ padding: 7, gap: 4 }}>
        {!chats.data && !chats.error ? <Loading /> : null}
        {visible.map((chat) => {
          const active = chat.id === cid;
          return (
            <Pressable key={chat.id} onPress={() => router.push(`/s/${sid}/c/${chat.id}`)} style={{ padding: 11, borderWidth: 1, borderColor: active ? p.line2 : "transparent", backgroundColor: active ? p.panel : "transparent", borderRadius: 9, gap: 6 }}>
              <Row style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                <Txt numberOfLines={2} style={{ flex: 1, fontSize: 13, lineHeight: 18, fontWeight: active ? "600" : "500" }}>{chat.title}</Txt>
                {chat.running ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: p.ok, marginTop: 5 }} /> : null}
              </Row>
              <Row style={{ justifyContent: "space-between" }}><Txt kind="small" numberOfLines={1} style={{ flex: 1, fontFamily: MONO, fontSize: 9 }}>{chat.model.split(":").pop()}</Txt><Txt kind="small" style={{ fontSize: 10 }}>{timeLabel(chat.updated_at)}</Txt></Row>
            </Pressable>
          );
        })}
        {chats.data && !visible.length ? <Txt kind="small" style={{ padding: 10 }}>Чаты не найдены.</Txt> : null}
      </ScrollView>
      <View style={{ marginTop: "auto", margin: 11, padding: 10, borderWidth: 1, borderColor: p.line, borderRadius: 9, backgroundColor: p.panel }}>
        <Row gap={6}><View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: p.ok }} /><Txt kind="small">Сервер подключён</Txt></Row>
        <Txt kind="small" numberOfLines={1} style={{ marginTop: 5 }}>{rec ? new URL(rec.url).host : ""}</Txt>
      </View>
    </View>
  );
}

export function DesktopConversationContext({ sid, cid }: { sid: string; cid: string }) {
  const { p } = useTheme();
  const { get } = useServers();
  const { api } = useApi(sid);
  const conv = useLoad(useCallback(() => api?.conversation(cid) ?? null, [api, cid]));
  const projects = useLoad(useCallback(() => api?.projects() ?? null, [api]));
  const rec = get(sid);
  const data: ConversationFull | null = conv.data;
  const project: Project | undefined = projects.data?.find((x) => x.id === data?.project_id);
  return (
    <ScrollView style={{ width: 264, backgroundColor: p.bg2, borderLeftWidth: 1, borderLeftColor: p.line }} contentContainerStyle={{ padding: 15, gap: 16 }}>
      <View><Txt kind="label">контекст задачи</Txt><Card style={{ marginTop: 10, padding: 12 }}><Detail label="Проект" value={project?.name || "—"} /><Detail label="Модель" value={data?.model.split(":").pop() || "—"} accent /><Detail label="Сообщений" value={String(data?.messages.length ?? 0)} /><Detail label="Статус" value={data?.active_run ? "Агент работает" : "Готов"} ok={!data?.active_run} /></Card></View>
      <View><Txt kind="label">репозитории</Txt><View style={{ marginTop: 9, gap: 6 }}>{project?.repos?.length ? project.repos.map((r) => <Chip key={`${r.provider}:${r.repo}`} text={r.repo} color={p.accent} />) : <Txt kind="small">Репозитории не привязаны.</Txt>}</View></View>
      <View><Txt kind="label">безопасность</Txt><Card style={{ marginTop: 10, padding: 12 }}><Txt kind="small">✓ Сессия устройства DPoP</Txt><Txt kind="small">✓ Ключ сервера закреплён</Txt><Txt kind="small">✓ Действия по правилам агента</Txt>{rec?.device?.certPem ? <Txt kind="small">✓ Сертификат mTLS</Txt> : null}</Card></View>
      <View style={{ borderWidth: 1, borderColor: alpha(p.accent, 0.25), backgroundColor: alpha(p.accent, 0.04), borderRadius: 9, padding: 11 }}><Txt kind="small">Модель работает через облачный API. На этом компьютере выполняются только интерфейс и разрешённые инструменты.</Txt></View>
    </ScrollView>
  );
}

function Detail({ label, value, accent, ok }: { label: string; value: string; accent?: boolean; ok?: boolean }) {
  const { p } = useTheme();
  return <Row style={{ justifyContent: "space-between", alignItems: "flex-start", paddingVertical: 5 }}><Txt kind="small">{label}</Txt><Txt kind="small" color={accent ? p.accent : ok ? p.ok : p.text} numberOfLines={2} style={{ maxWidth: 145, textAlign: "right", fontFamily: accent ? MONO : undefined }}>{value}</Txt></Row>;
}

