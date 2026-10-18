/**
 * Задания агента по расписанию в проекте: что поручить и когда. Каждое задание пишет в свой чат «⏰ <название>».
 * Пространство в кластере спит, когда им не пользуются; к сроку задания его будит control-plane.
 */
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";

import type { Schedule } from "@/core/api";
import { buildSchedule, emptyForm, formOf, KIND_TITLES, WEEKDAYS, whenText, type ScheduleForm } from "@/core/schedule";
import { useApi, useLoad } from "@/state/hooks";
import { Btn, Card, Chip, Empty, errText, Field, Loading, Notice, Row, Screen, Txt } from "@/ui/kit";
import { useTheme } from "@/ui/theme";
import { DEV } from "@/platform/desktop";

export default function Schedules() {
  const { p } = useTheme();
  const { sid, pid } = useLocalSearchParams<{ sid: string; pid: string }>();
  const { api, error: apiError } = useApi(sid);
  const cfg = useLoad(useCallback(() => api?.config() ?? null, [api]));
  const { data, error, reload } = useLoad(useCallback(() => api?.schedules(pid) ?? null, [api, pid]));
  const [form, setForm] = useState<{ id?: string; f: ScheduleForm } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const [armed, setArmed] = useState<string | null>(null);

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
      setArmed(null);
    }
  };

  const built = form ? buildSchedule(form.f) : null;
  const save = () => {
    if (!form || typeof built === "string" || !built) return;
    void run("save", async () => {
      const s = form.id ? await api!.updateSchedule(form.id, built) : await api!.createSchedule(pid, built);
      setForm(null);
      return `«${s.title}»: ${s.description}. Следующий запуск — ${whenText(s.next_at)}.`;
    });
  };
  const toggle = (s: Schedule) => run(`t:${s.id}`, async () => {
    const out = await api!.updateSchedule(s.id, { enabled: !s.enabled });
    return out.enabled ? `«${s.title}» включено, следующий запуск — ${whenText(out.next_at)}` : `«${s.title}» на паузе`;
  });
  const now = (s: Schedule) => run(`n:${s.id}`, async () => {
    const out = await api!.runSchedule(s.id);
    if (out.conversation_id) router.push(`/s/${sid}/c/${out.conversation_id}`);
    return `«${s.title}» запущено`;
  });
  const remove = (s: Schedule) => run(`rm:${s.id}`, async () => {
    await api!.deleteSchedule(s.id);
    return `«${s.title}» удалено; его чат остался`;
  });

  const models = cfg.data?.models ?? [];
  const ready = cfg.data?.llm_ready ?? [];
  const set = (patch: Partial<ScheduleForm>) => form && setForm({ ...form, f: { ...form.f, ...patch } });
  const team = cfg.data?.space && (cfg.data.space as { kind?: string }).kind === "team";

  if (!data && !error && !apiError) return <Screen title="Расписание"><Loading /></Screen>;

  return (
    <Screen title="Расписание">
      {apiError || error ? <Notice text={(apiError || error)!} /> : null}
      {msg ? <Notice kind={msg.kind} text={msg.text} /> : null}
      {team ? <Notice kind="info" text="В общем пространстве задания по расписанию не выполняются: модель там оплачивает спонсор по своему разрешению." /> : null}
      <Txt kind="small">Агент выполнит поручение в назначенное время и напишет результат в чат задания. Подтверждения действий, как обычно, — с {DEV.gen}.</Txt>

      {form ? (
        <Card accent={p.accent}>
          <Txt kind="label">{form.id ? "правка задания" : "новое задание"}</Txt>
          <Field label="Название" value={form.f.title} onChangeText={(title) => set({ title })} maxLength={80} placeholder="Утренняя сводка" />
          <Field label="Что поручить агенту" value={form.f.prompt} onChangeText={(prompt) => set({ prompt })} multiline maxLength={8000}
            style={{ minHeight: 100, textAlignVertical: "top" }} placeholder="Проверь открытые PR в репозитории … и кратко перескажи, что требует внимания" />
          <Row gap={6} style={{ flexWrap: "wrap" }}>
            {(Object.keys(KIND_TITLES) as ScheduleForm["kind"][]).map((k) => (
              <Btn key={k} small title={KIND_TITLES[k]} kind={form.f.kind === k ? "primary" : "ghost"} onPress={() => set({ kind: k, time: k === "hourly" ? ":00" : form.f.kind === "hourly" ? "09:00" : form.f.time })} />
            ))}
          </Row>
          {form.f.kind === "weekly" ? (
            <Row gap={4} style={{ flexWrap: "wrap" }}>
              {WEEKDAYS.map((w, i) => {
                const on = form.f.weekdays.includes(i);
                return <Btn key={w} small title={w} kind={on ? "primary" : "ghost"} onPress={() => set({ weekdays: on ? form.f.weekdays.filter((x) => x !== i) : [...form.f.weekdays, i] })} />;
              })}
            </Row>
          ) : null}
          <Row gap={8}>
            {form.f.kind === "once" ? <Field label="Дата" value={form.f.date} onChangeText={(date) => set({ date })} placeholder="ДД.ММ.ГГГГ" keyboardType="numbers-and-punctuation" style={{ minWidth: 130 }} /> : null}
            <Field label={form.f.kind === "hourly" ? "Минуты часа" : "Время"} value={form.f.time} onChangeText={(time) => set({ time })}
              placeholder={form.f.kind === "hourly" ? ":15" : "09:00"} keyboardType="numbers-and-punctuation" style={{ minWidth: 90 }} />
          </Row>
          <Txt kind="small">Часовой пояс: {form.f.tz}</Txt>
          {models.length ? (
            <>
              <Txt kind="label">модель</Txt>
              <Row gap={6} style={{ flexWrap: "wrap" }}>
                {models.map((m) => (
                  <Btn key={m} small title={m.split(":").pop()!} kind={form.f.model === m ? "primary" : "ghost"} disabled={!ready.includes(m.split(":")[0])} onPress={() => set({ model: m })} />
                ))}
              </Row>
            </>
          ) : null}
          {typeof built === "string" ? <Txt kind="small" color={p.warn}>{built}</Txt> : null}
          <Row>
            <Btn title="Сохранить" onPress={save} busy={busy === "save"} disabled={typeof built === "string"} style={{ flex: 1 }} />
            <Btn title="Отмена" kind="ghost" onPress={() => setForm(null)} style={{ flex: 1 }} />
          </Row>
        </Card>
      ) : !team ? (
        <Btn title="＋ Задание" kind="ghost" onPress={() => setForm({ f: emptyForm(cfg.data?.default_model || models[0] || "") })} />
      ) : null}

      {data && data.length === 0 && !form ? <Empty title="Заданий нет" text="Например: каждое утро — сводка по открытым PR." /> : null}
      {data?.map((s) => (
        <Card key={s.id} accent={s.enabled ? p.ok : p.line2}>
          <Row style={{ justifyContent: "space-between" }}>
            <Txt style={{ fontWeight: "600", flex: 1 }} numberOfLines={1}>{s.title}</Txt>
            <Chip text={s.enabled ? (s.next_at ? "включено" : "выполнено") : "пауза"} color={s.enabled ? p.ok : undefined} />
          </Row>
          <Txt kind="small">{s.description} · {s.tz}</Txt>
          <Txt kind="dim" numberOfLines={3}>{s.prompt}</Txt>
          <Txt kind="small">Следующий запуск: {s.enabled ? whenText(s.next_at) : "—"}{s.last_status ? ` · последний: ${s.last_status}` : ""}</Txt>
          <Row gap={6} style={{ flexWrap: "wrap" }}>
            <Btn small title="Запустить сейчас" onPress={() => now(s)} busy={busy === `n:${s.id}`} disabled={!!busy || !!team} />
            {s.conversation_id ? <Btn small kind="ghost" title="Чат" onPress={() => router.push(`/s/${sid}/c/${s.conversation_id}`)} /> : null}
            <Btn small kind="ghost" title={s.enabled ? "Пауза" : "Включить"} onPress={() => toggle(s)} busy={busy === `t:${s.id}`} disabled={!!busy || !!team} />
            <Btn small kind="ghost" title="Изменить" onPress={() => setForm({ id: s.id, f: formOf(s) })} disabled={!!busy || !!team} />
            {armed === s.id
              ? <Btn small kind="danger" title="Да, удалить" onPress={() => remove(s)} busy={busy === `rm:${s.id}`} />
              : <Btn small kind="ghost" title="Удалить" onPress={() => setArmed(s.id)} disabled={!!busy} />}
          </Row>
        </Card>
      ))}
    </Screen>
  );
}
