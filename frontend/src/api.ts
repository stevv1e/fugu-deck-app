export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/* ---------------------------------------------------------------------------------
 * Куда ходит API: в одиночном режиме — /api, в кластере — /s/<пространство>/api
 * с коротким токеном от control-plane в заголовке Authorization.
 * ------------------------------------------------------------------------------- */
let BASE = "";
let tokenFn: ((force?: boolean) => Promise<string | null>) | null = null;

export function configureApi(base: string, fn: ((force?: boolean) => Promise<string | null>) | null) {
  BASE = base;
  tokenFn = fn;
}

export async function authHeaders(force = false): Promise<Record<string, string>> {
  const t = tokenFn ? await tokenFn(force) : null;
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export const apiUrl = (path: string) => `${BASE}${path}`;

async function req<T>(method: string, url: string, body?: unknown, retried = false): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", headers: { ...(await authHeaders()) } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  const r = await fetch(apiUrl(url), init);
  if (r.status === 401 && tokenFn && !retried) {
    await authHeaders(true); // токен истёк или роль сменилась — берём новый и повторяем
    return req<T>(method, url, body, true);
  }
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

export type Me = { id: string; username: string; display_name: string; role: "owner" | "member"; space_role?: Role };
export type Role = "viewer" | "editor" | "owner";
export type Project = {
  id: string; name: string; description: string; instructions: string; skills: string[]; color: string;
  my_role: Role; conversations?: number; memories?: number; running?: number | any[];
  members?: { id: string; username: string; display_name: string; role: Role }[];
  memory_sources?: { id: string; name: string }[];
  online?: Online[];
};
export type Online = { user_id: string; name: string; conversations: string[]; devices: number };
export type Memory = {
  id: number; project_id: string; content: string; tags: string; pinned: number; source: string;
  author: string | null; created_at: number; updated_at: number; project_name?: string;
};
export type Skill = { name: string; description: string; files: string[]; size?: number; updated_at: number; body?: string };
export type UserRow = { id: string; username: string; display_name: string; role: string; disabled?: number };

export type Provider = { ok: boolean; login?: string; name?: string; error?: string };
export type Config = {
  models: string[];
  default_model: string;
  pricing: Record<string, number[]>;
  providers: Record<string, Provider>;
  approval_mode: string;
  llm_configured: boolean;
  llm_ready?: string[];
  keys?: string[];
  mode?: "standalone" | "space";
  space?: { id: string; kind: "personal" | "team"; name: string } | null;
  me: Me;
  skills_writable: boolean;
};
export type Conversation = {
  id: string;
  title: string;
  model: string;
  updated_at: number;
  cost_usd?: number;
  running?: boolean;
  author?: string | null;
  project_id?: string;
};
export type Attachment = { id: string; filename: string; mime: string; size: number };
export type StoredMessage = {
  id: number;
  role: "user" | "assistant" | "tool" | "note";
  content: string | null;
  created_at: number;
  tool_calls?: { id: string; name: string; args: any }[];
  tool_call_id?: string;
  name?: string;
  ok?: boolean;
  meta?: { attachments?: Attachment[]; model?: string; author?: string; author_id?: string };
};
export type Sponsor = {
  id: string; name: string; online: boolean; limit_usd: number | null; limit_tokens: number | null;
  until: number | null; since: number | null; spent_usd: number; spent_tokens: number; blocked: string | null;
};
export type ModelProposal = {
  id: string; model: string; proposer_id: string; proposer_name: string; limit_usd: number | null;
  limit_tokens: number | null; days: number | null; until: number | null; status: string;
  expires_at: number | null; yes: string[]; no: string[]; need: number; voters: number | null; my_vote: boolean | null;
};
export type ModelPolicy = "vote" | "open";
export type SponsorTerms = { limit_usd?: number | null; limit_tokens?: number | null; days?: number | null; until?: number | null };
export type MemberUsage = {
  user_id: string | null; name: string; me: boolean; requests: number;
  launched_usd: number; launched_tokens: number; paid_usd: number; paid_tokens: number; paid_for_others_usd: number;
};
export type UsageReport = {
  period: string; members: MemberUsage[]; models: { model: string; usd: number; tokens: number; requests: number }[];
  total_usd: number; total_tokens: number;
};
export type ConversationFull = Conversation & {
  team?: boolean;
  sponsor?: Sponsor | null;
  proposal?: ModelProposal | null;
  created_by?: string;
  model_policy?: ModelPolicy;
  proposal_ttl_hours?: number;
  messages: StoredMessage[];
  active_run: string | null;
  active_run_started_at: number | null;
  my_role: Role;
};
export type Usage = { cost_usd: number; prompt_tokens: number; completion_tokens: number; requests: number };
export type RunEvent = { seq: number; type: string; ts: number; [k: string]: any };

export const api = {
  authInfo: () => req<{ owner_totp: boolean }>("GET", "/api/auth/info"),
  login: (username: string, password: string, totp?: string) =>
    req("POST", "/api/auth/login", { username, password, totp }),
  logout: () => req("POST", "/api/auth/logout"),
  config: () => req<Config>("GET", "/api/config"),
  usage: () => req<{ month: Usage; today: Usage }>("GET", "/api/usage"),
  audit: () => req<any[]>("GET", "/api/audit?limit=100"),
  conversations: (pid: string) => req<Conversation[]>("GET", `/api/projects/${pid}/conversations`),
  createConversation: (pid: string, model?: string) =>
    req<Conversation>("POST", `/api/projects/${pid}/conversations`, { model }),
  // проекты
  projects: () => req<Project[]>("GET", "/api/projects"),
  project: (pid: string) => req<Project>("GET", `/api/projects/${pid}`),
  createProject: (name: string, description = "") => req<Project>("POST", "/api/projects", { name, description }),
  updateProject: (pid: string, data: Partial<Pick<Project, "name" | "description" | "instructions" | "skills">>) =>
    req<Project>("PATCH", `/api/projects/${pid}`, data),
  deleteProject: (pid: string) => req("DELETE", `/api/projects/${pid}`),
  setMember: (pid: string, uid: string, role: Role | null) => req("PUT", `/api/projects/${pid}/members/${uid}`, { role }),
  setMemorySources: (pid: string, ids: string[]) =>
    req<{ id: string; name: string }[]>("PUT", `/api/projects/${pid}/memory-sources`, { source_ids: ids }),
  // память
  memory: (pid: string, q = "", linked = false) =>
    req<Memory[]>("GET", `/api/projects/${pid}/memory?q=${encodeURIComponent(q)}&linked=${linked}`),
  addMemory: (pid: string, content: string, tags = "", pinned = false) =>
    req<Memory>("POST", `/api/projects/${pid}/memory`, { content, tags, pinned }),
  updateMemory: (id: number, data: { content?: string; tags?: string; pinned?: boolean }) =>
    req<Memory>("PATCH", `/api/memory/${id}`, data),
  deleteMemory: (id: number) => req("DELETE", `/api/memory/${id}`),
  // скилы
  skills: () => req<{ writable: boolean; items: Skill[] }>("GET", "/api/skills"),
  skill: (name: string) => req<Skill>("GET", `/api/skills/${name}`),
  saveSkill: (name: string, description: string, body: string, rename_from?: string) =>
    req<Skill>("PUT", `/api/skills/${name}`, { description, body, rename_from }),
  deleteSkill: (name: string) => req("DELETE", `/api/skills/${name}`),
  // пользователи
  users: () => req<UserRow[]>("GET", "/api/users"),
  createUser: (username: string, display_name: string, password: string) =>
    req<UserRow>("POST", "/api/users", { username, display_name, password }),
  patchUser: (id: string, data: { display_name?: string; password?: string; disabled?: boolean }) =>
    req("PATCH", `/api/users/${id}`, data),
  deleteUser: (id: string) => req("DELETE", `/api/users/${id}`),
  updateMe: (data: { display_name?: string; old_password?: string; new_password?: string }) =>
    req<Me>("PATCH", "/api/me", data),
  usageMembers: (period: string) => req<UsageReport>("GET", `/api/usage/members?period=${period}`),
  proposeModel: (cid: string, model: string, terms: SponsorTerms, model_policy?: ModelPolicy) =>
    req<{ applied: boolean; proposal?: ModelProposal }>("POST", `/api/conversations/${cid}/model`, { model, ...terms, model_policy }),
  setPolicy: (cid: string, model_policy: ModelPolicy) => req("PATCH", `/api/conversations/${cid}/policy`, { model_policy }),
  decideProposal: (pid: string, approve: boolean) => req("POST", `/api/model-proposals/${pid}`, { approve }),
  patchSponsor: (cid: string, data: SponsorTerms & { withdraw?: boolean }) =>
    req("PATCH", `/api/conversations/${cid}/sponsor`, data),
  pushKeys: (keys: Record<string, string>) => req<{ providers: string[] }>("POST", "/api/session/keys", { keys }),
  wipeKeys: () => req("DELETE", "/api/session/keys"),
  exportProject: (pid: string) => req<any>("GET", `/api/projects/${pid}/export`),
  importProject: (data: any) => req<Project>("POST", "/api/projects/import", data),
  presence: (device_id: string, project_id: string | null, conversation_id: string | null) =>
    req<{ online: Online[] }>("POST", "/api/presence", { device_id, project_id, conversation_id }),
  conversation: (id: string) => req<ConversationFull>("GET", `/api/conversations/${id}`),
  updateConversation: (id: string, data: { title?: string; model?: string }) =>
    req<Conversation>("PATCH", `/api/conversations/${id}`, data),
  deleteConversation: (id: string) => req("DELETE", `/api/conversations/${id}`),
  upload: (id: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return req<Attachment>("POST", `/api/conversations/${id}/attachments`, fd);
  },
  send: (id: string, content: string, attachment_ids: string[], model?: string) =>
    req<{ run_id: string }>("POST", `/api/conversations/${id}/messages`, { content, attachment_ids, model }),
  cancel: (runId: string) => req("POST", `/api/runs/${runId}/cancel`),
  approve: (approvalId: string, approve: boolean, comment = "") =>
    req("POST", `/api/approvals/${approvalId}`, { approve, comment }),
};

/**
 * Подписка на события запуска с автоматическим переподключением.
 * Мобильные браузеры часто рвут соединение (экран погас, смена сети) —
 * мы просто продолжаем с последнего полученного события.
 */
export function subscribeRun(
  runId: string,
  onEvent: (e: RunEvent) => void,
  onEnd: () => void,
  startAfter = 0,
): () => void {
  let after = startAfter;
  let stopped = false;
  let ctrl: AbortController | null = null;
  let finished = false;
  let kick = false;

  const loop = async () => {
    let failures = 0;
    while (!stopped && !finished) {
      ctrl = new AbortController();
      try {
        const r = await fetch(apiUrl(`/api/runs/${runId}/events?after=${after}`), {
          credentials: "same-origin",
          signal: ctrl.signal,
          headers: await authHeaders(failures > 0),
        });
        if (r.status === 401 && tokenFn && failures < 2) {
          failures++; // токен истёк — следующий заход возьмёт новый
          continue;
        }
        if (r.status === 404 || r.status === 401) {
          finished = true;
          break;
        }
        if (!r.ok || !r.body) throw new Error(String(r.status));
        failures = 0;
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            if (block.startsWith("event: end")) {
              finished = true;
              continue;
            }
            const line = block.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            const ev = JSON.parse(line.slice(6)) as RunEvent;
            after = ev.seq + 1;
            onEvent(ev);
            if (["done", "error", "cancelled"].includes(ev.type)) finished = true;
          }
        }
      } catch (e) {
        if (stopped) return;
        failures++;
      }
      if (kick) {
        kick = false;
        failures = 0;
        continue;
      }
      if (!finished && !stopped) await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** failures, 10000)));
    }
    if (!stopped) onEnd();
  };

  const onVisible = () => {
    // Вернулись в приложение — сразу переподключаемся, не дожидаясь таймаута
    if (document.visibilityState === "visible" && ctrl) {
      kick = true;
      ctrl.abort();
    }
  };
  document.addEventListener("visibilitychange", onVisible);
  loop();
  return () => {
    stopped = true;
    ctrl?.abort();
    document.removeEventListener("visibilitychange", onVisible);
  };
}

/** Глобальный поток событий реального времени (синхронизация устройств и людей). */
export function openEventStream(deviceId: string, onEvent: (e: any) => void, onReconnect: () => void): () => void {
  let stopped = false;
  let ctrl: AbortController | null = null;
  let first = true;
  const loop = async () => {
    let failures = 0;
    while (!stopped) {
      ctrl = new AbortController();
      try {
        const r = await fetch(apiUrl(`/api/events?device_id=${encodeURIComponent(deviceId)}`), {
          credentials: "same-origin", signal: ctrl.signal, headers: await authHeaders(failures > 0),
        });
        if (r.status === 401 && !tokenFn) return;
        if (r.status === 401) throw new Error("401");
        if (!r.ok || !r.body) throw new Error(String(r.status));
        failures = 0;
        if (!first) onReconnect(); // пропустили события, пока были офлайн — перечитываем
        first = false;
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = block.split("\n").find((l) => l.startsWith("data: "));
            if (line) {
              try { onEvent(JSON.parse(line.slice(6))); } catch {}
            }
          }
        }
      } catch {
        if (stopped) return;
        failures++;
      }
      if (!stopped) await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** failures, 15000)));
    }
  };
  const onVisible = () => { if (document.visibilityState === "visible") ctrl?.abort(); };
  document.addEventListener("visibilitychange", onVisible);
  loop();
  return () => {
    stopped = true;
    ctrl?.abort();
    document.removeEventListener("visibilitychange", onVisible);
  };
}

export function deviceId(): string {
  const k = "fd:device";
  try {
    let v = localStorage.getItem(k);
    if (!v) {
      v = Math.random().toString(36).slice(2, 12);
      localStorage.setItem(k, v);
    }
    return v;
  } catch {
    return "anon-" + Math.random().toString(36).slice(2, 8);
  }
}
