import { useEffect, useState, type ReactElement } from "react";
import { api, type Config, type Conversation, type Online, type Project, type Usage } from "../api";
import { IconBolt, IconBrain, IconChat, IconChevron, IconFolder, IconGear, IconPlus, IconTrash, Logo } from "./icons";
import { Avatar } from "./ui";
import { useCluster } from "../cluster/context";
import { IconUsers } from "./icons";

export const usd = (v: number | undefined) =>
  v === undefined ? "—" : v < 0.01 && v > 0 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;

export function modelLabel(m: string) {
  const id = m.includes(":") ? m.split(":")[1] : m;
  return id.replace(/^fugu-?/, "").replace(/^claude-/, "").replace(/-v[\d.]+$/, "").replace(/-\d{8}$/, "") || "fugu";
}

export function providerOf(m: string) {
  return m.includes(":") ? m.split(":")[0] : "sakana";
}

export type View = "chat" | "memory" | "skills" | "project" | "settings" | "space";

export function Sidebar(props: {
  open: boolean;
  onClose: () => void;
  config: Config;
  projects: Project[];
  project: Project | null;
  onProject: (id: string) => void;
  view: View;
  onView: (v: View) => void;
  conversations: Conversation[];
  activeId: string | null;
  online: Online[];
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  toast: (m: string) => void;
  onProjectsChanged: (selectId?: string) => void;
  refreshKey: number;
}) {
  const [usage, setUsage] = useState<{ month: Usage; today: Usage } | null>(null);
  const [picker, setPicker] = useState(false);
  const meId = props.config.me.id;
  const cluster = useCluster();
  const [spacePicker, setSpacePicker] = useState(false);

  useEffect(() => {
    api.usage().then(setUsage).catch(() => {});
  }, [props.refreshKey]);

  // меню закрыто — выпадающие списки тоже закрываем
  useEffect(() => {
    if (!props.open) { setPicker(false); setSpacePicker(false); }
  }, [props.open]);

  const viewersOf = (cid: string) => props.online.filter((o) => o.user_id !== meId && o.conversations.includes(cid));
  const others = props.online.filter((o) => o.user_id !== meId);
  const canWrite = props.project?.my_role !== "viewer";

  const newProject = async () => {
    const name = prompt("Название проекта:");
    if (!name?.trim()) return;
    try {
      const p = await api.createProject(name.trim());
      setPicker(false);
      props.onProjectsChanged(p.id);
    } catch (e: any) {
      props.toast(e.message);
    }
  };

  const NAV: [View, string, ReactElement][] = [
    ["chat", "чаты", <IconChat key="c" />],
    ["memory", "память", <IconBrain key="m" />],
    ["skills", "скилы", <IconBolt key="s" />],
    ["project", "проект", <IconFolder key="p" />],
  ];
  if (cluster) NAV.push(["space", cluster.space.kind === "team" ? "команда" : "доступ", <IconUsers key="u" />]);

  return (
    <>
      {props.open && <div className="scrim" onClick={props.onClose} />}
      <aside className={`sidebar ${props.open ? "open" : ""}`}>
        <div className="sidebar-head">
          <div className="brand">
            <Logo size={24} />
            <span>FUGU<b>/</b>DECK</span>
          </div>
          <button className={`icon-btn ${props.view === "settings" ? "on" : ""}`} title="Настройки" onClick={() => props.onView("settings")}>
            <IconGear />
          </button>
        </div>

        {cluster && (
          <div className="proj-switch space-switch">
            <button className="proj-current" onClick={() => setSpacePicker(!spacePicker)}>
              <span className={`space-ico ${cluster.space.kind}`}>{cluster.space.kind === "team" ? "👥" : "◆"}</span>
              <span className="grow">
                <span className="label">пространство {cluster.invites.length > 0 && <i className="badge">{cluster.invites.length}</i>}</span>
                <b>{cluster.space.kind === "personal" ? "Личное" : cluster.space.name}</b>
              </span>
              <IconChevron />
            </button>
            {spacePicker && (
              <div className="proj-menu">
                {cluster.spaces.map((s) => (
                  <button key={s.id} className={s.id === cluster.space.id ? "on" : ""}
                    onClick={() => { cluster.switchSpace(s.id); setSpacePicker(false); }}>
                    <span>{s.kind === "team" ? "👥" : "◆"}</span>
                    <span className="grow">{s.kind === "personal" ? "Личное" : s.name}</span>
                    <small>{s.kind === "team" ? `${s.members} чел.` : ""}</small>
                  </button>
                ))}
                {cluster.invites.map((i) => (
                  <button key={i.id} className="add" onClick={() => { setSpacePicker(false); props.onView("space"); }}>
                    📨 приглашение: {i.space_name}
                  </button>
                ))}
                <button className="add" onClick={() => {
                  setSpacePicker(false);
                  const personal = cluster.spaces.find((s) => s.kind === "personal");
                  if (personal && personal.id !== cluster.space.id) cluster.switchSpace(personal.id);
                  props.onView("space");
                }}><IconPlus /> общий проект</button>
              </div>
            )}
          </div>
        )}

        <div className="proj-switch">
          <button className="proj-current" onClick={() => setPicker(!picker)}>
            <span className="proj-dot" />
            <span className="grow">
              <span className="label">проект</span>
              <b>{props.project?.name || "…"}</b>
            </span>
            <IconChevron />
          </button>
          {picker && (
            <div className="proj-menu">
              {props.projects.map((p) => (
                <button key={p.id} className={p.id === props.project?.id ? "on" : ""}
                  onClick={() => { props.onProject(p.id); setPicker(false); }}>
                  <span className="grow">{p.name}</span>
                  {!!p.running && <i className="live" title="агент работает" />}
                  <small>{p.conversations ?? 0}</small>
                </button>
              ))}
              <button className="add" onClick={newProject}><IconPlus /> новый проект</button>
            </div>
          )}
        </div>

        <nav className={`nav ${cluster ? "n5" : ""}`}>
          {NAV.map(([v, label, icon]) => (
            <button key={v} className={props.view === v ? "on" : ""} onClick={() => props.onView(v)}>
              {icon}
              <span>{label}</span>
            </button>
          ))}
        </nav>

        {!!others.length && (
          <div className="online-row">
            <span className="label">сейчас здесь</span>
            {others.map((o) => <Avatar key={o.user_id} name={o.name} size={20} title={`${o.name} · устройств: ${o.devices}`} />)}
          </div>
        )}

        <button className="btn primary new" onClick={props.onNew} disabled={!canWrite}>
          <IconPlus /> новый чат
        </button>
        <div className="conv-list">
          {props.conversations.map((c) => {
            const viewers = viewersOf(c.id);
            return (
              <div key={c.id} className="conv-row">
                <button className={`conv ${c.id === props.activeId && props.view === "chat" ? "active" : ""}`}
                  onClick={() => props.onSelect(c.id)}>
                  {c.running && <i className="live" />}
                  <span className="t">{c.title}</span>
                  {viewers.map((v) => <Avatar key={v.user_id} name={v.name} size={16} />)}
                  <span className="m">{c.author && c.author !== props.config.me.display_name ? c.author : modelLabel(c.model)}</span>
                </button>
                {c.id === props.activeId && canWrite && (
                  <button className="icon-btn" title="Удалить чат" onClick={() => confirm("Удалить этот чат?") && props.onDelete(c.id)}>
                    <IconTrash />
                  </button>
                )}
              </div>
            );
          })}
          {!props.conversations.length && <div className="label" style={{ padding: 12 }}>// чатов пока нет</div>}
        </div>
        <div className="sidebar-foot">
          <div className="stat-row" role={cluster ? "button" : undefined} style={cluster ? { cursor: "pointer" } : undefined}
            title={cluster ? "сводка расходов по участникам" : undefined} onClick={() => cluster && props.onView("space")}>
            <span className="label">сегодня / месяц</span>
            <b>{usd(usage?.today.cost_usd)} / {usd(usage?.month.cost_usd)}</b>
          </div>
          <div className="prov-row">
            {Object.entries(props.config.providers).map(([name, p]) => (
              <span key={name} className={`prov ${p.ok ? "ok" : "bad"}`} title={p.error}><i /> {name}</span>
            ))}
            {!Object.keys(props.config.providers).length && <span className="prov bad"><i /> git не подключён</span>}
            <span className="grow" />
            <Avatar name={props.config.me.display_name} size={20} />
          </div>
        </div>
      </aside>
    </>
  );
}
