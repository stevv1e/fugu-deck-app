/**
 * Общие пространства кластера и спонсорство (control-plane: /v1/spaces, /v1/grants; агент: предложения модели).
 *
 * Всё, что меняет состав или тратит чьи-то деньги, — подписанное действие (биометрия):
 *  • состав меняет владелец действием role_change;
 *  • модель общего чата оплачивает спонсор: он подписывает разрешение (grant) с лимитом, сроком и списком
 *    допущенных — keyguard подставляет его ключ только в этих пределах;
 *  • отозвать разрешение спонсор может в любой момент (grant_revoke).
 */
import { signClusterAction } from "./cluster";
import type { DeviceKeys } from "./keys";

export type ApiSession = { request<T = any>(method: string, path: string, body?: unknown): Promise<T> };

export type MemberRole = "owner" | "editor" | "reader";
export type SpaceSummary = {
  id: string;
  kind: "personal" | "team";
  title: string;
  owner: string;
  /** Роль в терминах агента: owner | editor | viewer. */
  role: string;
  /** Как пространство названо в подписанных действиях: u-<ник> или t-<id>. */
  space: string;
  exists: boolean;
  phase?: string;
  message?: string;
  url: string;
  delete_requested?: boolean;
  delete_at?: string;
  delete_error?: string;
};
export type TeamState = SpaceSummary & { members: { nick: string; role: MemberRole }[] };

export const listSpaces = (s: ApiSession) => s.request<{ spaces: SpaceSummary[] }>("GET", "/v1/spaces").then((r) => r.spaces);
export const createTeam = (s: ApiSession, title: string) => s.request<SpaceSummary>("POST", "/v1/spaces", { title });
export const teamState = (s: ApiSession, id: string) => s.request<TeamState>("GET", `/v1/spaces/${id}`);
export const wakeTeam = (s: ApiSession, id: string) => s.request<TeamState>("POST", `/v1/spaces/${id}/wake`);
export const restoreTeam = (s: ApiSession, id: string) => s.request<SpaceSummary>("POST", `/v1/spaces/${id}/restore`);

export function titleProblem(title: string): string | null {
  const t = title.trim();
  return t.length >= 1 && [...t].length <= 60 ? null : "Название: от 1 до 60 знаков";
}

/** Добавить участника, сменить роль, исключить (role = "none") или передать владение (role = "owner"). Подписывает владелец. */
export async function setMember(s: ApiSession, keys: DeviceKeys, team: string, nick: string, role: "editor" | "reader" | "none" | "owner") {
  const signed = await signClusterAction(keys, { type: "role_change", member: nick, role }, { space: team });
  return s.request<TeamState>("POST", `/v1/spaces/${team}/members`, signed);
}

/** Запросить удаление общего пространства (подписывает владелец; срок до удаления отсчитывает сервер). */
export async function deleteTeam(s: ApiSession, keys: DeviceKeys, team: string) {
  const signed = await signClusterAction(keys, { type: "space_delete" }, { space: team });
  return s.request<SpaceSummary>("POST", `/v1/spaces/${team}/delete`, signed);
}

// ---------- модель общего чата: спонсор, предложение, голосование ----------

export type SponsorInfo = {
  id: string;
  name: string;
  limit_usd: number | null;
  until: number | null;
  spent_usd: number;
  blocked: string | null;
  grant_id?: string | null;
  proposal_id?: string | null;
};
export type ProposalInfo = {
  id: string;
  model: string;
  proposer_id: string;
  proposer_name?: string;
  limit_usd?: number | null;
  grant_id?: string | null;
  yes: string[];
  no: string[];
  need: number;
  voters: number | null;
  my_vote: boolean | null;
};
export type TeamChatState = {
  team?: boolean;
  /** Расход в этом чате по участникам с начала спонсорства. */
  by_member?: { user_id: string; name: string; usd: number }[];
  sponsor?: SponsorInfo | null;
  proposal?: ProposalInfo | null;
  model_policy?: "vote" | "open";
  created_by?: string | null;
  /** Я владелец пространства: моя модель применяется сразу, без голосования. */
  owner_switch?: boolean;
};

/** То, что агент просит подписать: чат, предложение, модель и список допущенных — из его ответа, условия — от человека. */
export type GrantBase = { space: string; chat: string; proposal: string; provider: string; model: string; members: string[] };
export type GrantTerms = { limitUsd: number; days: number; perMemberUsdDay?: number | null };

/** Дата окончания: сегодня + days, по UTC (разрешение действует до конца названных суток). */
export function untilDate(days: number, nowMs = Date.now()): string {
  return new Date(nowMs + Math.round(days) * 86400_000).toISOString().slice(0, 10);
}

export function termsProblem(t: GrantTerms): string | null {
  if (!(t.limitUsd > 0) || t.limitUsd > 100000) return "Лимит: больше 0 и не больше 100 000 долларов";
  if (!Number.isInteger(t.days) || t.days < 1 || t.days > 365) return "Срок: от 1 до 365 дней";
  if (t.perMemberUsdDay != null && !(t.perMemberUsdDay > 0 && t.perMemberUsdDay <= t.limitUsd)) return "Лимит на участника в день: больше 0 и не больше общего";
  return null;
}

export function grantBody(base: GrantBase, t: GrantTerms, nowMs = Date.now()) {
  const until = untilDate(t.days, nowMs);
  return {
    type: "grant" as const, chat: base.chat, provider: base.provider, model: base.model,
    limit_usd: t.limitUsd, limit_tokens: null, until, key_until: until,
    per_member_usd_day: t.perMemberUsdDay ?? null, members: base.members, proposal: base.proposal,
  };
}

/**
 * Предложить модель общего чата и оплатить её своим ключом.
 *  1. агент заводит предложение и говорит, что нужно подписать;
 *  2. телефон подписывает разрешение (биометрия) — оно уходит в keyguard через control-plane;
 *  3. агенту сообщается id разрешения: начинается голосование или модель применяется сразу.
 * Если подпись не состоялась или keyguard отказал, предложение отменяется — чат не остаётся с «висящим» голосованием.
 */
export async function proposeModel(
  space: ApiSession, cluster: ApiSession, keys: DeviceKeys, chat: string,
  p: { model: string; policy?: "vote" | "open" } & GrantTerms,
): Promise<{ status: string; applied: boolean }> {
  const bad = termsProblem(p);
  if (bad) throw new Error(bad);
  const r = await space.request<{ applied: boolean; need_grant?: boolean; grant?: GrantBase; proposal?: { id: string } }>(
    "POST", `/api/conversations/${chat}/model`, { model: p.model, limit_usd: p.limitUsd, days: p.days, model_policy: p.policy ?? null });
  if (!r.need_grant || !r.grant) return { status: r.applied ? "approved" : "pending", applied: r.applied };
  const cancel = () => space.request("POST", `/api/model-proposals/${r.grant!.proposal}`, { approve: false }).catch(() => {});
  let grantId: string;
  try {
    const signed = await signClusterAction(keys, grantBody(r.grant, p), { space: r.grant.space });
    grantId = (await cluster.request<{ grant_id: string }>("POST", "/v1/grants", signed)).grant_id;
  } catch (e) {
    await cancel();
    throw e;
  }
  return space.request<{ status: string; applied: boolean }>("POST", `/api/model-proposals/${r.grant.proposal}/grant`, { grant_id: grantId });
}

export const vote = (space: ApiSession, proposal: string, approve: boolean) =>
  space.request<{ status: string }>("POST", `/api/model-proposals/${proposal}`, { approve });

/**
 * Спонсор перестаёт оплачивать чат: подписанный отзыв в keyguard (после него ключ не выдаётся, и включить
 * разрешение обратно уже нельзя), затем отметка в самом чате.
 */
export async function withdrawSponsorship(space: ApiSession, cluster: ApiSession, keys: DeviceKeys, spaceKey: string, chat: string, proposal: string | null | undefined) {
  if (proposal) {
    const signed = await signClusterAction(keys, { type: "grant_revoke", chat, proposal }, { space: spaceKey });
    await cluster.request("POST", "/v1/grants/revoke", signed);
  }
  return space.request("PATCH", `/api/conversations/${chat}/sponsor`, { withdraw: true });
}

/** Подписи для экранов. */
export const PHASE_NAMES: Record<string, string> = { Ready: "готово", Pending: "запускается", Sleeping: "спит", Deleting: "удаляется", Failed: "ошибка" };
export const ROLE_LABELS: Record<string, string> = { owner: "владелец", editor: "редактор", viewer: "читатель", reader: "читатель" };
