import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";

import type { Conversation, Project } from "@/core/types";
import { useApi, useLoad } from "@/state/hooks";
import { useServers } from "@/state/servers";
import { Btn, Card, Chip, Empty, errText, Field, Loading, Notice, Row, Screen, Txt } from "@/ui/kit";
import { SectionHeading } from "@/ui/SectionHeading";
import { Tabs, type TabItem } from "@/ui/Tabs";
import { useTheme } from "@/ui/theme";

type Filter = "all" | "agents" | "talk";
type ChatRow = Conversation & { projectName: string };
type ChatData = { projects: Project[]; items: ChatRow[] };

const FILTERS: TabItem<Filter>[] = [
  { id: "all", title: "Все" },
  { id: "agents", title: "Агенты" },
  { id: "talk", title: "Общение" },
];

function ago(ts?: number): string {
  if (!ts) return "";
  const seconds = Date.now() / 1000 - ts;
  if (seconds < 60) return "только что";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} мин назад`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} ч назад`;
  return new Date(ts * 1000).toLocaleDateString("ru-RU");
}

export default function RecentChats() {
  const { p } = useTheme();
  const { sid } = useLocalSearchParams<{ sid: string }>();
  const { get } = useServers();
  const rec = get(sid);
  const { api, error: apiError } = useApi(sid);
  const { data, error, reload } = useLoad(useCallback(async (): Promise<ChatData | null> => {
    if (!api) return null;
    const projects = await api.projects();
    const lists = await Promise.all(projects.map(async (project) => {
      const conversations = await api.conversations(project.id);
      return conversations.map((chat) => ({ ...chat, projectName: project.name }));
    }));
    return { projects, items: lists.flat().sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0)) };
  }, [api]));
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  if (!rec) return <Redirect href="/" />;
  if (!rec.device) return <Redirect href={`/s/${sid}/login`} />;

  const normalized = query.trim().toLowerCase();
  const visible = (data?.items || []).filter((chat) => {
    if (filter === "talk" && chat.project_id !== "talk") return false;
    if (filter === "agents" && chat.project_id === "talk") return false;
    return !normalized || `${chat.title} ${chat.projectName} ${chat.model}`.toLowerCase().includes(normalized);
  });
  const running = data?.items.filter((chat) => chat.running).length || 0;
  const newTalk = async () => {
    if (!api) return;
    setBusy(true);
    setActionError("");
    try {
      const chat = await api.createConversation("talk");
      router.push(`/s/${sid}/c/${chat.id}`);
    } catch (e) {
      setActionError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Чаты" back={false}>
      <SectionHeading
        eyebrow={rec.name}
        title="Недавние"
        text="Разговоры с моделями и рабочие чаты агентов со всех проектов — в одной ленте."
        right={running ? <Chip text={`${running} активны`} color={p.ok} /> : undefined}
      />
      {apiError || error || actionError ? <Notice text={(apiError || error || actionError)!} /> : null}
      <Row gap={8}>
        <Btn title="+ Разговор" onPress={newTalk} busy={busy} disabled={!api} style={{ flex: 1 }} />
        <Btn title="В проект" kind="ghost" onPress={() => router.push(`/s/${sid}`)} style={{ flex: 1 }} />
      </Row>
      <Tabs<Filter> items={FILTERS} value={filter} onChange={setFilter} label="Фильтр чатов" />
      <Field label="Поиск" value={query} onChangeText={setQuery} placeholder="Название, проект или модель" returnKeyType="search" />
      {!data && !error && !apiError ? <Loading text="Собираем чаты проектов…" /> : null}
      {data && !visible.length ? <Empty title={query ? "Ничего не найдено" : "Чатов пока нет"} text={query ? "Измените запрос или фильтр." : "Создайте разговор или откройте проект для чата с агентом."} /> : null}
      {visible.map((chat) => (
        <Card key={chat.id} accent={chat.running ? p.ok : chat.project_id === "talk" ? p.accent : undefined} onPress={() => router.push(`/s/${sid}/c/${chat.id}`)}>
          <Row style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
            <ViewTitle title={chat.title} sub={!!chat.parent_id} />
            {chat.running ? <Chip text="работает" color={p.ok} /> : <Txt kind="small">{ago(chat.updated_at)}</Txt>}
          </Row>
          <Row style={{ justifyContent: "space-between", gap: 8 }}>
            <Txt kind="small" numberOfLines={1} style={{ flex: 1 }}>{chat.projectName}{chat.parent_id ? " · под-агент" : ""}</Txt>
            <Txt kind="mono" numberOfLines={1} style={{ maxWidth: "52%", fontSize: 11, color: p.dim }}>{chat.model.split(":").pop()}</Txt>
          </Row>
        </Card>
      ))}
      {data ? <Btn small kind="ghost" title="Обновить список" onPress={reload} style={{ alignSelf: "center" }} /> : null}
    </Screen>
  );
}

function ViewTitle({ title, sub }: { title: string; sub: boolean }) {
  return <Txt numberOfLines={2} style={{ flex: 1, fontWeight: "600" }}>{sub ? "↳ " : ""}{title}</Txt>;
}
