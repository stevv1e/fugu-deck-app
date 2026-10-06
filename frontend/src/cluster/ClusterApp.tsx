import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, configureApi } from "../api";
import App from "../App";
import { cp, cpEvents, dropTokens, spaceTokenFn, type MeResp } from "../cp";
import { vault } from "../vault";
import { Cluster, type ClusterCtx } from "./context";
import { setPendingPrf } from "./prf";
import { Unlock } from "./Unlock";
import { Welcome } from "./Welcome";

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} },
};

export default function ClusterApp() {
  const [phase, setPhase] = useState<"loading" | "welcome" | "unlock" | "ready">("loading");
  const [me, setMe] = useState<MeResp | null>(null);
  const [spaceId, setSpaceId] = useState<string | null>(store.get("fd:space"));
  const [keysVersion, setKeysVersion] = useState(0);
  const [toastMsg, setToastMsg] = useState("");
  const [skipped, setSkipped] = useState(false);

  const toast = useCallback((m: string) => {
    setToastMsg(m);
    setTimeout(() => setToastMsg(""), 3800);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setMe(await cp.me());
    } catch (e: any) {
      if (e.status === 401) setPhase("welcome");
    }
  }, []);

  const afterAuth = useCallback(async () => {
    try {
      const m = await cp.me();
      setMe(m);
      setPhase(vault.exists() && !vault.unlocked() && !skipped ? "unlock" : "ready");
    } catch {
      setPhase("welcome");
    }
  }, [skipped]);

  useEffect(() => { afterAuth(); /* eslint-disable-next-line */ }, []);
  useEffect(() => vault.subscribe(() => setKeysVersion((v) => v + 1)) as any, []);

  const space = useMemo(() => {
    if (!me) return null;
    return me.spaces.find((s) => s.id === spaceId) || me.spaces.find((s) => s.kind === "personal") || me.spaces[0] || null;
  }, [me, spaceId]);

  // API текущего пространства настраиваем до рендера App
  useMemo(() => {
    if (space) configureApi(space.base, spaceTokenFn(space.id));
  }, [space?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const pushKeys = useCallback(async () => {
    if (!space || !vault.unlocked()) return;
    try {
      await api.pushKeys(vault.keys()); // только в RAM пространства
    } catch {}
  }, [space?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const [keysPushed, setKeysPushed] = useState<string>("");
  const [pushedCount, setPushedCount] = useState(0);
  useEffect(() => {
    if (phase !== "ready" || !space) return;
    let alive = true;
    pushKeys().then(() => {
      if (!alive) return;
      setKeysPushed(`${space.id}:${keysVersion}`);
      setPushedCount((n) => n + 1); // App перечитает конфиг: какие модели теперь доступны
    });
    const t = setInterval(pushKeys, 10 * 60 * 1000);
    const onVis = () => document.visibilityState === "visible" && pushKeys();
    document.addEventListener("visibilitychange", onVis);
    return () => { alive = false; clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, [phase, space?.id, keysVersion, pushKeys]); // eslint-disable-line react-hooks/exhaustive-deps

  // личные уведомления control-plane
  useEffect(() => {
    if (phase !== "ready") return;
    return cpEvents((e) => {
      if (e.type === "invite") toast(`📨 ${e.from} приглашает в «${e.space_name}»`);
      if (e.type === "removed") {
        toast(`Вас удалили из «${e.space_name}»`);
        if (e.space_id === store.get("fd:space")) setSpaceId(null);
      }
      if (e.type === "notification" && e.kind === "inactivity") toast(`⚠ Через ${e.hours_left} ч неактивности данные будут удалены`);
      refresh();
    });
  }, [phase, refresh, toast]);

  const initialView = useRef<string | null>(null);
  const switchSpace = useCallback((id: string, view?: string) => {
    initialView.current = view || null;
    store.set("fd:space", id);
    setSpaceId(id);
  }, []);

  const logout = useCallback(async () => {
    try { await api.wipeKeys(); } catch {}
    await cp.logout().catch(() => {});
    vault.lock();
    dropTokens();
    setMe(null);
    setPhase("welcome");
  }, []);

  if (phase === "loading") return null;
  if (phase === "welcome")
    return (
      <Welcome onDone={async (r) => {
        setPendingPrf(r.prf);
        if (r.prf && vault.method() === "prf") await vault.unlockWithPrf(r.prf);
        await afterAuth();
      }} />
    );
  if (phase === "unlock")
    return <Unlock onDone={() => setPhase("ready")} onSkip={() => { setSkipped(true); setPhase("ready"); }} />;
  if (!me || !space) return <div className="login"><div className="label">нет доступных пространств…</div></div>;

  const ctx: ClusterCtx & { purgeHours: number } = {
    user: me.user, spaces: me.spaces, space, invites: me.invites, switchSpace, refresh, logout,
    takeInitialView: () => { const v = initialView.current; initialView.current = null; return v; },
    keysVersion: pushedCount, pushKeys, requestUnlock: () => setPhase("unlock"), toast, purgeHours: me.purge_after_hours,
  };

  return (
    <Cluster.Provider value={ctx}>
      {keysPushed.startsWith(`${space.id}:`) || !vault.unlocked() ? (
        <App key={space.id} />
      ) : (
        <div className="login"><div className="label">подключение к пространству…</div></div>
      )}
      {toastMsg && <div className="toast">{toastMsg}</div>}
    </Cluster.Provider>
  );
}
