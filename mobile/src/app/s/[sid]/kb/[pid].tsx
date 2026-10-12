/**
 * База знаний проекта: заметки агента и людей со связями — деревом (Иггдрасиль), паутиной или мозгом.
 * Картинку рисует страница в WebView (kb/kb.html): она получает данные одним куском, в сеть не ходит и никуда
 * не переходит. Правка заметок — здесь, обычной формой.
 */
import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

import type { KbGraph, KbNote } from "@/core/api";
import { kbInjection, parseKbMessage } from "@/kb/inject";
import { KB_HTML } from "@/kb/kbHtml";
import { prefs } from "@/platform/storage";
import { useApi } from "@/state/hooks";
import { Btn, errText, Field, IconBtn, Loading, Notice, Row, TopBar, Txt } from "@/ui/kit";
import { useTheme } from "@/ui/theme";

const VIEW_KEY = "fd.kb.view";
type Draft = { mid: number | null; title: string; content: string; area: string | null; tags: string; stale: boolean };
const EMPTY: Draft = { mid: null, title: "", content: "", area: null, tags: "", stale: false };

export default function KnowledgeBase() {
  const { p } = useTheme();
  const { sid, pid } = useLocalSearchParams<{ sid: string; pid: string }>();
  const { api, error: apiError } = useApi(sid);
  const [graph, setGraph] = useState<KbGraph | null>(null);
  const [view, setView] = useState<string | null>(null);
  const [version, setVersion] = useState(0); // новая загрузка страницы после изменения заметок
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);

  const load = useCallback(async () => {
    if (!api) return;
    try {
      const [g, v] = await Promise.all([api.kb(pid), prefs.get<string | null>(VIEW_KEY, null)]);
      setGraph(g);
      setView(v);
      setVersion((x) => x + 1);
      setErr(null);
    } catch (e) {
      setErr(errText(e));
    }
  }, [api, pid]);

  useEffect(() => {
    void load();
  }, [load]);

  const injected = useMemo(() => (graph ? kbInjection(graph, view) : ""), [graph, view, version]); // eslint-disable-line react-hooks/exhaustive-deps

  const onMessage = (raw: string) => {
    const m = parseKbMessage(raw);
    if (!m) return;
    if (m.type === "view") void prefs.set(VIEW_KEY, m.key);
    if (m.type === "error") setErr("Страница базы знаний сообщила об ошибке: " + m.message);
    if (m.type === "edit") {
      const n = graph?.notes.find((x: KbNote) => x.mid === m.mid);
      if (n) setDraft({ mid: n.mid, title: n.title, content: n.body, area: n.area, tags: n.tags, stale: n.stale });
    }
  };

  const save = async () => {
    if (!api || !draft || !draft.content.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const body = { content: draft.content.trim(), title: draft.title.trim() || null, area: draft.area, tags: draft.tags.trim() };
      if (draft.mid === null) await api.addNote(pid, body);
      else await api.updateNote(draft.mid, { ...body, stale: draft.stale });
      setDraft(null);
      await load();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!api || !draft || draft.mid === null) return;
    setBusy(true);
    try {
      await api.deleteNote(draft.mid);
      setDraft(null);
      setArmed(false);
      await load();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: p.bg }} edges={["top", "left", "right", "bottom"]}>
      <TopBar title="База знаний" back right={draft ? undefined : <IconBtn glyph="＋" label="Новая заметка" onPress={() => { setArmed(false); setDraft({ ...EMPTY }); }} />} />
      {apiError || err ? <View style={{ padding: 12 }}><Notice text={(apiError || err)!} /></View> : null}
      {draft ? (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          <Txt kind="h2">{draft.mid === null ? "Новая заметка" : "Заметка"}</Txt>
          <Field label="Заголовок (необязательно)" value={draft.title} onChangeText={(t) => setDraft({ ...draft, title: t })} maxLength={120} />
          <Field label="Текст" value={draft.content} onChangeText={(t) => setDraft({ ...draft, content: t })} multiline maxLength={8000}
            hint="Сослаться на другую заметку: [[её заголовок]] — связь появится сама." />
          <Txt kind="label">область</Txt>
          <Row gap={6} style={{ flexWrap: "wrap" }}>
            <Btn small title="Сама" kind={draft.area === null ? "primary" : "ghost"} onPress={() => setDraft({ ...draft, area: null })} />
            {Object.entries(graph?.areas ?? {}).map(([k, a]) => (
              <Btn key={k} small title={a.name} kind={draft.area === k ? "primary" : "ghost"} onPress={() => setDraft({ ...draft, area: k })} />
            ))}
          </Row>
          <Field label="Теги через запятую (первый — группа)" value={draft.tags} onChangeText={(t) => setDraft({ ...draft, tags: t })} autoCapitalize="none" />
          {draft.mid !== null ? (
            <Btn small kind="ghost" title={draft.stale ? "Отмечена устаревшей — снять отметку" : "Отметить устаревшей"} onPress={() => setDraft({ ...draft, stale: !draft.stale })} />
          ) : null}
          <Row>
            <Btn title="Сохранить" onPress={save} busy={busy} disabled={!draft.content.trim()} style={{ flex: 1.5 }} />
            <Btn title="Отмена" kind="ghost" onPress={() => setDraft(null)} disabled={busy} style={{ flex: 1 }} />
          </Row>
          {draft.mid !== null ? (
            armed ? (
              <Row>
                <Btn title="Да, удалить заметку" small kind="danger" onPress={remove} disabled={busy} />
                <Btn title="Отмена" small kind="ghost" onPress={() => setArmed(false)} />
              </Row>
            ) : (
              <Btn title="Удалить заметку" small kind="ghost" onPress={() => setArmed(true)} disabled={busy} />
            )
          ) : null}
        </ScrollView>
      ) : graph ? (
        <WebView
          key={version}
          style={{ flex: 1, backgroundColor: "#07060e" }}
          originWhitelist={["*"]}
          source={{ html: KB_HTML, baseUrl: "about:blank" }}
          injectedJavaScriptBeforeContentLoaded={injected}
          onMessage={(e) => onMessage(e.nativeEvent.data)}
          // страница самодостаточна: никаких переходов и загрузок извне
          onShouldStartLoadWithRequest={(r) => r.url === "about:blank" || r.url.startsWith("data:")}
          setSupportMultipleWindows={false}
          javaScriptCanOpenWindowsAutomatically={false}
          allowFileAccess={false}
          domStorageEnabled={false}
          overScrollMode="never"
          bounces={false}
        />
      ) : (
        <Loading />
      )}
    </SafeAreaView>
  );
}
