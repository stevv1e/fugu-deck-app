import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, subscribeRun, type Attachment, type Config, type ConversationFull, type Online, type Role, type RunEvent } from "../api";
import { ModelSheet } from "./ModelSheet";
import { termsText } from "./SponsorTerms";

function leftText(ts: number) {
  const m = Math.max(0, Math.round((ts * 1000 - Date.now()) / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m} мин`;
}
import { applyEvent, fromStored, type Item } from "../timeline";
import { IconClip, IconMenu, IconSend, IconStop, IconX, Logo } from "./icons";
import { Markdown } from "./Markdown";
import { modelLabel, providerOf, usd } from "./Sidebar";
import { useCluster } from "../cluster/context";
import { ToolCard } from "./ToolCard";
import { Avatar, OnlineStack } from "./ui";

type Pending = { localId: string; name: string; att?: Attachment; error?: string };

const SUGGESTIONS: [string, string][] = [
  ["repos", "Покажи мои последние репозитории на GitHub и GitLab"],
  ["new", "Создай приватный репозиторий fastapi-starter с минимальным FastAPI-приложением, Dockerfile и README"],
  ["ci", "Проверь статус CI в моём последнем обновлённом репозитории"],
  ["review", "Прочитай README в репозитории … и предложи, что улучшить"],
];

export function Chat(props: {
  projectId: string;
  projectName: string;
  role: Role;
  online: Online[];
  remote: any;
  conversationId: string | null;
  config: Config | null;
  onMenu: () => void;
  onCreated: (id: string) => void;
  onChanged: () => void;
  toast: (msg: string) => void;
}) {
  const { conversationId, config } = props;
  const [title, setTitle] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [model, setModel] = useState<string>("");
  const [runId, setRunId] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const [runCost, setRunCost] = useState(0);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [loading, setLoading] = useState(false);
  const [meta, setMeta] = useState<ConversationFull | null>(null);
  const [sheet, setSheet] = useState(false);
  const [pendingSend, setPendingSend] = useState<string | null>(null);
  const sheetApplied = useRef(false);

  const unsub = useRef<(() => void) | null>(null);
  const justCreated = useRef<string | null>(null);
  const convRef = useRef<string | null>(conversationId);
  const feedRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  convRef.current = conversationId;

  const onEvent = useCallback((e: RunEvent) => {
    if (e.type === "thinking") setThinking(true);
    if (["text", "tool_start", "approval_request", "done", "error", "cancelled"].includes(e.type)) setThinking(false);
    if (e.type === "usage") setRunCost((c) => c + (e.cost_usd || 0));
    setItems((prev) => applyEvent(prev, e));
  }, []);

  const attach = useCallback(
    (rid: string, after = 0) => {
      if (runRef.current === rid && unsub.current) return;
      unsub.current?.();
      setRunId(rid);
      setThinking(true);
      unsub.current = subscribeRun(rid, onEvent, () => {
        setRunId(null);
        setThinking(false);
        props.onChanged();
      }, after);
    },
    [onEvent, props.onChanged],
  );

  const load = useCallback((cid: string) => {
    setLoading(true);
    api
      .conversation(cid)
      .then((c) => {
        if (convRef.current !== cid) return;
        setTitle(c.title);
        setModel(c.model);
        setMeta(c);
        stick.current = true;
        if (c.active_run && c.active_run_started_at) {
          const before = c.messages.filter((m) => m.created_at <= c.active_run_started_at!);
          setItems(fromStored(before, props.config?.me.id));
          attach(c.active_run, 0);
        } else {
          setItems(fromStored(c.messages, props.config?.me.id));
        }
      })
      .catch((e) => props.toast(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attach]);

  // Изменения с других устройств / от других людей
  const runRef = useRef<string | null>(null);
  const sendingRef = useRef(false);
  runRef.current = runId;
  useEffect(() => {
    const e = props.remote;
    if (!e || !conversationId || e.conversation_id !== conversationId) return;
    if (e.type === "run.started" && runRef.current !== e.run_id && !sendingRef.current) load(conversationId);
    else if (e.type === "run.finished" && !runRef.current) load(conversationId);
    else if ((e.type === "conversation" && e.action === "updated") || e.type === "model.proposal") {
      if (!runRef.current) load(conversationId); // новые отметки о модели и спонсоре — в ленте
      else api.conversation(conversationId).then((c) => { setTitle(c.title); setModel(c.model); setMeta(c); }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.remote]);

  // Загрузка чата
  useEffect(() => {
    if (conversationId && justCreated.current === conversationId) {
      justCreated.current = null;
      return;
    }
    unsub.current?.();
    unsub.current = null;
    setRunId(null);
    setThinking(false);
    setItems([]);
    setPending([]);
    setRunCost(0);
    setTitle("");
    setMeta(null);
    if (!conversationId) {
      setModel(config?.default_model || "");
      return;
    }
    load(conversationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, props.projectId]);

  useEffect(() => () => unsub.current?.(), []);
  useEffect(() => {
    if (!model && config) setModel(config.default_model);
  }, [config, model]);

  // Автопрокрутка, если пользователь внизу
  useLayoutEffect(() => {
    const el = feedRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, thinking]);

  const onScroll = () => {
    const el = feedRef.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const ensureConv = async (): Promise<string> => {
    if (conversationId) return conversationId;
    const c = await api.createConversation(props.projectId, model || undefined);
    justCreated.current = c.id;
    props.onCreated(c.id);
    return c.id;
  };

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    let cid: string;
    try {
      cid = await ensureConv();
    } catch (e: any) {
      props.toast(e.message);
      return;
    }
    for (const f of Array.from(files)) {
      const localId = Math.random().toString(36).slice(2);
      setPending((p) => [...p, { localId, name: f.name }]);
      api
        .upload(cid, f)
        .then((att) => setPending((p) => p.map((x) => (x.localId === localId ? { ...x, att } : x))))
        .catch((e) => setPending((p) => p.map((x) => (x.localId === localId ? { ...x, error: e.message } : x))));
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  const cluster = useCluster();
  const noKey = !!config && !!model && !config.llm_ready?.includes(providerOf(model));
  // общий чат: одна модель, платит спонсор; своего ключа этой модели не нужно
  const team = !!meta?.team && !!conversationId;
  const teamBlock = team
    ? !meta?.sponsor ? "У чата нет спонсора модели — предложите модель, которую оплатите своим ключом"
      : !meta.sponsor.online ? `Ключ спонсора недоступен: ${meta.sponsor.name} сейчас не в сети`
      : meta.sponsor.blocked
    : null;
  const keyBlocked = team ? !!teamBlock : noKey;
  // новый чат: если для модели по умолчанию нет ключа — берём первую модель, для которой ключ есть
  useEffect(() => {
    if (conversationId || !config?.llm_ready?.length || !noKey) return;
    const first = config.models.find((m) => config.llm_ready!.includes(providerOf(m)));
    if (first) setModel(first);
  }, [conversationId, config, noKey]);
  const uploading = pending.some((p) => !p.att && !p.error);
  const ready = pending.filter((p) => p.att).map((p) => p.att!);
  const canSend = !runId && !uploading && (text.trim().length > 0 || ready.length > 0) && (team || !!config?.llm_configured) && !keyBlocked;

  const teamSpace = cluster?.space.kind === "team";
  const send = async (override?: string) => {
    const content = (override ?? text).trim();
    if (runId || uploading || (!content && !ready.length)) return;
    try {
      const cid = await ensureConv();
      if (teamSpace) {
        // общий чат без спонсора: сначала модель и условия оплаты, затем отправка
        const m = meta && meta.id === cid ? meta : await api.conversation(cid);
        setMeta(m);
        if (!m.sponsor) {
          setPendingSend(content);
          setSheet(true);
          return;
        }
      }
      setItems((prev) => [...prev, { kind: "user", key: `u${Date.now()}`, content, attachments: ready,
        author: props.config?.me.display_name, mine: true }]);
      setText("");
      setPending([]);
      setRunCost(0);
      stick.current = true;
      if (!title) setTitle(content.split("\n")[0].slice(0, 60) || "Новый чат");
      sendingRef.current = true;
      const { run_id } = await api.send(cid, content, ready.map((a) => a.id), team ? undefined : model);
      attach(run_id);
      sendingRef.current = false;
      props.onChanged();
    } catch (e: any) {
      sendingRef.current = false;
      props.toast(e.message);
    }
  };

  useEffect(() => {
    if (pendingSend && meta?.sponsor && !runId) {
      const t = pendingSend;
      setPendingSend(null);
      send(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.sponsor?.id, pendingSend]);

  const vote = (yes: boolean) =>
    api.decideProposal(meta!.proposal!.id, yes)
      .then((r: any) => {
        if (r?.status === "approved") props.toast("Голосование прошло — модель сменена");
        else if (r?.status === "rejected") props.toast("Предложение отклонено");
        load(conversationId!);
      })
      .catch((e) => props.toast(e.message));

  const cycleModel = async () => {
    if (team) { setSheet(true); return; }
    if (teamSpace && !conversationId) {
      try {
        const cid = await ensureConv();
        setMeta(await api.conversation(cid));
        setSheet(true);
      } catch (e: any) { props.toast(e.message); }
      return;
    }
    if (!config?.models.length) return;
    const ready = config.llm_ready?.length ? config.models.filter((m) => config.llm_ready!.includes(providerOf(m))) : config.models;
    const list = ready.length ? ready : config.models;
    const i = list.indexOf(model);
    const next = list[(i + 1) % list.length];
    setModel(next);
    if (conversationId) api.updateConversation(conversationId, { model: next }).catch(() => {});
  };

  const decide = async (approvalId: string, approve: boolean) => {
    try {
      await api.approve(approvalId, approve);
    } catch (e: any) {
      props.toast(e.message);
    }
  };

  // автоувеличение поля ввода
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 180) + "px";
  }, [text]);

  const isUltra = /ultra|opus|fable/i.test(model);
  const price = config?.pricing[model];
  const lastIsStreaming = items.length > 0 && items[items.length - 1].kind === "assistant" && (items[items.length - 1] as any).streaming;

  return (
    <div className="main">
      <header className="topbar">
        <button className="icon-btn only-mobile" onClick={props.onMenu} aria-label="Меню">
          <IconMenu />
        </button>
        <div className="title">
          {title || "Новый чат"}
          <small>{props.projectName} {runId ? "// агент работает" : "// online"}</small>
        </div>
        <OnlineStack online={props.online.filter((o) => conversationId && o.conversations.includes(conversationId))}
          meId={config?.me.id} />
        <button className={`model-chip ${isUltra ? "ultra" : ""} ${team && !meta?.sponsor ? "warn" : ""}`}
          onClick={cycleModel} disabled={!!runId && !team}
          title={noKey && !team ? "нет ключа для этой модели" : price ? `$${price[0]} / $${price[1]} за 1M токенов` : undefined}>
          <i className="dot" />
          {modelLabel(model)}
          {team && meta?.sponsor && <Avatar name={meta.sponsor.name} size={16} title={`платит ${meta.sponsor.name}`} />}
          {team && meta?.proposal && <i className="badge">?</i>}
        </button>
      </header>

      <div className="feed" ref={feedRef} onScroll={onScroll}>
        <div className="feed-inner">
          {!items.length && !loading && (
            <div className="empty">
              <Logo size={56} />
              <h2>
                что <span>строим</span>?
              </h2>
              <p>
                Агент работает с вашими репозиториями: создаёт, читает, коммитит и открывает PR. Изменения вы подтверждаете.
              </p>
              {config && !config.llm_configured && (
                <div className="notice error" style={{ marginBottom: 16 }}>
                  {cluster ? (
                    <>Нет ключей ИИ. <button className="btn slim" onClick={() => cluster.requestUnlock()}>разблокировать</button>{" "}
                      или добавьте их в «Настройки → Ключи API».</>
                  ) : "На сервере не задан ключ API"}
                </div>
              )}
              <div className="suggest">
                {SUGGESTIONS.map(([k, s]) => (
                  <button key={k} onClick={() => (s.includes("…") ? setText(s) : send(s))}>
                    <span className="label">{k}</span>
                    <span>{s}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {items.map((it) => {
            switch (it.kind) {
              case "user":
                return (
                  <div className={`msg-user ${it.mine === false ? "other" : ""}`} key={it.key}>
                    {it.mine === false && it.author && (
                      <div className="msg-author"><Avatar name={it.author} size={16} /> {it.author}</div>
                    )}
                    {it.content}
                    {!!it.attachments?.length && (
                      <div className="atts">
                        {it.attachments.map((a) => (
                          <span className="att-chip" key={a.id}>⇪ <span>{a.filename}</span></span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              case "assistant":
                return (
                  <div className="msg-ai" key={it.key}>
                    <Markdown text={it.content} />
                    {it.streaming && <span className="cursor" />}
                  </div>
                );
              case "tool":
                return <ToolCard key={it.key} item={it} onDecide={decide} canDecide={props.role !== "viewer"} />;
              case "notice":
                return (
                  <div className={`notice ${it.level === "error" ? "error" : ""}`} key={it.key}>
                    {it.level === "error" ? "✕ " : "// "}
                    {it.text}
                  </div>
                );
            }
          })}
          {runId && thinking && !lastIsStreaming && (
            <div className="thinking">
              <span className="bars"><i /><i /><i /><i /></span>
              {isUltra ? "команда моделей думает…" : "думает…"}
            </div>
          )}
        </div>
      </div>

      {team && meta?.proposal && (
        <div className="proposal-bar">
          <span className="grow">
            🗳 <b>{meta.proposal.proposer_name}</b> предлагает <b>{modelLabel(meta.proposal.model)}</b>
            <small> · платит {meta.proposal.proposer_name}: {termsText(meta.proposal)}</small>
            <span className="votes">
              <b>за {meta.proposal.yes.length}</b> из {meta.proposal.need} нужных
              {meta.proposal.no.length ? ` · против ${meta.proposal.no.length}` : ""}
              {meta.proposal.expires_at ? ` · осталось ${leftText(meta.proposal.expires_at)}` : ""}
            </span>
          </span>
          {meta.proposal.proposer_id === config?.me.id ? (
            <button className="btn slim" onClick={() => vote(false)}>отменить</button>
          ) : props.role === "viewer" ? null : meta.proposal.my_vote != null ? (
            <span className="chip">вы: {meta.proposal.my_vote ? "за" : "против"}</span>
          ) : (
            <>
              <button className="btn slim danger" onClick={() => vote(false)}>против</button>
              <button className="btn slim primary" disabled={!!runId} onClick={() => vote(true)}>за</button>
            </>
          )}
        </div>
      )}
      {props.role !== "viewer" && teamBlock && !runId && (
        <div className="proposal-bar warn">
          <span className="grow">{teamBlock}</span>
          <button className="btn slim" onClick={() => setSheet(true)}>модель</button>
        </div>
      )}
      {sheet && meta && config && (
        <ModelSheet config={config} conv={meta} meId={config.me.id} fresh={!meta.sponsor && !items.some((i) => i.kind !== "notice")}
          onClose={() => { setSheet(false); if (!sheetApplied.current && !meta.sponsor) setPendingSend(null); sheetApplied.current = false; }}
          onChanged={() => { sheetApplied.current = true; if (conversationId) load(conversationId); }} toast={props.toast} />
      )}
      {props.role === "viewer" ? (
        <div className="composer"><div className="composer-inner notice">// у вас доступ только на чтение — вы видите работу агента в реальном времени</div></div>
      ) : (
      <div className="composer">
        <div className="composer-inner">
          {!!pending.length && (
            <div className="atts">
              {pending.map((p) => (
                <span key={p.localId} className={`att-chip ${p.att ? "" : "loading"}`}
                  style={p.error ? { borderColor: "var(--magenta)", color: "var(--magenta)" } : undefined}
                  title={p.error}>
                  {p.error ? "✕" : p.att ? "⇪" : "…"} <span>{p.name}</span>
                  <button onClick={() => setPending((x) => x.filter((y) => y.localId !== p.localId))} aria-label="Убрать">
                    <IconX />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="composer-box">
            <input ref={fileRef} type="file" multiple hidden onChange={(e) => onFiles(e.target.files)} />
            <button className="icon-btn" onClick={() => fileRef.current?.click()} disabled={!!runId} aria-label="Прикрепить файл">
              <IconClip />
            </button>
            <textarea
              ref={taRef}
              rows={1}
              placeholder={runId ? "агент работает…" : "Задача для Fugu…"}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            {runId ? (
              <button className="send stop" onClick={() => api.cancel(runId).catch(() => {})} aria-label="Остановить">
                <IconStop />
              </button>
            ) : (
              <button className="send" disabled={!canSend} onClick={() => send()} aria-label="Отправить">
                <IconSend />
              </button>
            )}
          </div>
          <div className="run-cost">
            <span>{modelLabel(model).toUpperCase()}{price ? ` · $${price[0]}/$${price[1]} per 1M` : ""}</span>
            <span>{runCost > 0 ? `запрос: ${usd(runCost)}` : ""}</span>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
