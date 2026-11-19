import { useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";

import { useApi, useLoad } from "@/state/hooks";
import { Btn, Empty, Loading, Notice, Row, Screen } from "@/ui/kit";
import { SectionHeading } from "@/ui/SectionHeading";
import { Tabs, type TabItem } from "@/ui/Tabs";
import { WorkspaceGit } from "@/ui/WorkspaceGit";
import { WorkspaceTasks } from "@/ui/WorkspaceTasks";
import { WorkspaceTerminal } from "@/ui/WorkspaceTerminal";

type Tab = "files" | "diff" | "ci" | "tasks" | "terminal";

const TABS: TabItem<Tab>[] = [
  { id: "files", title: "Файлы" },
  { id: "diff", title: "Diff" },
  { id: "ci", title: "CI" },
  { id: "tasks", title: "Задачи" },
  { id: "terminal", title: "SSH" },
];

export default function Workspace() {
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

  return <Screen title="Workspace" back={false}>
    <SectionHeading eyebrow="рабочее пространство" title={project?.name || "Проект"} text="Код, изменения, CI, фоновые запуски и серверы — с существующими правами и подтверждениями Fugu Deck." />
    {apiError ? <Notice text={apiError} /> : null}
    {projects.data?.length ? <Tabs
      items={projects.data.filter((item) => item.id !== "talk").map((item) => ({ id: item.id, title: item.name }))}
      value={effectivePid}
      onChange={(id) => { setPid(id); setCid(""); }}
      label="Проекты Workspace"
    /> : null}
    <Tabs<Tab> items={TABS} value={tab} onChange={setTab} label="Разделы Workspace" />
    {!api || !project ? <Loading /> : null}
    {api && project && ["files", "diff", "ci"].includes(tab) ? <WorkspaceGit api={api} repos={project.repos || []} mode={tab as "files" | "diff" | "ci"} /> : null}
    {api && tab === "tasks" ? <WorkspaceTasks api={api} sid={sid} /> : null}
    {api && tab === "terminal" ? <>
      {conversations.data?.length ? <Row gap={7} style={{ flexWrap: "wrap" }}>{conversations.data.map((chat) => <Btn key={chat.id} small kind={chat.id === effectiveCid ? "primary" : "ghost"} title={chat.title} onPress={() => setCid(chat.id)} />)}</Row> : null}
      {effectiveCid ? <WorkspaceTerminal api={api} cid={effectiveCid} /> : <Empty title="Нужен чат проекта" text="Создайте чат: через его агента SSH Gateway проверяет доступ к серверам." />}
    </> : null}
  </Screen>;
}
