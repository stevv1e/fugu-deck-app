/**
 * Чат с агентом: ответ приходит потоком, инструменты видны карточками.
 * Запрос на подтверждение — отдельная карточка: «Разрешить» подписывается ключом подтверждения
 * (биометрия), подпись покрывает хэш именно тех аргументов, что на экране.
 */
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { AppConfig, ApprovalRequest, DeckApi } from "@/core/api";
import { attachProblem, isImage, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, PREVIEW_MAX, rememberPreviewUri, sizeText, type PickedFile, type Uploaded } from "@/core/attachments";
import { argsHash } from "@/core/crypto";
import { approvalActionTitle, APPROVAL_MODES } from "@/core/agentPolicies";
import { fallbackChain, nameOfModel, resolveScenario, type ModelPreferences } from "@/core/models";
import { applyEvent, fromStored, type Item } from "@/core/timeline";
import type { ConversationFull, RunEvent } from "@/core/types";
import { desktopAvailable, desktopDropFiles } from "@/platform/desktop";
import { readAll, readChunk } from "@/platform/files";
import { pickFiles, pickPhotos, takePhoto } from "@/platform/pick";
import { useApi } from "@/state/hooks";
import { loadModelPreferences } from "@/state/modelPreferences";
import { useServers } from "@/state/servers";
import type { TeamChatState } from "@/core/teams";
import { AttachmentList } from "@/ui/Attachments";
import { Btn, Card, Chip, errText, IconBtn, Loading, Notice, Row, TopBar, Txt } from "@/ui/kit";
import { TeamModel } from "@/ui/TeamModel";
import { ModelPicker } from "@/ui/ModelPicker";
import { ModeSwitch, type Mode } from "@/ui/Modes";
import { alpha, MONO, useTheme } from "@/ui/theme";
import { useDesktopLayout } from "@/ui/useDesktopLayout";

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
    case "agent_save":
      return `${a.name} (${a.id})`;
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

const ACCESS: Record<string, string> = { git: "репозитории", ssh: "серверы", memory: "база знаний", files: "вложения", skills: "навыки", mcp: "MCP-серверы", web: "сайты" };

/** Агент, которого модель предлагает создать или изменить: доступы — словами, инструкция — целиком. */
function AgentPreview({ a }: { a: any }) {
  const { p } = useTheme();
  const tools: string[] = Array.isArray(a?.tools) ? a.tools : [];
  const rules = Object.entries(a?.approval_rules || {}).filter(([, mode]) => !!mode)
    .map(([id, mode]) => `${approvalActionTitle(id)}: ${APPROVAL_MODES.find(([v]) => v === mode)?.[1] || mode}`);
  const automatic = a?.approvals === "none" || Object.values(a?.approval_rules || {}).includes("none");
  return (
    <View style={{ gap: 6 }}>
      <Txt>Доступы: {tools.length ? tools.map((t) => ACCESS[t] || t).join(", ") : "никаких"}</Txt>
      {tools.includes("ssh") ? <Notice kind="warn" text="Агент получит доступ к серверам (каждую команду вы всё равно подписываете)." /> : null}
      {a?.model ? <Txt kind="small">Модель: {a.model}</Txt> : null}
      {rules.length ? <Txt kind="small">Отдельные правила: {rules.join("; ")}</Txt> : null}
      {automatic ? <Notice kind="warn" text="Агент сможет выполнять часть изменений автоматически, без вашего подтверждения." /> : null}
      <Txt kind="label">инструкция</Txt>
      <View style={{ backgroundColor: p.bg2, borderWidth: 1, borderColor: p.line, padding: 10, borderRadius: p.radius }}>
        <Txt selectable>{String(a?.instructions || "—")}</Txt>
      </View>
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
          {req.review ? (
            <View style={{ borderLeftWidth: 2, borderLeftColor: p.accent, paddingLeft: 10, gap: 2 }}>
              <Txt kind="label">независимая проверка</Txt>
              <Txt kind="dim">{req.review}</Txt>
            </View>
          ) : null}
          {req.preview ? (
            <View style={{ gap: 4 }}>
              <Txt kind="label">пробный прогон: {req.preview.command}</Txt>
              <View style={{ backgroundColor: p.bg2, borderWidth: 1, borderColor: p.line, padding: 10, borderRadius: p.radius }}>
                <Text selectable style={{ fontFamily: MONO, fontSize: 12, color: req.preview.error ? p.accent2 : p.text }}>
                  {req.preview.error ? `не выполнен: ${req.preview.error}` : (req.preview.output || "(вывода нет)") + (req.preview.truncated ? "\n…" : "")}
                </Text>
              </View>
            </View>
          ) : null}
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
          {req.name === "agent_save" ? <AgentPreview a={req.args} /> : <ArgsBlock args={req.args} />}
          <Txt kind="small">
            Подпись покроет хэш аргументов {mine.slice(0, 10)}… {matches ? "✓ совпадает с сервером" : ""}
          </Txt>
        </>
      )}
      {!matches ? <Notice kind="warn" text="Хэш аргументов на телефоне и на сервере не совпал. Не разрешайте: то, что вы видите, может отличаться от того, что выполнится." /> : null}
      {error ? <Notice text={error} /> : null}
      <Row>
        <Btn title="Отклонить" kind="ghost" onPress={() => decide(false)} busy={busy === "no"} disabled={!!busy} style={{ flex: 1 }} />
        <Btn title={req.nosign && !cmd ? "Разрешить" : "Разрешить ⌁"} kind={danger ? "danger" : "ok"} onPress={() => decide(true)} busy={busy === "yes"} disabled={!!busy || !matches || !nameOk} style={{ flex: 1.4 }} />
      </Row>
      <Txt kind="small" style={{ textAlign: "center" }}>
        {req.nosign && !cmd ? "Агент настроен без подписи: «Разрешить» — без биометрии" : "«Разрешить» спросит биометрию и подпишет решение ключом этого телефона"}
      </Txt>
    </View>
  );
}

function ToolCard({ t, api }: { t: Tool; api: DeckApi | null }) {
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
      {t.name === "create_file" && t.result?.attachment?.id ? <AttachmentList items={[t.result.attachment]} api={api} /> : null}
      {open ? (
        <>
          <ArgsBlock args={t.args} full />
          {t.result !== undefined ? <ArgsBlock args={t.result} /> : null}
        </>
      ) : null}
    </Pressable>
  );
}

/** Удержание сообщения — текст в буфер обмена. */
function copyText(text: string, onCopied: () => void) {
  if (!text.trim()) return;
  Clipboard.setStringAsync(text).then(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onCopied();
  }, () => {});
}

function Bubble({ item, api, onCopied, onRetry }: { item: Item; api: DeckApi | null; onCopied: () => void; onRetry?: () => void }) {
  const { p } = useTheme();
  if (item.kind === "user") {
    return (
      <Pressable onLongPress={() => copyText(item.content, onCopied)} delayLongPress={350}
        style={{ alignSelf: "flex-end", maxWidth: "88%", gap: 5 }}>
        <Txt kind="small" style={{ textAlign: "right", paddingRight: 4 }}>{!item.mine && item.author ? item.author : "Вы"}</Txt>
        <View style={{ backgroundColor: alpha(p.accent, 0.1), borderColor: alpha(p.accent, 0.32), borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 16, borderBottomRightRadius: 5 }}>
          {item.content ? <Txt selectable>{item.content}</Txt> : null}
          {item.attachments?.length ? <AttachmentList items={item.attachments} api={api} /> : null}
        </View>
      </Pressable>
    );
  }
  if (item.kind === "assistant") {
    return (
      <Pressable onLongPress={() => !item.streaming && copyText(item.content, onCopied)} delayLongPress={350} style={{ flexDirection: "row", gap: 10, alignItems: "flex-start", maxWidth: "96%" }}>
        <View style={{ width: 30, height: 30, borderRadius: 9, borderWidth: 1, borderColor: alpha(p.accent, 0.35), backgroundColor: alpha(p.accent, 0.08), alignItems: "center", justifyContent: "center", marginTop: 2 }}>
          <Text style={{ color: p.accent, fontFamily: MONO, fontWeight: "700", fontSize: 10 }}>FD</Text>
        </View>
        <View style={{ flex: 1, gap: 7, backgroundColor: p.panel, borderWidth: 1, borderColor: p.line, borderRadius: 16, borderTopLeftRadius: 5, padding: 13 }}>
          <Txt kind="small" color={p.accent}>Fugu Agent{item.streaming ? " · отвечает" : ""}</Txt>
          <RichText text={item.content + (item.streaming ? " ▍" : "")} color={p.text} />
        </View>
      </Pressable>
    );
  }
  if (item.kind === "notice") {
    return (
      <View style={{ gap: 6, alignItems: "center" }}>
        <Txt kind="small" color={item.level === "error" ? p.accent2 : p.dim} style={{ textAlign: "center" }}>{item.text}</Txt>
        {item.retry && onRetry ? <Btn small title="Повторить" onPress={onRetry} /> : null}
      </View>
    );
  }
  return null;
}

export default function Chat() {
  const { p } = useTheme();
  const desktop = useDesktopLayout();
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
  const [models, setModels] = useState<{ list: string[]; ready: string[]; titles: Record<string, string> } | null>(null);
  const [catalog, setCatalog] = useState<AppConfig | null>(null);
  const [modelPrefs, setModelPrefs] = useState<ModelPreferences | null>(null);
  const [scenarioEnabled, setScenarioEnabled] = useState(false);
  useEffect(() => { void loadModelPreferences().then(setModelPrefs); }, []);
  const [switching, setSwitching] = useState(false);
  const [chatMenu, setChatMenu] = useState(false);
  const [agentList, setAgentList] = useState<{ id: string; name: string }[]>([]);
  const pickAgent = async (id: string) => {
    if (!api || !conv) return;
    setSwitching(true);
    setError(null);
    try {
      await api.setConversationAgent(cid, id);
      setConv({ ...conv, agent: agentList.find((a) => a.id === id) });
      setModels(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setSwitching(false);
    }
  };
  const [atts, setAtts] = useState<Uploaded[]>([]); // загружены и ждут отправки с сообщением
  const [uploading, setUploading] = useState<string | null>(null);
  const [attachMenu, setAttachMenu] = useState(false);
  const stream = useRef<{ close(): void } | null>(null);
  const list = useRef<FlatList<Item>>(null);
  // Прокручиваем вниз за новым содержимым, только если человек и так внизу: иначе при чтении истории
  // каждое изменение высоты (поток ответа, опрос, догрузка картинки) сбрасывало бы его в конец.
  const atEnd = useRef(true);
  const [showDown, setShowDown] = useState(false);
  const toEnd = (animated: boolean) => {
    atEnd.current = true;
    setShowDown(false);
    list.current?.scrollToEnd({ animated });
  };

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
            (globalThis as typeof globalThis & { fuguDesktop?: { notify?(title: string, body: string): void } }).fuguDesktop?.notify?.("Fugu Deck", err ? "Задача завершилась с ошибкой соединения" : "Ответ агента готов");
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

  // Вложение: выбрать или перетащить → сразу загрузить → приложить к следующему сообщению.
  const uploadAbort = useRef<AbortController | null>(null);
  const currentUploadId = useRef<string | null>(null);
  const [failedUpload, setFailedUpload] = useState<{ file: PickedFile; uploadId: string | null } | null>(null);
  const [dragging, setDragging] = useState(false);

  const uploadOne = async (f: PickedFile, resumeId?: string): Promise<boolean> => {
    if (!api) return false;
    setFailedUpload(null);
    setError(null);
    setUploading(`${f.name} · ${sizeText(f.size)}`);
    const controller = new AbortController();
    uploadAbort.current = controller;
    try {
      const up = await api.upload(cid, f, { all: readAll, chunk: readChunk }, (d, t) =>
        setUploading(`${f.name} · ${Math.round((d / t) * 100)}% из ${sizeText(t)}`), {
        signal: controller.signal,
        resumeId,
        onUploadId: (id) => { currentUploadId.current = id; },
      });
      if (!desktopAvailable() && isImage(up.mime) && up.size <= PREVIEW_MAX) rememberPreviewUri(up.id, up.mime, f.uri);
      setAtts((prev) => [...prev, up]);
      return true;
    } catch (e) {
      if ((e as { name?: string })?.name !== "AbortError") {
        setError(`${errText(e)}. Можно повторить с принятой сервером позиции.`);
        setFailedUpload({ file: f, uploadId: currentUploadId.current });
      }
      return false;
    } finally {
      uploadAbort.current = null;
      currentUploadId.current = null;
      setUploading(null);
    }
  };

  const uploadPicked = async (picked: PickedFile[]) => {
    let n = atts.length;
    for (const f of picked) {
      const bad = attachProblem(f, n);
      if (bad) {
        setError(bad);
        continue;
      }
      if (!await uploadOne(f)) break;
      n++;
    }
  };

  const attach = async (kind: "photo" | "camera" | "file") => {
    if (!api || uploading) return;
    setAttachMenu(false);
    setError(null);
    try {
      const room = MAX_ATTACHMENTS - atts.length;
      if (room <= 0) return setError(`К сообщению можно приложить не больше ${MAX_ATTACHMENTS} файлов`);
      const picked: PickedFile[] = kind === "photo" ? await pickPhotos(room) : kind === "camera" ? [await takePhoto()].filter((x): x is PickedFile => !!x) : await pickFiles(room);
      await uploadPicked(picked);
    } catch (e) {
      setError(errText(e));
    }
  };

  const attachDropped = async (files: FileList | File[]) => {
    if (!api || uploading || !desktopAvailable()) return;
    setError(null);
    try {
      const room = MAX_ATTACHMENTS - atts.length;
      if (room <= 0) return setError(`К сообщению можно приложить не больше ${MAX_ATTACHMENTS} файлов`);
      await uploadPicked(await desktopDropFiles(files, room));
    } catch (e) {
      setError(errText(e));
    }
  };

  const send = async () => {
    const msg = text.trim();
    if (!api || (!msg && atts.length === 0) || runId || uploading) return;
    setSending(true);
    setError(null);
    try {
      const sent = atts;
      const roles = catalog ? resolveScenario(modelPrefs || { favorites: [], recent: [], roles: { code: "", review: "", summary: "" }, fallbacks: [] }, conv?.model || catalog.default_model, catalog.models, catalog.llm_ready) : null;
      const r = await api.send(cid, msg, undefined, sent.map((a) => a.id), {
        fallbackModels: modelPrefs ? fallbackChain(modelPrefs) : [],
        scenario: scenarioEnabled && roles ? { kind: "code-review-summary", worker: roles.code, review: roles.review, summary: roles.summary } : undefined,
      });
      setText("");
      setAtts([]);
      setScenarioEnabled(false);
      setItems((prev) => [...prev, { kind: "user", key: "u" + Date.now(), content: msg, mine: true, attachments: sent }]);
      toEnd(false);
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

  // Выбор модели личного чата: список моделей сервера; недоступны те, для чьего провайдера нет ключа.
  const openModels = async () => {
    if (!api) return;
    if (models) return setModels(null);
    try {
      const [c, ags] = await Promise.all([api.config(), api.agents().catch(() => [])]);
      setAgentList(ags.length > 1 ? ags.map((a) => ({ id: a.id, name: a.name })) : []);
      setCatalog(c);
      setModels({ list: c.models, ready: c.llm_ready, titles: c.provider_titles ?? {} });
    } catch (e) {
      setError(errText(e));
    }
  };
  const pickModel = async (m: string) => {
    if (!api || !conv || m === conv.model) return setModels(null);
    setSwitching(true);
    setError(null);
    try {
      await api.setModel(cid, m);
      setConv({ ...conv, model: m });
      setModels(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setSwitching(false);
    }
  };

  const changeMode = async (next: Mode) => {
    if (!api || !conv || runId || switching || !canWrite || (next === "talk") === (conv.project_id === "talk")) return;
    setSwitching(true);
    setError(null);
    try {
      let target = "talk";
      if (next === "eng") {
        const projects = await api.projects();
        const remembered = typeof conv.eng_project_id === "string" ? conv.eng_project_id : "";
        target = projects.some((p) => p.id === remembered) ? remembered : projects.some((p) => p.id === "general") ? "general" : projects[0]?.id || "";
        if (!target) throw new Error("Сначала создайте инженерный проект");
      }
      const moved = await api.moveConversation(cid, target);
      setConv({ ...conv, ...moved });
      setScenarioEnabled(false);
      setModels(null);
      setChatMenu(false);
    } catch (e) {
      setError(errText(e));
    } finally {
      setSwitching(false);
    }
  };

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

  // «Повторить» у пометки о прерванном задании: агент продолжает ту же переписку.
  const retryRun = useCallback(async () => {
    if (!api || runId) return;
    setError(null);
    try {
      const r = await api.retry(cid);
      setItems((prev) => prev.map((x) => (x.kind === "notice" && x.retry ? { ...x, retry: false } : x)));
      follow(r.run_id);
    } catch (e) {
      setError(errText(e));
    }
  }, [api, cid, runId, follow]);

  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashCopied = useCallback(() => {
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1500);
  }, []);

  const pending = items.filter((i): i is Tool => i.kind === "tool" && i.status === "pending" && !!i.approval);
  const scenarioModels = catalog ? resolveScenario(modelPrefs || { favorites: [], recent: [], roles: { code: "", review: "", summary: "" }, fallbacks: [] }, conv?.model || catalog.default_model, catalog.models, catalog.llm_ready) : null;
  const canWrite = conv?.my_role !== "viewer";
  const dropProps = desktopAvailable() && canWrite ? {
    onDragEnter: (e: any) => { e.preventDefault(); setDragging(true); },
    onDragOver: (e: any) => { e.preventDefault(); },
    onDragLeave: (e: any) => { if (e.currentTarget === e.target) setDragging(false); },
    onDrop: (e: any) => {
      e.preventDefault();
      setDragging(false);
      if (e.dataTransfer?.files?.length) void attachDropped(e.dataTransfer.files);
    },
  } : {};

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: p.bg }} edges={["top", "left", "right", "bottom"]} {...dropProps}>
      <TopBar title={conv?.title || "Чат"} back right={<IconBtn glyph="⋮" label="Контекст и переходы чата" onPress={() => { setModels(null); setChatMenu(!chatMenu); }} />} />
      {conv && !conv.parent_id ? (
        <View style={{ paddingHorizontal: desktop ? 24 : 12, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: p.line, width: "100%", maxWidth: desktop ? 1008 : undefined, alignSelf: "center" }}>
          <ModeSwitch compact mode={conv.project_id === "talk" ? "talk" : "eng"} disabled={!!runId || switching || !canWrite} onChange={(next) => { void changeMode(next); }} />
        </View>
      ) : null}
      {chatMenu && conv ? (
        <ScrollView style={{ flexGrow: 0, maxHeight: "60%", borderBottomWidth: 1, borderBottomColor: p.line, backgroundColor: p.bg2 }} contentContainerStyle={{ padding: 12, gap: 10 }} keyboardShouldPersistTaps="handled">
          <Row style={{ justifyContent: "space-between" }}><Txt kind="label">контекст задачи</Txt><Chip text={runId ? "агент работает" : "готов"} color={runId ? p.ok : p.dim} /></Row>
          <Card style={{ padding: 12 }}>
            <Txt kind="small">Проект: {conv.project_id === "talk" ? "Общение" : conv.project_id}</Txt>
            <Txt kind="mono" numberOfLines={1}>{conv.model}</Txt>
            <Txt kind="small">Подтверждения выполняются по правилам выбранного агента.</Txt>
          </Card>
          <Row gap={7} style={{ flexWrap: "wrap" }}>
            <Btn small kind="ghost" title="Чаты проекта" onPress={() => { setChatMenu(false); router.push(`/s/${sid}/p/${conv.project_id}`); }} />
            <Btn small kind="ghost" title="Workspace" onPress={() => { setChatMenu(false); router.push(`/s/${sid}/workspace`); }} />
            <Btn small kind="ghost" title="Задачи" onPress={() => { setChatMenu(false); router.push(`/s/${sid}/tasks`); }} />
          </Row>
          {conv.project_id !== "talk" ? <Row gap={7} style={{ flexWrap: "wrap" }}>
            <Btn small kind="ghost" title="База знаний" onPress={() => { setChatMenu(false); router.push(`/s/${sid}/kb/${conv.project_id}`); }} />
            <Btn small kind="ghost" title="Расписание" onPress={() => { setChatMenu(false); router.push(`/s/${sid}/sched/${conv.project_id}`); }} />
          </Row> : null}
        </ScrollView>
      ) : null}
      {conv ? (
        <Pressable onPress={conv.team || runId || !canWrite ? undefined : () => { setChatMenu(false); void openModels(); }}>
          <Row style={{ paddingHorizontal: 14, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: p.line, justifyContent: "space-between" }}>
            <Txt kind="mono" color={p.accent} numberOfLines={1} style={{ fontSize: 11.5, flex: 1 }}>
              {(conv.agent as { name?: string } | undefined)?.name && (conv.agent as { id?: string }).id !== "fugu" ? `${(conv.agent as { name: string }).name} · ` : ""}{conv.model}{conv.team || !canWrite ? "" : "  ▾"}
            </Txt>
            {copied ? <Chip text="текст скопирован" color={p.ok} /> : runId ? <Chip text={link || "работает"} color={link ? p.warn : p.ok} /> : null}
          </Row>
        </Pressable>
      ) : null}
      {models && conv && !conv.team ? (
        <ScrollView style={{ flexGrow: 0, maxHeight: "65%", borderBottomWidth: 1, borderBottomColor: p.line, backgroundColor: p.bg2 }}
          contentContainerStyle={{ padding: 10, gap: 8 }} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
          <ModelPicker models={models.list} ready={models.ready} providerTitles={models.titles} selected={conv.model}
            onSelect={(m) => { if (!switching) void pickModel(m); }} onClose={() => setModels(null)} maxHeight={320} />
          {agentList.length ? (
            <>
              <Txt kind="label">агент</Txt>
              <Row gap={6} style={{ flexWrap: "wrap" }}>
                {agentList.map((a) => (
                  <Btn key={a.id} small title={a.name} kind={(conv.agent as { id?: string } | undefined)?.id === a.id ? "primary" : "ghost"}
                    disabled={switching} onPress={() => pickAgent(a.id)} />
                ))}
              </Row>
            </>
          ) : null}
          {conv.project_id !== "talk" ? <Btn small kind="ghost" title={scenarioEnabled ? "✓ Multi-model: работа → ревью → сводка" : "Multi-model сценарий…"} onPress={() => setScenarioEnabled(!scenarioEnabled)} /> : null}
          {conv.project_id !== "talk" && scenarioEnabled && scenarioModels ? <Card accent={p.accent} style={{ padding: 12 }}>
            <Txt kind="small">Исполнитель: {nameOfModel(scenarioModels.code)}</Txt>
            <Txt kind="small">Ревью без инструментов: {nameOfModel(scenarioModels.review)}</Txt>
            <Txt kind="small">Сводка: {nameOfModel(scenarioModels.summary)}</Txt>
            <Txt kind="small">Роли и резервные модели настраиваются в «Модели и провайдеры». Сценарий применится к следующему сообщению.</Txt>
          </Card> : null}
          {models.list.some((m) => !models.ready.includes(m.split(":")[0])) ? (
            <Txt kind="small">Серые модели недоступны: для их провайдера не введён ключ (экран кластера → ключи).</Txt>
          ) : null}
        </ScrollView>
      ) : null}
      {/* На Android окно рисуется под системными панелями (edge-to-edge), и система сама его под клавиатуру
          не сжимает — без отступа клавиатура закрывала бы поле ввода. */}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        {!conv && !apiError && !error ? <Loading /> : null}
        <View style={{ flex: 1 }}>
        <FlatList
          ref={list}
          data={items}
          keyExtractor={(i) => i.key}
          contentContainerStyle={{ padding: desktop ? 24 : 14, gap: 12, paddingBottom: 20, width: "100%", maxWidth: desktop ? 960 : undefined, alignSelf: "center" }}
          // Пока агент пишет, размер списка растёт десятки раз в секунду. Прокрутка с анимацией на каждый прирост
          // наслаивается сама на себя и дёргает список вверх-вниз — поэтому держим низ мгновенно (animated: false).
          onContentSizeChange={() => { if (atEnd.current) list.current?.scrollToEnd({ animated: false }); }}
          onLayout={() => { if (atEnd.current) list.current?.scrollToEnd({ animated: false }); }}
          scrollEventThrottle={16}
          onScroll={(e) => {
            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
            const end = contentSize.height - contentOffset.y - layoutMeasurement.height < 120;
            atEnd.current = end;
            setShowDown((v) => (v === !end ? v : !end));
          }}
          renderItem={({ item }) =>
            item.kind === "tool" ? item.status === "pending" && item.approval ? <ApprovalCard t={item} onDecide={decide} /> : <ToolCard t={item} api={api} /> : <Bubble item={item} api={api} onCopied={flashCopied}
              onRetry={!runId && canWrite && item.kind === "notice" && item.retry && items[items.length - 1]?.key === item.key ? retryRun : undefined} />
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
        {showDown ? (
          <Pressable onPress={() => toEnd(true)} accessibilityLabel="К последним сообщениям"
            style={{ position: "absolute", right: 14, bottom: 14, width: 40, height: 40, borderRadius: 20, alignItems: "center",
              justifyContent: "center", backgroundColor: p.panel2, borderWidth: 1, borderColor: p.line2 }}>
            <Text style={{ color: p.accent, fontSize: 20, lineHeight: 22 }}>↓</Text>
          </Pressable>
        ) : null}
        </View>
        {canWrite && (atts.length > 0 || uploading || attachMenu || failedUpload) ? (
          <View style={{ paddingHorizontal: 10, paddingTop: 8, gap: 6, borderTopWidth: 1, borderTopColor: p.line, backgroundColor: p.bg, width: "100%", maxWidth: desktop ? 1000 : undefined, alignSelf: "center" }}>
            {attachMenu ? (
              <Row gap={6}>
                <Btn small title="Камера" kind="ghost" onPress={() => attach("camera")} />
                <Btn small title="Фото" kind="ghost" onPress={() => attach("photo")} />
                <Btn small title="Файл" kind="ghost" onPress={() => attach("file")} />
                <Txt kind="small" style={{ flex: 1 }}>до {sizeText(MAX_ATTACHMENT_BYTES)}; агент видит картинки, читает текст, PDF, DOCX, XLSX и архивы</Txt>
              </Row>
            ) : null}
            {atts.map((a) => (
              <Row key={a.id} style={{ justifyContent: "space-between" }}>
                <Txt kind="small" numberOfLines={1} style={{ flex: 1 }}>{isImage(a.mime) ? "🖼" : "📎"} {a.filename} · {sizeText(a.size)}</Txt>
                <Pressable hitSlop={10} onPress={() => setAtts((prev) => prev.filter((x) => x.id !== a.id))} accessibilityLabel={`Убрать ${a.filename}`}>
                  <Txt kind="small" color={p.accent2}>убрать</Txt>
                </Pressable>
              </Row>
            ))}
            {uploading ? (
              <Row style={{ justifyContent: "space-between" }}>
                <Txt kind="small" color={p.accent} style={{ flex: 1 }}>загружается: {uploading}…</Txt>
                <Btn small kind="ghost" title="Отмена" onPress={() => uploadAbort.current?.abort()} />
              </Row>
            ) : null}
            {failedUpload && !uploading ? (
              <Row style={{ justifyContent: "space-between" }}>
                <Txt kind="small" style={{ flex: 1 }}>{failedUpload.file.name}</Txt>
                <Btn small title="Повторить" onPress={() => {
                  const bad = attachProblem(failedUpload.file, atts.length);
                  if (bad) setError(bad);
                  else void uploadOne(failedUpload.file, failedUpload.uploadId || undefined);
                }} />
                <Btn small kind="ghost" title="Убрать" onPress={() => setFailedUpload(null)} />
              </Row>
            ) : null}
          </View>
        ) : null}
        {canWrite ? (
          <View style={{ flexDirection: "row", gap: 9, padding: desktop ? 16 : 12, borderTopWidth: 1, borderTopColor: p.line, backgroundColor: p.bg2, alignItems: "flex-end", width: "100%", maxWidth: desktop ? 1000 : undefined, alignSelf: "center", borderRadius: desktop ? 14 : 0, marginBottom: desktop ? 12 : 0 }}>
            {!runId ? (
              <Btn title="+" kind="ghost" onPress={() => setAttachMenu(!attachMenu)} disabled={!!uploading || sending} style={{ minWidth: 46, paddingHorizontal: 0, backgroundColor: p.panel }} />
            ) : null}
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder={runId ? "Агент работает…" : "Сообщение агенту…"}
              placeholderTextColor={p.faint}
              multiline
              style={{
                flex: 1,
                maxHeight: 140,
                minHeight: 46,
                color: p.text,
                backgroundColor: p.panel,
                borderWidth: 1,
                borderColor: p.line2,
                borderRadius: 13,
                paddingHorizontal: 14,
                paddingVertical: 11,
                fontSize: 15,
                fontFamily: p.monoText ? MONO : undefined,
              }}
            />
            {runId ? (
              <Btn title="Стоп" kind="danger" onPress={() => api?.cancel(runId).catch((e) => setError(errText(e)))} />
            ) : (
              <Btn title="↑" onPress={send} busy={sending} disabled={(!text.trim() && atts.length === 0) || !!uploading} style={{ minWidth: 48, paddingHorizontal: 0 }} />
            )}
          </View>
        ) : null}
      </KeyboardAvoidingView>
      {dragging ? (
        <View pointerEvents="none" style={{ position: "absolute", inset: 12, borderWidth: 2, borderStyle: "dashed", borderColor: p.accent, borderRadius: 16, backgroundColor: alpha(p.bg, 0.9), alignItems: "center", justifyContent: "center" }}>
          <Txt kind="h2">Отпустите файлы, чтобы приложить их</Txt>
          <Txt kind="dim">Можно выбрать до {MAX_ATTACHMENTS} файлов; большие загрузятся частями</Txt>
        </View>
      ) : null}
    </SafeAreaView>
  );
}
