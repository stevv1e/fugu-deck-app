/**
 * Чат с агентом: ответ приходит потоком, инструменты видны карточками.
 * Запрос на подтверждение — отдельная карточка: «Разрешить» подписывается ключом подтверждения
 * (биометрия), подпись покрывает хэш именно тех аргументов, что на экране.
 */
import * as Haptics from "expo-haptics";
import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Pressable, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { ApprovalRequest } from "@/core/api";
import { argsHash } from "@/core/crypto";
import { applyEvent, fromStored, type Item } from "@/core/timeline";
import type { ConversationFull, RunEvent } from "@/core/types";
import { useApi } from "@/state/hooks";
import { useServers } from "@/state/servers";
import type { TeamChatState } from "@/core/teams";
import { Btn, Chip, errText, Loading, Notice, Row, TopBar, Txt } from "@/ui/kit";
import { TeamModel } from "@/ui/TeamModel";
import { alpha, MONO, useTheme } from "@/ui/theme";

type Tool = Extract<Item, { kind: "tool" }>;

const STATUS: Record<Tool["status"], string> = {
  pending: "ждёт решения",
  running: "выполняется",
  ok: "готово",
  error: "ошибка",
  denied: "отклонено",
};

function subtitle(name: string, a: any): string {
  if (!a || typeof a !== "object") return "";
  switch (name) {
    case "ssh_exec":
      return `${a.server} · ${String(a.command || "").slice(0, 120)}`;
    case "commit_files":
      return `${a.repo} · ${a.base_branch ? `${a.base_branch} → ` : ""}${a.branch}`;
    case "create_pull_request":
      return `${a.repo} · ${a.source_branch} → ${a.target_branch || "default"}`;
    case "create_branch":
      return `${a.repo} · ${a.branch}`;
    case "read_file":
      return `${a.repo}/${a.path}`;
    case "memory_save":
    case "memory_update":
      return String(a.content || "").slice(0, 80);
    case "memory_search":
      return a.query;
    case "load_skill":
      return a.name;
    default:
      return [a.provider, a.repo, a.path, a.name].filter(Boolean).join(" · ");
  }
}

/** Текст ответа: блоки кода моноширинно, остальное как есть. */
function RichText({ text, color }: { text: string; color: string }) {
  const { p } = useTheme();
  const parts = text.split(/```[^\n]*\n?/);
  return (
    <View style={{ gap: 8 }}>
      {parts.map((part, i) =>
        i % 2 ? (
          <View key={i} style={{ backgroundColor: p.bg2, borderWidth: 1, borderColor: p.line, padding: 10, borderRadius: p.radius }}>
            <Text selectable style={{ fontFamily: MONO, fontSize: 12.5, color: p.text }}>
              {part.replace(/\n$/, "")}
            </Text>
          </View>
        ) : part.trim() ? (
          <Txt key={i} selectable color={color}>
            {part.trim()}
          </Txt>
        ) : null,
      )}
    </View>
  );
}

function ArgsBlock({ args, full }: { args: any; full?: boolean }) {
  const { p } = useTheme();
  const [open, setOpen] = useState(!!full);
  const json = JSON.stringify(args, null, 2) ?? "";
  const long = json.length > 600;
  return (
    <View style={{ gap: 6 }}>
      <View style={{ backgroundColor: p.bg2, borderWidth: 1, borderColor: p.line, padding: 10, borderRadius: p.radius }}>
        <Text selectable style={{ fontFamily: MONO, fontSize: 12, color: p.text }}>
          {open || !long ? json : json.slice(0, 600) + "\n…"}
        </Text>
      </View>
      {long ? (
        <Pressable onPress={() => setOpen(!open)}>
          <Txt kind="small" color={p.accent}>
            {open ? "Свернуть" : `Показать всё (${Math.round(json.length / 1024) || 1} КБ)`}
          </Txt>
        </Pressable>
      ) : null}
    </View>
  );
}

function ApprovalCard({ t, onDecide }: { t: Tool; onDecide(req: ApprovalRequest, ok: boolean, typedServer?: string): Promise<void> }) {
  const { p } = useTheme();
  const [busy, setBusy] = useState<"yes" | "no" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const req = t.approval!;
  const danger = req.risk === "dangerous";
  const mine = argsHash(req.args);
  const matches = !req.args_sha256 || req.args_sha256 === mine;
  const c = danger ? p.accent2 : p.warn;
  // Команда на сервере: человек подписывает саму команду; для опасной — ещё и вводит имя сервера руками.
  const cmd = req.sign ?? null;
  const needName = cmd?.type === "ssh_danger";
  const nameOk = !needName || typed.trim() === cmd!.server;

  const decide = async (ok: boolean) => {
    setBusy(ok ? "yes" : "no");
    setError(null);
    try {
      await onDecide(req, ok, typed.trim());
    } catch (e) {
      setError(errText(e));
      setBusy(null);
    }
  };

  return (
    <View style={{ borderWidth: 1.5, borderColor: c, backgroundColor: alpha(c, 0.06), padding: 14, gap: 10, borderRadius: p.radius }}>
      <Row style={{ justifyContent: "space-between" }}>
        <Txt kind="label" color={c}>
          агент просит разрешения
        </Txt>
        <Chip text={danger ? "опасно" : "изменение"} color={c} />
      </Row>
      <Txt kind="h2">{cmd ? `Команда на сервере ${cmd.server}` : req.title || req.name}</Txt>
      {cmd ? (
        <>
          {typeof req.args?.why === "string" && req.args.why ? <Txt kind="dim">Зачем (со слов агента): {req.args.why}</Txt> : null}
          <View style={{ backgroundColor: p.bg2, borderWidth: 1, borderColor: c, padding: 10, borderRadius: p.radius }}>
            <Text selectable style={{ fontFamily: MONO, fontSize: 13, color: p.text }}>{cmd.command}</Text>
          </View>
          <Txt kind="small">Подпись покроет эту команду целиком, сервер и агента. Сервер выполнит только её.</Txt>
          {needName ? (
            <>
              <Notice kind="warn" text="Команда может уничтожить данные или лишить вас доступа к серверу. Чтобы подтвердить, введите имя сервера." />
              <TextInput
                value={typed}
                onChangeText={setTyped}
                placeholder={`Имя сервера: ${cmd.server}`}
                placeholderTextColor={p.faint}
                autoCapitalize="none"
                autoCorrect={false}
                style={{ color: p.text, backgroundColor: p.bg2, borderWidth: 1, borderColor: nameOk ? p.ok : p.line2, borderRadius: p.radius, paddingHorizontal: 12, paddingVertical: 10, fontFamily: MONO }}
              />
            </>
          ) : null}
        </>
      ) : (
        <>
          {subtitle(req.name, req.args) ? <Txt kind="mono">{subtitle(req.name, req.args)}</Txt> : null}
          <ArgsBlock args={req.args} />
          <Txt kind="small">
            Подпись покроет хэш аргументов {mine.slice(0, 10)}… {matches ? "✓ совпадает с сервером" : ""}
          </Txt>
        </>
      )}
      {!matches ? <Notice kind="warn" text="Хэш аргументов на телефоне и на сервере не совпал. Не разрешайте: то, что вы видите, может отличаться от того, что выполнится." /> : null}
      {error ? <Notice text={error} /> : null}
      <Row>
        <Btn title="Отклонить" kind="ghost" onPress={() => decide(false)} busy={busy === "no"} disabled={!!busy} style={{ flex: 1 }} />
        <Btn title="Разрешить ⌁" kind={danger ? "danger" : "ok"} onPress={() => decide(true)} busy={busy === "yes"} disabled={!!busy || !matches || !nameOk} style={{ flex: 1.4 }} />
      </Row>
      <Txt kind="small" style={{ textAlign: "center" }}>
        «Разрешить» спросит биометрию и подпишет решение ключом этого телефона
      </Txt>
    </View>
  );
}

function ToolCard({ t }: { t: Tool }) {
  const { p } = useTheme();
  const [open, setOpen] = useState(false);
  const color = { pending: p.warn, running: p.accent, ok: p.ok, error: p.accent2, denied: p.dim }[t.status];
  return (
    <Pressable onPress={() => setOpen(!open)} style={{ borderLeftWidth: 2, borderLeftColor: color, backgroundColor: p.panel, padding: 10, gap: 6, borderRadius: p.radius }}>
      <Row style={{ justifyContent: "space-between" }}>
        <Txt kind="mono" numberOfLines={1} style={{ flex: 1 }}>
          {t.title || t.name}
        </Txt>
        <Chip text={STATUS[t.status]} color={color} />
      </Row>
      {subtitle(t.name, t.args) ? (
        <Txt kind="small" numberOfLines={open ? undefined : 1}>
          {subtitle(t.name, t.args)}
        </Txt>
      ) : null}
      {t.error ? <Txt kind="small" color={p.accent2}>{t.error}</Txt> : null}
      {open ? (
        <>
          <ArgsBlock args={t.args} full />
          {t.result !== undefined ? <ArgsBlock args={t.result} /> : null}
        </>
      ) : null}
    </Pressable>
  );
}

function Bubble({ item, meId }: { item: Item; meId?: string }) {
  const { p } = useTheme();
  if (item.kind === "user") {
    return (
      <View style={{ alignSelf: "flex-end", maxWidth: "88%", gap: 4 }}>
        {!item.mine && item.author ? <Txt kind="small" style={{ textAlign: "right" }}>{item.author}</Txt> : null}
        <View style={{ backgroundColor: alpha(p.accent, 0.12), borderColor: alpha(p.accent, 0.45), borderWidth: 1, padding: 11, borderRadius: p.radius }}>
          <Txt selectable>{item.content}</Txt>
          {item.attachments?.length ? <Txt kind="small">📎 {item.attachments.map((a) => a.filename).join(", ")}</Txt> : null}
        </View>
      </View>
    );
  }
  if (item.kind === "assistant") {
    return (
      <View style={{ gap: 4 }}>
        <RichText text={item.content + (item.streaming ? " ▍" : "")} color={p.text} />
      </View>
    );
  }
  if (item.kind === "notice") {
    return <Txt kind="small" color={item.level === "error" ? p.accent2 : p.dim} style={{ textAlign: "center" }}>{item.text}</Txt>;
  }
  return null;
}

export default function Chat() {
  const { p } = useTheme();
  const { sid, cid } = useLocalSearchParams<{ sid: string; cid: string }>();
  const { get } = useServers();
  const meId = get(sid)?.device?.user.id;
  const { api, error: apiError } = useApi(sid);
  const [conv, setConv] = useState<ConversationFull | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string>("");
  const stream = useRef<{ close(): void } | null>(null);
  const list = useRef<FlatList<Item>>(null);

  const follow = useCallback(
    (rid: string) => {
      if (!api) return;
      stream.current?.close();
      setRunId(rid);
      stream.current = api.followRun(
        rid,
        (e: RunEvent) => {
          if (e.type === "approval_request") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
          setItems((prev) => applyEvent(prev, e));
        },
        {
          onState: (s) => setLink(s === "retry" ? "переподключение…" : ""),
          onEnd: (err) => {
            stream.current = null;
            setRunId(null);
            setLink("");
            if (err) setError(errText(err));
            // после завершения берём историю с сервера — она каноническая
            api.conversation(cid).then(
              (c) => {
                setConv(c);
                setItems(fromStored(c.messages, meId));
              },
              () => {},
            );
          },
        },
      );
    },
    [api, cid, meId],
  );

  useEffect(() => {
    if (!api) return;
    let alive = true;
    api.conversation(cid).then(
      (c) => {
        if (!alive) return;
        setConv(c);
        const started = c.active_run_started_at;
        if (c.active_run && started) {
          // идёт запуск: история до его начала + события запуска с первого
          setItems(fromStored(c.messages.filter((m) => m.created_at <= started), meId));
          follow(c.active_run);
        } else {
          setItems(fromStored(c.messages, meId));
        }
      },
      (e) => alive && setError(errText(e)),
    );
    return () => {
      alive = false;
      stream.current?.close();
    };
  }, [api, cid, meId, follow]);

  const send = async () => {
    const msg = text.trim();
    if (!api || !msg || runId) return;
    setSending(true);
    setError(null);
    try {
      const r = await api.send(cid, msg);
      setText("");
      setItems((prev) => [...prev, { kind: "user", key: "u" + Date.now(), content: msg, mine: true }]);
      follow(r.run_id);
    } catch (e) {
      setError(errText(e));
    } finally {
      setSending(false);
    }
  };

  const decide = useCallback(
    async (req: ApprovalRequest, ok: boolean, typedServer?: string) => {
      if (!api) return;
      await api.approve(req, ok, "", typedServer);
      if (ok) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    },
    [api],
  );

  // Состояние чата (модель, спонсор, предложение) перечитываем после действий с моделью общего чата.
  const refresh = useCallback(() => {
    api?.conversation(cid).then(
      (c) => {
        setConv(c);
        if (!stream.current) setItems(fromStored(c.messages, meId));
      },
      () => {},
    );
  }, [api, cid, meId]);

  const pending = items.filter((i): i is Tool => i.kind === "tool" && i.status === "pending" && !!i.approval);
  const canWrite = conv?.my_role !== "viewer";

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: p.bg }} edges={["top", "left", "right", "bottom"]}>
      <TopBar title={conv?.title || "Чат"} back />
      {conv ? (
        <Row style={{ paddingHorizontal: 14, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: p.line, justifyContent: "space-between" }}>
          <Txt kind="mono" color={p.accent} numberOfLines={1} style={{ fontSize: 11.5, flex: 1 }}>
            {conv.model}
          </Txt>
          {runId ? <Chip text={link || "работает"} color={link ? p.warn : p.ok} /> : null}
        </Row>
      ) : null}
      {/* На Android окно рисуется под системными панелями (edge-to-edge), и система сама его под клавиатуру
          не сжимает — без отступа клавиатура закрывала бы поле ввода. */}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        {!conv && !apiError && !error ? <Loading /> : null}
        <FlatList
          ref={list}
          data={items}
          keyExtractor={(i) => i.key}
          contentContainerStyle={{ padding: 14, gap: 12, paddingBottom: 20 }}
          onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
          onLayout={() => list.current?.scrollToEnd({ animated: false })}
          renderItem={({ item }) =>
            item.kind === "tool" ? item.status === "pending" && item.approval ? <ApprovalCard t={item} onDecide={decide} /> : <ToolCard t={item} /> : <Bubble item={item} meId={meId} />
          }
          ListHeaderComponent={
            <View style={{ gap: 12 }}>
              {apiError || error ? <Notice text={(apiError || error)!} /> : null}
              {conv?.team && api ? (
                <TeamModel sid={sid} cid={cid} api={api} state={conv as TeamChatState} model={conv.model} meId={meId} canWrite={canWrite} onChanged={refresh} />
              ) : null}
            </View>
          }
          ListFooterComponent={
            runId ? (
              <Row style={{ justifyContent: "center" }}>
                <Txt kind="small" color={p.ok}>
                  {link || (pending.length ? "ждёт вашего решения" : "агент работает…")}
                </Txt>
              </Row>
            ) : null
          }
        />
        {canWrite ? (
          <View style={{ flexDirection: "row", gap: 8, padding: 10, borderTopWidth: 1, borderTopColor: p.line, backgroundColor: p.bg, alignItems: "flex-end" }}>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder={runId ? "Агент работает…" : "Сообщение агенту"}
              placeholderTextColor={p.faint}
              multiline
              style={{
                flex: 1,
                maxHeight: 140,
                minHeight: 44,
                color: p.text,
                backgroundColor: p.bg2,
                borderWidth: 1,
                borderColor: p.line2,
                borderRadius: p.radius,
                paddingHorizontal: 12,
                paddingVertical: 10,
                fontSize: 15,
                fontFamily: p.monoText ? MONO : undefined,
              }}
            />
            {runId ? (
              <Btn title="Стоп" kind="danger" onPress={() => api?.cancel(runId).catch((e) => setError(errText(e)))} />
            ) : (
              <Btn title="↑" onPress={send} busy={sending} disabled={!text.trim()} style={{ minWidth: 52 }} />
            )}
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
