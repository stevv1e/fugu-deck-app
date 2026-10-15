/** Проекты на сервере. */
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { ProjectExport } from "@/core/api";
import type { Project } from "@/core/types";
import { pickText } from "@/platform/pick";
import { useApi, useLoad } from "@/state/hooks";
import { clusterOfSid, parseSid } from "@/state/cluster";
import { useServers } from "@/state/servers";
import { Btn, Card, Chip, Empty, errText, Field, IconBtn, Loading, Notice, Row, TopBar, Txt } from "@/ui/kit";
import { ModeSwitch, TalkChats, useMode } from "@/ui/Modes";
import { useTheme } from "@/ui/theme";

export default function Projects() {
  const { p } = useTheme();
  const { sid } = useLocalSearchParams<{ sid: string }>();
  const { get } = useServers();
  const rec = get(sid);
  const { api, error: apiError } = useApi(sid);
  const { data, error, loading, reload } = useLoad(useCallback(() => api?.projects() ?? null, [api]));
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [armed, setArmed] = useState<{ id: string; mode: "menu" | "rename" | "delete" } | null>(null); // меню проекта
  const [removing, setRemoving] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [mode, setMode] = useMode(sid);
  // Удалить проект может его владелец; проект по умолчанию не удаляется — в нём живёт всё, что не разложено.
  const canDelete = (pr: Project) => pr.id !== "general" && (pr.my_role === undefined || pr.my_role === "owner");
  const canRename = (pr: Project) => pr.my_role === undefined || pr.my_role === "owner";

  const rename = async (pid: string) => {
    if (!api || !newName.trim()) return;
    setRemoving(pid);
    setErr(null);
    try {
      await api.updateProject(pid, { name: newName.trim() });
      setArmed(null);
      reload();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setRemoving(null);
    }
  };

  // Импорт проекта из файла, сохранённого в другом пространстве (формат fugu-deck-project/1).
  const importFile = async () => {
    if (!api) return;
    setErr(null);
    setNote(null);
    try {
      const f = await pickText();
      if (!f) return;
      let data: ProjectExport;
      try {
        data = JSON.parse(f.text);
      } catch {
        throw new Error("Это не файл проекта Fugu Deck (JSON не читается)");
      }
      if (data?.format !== "fugu-deck-project/1") throw new Error("Это не файл проекта Fugu Deck");
      setBusy(true);
      const pr = await api.importProject(data);
      setNote(`Проект «${pr.name}» загружен из файла`);
      reload();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (pid: string) => {
    if (!api) return;
    setRemoving(pid);
    setErr(null);
    try {
      await api.deleteProject(pid);
      setArmed(null);
      reload();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setRemoving(null);
    }
  };

  if (!rec) return <Redirect href="/" />;
  if (!rec.device) return <Redirect href={`/s/${sid}/login`} />;

  const create = async () => {
    if (!api || !name.trim()) return;
    setBusy(true);
    try {
      const pr = await api.createProject(name.trim());
      setName("");
      setCreating(false);
      router.push(`/s/${sid}/p/${pr.id}`);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: p.bg }}>
      <TopBar title={rec.name} back right={
          // у пространства кластера свой экран устройства и ключей; настройки одиночного сервера к нему не относятся
          clusterOfSid(sid) !== null
            ? parseSid(sid)?.team
              ? <IconBtn glyph="⚙" label="Участники пространства" onPress={() => router.push({ pathname: "/team/[sid]", params: { sid } })} />
              : <IconBtn glyph="⚙" label="Кластер и ключи" onPress={() => router.push({ pathname: "/cluster/[cid]", params: { cid: clusterOfSid(sid)! } })} />
            : <IconBtn glyph="⚙" label="Сервер и устройства" onPress={() => router.push(`/s/${sid}/settings`)} />
        } />
      {mode ? <ModeSwitch mode={mode} onChange={setMode} /> : null}
      {mode === "talk" ? <TalkChats sid={sid} api={api} apiError={apiError} /> : mode === null ? <Loading /> : (
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} tintColor={p.accent} />}
      >
        <Row style={{ justifyContent: "space-between" }}>
          <Txt kind="label">проекты</Txt>
          <Txt kind="small">{rec.device.user.display_name || rec.device.user.username}</Txt>
        </Row>
        {apiError ? <Notice text={apiError} /> : null}
        {error ? <Notice text={error} /> : null}
        {!data && !error && !apiError ? <Loading /> : null}
        {data && data.length === 0 ? <Empty title="Проектов пока нет" text="Создайте первый — в нём будут чаты, память и участники." /> : null}
        {data?.map((pr: Project) => (
          <Card key={pr.id} onPress={() => (armed?.id === pr.id ? setArmed(null) : router.push(`/s/${sid}/p/${pr.id}`))}
            onLongPress={canRename(pr) || canDelete(pr) ? () => setArmed({ id: pr.id, mode: "menu" }) : undefined}
            accent={armed?.id === pr.id ? p.accent2 : p.accent}>
            <Row style={{ justifyContent: "space-between" }}>
              <Txt kind="h2" numberOfLines={1} style={{ flex: 1 }}>
                {pr.name}
              </Txt>
              {pr.my_role ? <Chip text={String(pr.my_role)} /> : null}
            </Row>
            {pr.description ? (
              <Txt kind="dim" numberOfLines={2}>
                {pr.description}
              </Txt>
            ) : null}
            <Txt kind="small">
              чатов: {String(pr.conversations ?? 0)} · памяти: {String(pr.memories ?? 0)}
            </Txt>
            {armed?.id === pr.id && armed.mode === "menu" ? (
              <Row gap={6} style={{ flexWrap: "wrap" }}>
                {canRename(pr) ? <Btn title="Переименовать" small kind="ghost" onPress={() => { setNewName(pr.name); setArmed({ id: pr.id, mode: "rename" }); }} /> : null}
                {canDelete(pr) ? <Btn title="Удалить" small kind="danger" onPress={() => setArmed({ id: pr.id, mode: "delete" })} /> : null}
                <Btn title="Отмена" small kind="ghost" onPress={() => setArmed(null)} />
              </Row>
            ) : null}
            {armed?.id === pr.id && armed.mode === "rename" ? (
              <>
                <Field label="Название проекта" value={newName} onChangeText={setNewName} autoFocus maxLength={80} onSubmitEditing={() => rename(pr.id)} />
                <Row>
                  <Btn title="Сохранить" small onPress={() => rename(pr.id)} busy={removing === pr.id} disabled={!newName.trim()} />
                  <Btn title="Отмена" small kind="ghost" onPress={() => setArmed(null)} disabled={removing === pr.id} />
                </Row>
              </>
            ) : null}
            {armed?.id === pr.id && armed.mode === "delete" ? (
              <>
                <Txt kind="dim">
                  Удалить проект «{pr.name}» со всеми чатами, вложениями и заметками базы знаний? Вернуть его будет нельзя.
                </Txt>
                <Row>
                  <Btn title="Удалить проект" small kind="danger" onPress={() => remove(pr.id)} busy={removing === pr.id} />
                  <Btn title="Отмена" small kind="ghost" onPress={() => setArmed(null)} disabled={removing === pr.id} />
                </Row>
              </>
            ) : null}
          </Card>
        ))}
        {err && !creating ? <Notice text={err} /> : null}
        {note ? <Notice kind="ok" text={note} /> : null}
        {data && data.some((x) => canRename(x) || canDelete(x)) ? <Txt kind="small">Удерживайте проект, чтобы переименовать или удалить его.</Txt> : null}
        {creating ? (
          <View style={{ gap: 10 }}>
            <Field label="Новый проект" value={name} onChangeText={setName} autoFocus placeholder="Название" onSubmitEditing={create} />
            {err ? <Notice text={err} /> : null}
            <Row>
              <Btn title="Создать" onPress={create} busy={busy} disabled={!name.trim()} style={{ flex: 1 }} />
              <Btn title="Отмена" kind="ghost" onPress={() => setCreating(false)} style={{ flex: 1 }} />
            </Row>
          </View>
        ) : data && rec.device.user.role === "owner" ? (
          <Row gap={8}>
            <Btn title="＋ Проект" kind="ghost" onPress={() => setCreating(true)} style={{ flex: 1 }} />
            <Btn title="Из файла" kind="ghost" onPress={importFile} busy={busy} style={{ flex: 1 }} />
          </Row>
        ) : null}
        {data ? (
          <Row gap={8} style={{ flexWrap: "wrap" }}>
            <Btn title="Модели и репозитории" kind="ghost" small onPress={() => router.push(`/s/${sid}/prefs`)} style={{ flexGrow: 1 }} />
            <Btn title="Скилы агента" kind="ghost" small onPress={() => router.push(`/s/${sid}/skills`)} style={{ flexGrow: 1 }} />
            <Btn title="Расходы" kind="ghost" small onPress={() => router.push(`/s/${sid}/usage`)} style={{ flexGrow: 1 }} />
          </Row>
        ) : null}
      </ScrollView>
      )}
    </SafeAreaView>
  );
}
