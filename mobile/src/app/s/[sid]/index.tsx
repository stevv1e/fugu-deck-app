/** Проекты на сервере. */
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { Project } from "@/core/types";
import { useApi, useLoad } from "@/state/hooks";
import { useServers } from "@/state/servers";
import { Btn, Card, Chip, Empty, errText, Field, IconBtn, Loading, Notice, Row, TopBar, Txt } from "@/ui/kit";
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
      <TopBar title={rec.name} back right={<IconBtn glyph="⚙" label="Сервер и устройства" onPress={() => router.push(`/s/${sid}/settings`)} />} />
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
          <Card key={pr.id} onPress={() => router.push(`/s/${sid}/p/${pr.id}`)} accent={p.accent}>
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
          </Card>
        ))}
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
          <Btn title="＋ Проект" kind="ghost" onPress={() => setCreating(true)} />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
