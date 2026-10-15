/**
 * Серверы пользователя и права агента на них (control-plane: /v1/ssh → ssh-gateway).
 * Сервер добавляется подписанным действием: адрес, пользователь и отпечаток ключа хоста — то, что человек видит на
 * экране. Права агента (к каким серверам допущен и можно ли читать без подтверждения) — тоже подпись владельца.
 */
import { signClusterAction } from "./cluster";
import type { DeviceKeys } from "./keys";

export type ApiSession = { request<T = any>(method: string, path: string, body?: unknown): Promise<T> };

/** Агент пространства: под этим именем подписываются его права и выписывается сертификат. */
export const AGENT = "fugu";

export type SshServer = { id: string; host: string; port: number; user: string; host_key: string; added_by?: string; added?: string };
export type SshRights = { agent: string; servers: string[]; read_without_confirm: boolean };
export type SshState = { servers: SshServer[]; rights: SshRights[]; ca_public_key: string; principal_prefix: string; paused?: boolean };
/** Запись журнала команд (шлюз хранит 30 дней). */
export type JournalEntry = {
  time: string; agent: string; server: string; command: string; level: "read" | "write" | "danger"; signer?: string;
  exit_code: number; duration_ms: number; stdout?: string; stderr?: string; error?: string; stopped?: boolean; preview?: boolean; timed_out?: boolean;
};

// team — общее пространство (t-…): его серверы настраивает владелец; без team — личное пространство.
const q = (team?: string | null) => (team ? `?space=${encodeURIComponent(team)}` : "");
const spaceKey = (user: string, team?: string | null) => team || `u-${user}`;

export const sshState = (s: ApiSession, team?: string | null) => s.request<SshState>("GET", `/v1/ssh${q(team)}`);
export const sshJournal = (s: ApiSession, team?: string | null) =>
  s.request<{ entries: JournalEntry[]; keep_days?: number }>("GET", `/v1/ssh/journal${q(team)}`);
/** Остановить агента на серверах (идущие команды обрываются) или возобновить. Подписи не требует: уменьшение прав. */
export const setPaused = (s: ApiSession, paused: boolean, team?: string | null) =>
  s.request<{ paused: boolean; stopped: number }>("POST", "/v1/ssh/pause", { paused, ...(team ? { space: team } : {}) });

export type ServerInput = { id: string; host: string; port: number; user: string; hostKey: string };

/** Те же правила, что в схеме подписанных действий: ошибку человек видит до биометрии. */
export function serverProblem(v: ServerInput): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(v.id)) return "Имя сервера: латинские буквы, цифры, дефис, точка";
  if (!/^(?=.{1,253}$)([A-Za-z0-9-]{1,63}\.)*[A-Za-z0-9-]{1,63}$/.test(v.host)) return "Адрес: имя хоста или IPv4";
  if (!Number.isInteger(v.port) || v.port < 1 || v.port > 65535) return "Порт: от 1 до 65535";
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(v.user)) return "Пользователь: строчные латинские буквы, цифры, дефис";
  if (v.user === "root") return "Вход под root не принимается: заведите отдельного пользователя с нужными правами";
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(v.hostKey)) return "Отпечаток ключа сервера: SHA256: и 43 знака (ssh-keygen -lf …)";
  return null;
}

export async function addServer(s: ApiSession, keys: DeviceKeys, user: string, v: ServerInput, team?: string | null): Promise<SshServer> {
  const bad = serverProblem(v);
  if (bad) throw new Error(bad);
  const signed = await signClusterAction(keys, { type: "server_add", server: v.id, host: v.host.toLowerCase(), port: v.port, user: v.user, host_key: v.hostKey }, { space: spaceKey(user, team) });
  return s.request<SshServer>("POST", "/v1/ssh/servers", signed);
}

export const removeServer = (s: ApiSession, id: string, team?: string | null) =>
  s.request("POST", "/v1/ssh/servers/remove", { server: id, ...(team ? { space: team } : {}) });

/** Права агента: полный список серверов и разрешение читать без подтверждения. Подписывается целиком. */
export async function setRights(s: ApiSession, keys: DeviceKeys, user: string, servers: string[], readWithoutConfirm: boolean, team?: string | null, agent = AGENT): Promise<SshRights> {
  const signed = await signClusterAction(keys, { type: "agent_rights", agent, servers: [...servers].sort(), read_without_confirm: readWithoutConfirm, limit_usd_month: null }, { space: spaceKey(user, team) });
  return s.request<SshRights>("POST", "/v1/ssh/rights", signed);
}

/** Что выполнить на сервере, чтобы он принимал агента: ключ CA, имя входа, отпечаток для формы. */
export function setupScript(st: Pick<SshState, "ca_public_key" | "principal_prefix">, user = "deck-agent", agents: string[] = [AGENT]): string {
  return [
    `sudo useradd -m ${user}`,
    `echo '${st.ca_public_key}' | sudo tee /etc/ssh/deck_ca.pub`,
    `sudo mkdir -p /etc/ssh/principals`,
    // каждый агент входит под своим именем: в файле — все, кого вы пускаете на этот сервер
    `printf '%s\\n' ${agents.map((a) => `'${st.principal_prefix}${a}'`).join(" ")} | sudo tee /etc/ssh/principals/${user}`,
    `printf 'TrustedUserCAKeys /etc/ssh/deck_ca.pub\\nAuthorizedPrincipalsFile /etc/ssh/principals/%%u\\n' | sudo tee /etc/ssh/sshd_config.d/deck.conf`,
    `sudo systemctl reload ssh`,
    `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub   # отпечаток SHA256:… — для формы ниже`,
  ].join("\n");
}
