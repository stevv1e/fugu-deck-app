/** Скилы агента: инструкции, которые он подгружает по описанию. Общие на пространство; править может владелец. */
import { useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";

import type { Skill } from "@/core/api";
import { useApi, useLoad } from "@/state/hooks";
import { Btn, Card, Empty, errText, Field, Loading, Notice, Row, Screen, Txt } from "@/ui/kit";
import { MONO, useTheme } from "@/ui/theme";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
type Draft = { from?: string; name: string; description: string; body: string };

export default function Skills() {
  const { p } = useTheme();
  const { sid } = useLocalSearchParams<{ sid: string }>();
  const { api, error: apiError } = useApi(sid);
  const cfg = useLoad(useCallback(() => api?.config() ?? null, [api]));
  const { data, error, reload } = useLoad(useCallback(() => api?.skills() ?? null, [api]));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [viewing, setViewing] = useState<Skill | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const [armed, setArmed] = useState(false);
  const me = cfg.data?.me as { role?: string; space_role?: string } | undefined;
  const canEdit = !!data?.writable && (me?.space_role ? me.space_role === "owner" : me?.role === "owner");

  const run = async (tag: string, fn: () => Promise<string>) => {
    if (!api) return;
    setBusy(tag);
    setMsg(null);
    try {
      setMsg({ kind: "ok", text: await fn() });
      reload();
    } catch (e) {
      setMsg({ kind: "error", text: errText(e) });
    } finally {
      setBusy(null);
      setArmed(false);
    }
  };

  const open = (name: string) => run(`open:${name}`, async () => {
    const s = await api!.skill(name);
    setViewing(s);
    setDraft(null);
    return "";
  }).then(() => setMsg(null));

  const bad = draft
    ? !NAME_RE.test(draft.name) ? "Имя: латинские строчные буквы, цифры и дефис (например, deploy-checklist)"
      : !draft.description.trim() ? "Нужно описание: по нему агент решает, когда подгрузить скил" : null
    : null;

  const save = () => draft && !bad && run("save", async () => {
    await api!.saveSkill(draft.name, draft.description.trim(), draft.body, draft.from && draft.from !== draft.name ? draft.from : undefined);
    setDraft(null);
    setViewing(null);
    return `Скил ${draft.name} сохранён`;
  });

  const remove = (name: string) => run("rm", async () => {
    await api!.deleteSkill(name);
    setViewing(null);
    return `Скил ${name} удалён`;
  });

  if (!data && !error && !apiError) return <Screen title="Скилы"><Loading /></Screen>;

  return (
    <Screen title="Скилы агента">
      {apiError || error ? <Notice text={(apiError || error)!} /> : null}
      {msg && msg.text ? <Notice kind={msg.kind} text={msg.text} /> : null}
      <Txt kind="small">
        Скил — инструкция для агента на отдельный случай. Агент видит только названия и описания и подгружает текст скила, когда он нужен.
        {data && !data.writable ? " На этом сервере скилы только для чтения." : ""}
      </Txt>

      {draft ? (
        <Card accent={p.accent}>
          <Txt kind="label">{draft.from ? "правка скила" : "новый скил"}</Txt>
          <Field label="Имя" value={draft.name} onChangeText={(name) => setDraft({ ...draft, name: name.trim().toLowerCase() })} placeholder="deploy-checklist" />
          <Field label="Когда применять (описание)" value={draft.description} onChangeText={(description) => setDraft({ ...draft, description })}
            multiline maxLength={1024} placeholder="Когда пользователь просит выкатить сервис…" />
          <Field label="Текст скила (Markdown)" value={draft.body} onChangeText={(body) => setDraft({ ...draft, body })} multiline
            style={{ minHeight: 220, textAlignVertical: "top", fontFamily: MONO, fontSize: 13 }} />
          {bad ? <Txt kind="small" color={p.warn}>{bad}</Txt> : null}
          <Row>
            <Btn title="Сохранить" onPress={save} busy={busy === "save"} disabled={!!bad} style={{ flex: 1 }} />
            <Btn title="Отмена" kind="ghost" onPress={() => setDraft(null)} style={{ flex: 1 }} />
          </Row>
        </Card>
      ) : viewing ? (
        <Card accent={p.accent}>
          <Txt kind="h2">{viewing.name}</Txt>
          <Txt kind="dim">{viewing.description}</Txt>
          <Txt kind="mono" selectable style={{ fontSize: 12.5 }}>{viewing.body || "(пусто)"}</Txt>
          <Row gap={6} style={{ flexWrap: "wrap" }}>
            {canEdit ? <Btn title="Изменить" small onPress={() => setDraft({ from: viewing.name, name: viewing.name, description: viewing.description, body: viewing.body || "" })} /> : null}
            {canEdit ? (armed
              ? <Btn title="Да, удалить" small kind="danger" onPress={() => remove(viewing.name)} busy={busy === "rm"} />
              : <Btn title="Удалить" small kind="ghost" onPress={() => setArmed(true)} />) : null}
            <Btn title="Закрыть" small kind="ghost" onPress={() => { setViewing(null); setArmed(false); }} />
          </Row>
        </Card>
      ) : canEdit ? (
        <Btn title="＋ Новый скил" kind="ghost" onPress={() => setDraft({ name: "", description: "", body: "" })} />
      ) : null}

      {data && data.items.length === 0 ? <Empty title="Скилов нет" text={canEdit ? "Создайте первый — например, порядок выкатки." : undefined} /> : null}
      {data?.items.map((s) => (
        <Card key={s.name} onPress={() => open(s.name)} accent={viewing?.name === s.name ? p.accent : undefined}>
          <Txt style={{ fontWeight: "600" }}>{s.name}</Txt>
          <Txt kind="small" numberOfLines={3}>{s.description}</Txt>
        </Card>
      ))}
      {!canEdit && data?.writable ? <Txt kind="small">Скилы меняет владелец пространства.</Txt> : null}
    </Screen>
  );
}
