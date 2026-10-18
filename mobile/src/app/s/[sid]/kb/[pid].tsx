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

import type { FoundNote, KbGraph, KbNote } from "@/core/api";
import { kbInjection, parseKbMessage } from "@/kb/inject";
import { KB_HTML } from "@/kb/kbHtml";
import { pickBase64, saveBase64 } from "@/platform/pick";
import { prefs } from "@/platform/storage";
import { useApi } from "@/state/hooks";
import { Btn, Card, errText, Field, IconBtn, Loading, Notice, Row, TopBar, Txt } from "@/ui/kit";
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
  const [tools, setTools] = useState(false); // поиск и Obsidian
  const [q, setQ] = useState("");
  const [found, setFound] = useState<FoundNote[] | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [linkType, setLinkType] = useState("dep");
  const [linkQ, setLinkQ] = useState("");

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

  const task = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setErr(null);
    setOkMsg(null);
    try {
      const m = await fn();
      if (m) setOkMsg(m);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const search = () => api && q.trim() && task(async () => { setFound(await api.searchNotes(pid, q.trim())); return null; });
  const exportVault = () => api && task(async () => {
    const z = await api.exportObsidian(pid);
    return (await saveBase64(z.filename, "application/zip", z.data)) ? `Сохранено: ${z.filename}. Распакуйте в хранилище Obsidian.` : null;
  });
  const importVault = () => api && task(async () => {
    const f = await pickBase64(8 * 1024 * 1024, ["application/zip", "application/x-zip-compressed", "*/*"]);
    if (!f) return null;
    const r = await api.importObsidian(pid, f.data);
    await load();
    return `Добавлено заметок: ${r.created}, связей: ${r.links}`;
  });
  const openNote = (id: number) => {
    const n = graph?.notes.find((x: KbNote) => x.mid === id);
    if (n) setDraft({ mid: n.mid, title: n.title, content: n.body, area: n.area, tags: n.tags, stale: n.stale });
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: p.bg }} edges={["top", "left", "right", "bottom"]}>
      <TopBar title="База знаний" back right={draft ? undefined : (
        <Row gap={4}>
          <IconBtn glyph="⌕" label="Поиск и Obsidian" onPress={() => setTools(!tools)} />
          <IconBtn glyph="＋" label="Новая заметка" onPress={() => { setArmed(false); setDraft({ ...EMPTY }); }} />
        </Row>
      )} />
      {apiError || err ? <View style={{ padding: 12 }}><Notice text={(apiError || err)!} /></View> : null}
      {okMsg ? <View style={{ paddingHorizontal: 12, paddingTop: 8 }}><Notice kind="ok" text={okMsg} /></View> : null}
      {tools && !draft ? (
        <ScrollView style={{ maxHeight: 360, flexGrow: 0 }} contentContainerStyle={{ padding: 12, gap: 8 }} keyboardShouldPersistTaps="handled">
          <Field label="Поиск по базе знаний" value={q} onChangeText={setQ} placeholder="бэкап, порядок выкатки…" onSubmitEditing={search} returnKeyType="search"
            hint="Словоформы не важны; связанные с найденным заметки — тоже в выдаче." />
          <Btn small title="Найти" onPress={search} busy={busy && !!q} disabled={!q.trim()} style={{ alignSelf: "flex-start" }} />
          {found && !found.length ? <Txt kind="small">Ничего не нашлось — попробуйте другими словами.</Txt> : null}
          {found?.map((n) => (
            <Card key={`${n.id}-${n.linked_to ?? ""}`} onPress={n.project_id === pid ? () => openNote(n.id) : undefined}>
              <Txt style={{ fontWeight: "600" }} numberOfLines={1}>{n.title || n.content.split("\n")[0]}</Txt>
              <Txt kind="dim" numberOfLines={2}>{n.content}</Txt>
              <Txt kind="small">{n.linked_to ? "связана с найденной" : "по словам"}{n.project_id !== pid && n.project_name ? ` · проект ${n.project_name}` : ""}</Txt>
            </Card>
          ))}
          <Txt kind="label">obsidian</Txt>
          <Row>
            <Btn small kind="ghost" title="Экспорт (zip)" onPress={exportVault} disabled={busy} style={{ flex: 1 }} />
            <Btn small kind="ghost" title="Импорт (zip)" onPress={importVault} disabled={busy} style={{ flex: 1 }} />
          </Row>
          <Txt kind="small">Заметки — файлы .md с [[ссылками]], связи — разделом «Связи». Импорт добавляет заметки, не заменяя имеющиеся.</Txt>
        </ScrollView>
      ) : null}
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
          {draft.mid !== null && graph ? (() => {
            const me = `n${draft.mid}`;
            const title = (id: string) => graph.notes.find((n) => n.id === id)?.title ?? id;
            const mine = graph.edges.filter((e) => e[0] === me || e[1] === me);
            const cands = linkQ.trim().length > 1
              ? graph.notes.filter((n) => n.mid !== null && n.id !== me && n.title.toLowerCase().includes(linkQ.trim().toLowerCase())).slice(0, 6) : [];
            const link = (to: number) => task(async () => { await api!.linkNotes(draft.mid!, to, linkType); setLinkQ(""); await load(); return "Связь добавлена"; });
            const unlink = (a: string, b: string, t: string) => task(async () => {
              await api!.unlinkNotes(Number(a.slice(1)), Number(b.slice(1)), t); await load(); return "Связь убрана";
            });
            return (
              <Card>
                <Txt kind="label">связи</Txt>
                {mine.length ? mine.map(([a, b, t]) => (
                  <Row key={`${a}-${b}-${t}`} style={{ justifyContent: "space-between" }}>
                    <Txt kind="small" style={{ flex: 1 }}>{a === me ? graph.link_types[t] : `← ${graph.link_types[t]}`}: {title(a === me ? b : a)}</Txt>
                    <Btn small kind="ghost" title="✕" onPress={() => unlink(a, b, t)} disabled={busy} />
                  </Row>
                )) : <Txt kind="small">Связей нет.</Txt>}
                <Row gap={6} style={{ flexWrap: "wrap" }}>
                  {Object.entries(graph.link_types).map(([k, name]) => (
                    <Btn key={k} small title={name} kind={linkType === k ? "primary" : "ghost"} onPress={() => setLinkType(k)} />
                  ))}
                </Row>
                <Field label="Связать с заметкой" value={linkQ} onChangeText={setLinkQ} placeholder="начните вводить заголовок" />
                {cands.map((n) => <Btn key={n.id} small kind="ghost" title={`${graph.link_types[linkType]} → ${n.title}`} onPress={() => link(n.mid!)} disabled={busy} style={{ alignSelf: "flex-start" }} />)}
              </Card>
            );
          })() : null}
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
