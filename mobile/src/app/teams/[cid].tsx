/** Выбор личного или общего пространства кластера. Список не запускает пространства: пробуждение — только по нажатию. */
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";

import { createTeam, listSpaces, PHASE_NAMES as PHASE, ROLE_LABELS as ROLE, titleProblem, wakeTeam, type SpaceSummary } from "@/core/teams";
import { getCluster, rememberSpaceTitle, spaceSid, type ClusterRecord } from "@/state/cluster";
import { openClusterSession, spaceState } from "@/state/clusterSession";
import { Btn, Card, Chip, errText, Field, IconBtn, Loading, Notice, Row, Screen, Txt } from "@/ui/kit";
import { SectionHeading } from "@/ui/SectionHeading";
import { useTheme } from "@/ui/theme";

export default function Spaces() {
  const { cid } = useLocalSearchParams<{ cid: string }>();
  const { p } = useTheme();
  const [rec, setRec] = useState<ClusterRecord | null>(null);
  const [spaces, setSpaces] = useState<SpaceSummary[] | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async (r: ClusterRecord) => {
    try {
      const all = await listSpaces(await openClusterSession(r, r.api));
      all.forEach((s) => {
        if (s.kind === "team") rememberSpaceTitle(spaceSid(r.id, s.id), s.title);
      });
      setSpaces(all);
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
    setNote(null);
    try {
      const t = await createTeam(await openClusterSession(rec, rec.api), title.trim());
      rememberSpaceTitle(spaceSid(rec.id, t.id), t.title);
      setSpaces((current) => [...(current ?? []), t]);
      setTitle("");
      setNote(`Общее пространство «${t.title}» создано. Откройте его из списка, когда будете готовы.`);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const open = async (space: SpaceSummary) => {
    if (!rec) return;
    setOpening(space.id);
    setErr(null);
    setNote(null);
    try {
      if (space.phase === "Deleting" || space.delete_requested) throw new Error("Пространство ожидает удаления. Сначала владелец должен отменить удаление.");
      if (space.phase === "Failed") throw new Error(`Пространство не запущено: ${space.message || "ошибка"}`);
      if (space.kind === "personal") {
        if (!space.exists || space.phase === "Sleeping") await spaceState(rec, true);
      } else {
        if (!space.exists) throw new Error("Общее пространство ещё не создано");
        if (space.phase === "Sleeping") await wakeTeam(await openClusterSession(rec, rec.api), space.id);
      }
      const sid = spaceSid(rec.id, space.kind === "team" ? space.id : null);
      router.push(`/launch/${sid}`);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setOpening(null);
    }
  };

  if (!rec || (!spaces && !err)) return <Screen title="Пространства"><Loading text="Загружаем пространства…" /></Screen>;
  const titleBad = title ? titleProblem(title) : null;

  return (
    <Screen title={new URL(rec.api).host} right={<IconBtn glyph="⚙" label="Устройство и настройки сервера" onPress={() => router.push(`/cluster/${rec.id}`)} />}>
      <SectionHeading
        eyebrow="сервер подключён"
        title="Выберите пространство"
        text="Личное — только ваше. Общее — проекты и чаты для нескольких участников. Ничего не запускается, пока вы не выберете пространство."
      />
      {err ? <Notice text={err} /> : null}
      {note ? <Notice kind="ok" text={note} /> : null}
      {!spaces ? <Loading /> : null}
      {spaces?.map((space) => {
        const personal = space.kind === "personal";
        const status = !space.exists ? "не создано" : PHASE[space.phase ?? ""] ?? "создаётся";
        return (
          <Card key={space.id} accent={personal ? p.accent : p.accent2} onPress={() => open(space)}>
            <Row style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
              <Txt kind="h2" style={{ flex: 1 }}>{personal ? "Личное пространство" : space.title}</Txt>
              <Chip text={status} color={space.phase === "Ready" ? p.ok : space.phase === "Failed" ? p.accent2 : p.dim} />
            </Row>
            <Txt kind="dim">{personal ? `Пользователь ${rec.user} · только вы` : `Владелец ${space.owner} · вы — ${ROLE[space.role] ?? space.role}`}</Txt>
            <Row style={{ justifyContent: "space-between" }}>
              <Txt color={p.accent}>{opening === space.id ? "Запускаем…" : "Открыть →"}</Txt>
              {!personal ? <Btn title="Участники и настройки" small kind="ghost" disabled={!!opening} onPress={() => router.push({ pathname: "/team/[sid]", params: { sid: spaceSid(rec.id, space.id) } })} /> : null}
            </Row>
          </Card>
        );
      })}
      {spaces ? (
        <Card accent={p.accent}>
          <Txt kind="label">новое общее пространство</Txt>
          <Txt kind="h2">Работа вместе</Txt>
          <Txt kind="dim">Создайте отдельное пространство с общими проектами и чатами. Участников и их роли можно будет настроить после создания.</Txt>
          <Field label="Название" value={title} onChangeText={setTitle} placeholder="Например, Магазин" maxLength={60} hint={titleBad ?? undefined} />
          <Btn title="+ Создать общее пространство" onPress={create} busy={busy} disabled={!!titleBad || !title.trim() || !!opening} />
        </Card>
      ) : null}
      <Btn title="Устройство, ключи и интеграции сервера" kind="ghost" onPress={() => router.push(`/cluster/${rec.id}`)} />
    </Screen>
  );
}
