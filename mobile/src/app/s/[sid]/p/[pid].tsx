/** Чаты проекта. */
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { RefreshControl, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useApi, useLoad } from "@/state/hooks";
import { Btn, Card, Chip, Empty, errText, Loading, Notice, Row, TopBar, Txt } from "@/ui/kit";
import { useTheme } from "@/ui/theme";

function ago(ts?: number): string {
  if (!ts) return "";
  const s = Date.now() / 1000 - ts;
  if (s < 60) return "только что";
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
  return new Date(ts * 1000).toLocaleDateString("ru-RU");
}

export default function ProjectChats() {
  const { p } = useTheme();
  const { sid, pid } = useLocalSearchParams<{ sid: string; pid: string }>();
  const { api, error: apiError } = useApi(sid);
  const proj = useLoad(useCallback(() => api?.projects().then((l) => l.find((x) => x.id === pid) ?? null) ?? null, [api, pid]));
  const { data, error, loading, reload } = useLoad(useCallback(() => api?.conversations(pid) ?? null, [api, pid]));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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

  const canWrite = proj.data?.my_role !== "viewer";

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: p.bg }}>
      <TopBar title={proj.data?.name || "Проект"} back />
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} tintColor={p.accent} />}
      >
        {apiError || error ? <Notice text={(apiError || error)!} /> : null}
        {err ? <Notice text={err} /> : null}
        {canWrite && data ? <Btn title="＋ Новый чат" onPress={create} busy={busy} /> : null}
        {!data && !error && !apiError ? <Loading /> : null}
        {data && data.length === 0 ? <Empty title="Чатов нет" text="Начните новый чат с агентом." /> : null}
        {data?.map((c) => (
          <Card key={c.id} onPress={() => router.push(`/s/${sid}/c/${c.id}`)} accent={c.running ? p.ok : undefined}>
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
          </Card>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
