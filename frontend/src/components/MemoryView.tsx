import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Memory, type Project } from "../api";
import { IconEdit, IconPin, IconSearch, IconTrash } from "./icons";
import { ago, Avatar, TopBar } from "./ui";

export function MemoryView(props: {
  project: Project;
  signal: number;
  onMenu: () => void;
  toast: (m: string) => void;
}) {
  const { project } = props;
  const canEdit = project.my_role !== "viewer";
  const [items, setItems] = useState<Memory[] | null>(null);
  const [q, setQ] = useState("");
  const [linked, setLinked] = useState(true);
  const [draft, setDraft] = useState("");
  const [tags, setTags] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const seen = useRef<Set<number>>(new Set());
  const [fresh, setFresh] = useState<Set<number>>(new Set());

  const load = async () => {
    try {
      const rows = await api.memory(project.id, q, linked);
      if (seen.current.size) {
        const nw = new Set(rows.filter((r) => !seen.current.has(r.id)).map((r) => r.id));
        if (nw.size) {
          setFresh(nw);
          setTimeout(() => setFresh(new Set()), 2500);
        }
      }
      rows.forEach((r) => seen.current.add(r.id));
      setItems(rows);
    } catch (e: any) {
      props.toast(e.message);
    }
  };

  useEffect(() => {
    seen.current = new Set();
    setItems(null);
  }, [project.id]);

  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, q, linked, props.signal]);

  const own = useMemo(() => (items || []).filter((m) => m.project_id === project.id), [items, project.id]);
  const foreign = useMemo(() => (items || []).filter((m) => m.project_id !== project.id), [items, project.id]);

  const add = async () => {
    if (!draft.trim()) return;
    try {
      await api.addMemory(project.id, draft.trim(), tags.trim());
      setDraft("");
      setTags("");
      load();
    } catch (e: any) {
      props.toast(e.message);
    }
  };

  const card = (m: Memory, ro?: boolean) => (
    <div key={m.id} className={`card mem ${m.pinned ? "pinned" : ""} ${fresh.has(m.id) ? "fresh" : ""}`}>
      {editing === m.id ? (
        <>
          <textarea className="area" rows={4} value={editText} onChange={(e) => setEditText(e.target.value)} autoFocus />
          <div className="row-end">
            <button className="btn ghost" onClick={() => setEditing(null)}>отмена</button>
            <button className="btn primary" onClick={async () => {
              await api.updateMemory(m.id, { content: editText }).catch((e) => props.toast(e.message));
              setEditing(null);
              load();
            }}>сохранить</button>
          </div>
        </>
      ) : (
        <>
          <div className="mem-text">{m.content}</div>
          <div className="mem-meta">
            {m.source === "agent" ? <span className="chip accent">⌬ агент</span> : m.author && <><Avatar name={m.author} size={16} /> <span>{m.author}</span></>}
            {ro && <span className="chip">{m.project_name} · только чтение</span>}
            {m.tags && m.tags.split(",").filter(Boolean).map((t) => <span className="chip" key={t}>#{t.trim()}</span>)}
            <span className="when">{ago(m.updated_at)}</span>
            {!ro && canEdit && (
              <span className="mem-actions">
                <button className={`icon-btn sm ${m.pinned ? "on" : ""}`} title="Закрепить (всегда в контексте агента)"
                  onClick={() => api.updateMemory(m.id, { pinned: !m.pinned }).then(load)}><IconPin /></button>
                <button className="icon-btn sm" title="Изменить" onClick={() => { setEditing(m.id); setEditText(m.content); }}><IconEdit /></button>
                <button className="icon-btn sm" title="Удалить"
                  onClick={() => confirm("Удалить запись из памяти?") && api.deleteMemory(m.id).then(load)}><IconTrash /></button>
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );

  return (
    <div className="main">
      <TopBar onMenu={props.onMenu} title={`Память · ${project.name}`}
        sub={`// ${own.length} записей${project.memory_sources?.length ? ` · +${project.memory_sources.length} связ.` : ""}`} />
      <div className="feed">
        <div className="page">
          <div className="searchbar">
            <IconSearch />
            <input placeholder="поиск по памяти…" value={q} onChange={(e) => setQ(e.target.value)} />
            {!!project.memory_sources?.length && (
              <label className="toggle">
                <input type="checkbox" checked={linked} onChange={(e) => setLinked(e.target.checked)} />
                <span>связанные</span>
              </label>
            )}
          </div>

          {canEdit && !q && (
            <div className="card composer-card">
              <textarea className="area" rows={2} placeholder="Добавить факт, решение или договорённость…"
                value={draft} onChange={(e) => setDraft(e.target.value)} />
              <div className="row-end">
                <input className="input slim" placeholder="теги через запятую" value={tags} onChange={(e) => setTags(e.target.value)} />
                <button className="btn primary" disabled={!draft.trim()} onClick={add}>запомнить</button>
              </div>
            </div>
          )}

          {items === null && <div className="label pad">загрузка…</div>}
          {items && !own.length && !foreign.length && (
            <div className="empty-note">
              {q ? "ничего не найдено" : "Память пуста. Агент будет сохранять сюда важные решения сам, а вы можете добавлять вручную."}
            </div>
          )}
          {own.map((m) => card(m))}
          {!!foreign.length && <div className="label pad">// из связанных проектов</div>}
          {foreign.map((m) => card(m, true))}
        </div>
      </div>
    </div>
  );
}
