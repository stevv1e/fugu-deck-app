/**
 * Чат с моделью. Запрос уходит с этого устройства прямо провайдеру (Sakana, Claude, DeepSeek) с ключом из
 * защищённого хранилища; ответ приходит потоком. Сервера нет — история хранится здесь же.
 */
import * as Clipboard from "expo-clipboard";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Pressable, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ask, titleOf } from "@/core/chat";
import { costUsd, PROVIDERS, splitModel, type Msg } from "@/core/providers";
import { streamFetch } from "@/platform/net";
import { getKey } from "@/platform/secrets";
import { getChat, getMessages, getSettings, newId, saveChat, type ChatMeta, type StoredMsg } from "@/state/store";
import { Btn, errText, IconBtn, Notice, Row, TopBar, Txt } from "@/ui/kit";
import { alpha, MONO, useTheme } from "@/ui/theme";

const short = (m: string) => m.split(":").pop() || m;

export default function Chat() {
  const { id: param } = useLocalSearchParams<{ id: string }>();
  const { p } = useTheme();
  const [meta, setMeta] = useState<ChatMeta | null>(null);
  const [msgs, setMsgs] = useState<StoredMsg[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [system, setSystem] = useState("");
  const [picking, setPicking] = useState(false);
  const [text, setText] = useState("");
  const [live, setLive] = useState<StoredMsg | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const list = useRef<FlatList<StoredMsg>>(null);
  // Вниз за новым текстом — только если человек и так внизу (как в Fugu Deck 0.6.5).
  const atEnd = useRef(true);
  const [showDown, setShowDown] = useState(false);

  useEffect(() => {
    (async () => {
      const s = await getSettings();
      setModels(s.models);
      setSystem(s.system);
      const existing = param && param !== "new" ? await getChat(param) : null;
      if (existing) {
        setMeta(existing);
        setMsgs(await getMessages(existing.id));
      } else {
        setMeta({ id: newId(), title: "Новый чат", model: s.defaultModel, updated: Date.now() });
      }
    })().catch((e) => setError(errText(e)));
  }, [param]);

  useEffect(() => () => abort.current?.abort(), []);

  const toEnd = () => {
    atEnd.current = true;
    setShowDown(false);
    list.current?.scrollToEnd({ animated: true });
  };

  const run = async (history: StoredMsg[], m: ChatMeta) => {
    const [prov] = splitModel(m.model);
    const key = await getKey(prov).catch(() => null);
    if (!key) {
      setError(`Нет ключа ${PROVIDERS[prov].title}: добавьте его в настройках.`);
      return;
    }
    setError(null);
    const ctrl = new AbortController();
    abort.current = ctrl;
    const start: StoredMsg = { role: "assistant", content: "", model: m.model, at: Date.now() };
    setLive(start);
    const convo: Msg[] = history.filter((x) => !x.error && x.content).map((x) => ({ role: x.role, content: x.content }));
    let got: StoredMsg = start;
    try {
      const a = await ask(streamFetch, m.model, convo, system, key, (u) => {
        got = { ...start, content: u.text, reasoning: u.reasoning || undefined, usage: u.usage };
        setLive(got);
      }, ctrl.signal);
      got = { ...start, content: a.text, reasoning: a.reasoning || undefined, usage: a.usage };
    } catch (e) {
      const stopped = ctrl.signal.aborted;
      if (!stopped) setError(errText(e));
      got = got.content ? { ...got, content: got.content + (stopped ? "\n\n_(остановлено)_" : "") } : { ...got, error: stopped ? "остановлено" : errText(e) };
    } finally {
      abort.current = null;
      setLive(null);
    }
    const next = got.content ? [...history, got] : history;
    const nm = { ...m, updated: Date.now() };
    setMsgs(next);
    setMeta(nm);
    await saveChat(nm, next);
  };

  const send = async () => {
    const t = text.trim();
    if (!t || !meta || live) return;
    const user: StoredMsg = { role: "user", content: t, at: Date.now() };
    const history = [...msgs, user];
    const m = msgs.length === 0 ? { ...meta, title: titleOf(t) } : meta;
    setText("");
    setMsgs(history);
    setMeta(m);
    toEnd();
    await saveChat(m, history);
    await run(history, m);
  };

  const retry = () => meta && msgs.length && msgs[msgs.length - 1].role === "user" && run(msgs, meta);

  const pick = async (model: string) => {
    if (!meta) return;
    const nm = { ...meta, model };
    setMeta(nm);
    setPicking(false);
    if (msgs.length) await saveChat(nm, msgs);
  };

  const copy = async (s: string) => {
    await Clipboard.setStringAsync(s);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const items = live ? [...msgs, live] : msgs;
  const total = msgs.reduce((s, m) => s + (m.usage && m.model ? costUsd(m.model, m.usage) ?? 0 : 0), 0);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: p.bg }} edges={["top", "left", "right", "bottom"]}>
      <TopBar title={meta?.title ?? "Чат"} back right={<IconBtn glyph="⚙" label="Настройки" onPress={() => router.push("/settings")} />} />
      <Pressable onPress={live ? undefined : () => setPicking((v) => !v)} style={{ paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: p.line }}>
        <Txt kind="small">
          модель: <Text style={{ color: p.accent, fontFamily: MONO }}>{meta ? short(meta.model) : "—"}</Text>
          {meta ? ` · ${PROVIDERS[splitModel(meta.model)[0]].title}, напрямую` : ""}
          {total > 0 ? ` · ≈$${total.toFixed(3)}` : ""}
          {live ? "" : "  ▾"}
        </Txt>
      </Pressable>
      {picking ? (
        <View style={{ padding: 12, gap: 8, borderBottomWidth: 1, borderBottomColor: p.line, backgroundColor: p.bg2 }}>
          <Row gap={6} style={{ flexWrap: "wrap" }}>
            {models.map((m) => (
              <Btn key={m} small title={short(m)} kind={m === meta?.model ? "primary" : "ghost"} onPress={() => pick(m)} />
            ))}
          </Row>
          <Txt kind="small">Список моделей и ключи — в настройках.</Txt>
        </View>
      ) : null}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        <View style={{ flex: 1 }}>
          <FlatList
            ref={list}
            data={items}
            keyExtractor={(m, i) => `${m.at}-${i}`}
            contentContainerStyle={{ padding: 14, gap: 12, paddingBottom: 20 }}
            onContentSizeChange={() => { if (atEnd.current) list.current?.scrollToEnd({ animated: true }); }}
            onLayout={() => { if (atEnd.current) list.current?.scrollToEnd({ animated: false }); }}
            scrollEventThrottle={100}
            onScroll={(e) => {
              const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
              const end = contentSize.height - contentOffset.y - layoutMeasurement.height < 80;
              atEnd.current = end;
              setShowDown((v) => (v === !end ? v : !end));
            }}
            ListEmptyComponent={
              <Txt kind="dim" style={{ textAlign: "center", marginTop: 40 }}>
                Напишите сообщение. Оно уйдёт прямо {meta ? PROVIDERS[splitModel(meta.model)[0]].title : "провайдеру"} с этого устройства.
              </Txt>
            }
            renderItem={({ item }) => {
              const mine = item.role === "user";
              const cost = item.usage && item.model ? costUsd(item.model, item.usage) : null;
              return (
                <Pressable onLongPress={() => copy(item.content)} style={{
                  alignSelf: mine ? "flex-end" : "stretch", maxWidth: mine ? "88%" : "100%", padding: 12, gap: 6,
                  borderRadius: p.radius, borderWidth: 1, borderColor: mine ? alpha(p.accent, 0.4) : p.line,
                  backgroundColor: mine ? alpha(p.accent, 0.08) : p.panel,
                }}>
                  {item.reasoning ? <Txt kind="small" numberOfLines={item === live ? 3 : 6}>💭 {item.reasoning}</Txt> : null}
                  <Txt selectable>{item.content || (item === live ? "…" : "")}</Txt>
                  {!mine && item !== live && (item.usage || item.model) ? (
                    <Txt kind="small">
                      {item.model ? short(item.model) : ""}
                      {item.usage ? ` · ${item.usage.input}→${item.usage.output} ток.` : ""}
                      {cost != null ? ` · ≈$${cost.toFixed(4)}` : ""}
                    </Txt>
                  ) : null}
                </Pressable>
              );
            }}
            ListFooterComponent={
              <View style={{ gap: 8 }}>
                {error ? <Notice text={error} /> : null}
                {error && !live && msgs.length && msgs[msgs.length - 1].role === "user" ? <Btn small kind="ghost" title="Повторить" onPress={retry} /> : null}
                {copied ? <Txt kind="small" style={{ textAlign: "center" }}>Скопировано</Txt> : null}
              </View>
            }
          />
          {showDown ? (
            <Pressable onPress={toEnd} accessibilityLabel="К последним сообщениям" style={{
              position: "absolute", right: 14, bottom: 14, width: 40, height: 40, borderRadius: 20, alignItems: "center",
              justifyContent: "center", backgroundColor: p.panel2, borderWidth: 1, borderColor: p.line2,
            }}>
              <Text style={{ color: p.accent, fontSize: 20, lineHeight: 22 }}>↓</Text>
            </Pressable>
          ) : null}
        </View>
        <Row style={{ padding: 10, borderTopWidth: 1, borderTopColor: p.line, alignItems: "flex-end" }}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Сообщение"
            placeholderTextColor={p.faint}
            multiline
            style={{
              flex: 1, maxHeight: 160, borderWidth: 1, borderColor: p.line2, backgroundColor: p.bg2, color: p.text,
              borderRadius: p.radius, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15,
            }}
          />
          {live ? (
            <Btn title="■" kind="danger" onPress={() => abort.current?.abort()} />
          ) : (
            <Btn title="➤" onPress={send} disabled={!text.trim() || !meta} />
          )}
        </Row>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
