/** Общие пространства кластера: те, где вы участник, и создание нового. */
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";

import { createTeam, listSpaces, PHASE_NAMES as PHASE, ROLE_LABELS as ROLE, titleProblem, type SpaceSummary } from "@/core/teams";
import { getCluster, rememberSpaceTitle, spaceSid, type ClusterRecord } from "@/state/cluster";
import { openClusterSession } from "@/state/clusterSession";
import { Btn, Card, Chip, Empty, errText, Field, Loading, Notice, Row, Screen, Txt } from "@/ui/kit";
import { useTheme } from "@/ui/theme";


export default function Teams() {
  const { cid } = useLocalSearchParams<{ cid: string }>();
  const { p } = useTheme();
  const [rec, setRec] = useState<ClusterRecord | null>(null);
  const [teams, setTeams] = useState<SpaceSummary[] | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (r: ClusterRecord) => {
    try {
      const all = await listSpaces(await openClusterSession(r, r.api));
      const ts = all.filter((s) => s.kind === "team");
      ts.forEach((t) => rememberSpaceTitle(spaceSid(r.id, t.id), t.title));
      setTeams(ts);
      setErr(null);
    } catch (e) {
      setErr(errText(e));
    }
  }, []);

  useEffect(() => {
    getCluster(cid).then((r) => {
      setRec(r);
      if (r) void load(r);
    });
  }, [cid, load]);

  const create = async () => {
    if (!rec) return;
    const bad = titleProblem(title);
    if (bad) return setErr(bad);
    setBusy(true);
    setErr(null);
    try {
      const t = await createTeam(await openClusterSession(rec, rec.api), title.trim());
      rememberSpaceTitle(spaceSid(rec.id, t.id), t.title);
      setTitle("");
      router.push({ pathname: "/team/[sid]", params: { sid: spaceSid(rec.id, t.id) } });
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!rec || (!teams && !err)) return <Screen title="Общие пространства"><Loading /></Screen>;
  return (
    <Screen title="Общие пространства">
      {err ? <Notice text={err} /> : null}
      <Txt kind="dim">
        Общее пространство — проекты и чаты с агентом для нескольких человек. Модель в каждом чате оплачивает спонсор:
        участник, который разрешил пользоваться своим ключом в заданных им пределах.
      </Txt>
      {teams && teams.length === 0 ? <Empty title="Общих пространств нет" text="Создайте своё или попросите владельца добавить вас по нику." /> : null}
      {teams?.map((t) => (
        <Card key={t.id} onPress={() => router.push({ pathname: "/team/[sid]", params: { sid: spaceSid(rec.id, t.id) } })}
          accent={t.delete_at ? p.accent2 : undefined}>
          <Row style={{ justifyContent: "space-between" }}>
            <Txt style={{ flex: 1, fontWeight: "600" }} numberOfLines={1}>{t.title}</Txt>
            <Chip text={PHASE[t.phase ?? ""] ?? "создаётся"} color={t.phase === "Ready" ? p.ok : p.dim} />
          </Row>
          <Txt kind="dim">Владелец {t.owner} · вы — {ROLE[t.role] ?? t.role}</Txt>
        </Card>
      ))}
      <Card>
        <Txt kind="h2">Создать</Txt>
        <Field label="Название" value={title} onChangeText={setTitle} placeholder="Например, Магазин" maxLength={60} />
        <Btn title="Создать общее пространство" onPress={create} busy={busy} disabled={!title.trim()} />
      </Card>
    </Screen>
  );
}
