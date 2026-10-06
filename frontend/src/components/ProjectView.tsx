import { useEffect, useState } from "react";
import { api, type Config, type Project, type Role, type UserRow } from "../api";
import { Avatar, ROLE_LABEL, Section, TopBar } from "./ui";
import { useCluster } from "../cluster/context";

export function ProjectView(props: {
  config: Config;
  project: Project;
  projects: Project[];
  onMenu: () => void;
  toast: (m: string) => void;
  onChanged: () => void;
  onDeleted: () => void;
  onOpenChat: (cid: string) => void;
}) {
  const { project } = props;
  const cluster = useCluster();
  const role = project.my_role;
  const isOwner = role === "owner";
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [instructions, setInstructions] = useState(project.instructions);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setName(project.name);
    setDescription(project.description);
    setInstructions(project.instructions);
    setDirty(false);
  }, [project.id, project.name, project.description, project.instructions]);

  useEffect(() => {
    if (isOwner && !cluster) api.users().then(setUsers).catch(() => {});
  }, [isOwner, project.id]);

  const save = async () => {
    try {
      await api.updateProject(project.id, isOwner ? { name, description, instructions } : { instructions });
      setDirty(false);
      props.toast("Сохранено");
      props.onChanged();
    } catch (e: any) {
      props.toast(e.message);
    }
  };

  const sources = new Set((project.memory_sources || []).map((s) => s.id));
  const toggleSource = async (id: string) => {
    const next = new Set(sources);
    next.has(id) ? next.delete(id) : next.add(id);
    await api.setMemorySources(project.id, [...next]).catch((e) => props.toast(e.message));
    props.onChanged();
  };

  const members = project.members || [];
  const nonMembers = users.filter((u) => u.role !== "owner" && !members.some((m) => m.id === u.id) && !u.disabled);
  const running = Array.isArray(project.running) ? project.running : [];

  return (
    <div className="main">
      <TopBar onMenu={props.onMenu} title={`Проект · ${project.name}`} sub={`// вы: ${ROLE_LABEL[role]}`} />
      <div className="feed">
        <div className="page">
          {!!running.length && (
            <Section title="Сейчас работают агенты">
              {running.map((r: any) => (
                <button key={r.run_id} className="card run-row" onClick={() => props.onOpenChat(r.conversation_id)}>
                  <span className="bars"><i /><i /><i /><i /></span>
                  <span>чат запущен: {r.user}</span>
                  <span className="chev">›</span>
                </button>
              ))}
            </Section>
          )}

          <Section title="Основное">
            <div className="field">
              <label className="label">название</label>
              <input className="input" value={name} disabled={!isOwner} onChange={(e) => { setName(e.target.value); setDirty(true); }} />
            </div>
            <div className="field">
              <label className="label">описание</label>
              <input className="input" value={description} disabled={!isOwner} onChange={(e) => { setDescription(e.target.value); setDirty(true); }} />
            </div>
            <div className="field">
              <label className="label">инструкции для агента в этом проекте</label>
              <textarea className="area" rows={7} value={instructions} disabled={role === "viewer"}
                placeholder={"Например:\n- Основной репозиторий: github me/shop\n- Стек: FastAPI + Postgres\n- PR всегда в ветку develop"}
                onChange={(e) => { setInstructions(e.target.value); setDirty(true); }} />
            </div>
            {role !== "viewer" && (
              <div className="row-end">
                <button className="btn primary" disabled={!dirty} onClick={save}>сохранить</button>
              </div>
            )}
          </Section>

          <Section title="Доступ к памяти других проектов"
            hint="Агент этого проекта сможет искать в памяти выбранных проектов. Только чтение: изменить чужую память он не может.">
            <div className="checks">
              {props.projects.filter((p) => p.id !== project.id).map((p) => (
                <label key={p.id} className="check">
                  <input type="checkbox" checked={sources.has(p.id)} disabled={!isOwner} onChange={() => toggleSource(p.id)} />
                  <span>{p.name}</span>
                  <small>{p.memories ?? 0} записей</small>
                </label>
              ))}
              {props.projects.length < 2 && <div className="empty-note">Других проектов пока нет.</div>}
            </div>
          </Section>

          {!cluster && <Section title="Участники" hint="Все участники видят чаты и память проекта в реальном времени. Редакторы могут запускать агента и подтверждать действия.">
            <div className="members">
              <div className="member">
                <Avatar name={props.config.me.role === "owner" ? props.config.me.display_name : "owner"} />
                <span className="grow">владелец сервера</span>
                <span className="chip">все права</span>
              </div>
              {members.map((m) => (
                <div className="member" key={m.id}>
                  <Avatar name={m.display_name} />
                  <span className="grow">{m.display_name} <small className="dim">@{m.username}</small></span>
                  {isOwner ? (
                    <select className="input slim" value={m.role} onChange={async (e) => {
                      const v = e.target.value as Role | "remove";
                      await api.setMember(project.id, m.id, v === "remove" ? null : v).catch((er) => props.toast(er.message));
                      props.onChanged();
                    }}>
                      <option value="viewer">читатель</option>
                      <option value="editor">редактор</option>
                      <option value="owner">владелец</option>
                      <option value="remove">— убрать</option>
                    </select>
                  ) : <span className="chip">{ROLE_LABEL[m.role]}</span>}
                </div>
              ))}
              {isOwner && !!nonMembers.length && (
                <select className="input slim" value="" onChange={async (e) => {
                  if (!e.target.value) return;
                  await api.setMember(project.id, e.target.value, "editor").catch((er) => props.toast(er.message));
                  props.onChanged();
                }}>
                  <option value="">+ добавить участника…</option>
                  {nonMembers.map((u) => <option key={u.id} value={u.id}>{u.display_name} (@{u.username})</option>)}
                </select>
              )}
              {isOwner && !users.some((u) => u.role !== "owner") && props.config.me.role === "owner" && (
                <p className="hint">Создайте пользователей в «Настройки → Пользователи», чтобы пригласить их в проект.</p>
              )}
            </div>
          </Section>}

          {isOwner && project.id !== "general" && (
            <Section title="Опасная зона">
              <button className="btn danger" onClick={async () => {
                if (!confirm(`Удалить проект «${project.name}» со всеми чатами и памятью?`)) return;
                await api.deleteProject(project.id).catch((e) => props.toast(e.message));
                props.onDeleted();
              }}>удалить проект</button>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}
