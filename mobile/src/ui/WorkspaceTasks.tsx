import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";

import type { DeckApi } from "@/core/api";
import { useLoad } from "@/state/hooks";

import { Btn, Card, Chip, Empty, errText, Loading, Notice, Row, Txt } from "./kit";
import { useTheme } from "./theme";

export function WorkspaceTasks({ api, sid }: { api: DeckApi; sid: string }) {
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
    {error || runs.error ? <Notice text={(error || runs.error)!} /> : null}
    {!runs.data && !runs.error ? <Loading /> : null}
    {runs.data?.map((run) => <Card key={run.run_id} onPress={() => router.push(`/s/${sid}/c/${run.conversation_id}`)}>
      <Row style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <View style={{ flex: 1, gap: 4 }}>
          <Txt kind="mono" numberOfLines={1}>{run.model}</Txt>
          <Txt kind="small">{new Date(run.started_at * 1000).toLocaleString("ru-RU")} · {run.scenario ? "multi-model" : run.terminal ? "терминал" : "агент"}</Txt>
        </View>
        <Chip text={run.status} color={run.status === "running" ? p.ok : run.status === "error" ? p.accent2 : p.dim} />
      </Row>
      {run.status === "running" ? <Btn small kind="danger" title="Остановить" onPress={() => cancel(run.run_id)} /> : null}
    </Card>)}
    {runs.data && !runs.data.length ? <Empty title="Нет запусков" text="Активные и недавние задачи агента появятся здесь после старта." /> : null}
  </View>;
}
