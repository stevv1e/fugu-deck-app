/**
 * Режимы пространства: «Инжиниринг» (проекты, агент с Git, серверами и памятью) и «Общение» (разговоры с моделью
 * без инструментов — как отдельное пространство). Выбор запоминается на телефоне для каждого пространства.
 */
import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";

import type { DeckApi } from "@/core/api";
import { useLoad } from "@/state/hooks";
import { prefs } from "@/platform/storage";

import { Btn, Card, Chip, Empty, errText, Field, Loading, Notice, Row, Txt, usePage } from "./kit";
import { useTheme } from "./theme";

export type Mode = "eng" | "talk";
/** Скрытый проект агента, в котором живут разговоры режима «Общение» (backend: TALK_PROJECT). */
export const TALK_PROJECT = "talk";

const key = (sid: string) => `fd.mode.${sid}`;

// Экраны и боковая панель компьютера держат режим каждый у себя — смену рассылаем всем.
const listeners = new Set<(sid: string, m: Mode) => void>();

export function useMode(sid: string): [Mode | null, (m: Mode) => void] {
  const [mode, setMode] = useState<Mode | null>(null);
  useEffect(() => {
    let alive = true;
    prefs.get<Mode>(key(sid), "eng").then((m) => alive && setMode(m === "talk" ? "talk" : "eng"));
    const on = (s: string, m: Mode) => s === sid && setMode(m);
    listeners.add(on);
    return () => {
      alive = false;
      listeners.delete(on);
    };
  }, [sid]);
  const set = useCallback((m: Mode) => {
    void prefs.set(key(sid), m);
    listeners.forEach((f) => f(sid, m));
  }, [sid]);
  return [mode, set];
}

/** Рубильник вверху экрана пространства. */
export function ModeSwitch({ mode, onChange }: { mode: Mode; onChange(m: Mode): void }) {
  const { p } = useTheme();
  const item = (m: Mode, title: string) => {
    const on = mode === m;
    return (
      <Pressable key={m} onPress={() => onChange(m)} accessibilityRole="button" accessibilityState={{ selected: on }}
        style={{ flex: 1, paddingVertical: 9, alignItems: "center", backgroundColor: on ? p.accent : "transparent", borderRadius: p.radius }}>
        <Txt style={{ fontWeight: "700", color: on ? p.bg : p.dim }}>{title}</Txt>
      </Pressable>
    );
  };
  return (
    <View style={{ flexDirection: "row", margin: 12, marginBottom: 0, padding: 3, gap: 3, borderWidth: 1, borderColor: p.line2, borderRadius: p.radius, backgroundColor: p.bg2 }}>
      {item("eng", "Инжиниринг")}
      {item("talk", "Общение")}
    </View>
  );
}

function ago(ts?: number): string {
  if (!ts) return "";
  const s = Date.now() / 1000 - ts;
  if (s < 60) return "только что";
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
  return new Date(ts * 1000).toLocaleDateString("ru-RU");
}

/** Режим «Общение»: плоский список разговоров. Удержание — переименовать или удалить. */
export function TalkChats({ sid, api, apiError }: { sid: string; api: DeckApi | null; apiError: string | null }) {
  const { p } = useTheme();
  const page = usePage();
  const { data, error, loading, reload } = useLoad(useCallback(() => api?.conversations(TALK_PROJECT) ?? null, [api]));
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<{ id: string; mode: "menu" | "rename" | "delete" } | null>(null);
  const [title, setTitle] = useState("");

  const act = async (tag: string, fn: () => Promise<unknown>) => {
    if (!api) return;
    setBusy(tag);
    setErr(null);
    try {
      await fn();
      setSel(null);
      reload();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };
  const create = () => act("new", async () => {
    const c = await api!.createConversation(TALK_PROJECT);
    router.push(`/s/${sid}/c/${c.id}`);
  });

  return (
    <ScrollView contentContainerStyle={[{ padding: 16, gap: 12, paddingBottom: 40 }, page]} keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} tintColor={p.accent} />}>
      {apiError || error ? <Notice text={(apiError || error)!} /> : null}
      {err ? <Notice text={err} /> : null}
      <Txt kind="small">Разговор с моделью: вопросы, тексты, переводы, фото и документы. Без репозиториев, серверов и памяти проектов — поэтому каждый ответ дешевле.</Txt>
      {data ? <Btn title="＋ Новый разговор" onPress={create} busy={busy === "new"} /> : null}
      {!data && !error && !apiError ? <Loading /> : null}
      {data && data.length === 0 ? <Empty title="Разговоров нет" text="Начните новый — например, пришлите фото и спросите, что на нём." /> : null}
      {data?.map((c) => (
        <Card key={c.id} accent={sel?.id === c.id ? p.accent2 : c.running ? p.ok : undefined}
          onPress={() => (sel?.id === c.id ? setSel(null) : router.push(`/s/${sid}/c/${c.id}`))}
          onLongPress={() => setSel({ id: c.id, mode: "menu" })}>
          <Row style={{ justifyContent: "space-between" }}>
            <Txt numberOfLines={1} style={{ flex: 1, fontWeight: "600" }}>{c.title}</Txt>
            {c.running ? <Chip text="отвечает" color={p.ok} /> : null}
          </Row>
          <Row style={{ justifyContent: "space-between" }}>
            <Txt kind="mono" color={p.dim} numberOfLines={1} style={{ flex: 1, fontSize: 12 }}>{c.model}</Txt>
            <Txt kind="small">{ago(c.updated_at as number | undefined)}</Txt>
          </Row>
          {sel?.id === c.id && sel.mode === "menu" ? (
            <Row gap={6} style={{ flexWrap: "wrap" }}>
              <Btn title="Переименовать" small kind="ghost" onPress={() => { setTitle(c.title); setSel({ id: c.id, mode: "rename" }); }} />
              <Btn title="Удалить" small kind="danger" onPress={() => setSel({ id: c.id, mode: "delete" })} />
              <Btn title="Отмена" small kind="ghost" onPress={() => setSel(null)} />
            </Row>
          ) : null}
          {sel?.id === c.id && sel.mode === "rename" ? (
            <>
              <Field label="Название" value={title} onChangeText={setTitle} autoFocus maxLength={120}
                onSubmitEditing={() => title.trim() && act("rename", () => api!.renameConversation(c.id, title.trim()))} />
              <Row>
                <Btn title="Сохранить" small onPress={() => act("rename", () => api!.renameConversation(c.id, title.trim()))} busy={busy === "rename"} disabled={!title.trim()} />
                <Btn title="Отмена" small kind="ghost" onPress={() => setSel(null)} />
              </Row>
            </>
          ) : null}
          {sel?.id === c.id && sel.mode === "delete" ? (
            <>
              <Txt kind="dim">Удалить разговор со всеми сообщениями и файлами? Вернуть его будет нельзя.</Txt>
              <Row>
                <Btn title="Удалить" small kind="danger" onPress={() => act("rm", () => api!.deleteConversation(c.id))} busy={busy === "rm"} />
                <Btn title="Отмена" small kind="ghost" onPress={() => setSel(null)} />
              </Row>
            </>
          ) : null}
        </Card>
      ))}
      {data && data.length > 0 ? <Txt kind="small">Удерживайте разговор, чтобы переименовать или удалить его.</Txt> : null}
    </ScrollView>
  );
}
