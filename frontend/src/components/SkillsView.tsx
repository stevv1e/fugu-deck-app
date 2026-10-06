import { useEffect, useState } from "react";
import { api, type Config, type Project, type Skill } from "../api";
import { IconBolt, IconPlus } from "./icons";
import { Markdown } from "./Markdown";
import { ago, Seg, TopBar } from "./ui";

const TEMPLATE = `# Название скила

Когда применять: …

## Правила
- …

## Пример
\`\`\`
…
\`\`\`
`;

export function SkillsView(props: {
  config: Config;
  project: Project;
  signal: number;
  onMenu: () => void;
  toast: (m: string) => void;
  onProjectChanged: () => void;
}) {
  const isOwner = props.config.me.role === "owner";
  const [data, setData] = useState<{ writable: boolean; items: Skill[] } | null>(null);
  const [open, setOpen] = useState<string | "new" | null>(null);

  const load = () => api.skills().then(setData).catch((e) => props.toast(e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.signal]);

  const enabled = (name: string) => props.project.skills.includes("*") || props.project.skills.includes(name);
  const canToggle = props.project.my_role !== "viewer";

  const toggle = async (name: string) => {
    const all = data?.items.map((s) => s.name) || [];
    let next: string[];
    if (props.project.skills.includes("*")) next = all.filter((n) => n !== name);
    else if (enabled(name)) next = props.project.skills.filter((n) => n !== name);
    else next = [...props.project.skills, name];
    if (all.length && all.every((n) => next.includes(n))) next = ["*"];
    await api.updateProject(props.project.id, { skills: next }).catch((e) => props.toast(e.message));
    props.onProjectChanged();
  };

  if (open) {
    return (
      <SkillEditor
        name={open === "new" ? null : open}
        editable={isOwner && !!data?.writable}
        onBack={() => { setOpen(null); load(); }}
        onMenu={props.onMenu}
        toast={props.toast}
      />
    );
  }

  return (
    <div className="main">
      <TopBar onMenu={props.onMenu} title="Скилы" sub={`// папка skills/ · ${data?.items.length ?? "…"} шт.`}
        right={isOwner && data?.writable ? (
          <button className="btn primary slim" onClick={() => setOpen("new")}><IconPlus /> скил</button>
        ) : undefined} />
      <div className="feed">
        <div className="page">
          <p className="hint">
            Скилы — инструкции для агента в отдельной папке приложения (<span className="mono">skills/&lt;имя&gt;/SKILL.md</span>).
            Агент видит их список и загружает нужный, когда задача к нему относится. Переключатели включают скил
            для проекта <b>{props.project.name}</b>.
          </p>
          {data && !data.writable && (
            <div className="notice">// папка скилов подключена только для чтения — изменения через git</div>
          )}
          {data?.items.map((s) => (
            <div key={s.name} className={`card skill ${enabled(s.name) ? "" : "off"}`}>
              <button className="skill-main" onClick={() => setOpen(s.name)}>
                <span className="skill-ico"><IconBolt /></span>
                <span className="skill-txt">
                  <b className="mono">{s.name}</b>
                  <span>{s.description}</span>
                  <small>{ago(s.updated_at)}{s.files.length ? ` · +${s.files.length} файл.` : ""}</small>
                </span>
              </button>
              <label className="switch" title={enabled(s.name) ? "Включён в проекте" : "Выключен в проекте"}>
                <input type="checkbox" checked={enabled(s.name)} disabled={!canToggle} onChange={() => toggle(s.name)} />
                <i />
              </label>
            </div>
          ))}
          {data && !data.items.length && <div className="empty-note">Скилов пока нет.</div>}
        </div>
      </div>
    </div>
  );
}

function SkillEditor(props: {
  name: string | null;
  editable: boolean;
  onBack: () => void;
  onMenu: () => void;
  toast: (m: string) => void;
}) {
  const [name, setName] = useState(props.name || "");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState(props.name ? "" : TEMPLATE);
  const [mode, setMode] = useState<"edit" | "preview">(props.editable ? "edit" : "preview");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (props.name)
      api.skill(props.name).then((s) => { setDescription(s.description); setBody(s.body || ""); })
        .catch((e) => props.toast(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.name]);

  const save = async () => {
    setBusy(true);
    try {
      await api.saveSkill(name.trim(), description.trim(), body, props.name && props.name !== name ? props.name : undefined);
      props.toast("Скил сохранён");
      props.onBack();
    } catch (e: any) {
      props.toast(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="main">
      <TopBar onMenu={props.onMenu} onBack={props.onBack} title={props.name || "Новый скил"} sub="// SKILL.md"
        right={<Seg value={mode} onChange={setMode} options={[["edit", "текст"], ["preview", "вид"]]} />} />
      <div className="feed">
        <div className="page">
          {mode === "edit" && props.editable ? (
            <>
              <div className="field">
                <label className="label">имя (латиница, дефисы)</label>
                <input className="input" value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} placeholder="deploy-checklist" />
              </div>
              <div className="field">
                <label className="label">когда использовать — агент решает по этому описанию</label>
                <input className="input" value={description} onChange={(e) => setDescription(e.target.value)}
                  placeholder="Чеклист деплоя. Используй перед любым выкатом в прод." />
              </div>
              <div className="field">
                <label className="label">инструкция (markdown)</label>
                <textarea className="area code" rows={18} value={body} onChange={(e) => setBody(e.target.value)} />
              </div>
              <div className="row-end">
                {props.name && (
                  <button className="btn danger" onClick={async () => {
                    if (!confirm(`Удалить скил ${props.name}?`)) return;
                    await api.deleteSkill(props.name!).catch((e) => props.toast(e.message));
                    props.onBack();
                  }}>удалить</button>
                )}
                <button className="btn primary" disabled={busy || !name || !description.trim()} onClick={save}>сохранить</button>
              </div>
            </>
          ) : (
            <div className="card">
              <div className="label" style={{ marginBottom: 10 }}>{description}</div>
              <Markdown text={body || "_пусто_"} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
