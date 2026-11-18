import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";

import type { DeckApi } from "@/core/api";
import { useApi, useLoad } from "@/state/hooks";
import { Btn, Card, Chip, Empty, errText, Loading, Notice, Row, Screen, Txt } from "@/ui/kit";
import { SectionHeading } from "@/ui/SectionHeading";
import { useDesktopLayout } from "@/ui/useDesktopLayout";
import { useTheme } from "@/ui/theme";
import { WorkspaceGit } from "@/ui/WorkspaceGit";
import { WorkspaceTerminal } from "@/ui/WorkspaceTerminal";

type Tab = "files" | "diff" | "ci" | "tasks" | "terminal";

export default function Workspace() {
  const desktop = useDesktopLayout();
  const { sid } = useLocalSearchParams<{ sid: string }>();
  const { api, error: apiError } = useApi(sid);
  const [tab, setTab] = useState<Tab>("files");
  const [pid, setPid] = useState("");
  const [cid, setCid] = useState("");
  const projects = useLoad(useCallback(() => api?.projects() ?? null, [api]));
  const effectivePid = pid || projects.data?.find((item) => item.id !== "talk")?.id || "";
  const conversations = useLoad(useCallback(() => api && effectivePid ? api.conversations(effectivePid) : null, [api, effectivePid]));
  const project = projects.data?.find((item) => item.id === effectivePid);
  const effectiveCid = conversations.data?.some((item) => item.id === cid) ? cid : conversations.data?.[0]?.id || "";

  const tabs: { id: Tab; title: string }[] = [
    { id: "files", title: "Файлы" }, { id: "diff", title: "Diff" }, { id: "ci", title: "CI" },
    { id: "tasks", title: "Фоновые задачи" }, { id: "terminal", title: "SSH-терминал" },
  ];
  return <Screen title="Windows Workspace">
    {!desktop ? <Notice kind="info" text="Desktop-инструменты оптимизированы для Windows. На телефоне доступны те же API, но компоновка компактнее." /> : null}
    <SectionHeading eyebrow="рабочее пространство" title={project?.name || "Проект"} text="Код, изменения, CI, фоновые запуски и серверы — с существующими правами и подтверждениями Fugu Deck." />
    {apiError ? <Notice text={apiError} /> : null}
    <Row gap={7} style={{ flexWrap: "wrap" }}>{projects.data?.filter((item) => item.id !== "talk").map((item) => <Btn key={item.id} small kind={item.id === effectivePid ? "primary" : "ghost"} title={item.name} onPress={() => { setPid(item.id); setCid(""); }} />)}</Row>
    <Row gap={7} style={{ flexWrap: "wrap" }}>{tabs.map((item) => <Btn key={item.id} small kind={item.id === tab ? "primary" : "ghost"} title={item.title} onPress={() => setTab(item.id)} />)}</Row>
    {!api || !project ? <Loading /> : null}
    {api && project && ["files", "diff", "ci"].includes(tab) ? <WorkspaceGit api={api} repos={project.repos || []} mode={tab as "files" | "diff" | "ci"} /> : null}
    {api && tab === "tasks" ? <Tasks api={api} sid={sid} /> : null}
    {api && tab === "terminal" ? <>
      {conversations.data?.length ? <Row gap={6} style={{ flexWrap: "wrap" }}>{conversations.data.map((chat) => <Btn key={chat.id} small kind={chat.id === effectiveCid ? "primary" : "ghost"} title={chat.title} onPress={() => setCid(chat.id)} />)}</Row> : null}
      {effectiveCid ? <WorkspaceTerminal api={api} cid={effectiveCid} /> : <Empty title="Нужен чат проекта" text="Создайте чат: через его агента SSH Gateway проверяет доступ к серверам." />}
    </> : null}
  </Screen>;
}

function Tasks({ api, sid }: { api: DeckApi; sid: string }) {
  const { p } = useTheme();
  const runs = useLoad(useCallback(() => api.workspaceRuns(), [api]));
  const [error, setError] = useState("");
  const reloadRuns = runs.reload;
  useEffect(() => {
    const timer = setInterval(() => { void reloadRuns(); }, 5000);
    return () => clearInterval(timer);
  }, [reloadRuns]);
  const cancel = async (rid: string) => {
    try { await api.cancel(rid); await runs.reload(); } catch (e) { setError(errText(e)); }
  };
  return <View style={{ gap: 12 }}>
    {error ? <Notice text={error} /> : null}
    {!runs.data ? <Loading /> : null}
    {runs.data?.map((run) => <Card key={run.run_id} onPress={() => router.push(`/s/${sid}/c/${run.conversation_id}`)}>
      <Row style={{ justifyContent: "space-between" }}><Txt kind="mono" style={{ flex: 1 }}>{run.model}</Txt><Chip text={run.status} color={run.status === "running" ? p.ok : run.status === "error" ? p.accent2 : p.dim} /></Row>
      <Txt kind="small">{new Date(run.started_at * 1000).toLocaleString("ru-RU")} · {run.scenario ? "multi-model" : run.terminal ? "терминал" : "агент"}</Txt>
      {run.status === "running" ? <Btn small kind="danger" title="Остановить" onPress={() => cancel(run.run_id)} /> : null}
    </Card>)}
    {runs.data && !runs.data.length ? <Empty title="Нет запусков" text="Активные и недавние задачи агента появятся здесь после старта." /> : null}
  </View>;
}
