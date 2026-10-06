/** Клиент control-plane: вход, пространства, приглашения, пропуска в пространства. */
import { ApiError } from "./api";

export type CpUser = { id: string; nick: string; display_name: string; is_admin: boolean };
export type SpaceRole = "viewer" | "editor" | "owner";
export type Space = {
  id: string; kind: "personal" | "team"; name: string; role: SpaceRole; members: number; status: string; base: string;
};
export type Invite = { id: string; space_id: string; space_name: string; from_nick: string; from_name: string; role: SpaceRole };
export type SpaceFull = Space & {
  members_list: { id: string; nick: string; display_name: string; role: SpaceRole }[];
  pending?: { id: string; role: SpaceRole; nick: string; display_name: string }[];
};
export type MeResp = { user: CpUser; spaces: Space[]; invites: Invite[]; notifications: any[]; purge_after_hours: number };

async function cpReq<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(`/cp/api${url}`, {
    method, credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let msg = r.statusText;
    try {
      const j = await r.json();
      msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j);
    } catch {}
    throw new ApiError(r.status, msg);
  }
  return r.json();
}

export const cp = {
  async detect(): Promise<{ rp_id: string; bootstrap: boolean; test_mode: boolean } | null> {
    try {
      const r = await fetch("/cp/api/info", { credentials: "same-origin" });
      if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) return null;
      return await r.json();
    } catch {
      return null;
    }
  },
  me: () => cpReq<MeResp>("GET", "/me"),
  patchMe: (display_name: string) => cpReq("PATCH", "/me", { display_name }),
  registerOptions: (invite_code: string, nick: string, display_name: string) =>
    cpReq<{ session_id: string; options: any }>("POST", "/register/options", { invite_code, nick, display_name }),
  registerVerify: (session_id: string, credential: any) =>
    cpReq<{ user: CpUser; personal_space: string }>("POST", "/register/verify", { session_id, credential }),
  loginOptions: () => cpReq<{ session_id: string; options: any }>("POST", "/login/options"),
  loginVerify: (session_id: string, credential: any) => cpReq<{ user: CpUser }>("POST", "/login/verify", { session_id, credential }),
  logout: () => cpReq("POST", "/logout"),
  token: (sid: string) => cpReq<{ token: string; expires_in: number; base: string; role: SpaceRole }>("POST", `/spaces/${sid}/token`),
  createTeam: (name: string) => cpReq<Space>("POST", "/spaces", { name }),
  space: (sid: string) => cpReq<SpaceFull>("GET", `/spaces/${sid}`),
  renameSpace: (sid: string, name: string) => cpReq("PATCH", `/spaces/${sid}`, { name }),
  deleteSpace: (sid: string) => cpReq("DELETE", `/spaces/${sid}`),
  search: (q: string) => cpReq<{ id: string; nick: string; display_name: string }[]>("GET", `/users/search?q=${encodeURIComponent(q)}`),
  invite: (sid: string, nick: string, role: SpaceRole) => cpReq("POST", `/spaces/${sid}/invites`, { nick, role }),
  cancelInvite: (sid: string, iid: string) => cpReq("DELETE", `/spaces/${sid}/invites/${iid}`),
  answer: (iid: string, accept: boolean) =>
    cpReq<{ ok: boolean; space_id: string | null }>("POST", `/invites/${iid}/${accept ? "accept" : "decline"}`),
  setRole: (sid: string, uid: string, role: SpaceRole) => cpReq("PATCH", `/spaces/${sid}/members/${uid}`, { role }),
  removeMember: (sid: string, uid: string) => cpReq("DELETE", `/spaces/${sid}/members/${uid}`),
  newCode: () => cpReq<{ code: string }>("POST", "/admin/codes"),
  codes: () => cpReq<any[]>("GET", "/admin/codes"),
  readNotifications: () => cpReq("POST", "/notifications/read"),
};

/** Кэш коротких пропусков в пространства: обновляется заранее, до истечения. */
const tokens = new Map<string, { token: string; exp: number }>();
export function spaceTokenFn(sid: string) {
  return async (force = false): Promise<string | null> => {
    const c = tokens.get(sid);
    if (!force && c && c.exp - Date.now() > 60_000) return c.token;
    const t = await cp.token(sid);
    tokens.set(sid, { token: t.token, exp: Date.now() + t.expires_in * 1000 });
    return t.token;
  };
}
export function dropTokens() {
  tokens.clear();
}

/** Личный поток уведомлений control-plane (приглашения, удаление из проекта, 72 ч). */
export function cpEvents(onEvent: (e: any) => void): () => void {
  let stopped = false;
  let ctrl: AbortController | null = null;
  (async () => {
    let fails = 0;
    while (!stopped) {
      ctrl = new AbortController();
      try {
        const r = await fetch("/cp/api/events", { credentials: "same-origin", signal: ctrl.signal });
        if (r.status === 401) return;
        if (!r.ok || !r.body) throw new Error();
        fails = 0;
        const rd = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { value, done } = await rd.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
            buf = buf.slice(i + 2);
            if (line) try { onEvent(JSON.parse(line.slice(6))); } catch {}
          }
        }
      } catch {
        if (stopped) return;
        fails++;
      }
      await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** fails, 15000)));
    }
  })();
  return () => { stopped = true; ctrl?.abort(); };
}
