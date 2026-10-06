import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { api, ApiError, deviceId, openEventStream, type Config, type Conversation, type Online, type Project } from "./api";
import { Chat } from "./components/Chat";
import { Login } from "./components/Login";
import { MemoryView } from "./components/MemoryView";
import { ProjectView } from "./components/ProjectView";
import { SettingsView } from "./components/SettingsView";
import { Sidebar, type View } from "./components/Sidebar";
import { SkillsView } from "./components/SkillsView";
import { useCluster } from "./cluster/context";
import { SpaceView } from "./cluster/SpaceView";

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} },
};
const DEVICE = deviceId();

export default function App() {
  const cluster = useCluster();
  const P = cluster ? `fd:${cluster.space.id}:` : "fd:"; // своё «последнее место» для каждого пространства
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(store.get(P + "project"));
  const [project, setProject] = useState<Project | null>(null);
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(store.get(P + "conv"));
  const [view, setView] = useState<View>(() => (cluster?.takeInitialView() as View) || "chat");
  const [online, setOnline] = useState<Online[]>([]);
  const [menu, setMenu] = useState(false);
  const [toastMsg, setToastMsg] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [remote, setRemote] = useState<any>(null);
  const [memorySignal, setMemorySignal] = useState(0);
  const [skillSignal, setSkillSignal] = useState(0);
  const pidRef = useRef(projectId);
  pidRef.current = projectId;
  const created = useRef<Set<string>>(new Set());
  const cidRef = useRef(activeId);
  cidRef.current = activeId;

  const toast = useCallback((m: string) => {
    setToastMsg(m);
    setTimeout(() => setToastMsg(""), 3500);
  }, []);

  const unauth = (e: unknown) => {
    if (e instanceof ApiError && e.status === 401) setAuthed(false);
  };

  const loadProjects = useCallback(async (select?: string) => {
    try {
      const list = await api.projects();
      setProjects(list);
      setProjectId((cur) => {
        const want = select || cur;
        return want && list.some((p) => p.id === want) ? want : list[0]?.id || null;
      });
    } catch (e) { unauth(e); }
  }, []);

  const loadProject = useCallback(async () => {
    const pid = pidRef.current;
    if (!pid) return;
    try {
      const p = await api.project(pid);
      if (pidRef.current === pid) {
        setProject(p);
        setOnline(p.online || []);
      }
    } catch (e) { unauth(e); }
  }, []);

  const loadConvs = useCallback(async () => {
    const pid = pidRef.current;
    if (!pid) return;
    try {
      const list = await api.conversations(pid);
      if (pidRef.current === pid) {
        setConvs(list);
        // сохранённый чат из другого проекта или удалённый — сбрасываем
        setActiveId((cur) => (cur && !list.some((c) => c.id === cur) && !created.current.has(cur) ? null : cur));
      }
      setRefreshKey((k) => k + 1);
    } catch (e) { unauth(e); }
  }, []);

  const boot = useCallback(async () => {
    try {
      const cfg = await api.config();
      setConfig(cfg);
      setAuthed(true);
      await loadProjects();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setAuthed(false);
      else { setAuthed(false); toast("Сервер недоступен"); }
    }
  }, [loadProjects, toast]);

  useEffect(() => { boot(); }, [boot]);
  // ключи на устройстве изменились и доставлены в пространство — обновляем список доступных моделей
  useEffect(() => {
    if (cluster && authed) api.config().then(setConfig).catch(() => {});
  }, [cluster?.keysVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  // смена проекта
  useEffect(() => {
    store.set(P + "project", projectId);
    if (!projectId || !authed) return;
    setProject(null);
    setConvs([]);
    loadProject();
    loadConvs();
  }, [projectId, authed, loadProject, loadConvs]);

  useEffect(() => { store.set(P + "conv", activeId); }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // присутствие: сообщаем, где мы сейчас
  useEffect(() => {
    if (!authed || !projectId) return;
    const ping = () => api.presence(DEVICE, projectId, view === "chat" ? activeId : null)
      .then((r) => setOnline(r.online)).catch(() => {});
    ping();
    const t = setInterval(ping, 25000);
    return () => clearInterval(t);
  }, [authed, projectId, activeId, view]);

  // realtime: одна подписка на все события
  useEffect(() => {
    if (!authed) return;
    return openEventStream(DEVICE, (e) => {
      const here = e.project_id && e.project_id === pidRef.current;
      switch (e.type) {
        case "presence":
          if (here) setOnline(e.users_online);
          break;
        case "conversation":
        case "run.started":
        case "run.finished":
          if (here) { loadConvs(); setRemote(e); }
          if (e.type !== "conversation") loadProjects();
          break;
        case "model.proposal":
          if (here) setRemote(e);
          if (e.conversation_id !== cidRef.current) toast(`🔁 ${e.by} предлагает сменить модель чата`);
          break;
        case "run.approval":
          if (here) setRemote(e);
          if (e.conversation_id !== cidRef.current)
            toast(`⚠ ${e.by || "агент"}: нужно подтверждение «${e.title}»`);
          break;
        case "memory":
          if (here) setMemorySignal((x) => x + 1);
          break;
        case "skill":
          setSkillSignal((x) => x + 1);
          break;
        case "project":
          loadProjects();
          if (here) {
            if (e.action === "deleted") setProjectId(null);
            else loadProject();
          }
          break;
      }
    }, () => { loadProjects(); loadProject(); loadConvs(); setMemorySignal((x) => x + 1); });
  }, [authed, loadConvs, loadProject, loadProjects, toast]);

  if (authed === null) return null;
  if (!authed) {
    if (cluster) return <div className="login"><div className="notice error">Нет доступа к пространству. <button className="btn slim" onClick={boot}>повторить</button></div></div>;
    return <Login onDone={boot} />;
  }
  if (!config) return null;

  const common = { onMenu: () => setMenu(true), toast };
  const role = project?.my_role || "viewer";

  let main: ReactElement | null = null;
  if (view === "settings") {
    main = <SettingsView config={config} {...common} onMeChanged={async () => { await cluster?.refresh(); boot(); }}
      onLogout={async () => {
        if (cluster) return cluster.logout();
        await api.logout().catch(() => {});
        setAuthed(false);
      }} />;
  } else if (view === "space" && cluster) {
    main = <SpaceView onMenu={() => setMenu(true)} projects={projects} />;
  } else if (!project) {
    main = <div className="main"><div className="feed"><div className="page label pad">загрузка проекта…</div></div></div>;
  } else if (view === "memory") {
    main = <MemoryView project={project} signal={memorySignal} {...common} />;
  } else if (view === "skills") {
    main = <SkillsView config={config} project={project} signal={skillSignal} {...common} onProjectChanged={loadProject} />;
  } else if (view === "project") {
    main = <ProjectView config={config} project={project} projects={projects} {...common}
      onChanged={() => { loadProject(); loadProjects(); }}
      onDeleted={() => { setProjectId(null); loadProjects(); setView("chat"); }}
      onOpenChat={(cid) => { setActiveId(cid); setView("chat"); }} />;
  } else {
    main = <Chat projectId={project.id} projectName={project.name} role={role} online={online} remote={remote}
      conversationId={activeId}
      config={config} {...common}
      onCreated={(id) => { created.current.add(id); setActiveId(id); loadConvs(); }}
      onChanged={loadConvs} />;
  }

  return (
    <div className="shell">
      <Sidebar
        open={menu}
        onClose={() => setMenu(false)}
        config={config}
        projects={projects}
        project={project}
        onProject={(id) => { setProjectId(id); setActiveId(null); setView("chat"); setMenu(false); }}
        view={view}
        onView={(v) => { setView(v); setMenu(false); }}
        conversations={convs}
        activeId={activeId}
        online={online}
        refreshKey={refreshKey}
        toast={toast}
        onProjectsChanged={(sel) => { loadProjects(sel); if (sel) { setActiveId(null); setView("project"); setMenu(false); } }}
        onSelect={(id) => { setActiveId(id); setView("chat"); setMenu(false); }}
        onNew={() => { setActiveId(null); setView("chat"); setMenu(false); }}
        onDelete={async (id) => {
          await api.deleteConversation(id).catch((e) => toast(e.message));
          setActiveId(null);
          loadConvs();
        }}
      />
      {main}
      {toastMsg && <div className="toast">{toastMsg}</div>}
    </div>
  );
}
