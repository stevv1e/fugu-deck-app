/** Чаты проекта. Удержание чата — меню: переименовать, перенести в другой проект, удалить. */
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { RefreshControl, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { Conversation } from "@/core/types";
import { useApi, useLoad } from "@/state/hooks";
import { Btn, Card, Chip, Empty, errText, Field, Loading, Notice, Row, TopBar, Txt } from "@/ui/kit";
import { ProjectTransfer } from "@/ui/ProjectTransfer";
import { useTheme } from "@/ui/theme";

function ago(ts?: number): string {
  if (!ts) return "";
  const s = Date.now() / 1000 - ts;
  if (s < 60) return "только что";
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
  return new Date(ts * 1000).toLocaleDateString("ru-RU");
}

type Mode = "menu" | "rename" | "move" | "delete";

export default function ProjectChats() {
  const { p } = useTheme();
  const { sid, pid } = useLocalSearchParams<{ sid: string; pid: string }>();
  const { api, error: apiError } = useApi(sid);
  const projects = useLoad(useCallback(() => api?.projects() ?? null, [api]));
  const proj = projects.data?.find((x) => x.id === pid) ?? null;
  const { data, error, loading, reload } = useLoad(useCallback(() => api?.conversations(pid) ?? null, [api, pid]));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<{ id: string; mode: Mode } | null>(null); // чат, для которого открыто меню
  const [title, setTitle] = useState("");
  const [working, setWorking] = useState<string | null>(null);
  const [transfer, setTransfer] = useState(false);

  const act = async (tag: string, fn: () => Promise<unknown>) => {
    if (!api) return;
    setWorking(tag);
    setErr(null);
    try {
      await fn();
      setSel(null);
      reload();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setWorking(null);
    }
  };

  const create = async () => {
    if (!api) return;
    setBusy(true);
    try {
      const c = await api.createConversation(pid);
      router.push(`/s/${sid}/c/${c.id}`);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const canWrite = proj?.my_role !== "viewer";
  // Перенести можно в проект, где вы тоже редактор.
  const moveTargets = (projects.data ?? []).filter((x) => x.id !== pid && x.my_role !== "viewer");

  const menu = (c: Conversation) => {
    if (!sel || sel.id !== c.id) return null;
    const off = working !== null;
    switch (sel.mode) {
      case "menu":
        return (
          <Row gap={6} style={{ flexWrap: "wrap" }}>
            <Btn title="Переименовать" small kind="ghost" onPress={() => { setTitle(c.title); setSel({ id: c.id, mode: "rename" }); }} />
            {moveTargets.length ? <Btn title="Перенести" small kind="ghost" onPress={() => setSel({ id: c.id, mode: "move" })} /> : null}
            <Btn title="Удалить" small kind="danger" onPress={() => setSel({ id: c.id, mode: "delete" })} />
            <Btn title="Отмена" small kind="ghost" onPress={() => setSel(null)} />
          </Row>
        );
      case "rename":
        return (
          <>
            <Field label="Название чата" value={title} onChangeText={setTitle} autoFocus maxLength={120}
              onSubmitEditing={() => title.trim() && act("rename", () => api!.renameConversation(c.id, title.trim()))} />
            <Row>
              <Btn title="Сохранить" small onPress={() => act("rename", () => api!.renameConversation(c.id, title.trim()))}
                busy={working === "rename"} disabled={!title.trim() || off} />
              <Btn title="Отмена" small kind="ghost" onPress={() => setSel(null)} disabled={off} />
            </Row>
          </>
        );
      case "move":
        return (
          <>
            <Txt kind="dim">Перенести чат в проект:</Txt>
            {moveTargets.map((t) => (
              <Btn key={t.id} title={`→ ${t.name}`} small kind="ghost" onPress={() => act(`mv:${t.id}`, () => api!.moveConversation(c.id, t.id))}
                busy={working === `mv:${t.id}`} disabled={off} />
            ))}
            <Txt kind="small">Чат увидят участники того проекта; агент в нём будет пользоваться его памятью и инструкциями.</Txt>
            <Btn title="Отмена" small kind="ghost" onPress={() => setSel(null)} disabled={off} />
          </>
        );
      case "delete":
        return (
          <>
            <Txt kind="dim">
              Удалить чат со всей перепиской и вложениями? Вернуть его будет нельзя.{c.running ? " Агент в нём сейчас работает — задание остановится." : ""}
            </Txt>
            <Row>
              <Btn title="Удалить" small kind="danger" onPress={() => act("rm", () => api!.deleteConversation(c.id))} busy={working === "rm"} />
              <Btn title="Отмена" small kind="ghost" onPress={() => setSel(null)} disabled={off} />
            </Row>
          </>
        );
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: p.bg }}>
      <TopBar title={proj?.name || "Проект"} back />
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} tintColor={p.accent} />}
        keyboardShouldPersistTaps="handled"
      >
        {apiError || error ? <Notice text={(apiError || error)!} /> : null}
        {err ? <Notice text={err} /> : null}
        <Row gap={8}>
          <Btn title="База знаний" kind="ghost" onPress={() => router.push(`/s/${sid}/kb/${pid}`)} style={{ flex: 1 }} />
          <Btn title="Расписание" kind="ghost" onPress={() => router.push(`/s/${sid}/sched/${pid}`)} style={{ flex: 1 }} />
        </Row>
        {canWrite && data ? <Btn title="＋ Новый чат" onPress={create} busy={busy} /> : null}
        {!data && !error && !apiError ? <Loading /> : null}
        {data && data.length === 0 ? <Empty title="Чатов нет" text="Начните новый чат с агентом." /> : null}
        {data?.map((c) => (
          <Card
            key={c.id}
            onPress={() => (sel?.id === c.id ? setSel(null) : router.push(`/s/${sid}/c/${c.id}`))}
            onLongPress={canWrite ? () => setSel({ id: c.id, mode: "menu" }) : undefined}
            accent={sel?.id === c.id ? p.accent2 : c.running ? p.ok : undefined}
          >
            <Row style={{ justifyContent: "space-between" }}>
              <Txt kind="body" numberOfLines={1} style={{ flex: 1, fontWeight: "600" }}>
                {c.title}
              </Txt>
              {c.running ? <Chip text="работает" color={p.ok} /> : null}
            </Row>
            <Row style={{ justifyContent: "space-between" }}>
              <Txt kind="mono" color={p.dim} numberOfLines={1} style={{ flex: 1, fontSize: 12 }}>
                {c.model}
              </Txt>
              <Txt kind="small">{ago(c.updated_at as number | undefined)}</Txt>
            </Row>
            {menu(c)}
          </Card>
        ))}
        {canWrite && data && data.length > 0 ? <Txt kind="small">Удерживайте чат, чтобы переименовать, перенести или удалить его.</Txt> : null}
        {api && proj && canWrite ? (
          transfer ? <ProjectTransfer sid={sid} pid={pid} name={proj.name} api={api} />
            : <Btn title="Перенос проекта…" kind="ghost" small onPress={() => setTransfer(true)} style={{ alignSelf: "flex-start" }} />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
