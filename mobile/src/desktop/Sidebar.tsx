/**
 * Боковая панель компьютера — каркас веб-клиента v1: пространство, режим, проект, чаты, разделы.
 * Экраны те же, что на телефоне; панель только переходит между ними и держит список чатов под рукой.
 */
import { router, usePathname } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, Text, View, type StyleProp, type ViewStyle } from "react-native";

import type { DeckApi } from "@/core/api";
import { listSpaces, type SpaceSummary } from "@/core/teams";
import type { Conversation, Project } from "@/core/types";
import { prefs } from "@/platform/storage";
import { listClusters, parseSid, rememberSpaceTitle, spaceSid, spaceTitle, type ClusterRecord } from "@/state/cluster";
import { openClusterSession } from "@/state/clusterSession";
import { useServers } from "@/state/servers";
import { errText, Txt } from "@/ui/kit";
import { TALK_PROJECT, useMode, type Mode } from "@/ui/Modes";
import { alpha, MONO, useTheme } from "@/ui/theme";

import { placeOf } from "./place";

export const SIDEBAR_WIDTH = 300;

type SpaceItem = { sid: string; title: string; kind: "personal" | "team" | "server"; sub: string };

const LAST_SID = "fd.desk.sid";
const lastPid = (sid: string) => `fd.desk.pid.${sid}`;

function ago(ts?: number): string {
  if (!ts) return "";
  const s = Date.now() / 1000 - ts;
  if (s < 60) return "сейчас";
  if (s < 3600) return `${Math.floor(s / 60)} мин`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч`;
  return new Date(ts * 1000).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

const byRecent = (list: Conversation[]) => [...list].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));

/** Нажимаемая строка с подсветкой под мышью. */
function Hover({ onPress, style, children, label, active }: {
  onPress(): void; style?: StyleProp<ViewStyle>; children: ReactNode | ((hover: boolean) => ReactNode); label?: string; active?: boolean;
}) {
  const { p } = useTheme();
  const [hover, setHover] = useState(false);
  return (
    <Pressable onPress={onPress} onHoverIn={() => setHover(true)} onHoverOut={() => setHover(false)} accessibilityLabel={label}
      accessibilityRole="button" accessibilityState={{ selected: !!active }}
      style={[{ backgroundColor: active || hover ? p.panel : "transparent" }, style]}>
      {typeof children === "function" ? children(hover) : children}
    </Pressable>
  );
}

/** Выпадающий список под кнопкой (пространство, проект). */
function Picker({ icon, label, value, open, onToggle, children, tone }: {
  icon: ReactNode; label: string; value: string; open: boolean; onToggle(): void; children: ReactNode; tone?: string;
}) {
  const { p } = useTheme();
  const [hover, setHover] = useState(false);
  return (
    <View style={{ position: "relative", zIndex: open ? 20 : 1, marginHorizontal: 14, marginBottom: 8 }}>
      <Pressable onPress={onToggle} onHoverIn={() => setHover(true)} onHoverOut={() => setHover(false)} accessibilityRole="button"
        style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, paddingHorizontal: 12, backgroundColor: p.panel,
          borderWidth: 1, borderColor: hover || open ? p.accent : tone ? alpha(tone, 0.45) : p.line2, borderRadius: p.radius }}>
        {icon}
        <View style={{ flex: 1, gap: 3 }}>
          <Txt kind="label" style={{ fontSize: 9.5 }}>{label}</Txt>
          <Text numberOfLines={1} style={{ color: p.text, fontFamily: MONO, fontWeight: "600", fontSize: 13.5 }}>{value}</Text>
        </View>
        <Text style={{ color: p.dim, fontSize: 12 }}>{open ? "▴" : "▾"}</Text>
      </Pressable>
      {open ? (
        <View style={{ position: "absolute", top: "100%", left: 0, right: 0, marginTop: 4, backgroundColor: p.panel2, borderWidth: 1,
          borderColor: p.line2, borderRadius: p.radius, maxHeight: 360, overflow: "hidden",
          ...(Platform.OS === "web" ? ({ boxShadow: "0 16px 40px rgba(0,0,0,.5)" } as object) : {}) }}>
          <ScrollView>{children}</ScrollView>
        </View>
      ) : null}
    </View>
  );
}

function MenuItem({ title, sub, on, onPress, add, live }: { title: string; sub?: string; on?: boolean; onPress(): void; add?: boolean; live?: boolean }) {
  const { p } = useTheme();
  return (
    <Hover onPress={onPress} active={on} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10, paddingHorizontal: 12,
      borderBottomWidth: 1, borderBottomColor: p.line }}>
      <Text numberOfLines={1} style={add
        ? { flex: 1, color: p.accent, fontFamily: MONO, fontWeight: "600", fontSize: 11, letterSpacing: 1.1, textTransform: "uppercase" }
        : { flex: 1, color: on ? p.accent : p.text, fontSize: 13.5, fontFamily: p.monoText ? MONO : undefined }}>
        {title}
      </Text>
      {live ? <Live /> : null}
      {sub ? <Text style={{ color: p.faint, fontFamily: MONO, fontSize: 10.5 }}>{sub}</Text> : null}
    </Hover>
  );
}

function Live() {
  const { p } = useTheme();
  return <View style={{ width: 6, height: 6, backgroundColor: p.ok, ...(Platform.OS === "web" ? ({ boxShadow: `0 0 8px ${p.ok}` } as object) : {}) }} />;
}

function SpaceIcon({ kind }: { kind: SpaceItem["kind"] }) {
  const { p } = useTheme();
  const c = kind === "team" ? p.accent2 : p.accent;
  return (
    <View style={{ width: 22, height: 22, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: alpha(c, 0.45),
      backgroundColor: alpha(c, 0.12), borderRadius: p.radius ? 6 : 0 }}>
      <Text style={{ color: c, fontSize: 11 }}>{kind === "team" ? "👥" : kind === "server" ? "▣" : "◆"}</Text>
    </View>
  );
}

/** Плитка раздела внизу панели (как навигация v1). */
function Tile({ glyph, title, on, onPress }: { glyph: string; title: string; on: boolean; onPress(): void }) {
  const { p } = useTheme();
  const [hover, setHover] = useState(false);
  return (
    <Pressable onPress={onPress} onHoverIn={() => setHover(true)} onHoverOut={() => setHover(false)} accessibilityRole="button" accessibilityLabel={title}
      style={{ width: "25%", alignItems: "center", gap: 4, paddingVertical: 8, borderRightWidth: 1, borderBottomWidth: 1, borderColor: p.line,
        backgroundColor: on ? alpha(p.accent, 0.12) : hover ? p.panel : "transparent", borderBottomColor: on ? p.accent : p.line }}>
      <Text style={{ color: on ? p.accent : hover ? p.text : p.dim, fontSize: 16 }}>{glyph}</Text>
      <Text numberOfLines={1} style={{ color: on ? p.accent : p.dim, fontFamily: MONO, fontSize: 9, letterSpacing: 0.6, textTransform: "uppercase" }}>{title}</Text>
    </Pressable>
  );
}

export function Sidebar() {
  const { p } = useTheme();
  const path = usePathname();
  const place = useMemo(() => placeOf(path), [path]);
  const { servers, get, api: apiFor } = useServers();

  // ---- пространства: личное и общие в каждом кластере, одиночные серверы ----
  const [clusters, setClusters] = useState<ClusterRecord[]>([]);
  const [teams, setTeams] = useState<Record<string, SpaceSummary[]>>({});
  useEffect(() => {
    void listClusters().then((cs) => setClusters((old) => (JSON.stringify(old) === JSON.stringify(cs) ? old : cs)));
  }, [path]);
  const activeClusters = useMemo(() => clusters.filter((c) => c.status === "active"), [clusters]);
  useEffect(() => {
    let alive = true;
    for (const c of activeClusters) {
      openClusterSession(c, c.api).then((s) => listSpaces(s)).then((all) => {
        if (!alive) return;
        const ts = all.filter((x) => x.kind === "team");
        ts.forEach((t) => rememberSpaceTitle(spaceSid(c.id, t.id), t.title));
        setTeams((old) => ({ ...old, [c.id]: ts }));
      }, () => {});
    }
    return () => {
      alive = false;
    };
  }, [activeClusters]);

  const spaces: SpaceItem[] = useMemo(() => {
    const out: SpaceItem[] = [];
    for (const c of activeClusters) {
      const host = (() => {
        try {
          return new URL(c.api).host.replace(/^api\./, "");
        } catch {
          return c.name;
        }
      })();
      out.push({ sid: spaceSid(c.id), title: "Личное", kind: "personal", sub: host });
      for (const t of teams[c.id] ?? []) out.push({ sid: spaceSid(c.id, t.id), title: t.title, kind: "team", sub: host });
    }
    for (const s of servers) if (s.device) out.push({ sid: s.id, title: s.name, kind: "server", sub: "сервер" });
    return out;
  }, [activeClusters, teams, servers]);

  // ---- выбранное пространство: из адреса, иначе последнее открытое ----
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => {
    void prefs.get<string | null>(LAST_SID, null).then((v) => setChosen((c) => c ?? v));
  }, []);
  useEffect(() => {
    const s = place.sid;
    if (s) void prefs.set(LAST_SID, s).then(() => setChosen(s));
  }, [place.sid]);
  const sid = place.sid ?? chosen;
  const cur = spaces.find((s) => s.sid === sid) ?? null;
  const rec = sid ? get(sid) : undefined;
  const enrolled = !!rec?.device;
  const cluster = sid ? parseSid(sid) : null;

  // сессия пространства; состояние помечено пространством, чтобы при переключении не показать чужое
  const [conn, setConn] = useState<{ sid: string; api: DeckApi | null; err: string | null } | null>(null);
  useEffect(() => {
    if (!sid || !enrolled) return;
    let alive = true;
    apiFor(sid).then((a) => alive && setConn({ sid, api: a, err: null }), (e) => alive && setConn({ sid, api: null, err: errText(e) }));
    return () => {
      alive = false;
    };
  }, [sid, enrolled, apiFor]);
  const api = conn && conn.sid === sid ? conn.api : null;
  const apiErr = conn && conn.sid === sid ? conn.err : null;

  const [mode, setMode] = useMode(sid ?? "");

  // ---- проекты и выбранный проект: из адреса, иначе последний в этом пространстве, иначе «general» ----
  const [proj, setProj] = useState<{ api: DeckApi; list: Project[]; last: string | null } | null>(null);
  useEffect(() => {
    if (!api || !sid) return;
    let alive = true;
    Promise.all([api.projects(), prefs.get<string | null>(lastPid(sid), null)]).then(
      ([list, last]) => alive && setProj({ api, list, last }), () => {});
    return () => {
      alive = false;
    };
  }, [api, sid]);
  const projects = proj && proj.api === api ? proj.list : null;
  const [picked, setPicked] = useState<{ sid: string; pid: string } | null>(null);
  useEffect(() => {
    const id = place.pid;
    if (id && sid) void prefs.set(lastPid(sid), id).then(() => setPicked({ sid, pid: id }));
  }, [place.pid, sid]);
  const pid = place.pid ?? (picked && picked.sid === sid ? picked.pid : null)
    ?? (projects ? (projects.find((x) => x.id === proj?.last) ?? projects.find((x) => x.id === "general") ?? projects[0])?.id ?? null : null);
  const choosePid = (id: string) => {
    if (!sid) return;
    setPicked({ sid, pid: id });
    void prefs.set(lastPid(sid), id);
  };
  const project = projects?.find((x) => x.id === pid) ?? null;

  // ---- чаты: проекта или режима «Общение»; обновляются при переходах и раз в 15 с ----
  const listPid = mode === "talk" ? TALK_PROJECT : pid;
  const listKey = `${sid}|${listPid}`;
  const [convState, setConvState] = useState<{ key: string; list: Conversation[] } | null>(null);
  // временная ошибка сети — оставляем прежний список
  const loadConvs = useCallback(() => {
    if (!api || !listPid) return;
    api.conversations(listPid).then(
      (list) => setConvState({ key: listKey, list: byRecent(list) }), () => {});
  }, [api, listPid, listKey]);
  const convs = convState && convState.key === listKey ? convState.list : null;
  useEffect(() => {
    if (!api || !listPid) return;
    let alive = true;
    api.conversations(listPid).then(
      (list) => alive && setConvState({ key: listKey, list: byRecent(list) }), () => {});
    return () => {
      alive = false;
    };
  }, [api, listPid, listKey, path]);
  // пока открыт чат — чаще: название нового чата появляется после первого ответа
  const openChat = !!place.chat;
  useEffect(() => {
    const t = setInterval(loadConvs, openChat ? 5000 : 15000);
    return () => clearInterval(t);
  }, [loadConvs, openChat]);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const newChat = useCallback(async () => {
    if (!api || !sid || !listPid || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const c = await api.createConversation(listPid);
      loadConvs();
      router.push(`/s/${sid}/c/${c.id}`);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }, [api, sid, listPid, busy, loadConvs]);

  // Ctrl+N — новый чат (как в настольных мессенджерах)
  const newRef = useRef(newChat);
  useEffect(() => {
    newRef.current = newChat;
  }, [newChat]);
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        void newRef.current();
      }
    };
    // перехват: поле ввода react-native-web не пускает нажатия дальше себя
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const [armed, setArmed] = useState<string | null>(null); // чат, для которого нажали «удалить»
  const remove = async (c: Conversation) => {
    if (!api) return;
    try {
      await api.deleteConversation(c.id);
      setArmed(null);
      if (place.chat === c.id && sid) router.replace(`/s/${sid}`);
      loadConvs();
    } catch (e) {
      setErr(errText(e));
    }
  };

  // открытый список закрывается при любом переходе
  const [menuAt, setMenuAt] = useState<{ m: "space" | "project"; path: string } | null>(null);
  const menu = menuAt && menuAt.path === path ? menuAt.m : null;
  const setMenu = (m: "space" | "project" | null) => setMenuAt(m ? { m, path } : null);

  const go = (to: string) => router.push(to as never);
  const pickSpace = (s: SpaceItem) => {
    setMenu(null);
    setChosen(s.sid);
    void prefs.set(LAST_SID, s.sid);
    go(get(s.sid)?.device ? `/s/${s.sid}` : `/s/${s.sid}/login`);
  };

  const tiles: { glyph: string; title: string; to: string; on: boolean }[] = [];
  if (sid && enrolled) {
    if (mode === "eng" && pid) {
      tiles.push({ glyph: "◎", title: "знания", to: `/s/${sid}/kb/${pid}`, on: place.section === "kb" });
      tiles.push({ glyph: "◷", title: "график", to: `/s/${sid}/sched/${pid}`, on: place.section === "sched" });
      tiles.push({ glyph: "▤", title: "проект", to: `/s/${sid}/p/${pid}`, on: place.section === "p" });
    }
    tiles.push({ glyph: "◈", title: "агенты", to: `/s/${sid}/prefs`, on: place.section === "prefs" });
    tiles.push({ glyph: "ϟ", title: "скилы", to: `/s/${sid}/skills`, on: place.section === "skills" });
    tiles.push({ glyph: "$", title: "расходы", to: `/s/${sid}/usage`, on: place.section === "usage" });
    if (cluster?.team) tiles.push({ glyph: "👥", title: "участники", to: `/team/${sid}`, on: place.section === "team" });
    if (cluster) tiles.push({ glyph: "◆", title: "кластер", to: `/cluster/${cluster.cluster}`, on: !!place.cluster });
    else tiles.push({ glyph: "▣", title: "сервер", to: `/s/${sid}/settings`, on: !!place.sid && place.section === "settings" });
  }

  const title = cur?.title ?? (sid ? spaceTitle(sid) ?? rec?.name : null) ?? "выберите";
  const me = rec?.device?.user;

  return (
    <View style={{ width: SIDEBAR_WIDTH, height: "100%", backgroundColor: p.bg2, borderRightWidth: 1, borderRightColor: p.line }}>
      {/* шапка */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingTop: 14, paddingBottom: 12 }}>
        <Pressable onPress={() => go("/")} accessibilityLabel="Серверы и кластеры" style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View style={{ width: 22, height: 22, borderWidth: 2, borderColor: p.accent, transform: [{ rotate: "45deg" }], borderRadius: p.radius ? 4 : 0 }} />
          <Text style={{ color: p.text, fontFamily: MONO, fontWeight: "700", fontSize: 15 }}>
            FUGU<Text style={{ color: p.accent }}>/</Text>DECK
          </Text>
        </Pressable>
        <Hover onPress={() => go("/settings")} label="Настройки приложения" active={place.section === "settings" && !place.sid}
          style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: p.line2, borderRadius: p.radius }}>
          <Text style={{ color: p.dim, fontSize: 16 }}>⚙</Text>
        </Hover>
      </View>

      {spaces.length === 0 ? (
        <View style={{ marginHorizontal: 14, gap: 10 }}>
          <Txt kind="dim">Подключите кластер по приглашению или одиночный сервер по адресу.</Txt>
          <MenuItem add title="＋ подключить" onPress={() => go("/add")} />
        </View>
      ) : (
        <>
          <Picker icon={<SpaceIcon kind={cur?.kind ?? "personal"} />} label="пространство" value={cur ? `${cur.title}` : title}
            open={menu === "space"} onToggle={() => setMenu(menu === "space" ? null : "space")} tone={cur?.kind === "team" ? p.accent2 : p.accent}>
            {spaces.map((s) => (
              <MenuItem key={s.sid} title={s.title} sub={s.sub} on={s.sid === sid} onPress={() => pickSpace(s)} />
            ))}
            {activeClusters.length ? (
              <MenuItem add title="＋ общее пространство" onPress={() => go(`/teams/${activeClusters[0].id}`)} />
            ) : null}
            <MenuItem add title="＋ подключить сервер" onPress={() => go("/add")} />
          </Picker>

          {sid && enrolled ? (
            <View style={{ flexDirection: "row", marginHorizontal: 14, marginBottom: 8, padding: 3, gap: 3, borderWidth: 1, borderColor: p.line2,
              borderRadius: p.radius, backgroundColor: p.bg }}>
              {(["eng", "talk"] as Mode[]).map((m) => (
                <Pressable key={m} onPress={() => setMode(m)} accessibilityRole="button" accessibilityState={{ selected: mode === m }}
                  style={{ flex: 1, paddingVertical: 6, alignItems: "center", backgroundColor: mode === m ? p.accent : "transparent", borderRadius: p.radius }}>
                  <Text style={{ fontFamily: MONO, fontSize: 10.5, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase",
                    color: mode === m ? p.onAccent : p.dim }}>{m === "eng" ? "инжиниринг" : "общение"}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          {sid && enrolled && mode === "eng" ? (
            <Picker icon={<View style={{ width: 10, height: 10, backgroundColor: p.accent2 }} />} label="проект" value={project?.name ?? "…"}
              open={menu === "project"} onToggle={() => setMenu(menu === "project" ? null : "project")}>
              {(projects ?? []).map((x) => (
                <MenuItem key={x.id} title={x.name} sub={String(x.conversations ?? "")} live={!!x.running} on={x.id === pid}
                  onPress={() => { choosePid(x.id); setMenu(null); }} />
              ))}
              <MenuItem add title="＋ новый проект" onPress={() => go(`/s/${sid}`)} />
            </Picker>
          ) : null}
        </>
      )}

      {sid && !enrolled && cur ? (
        <View style={{ marginHorizontal: 14, gap: 8 }}>
          <Txt kind="dim">Это устройство ещё не вошло в пространство.</Txt>
          <MenuItem add title="войти" onPress={() => go(`/s/${sid}/login`)} />
        </View>
      ) : null}

      {/* чаты */}
      {sid && enrolled ? (
        <>
          <Pressable onPress={newChat} disabled={busy || !listPid} accessibilityRole="button" accessibilityLabel="Новый чат (Ctrl+N)"
            style={({ pressed }) => ({ marginHorizontal: 14, marginTop: 2, marginBottom: 8, paddingVertical: 9, alignItems: "center",
              flexDirection: "row", justifyContent: "center", gap: 8, backgroundColor: p.accent, borderRadius: p.radius, opacity: busy ? 0.6 : pressed ? 0.8 : 1 })}>
            <Text style={{ color: p.onAccent, fontFamily: MONO, fontWeight: "700", fontSize: 12, letterSpacing: 1.2, textTransform: "uppercase" }}>
              ＋ новый чат
            </Text>
            <Text style={{ color: alpha(p.onAccent, 0.6), fontFamily: MONO, fontSize: 10 }}>Ctrl+N</Text>
          </Pressable>
          {err || apiErr ? (
            <Text style={{ color: p.accent2, fontSize: 12, marginHorizontal: 14, marginBottom: 6 }} numberOfLines={3}>{err || apiErr}</Text>
          ) : null}
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 8, paddingVertical: 2 }}>
            {convs === null ? <Txt kind="small" style={{ padding: 10 }}>загрузка…</Txt> : null}
            {convs?.length === 0 ? <Txt kind="small" style={{ padding: 10 }}>Чатов пока нет.</Txt> : null}
            {convs?.map((c) => {
              const on = place.chat === c.id;
              return (
                <Hover key={c.id} onPress={() => { setArmed(null); go(`/s/${sid}/c/${c.id}`); }} active={on} label={c.title || "Чат"}
                  style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 9, paddingLeft: 10, paddingRight: 6, marginBottom: 2,
                    borderLeftWidth: 2, borderLeftColor: on ? p.accent : "transparent" }}>
                  {(hover) => (
                    <>
                      {c.running ? <Live /> : null}
                      <Text numberOfLines={1} style={{ flex: 1, color: on ? p.text : alpha(p.text, 0.85), fontSize: 13.5, fontFamily: p.monoText ? MONO : undefined }}>
                        {c.title || "Новый чат"}
                      </Text>
                      {armed === c.id ? (
                        <Pressable onPress={() => void remove(c)} accessibilityLabel="Подтвердить удаление" hitSlop={6}>
                          <Text style={{ color: p.accent2, fontFamily: MONO, fontSize: 10.5, fontWeight: "700" }}>УДАЛИТЬ?</Text>
                        </Pressable>
                      ) : hover ? (
                        <Pressable onPress={() => setArmed(c.id)} accessibilityLabel={`Удалить чат ${c.title}`} hitSlop={6}>
                          <Text style={{ color: p.faint, fontSize: 13 }}>✕</Text>
                        </Pressable>
                      ) : (
                        <Text style={{ color: p.faint, fontFamily: MONO, fontSize: 10.5 }}>{ago(c.updated_at)}</Text>
                      )}
                    </>
                  )}
                </Hover>
              );
            })}
          </ScrollView>
        </>
      ) : (
        <View style={{ flex: 1 }} />
      )}

      {/* разделы */}
      {tiles.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", marginHorizontal: 14, marginTop: 8, borderLeftWidth: 1, borderTopWidth: 1, borderColor: p.line }}>
          {tiles.map((t) => <Tile key={t.title} glyph={t.glyph} title={t.title} on={t.on} onPress={() => go(t.to)} />)}
        </View>
      ) : null}

      {/* подвал */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, borderTopWidth: 1, borderTopColor: p.line, marginTop: 12, paddingHorizontal: 14, paddingVertical: 10 }}>
        <View style={{ width: 6, height: 6, backgroundColor: me ? p.ok : p.faint }} />
        <Text numberOfLines={1} style={{ flex: 1, color: p.dim, fontFamily: MONO, fontSize: 11.5 }}>
          {me ? me.display_name || me.username : "не выполнен вход"}
        </Text>
        <Text style={{ color: p.faint, fontFamily: MONO, fontSize: 10.5 }}>{rec?.device?.keyStorage === "tpm" ? "TPM" : enrolled ? "ключи" : ""}</Text>
      </View>
    </View>
  );
}
