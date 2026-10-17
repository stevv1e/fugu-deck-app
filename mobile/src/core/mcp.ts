/**
 * MCP-серверы владельца в кластере (keyguard, mcp.go). Адрес и токен добавляются подписанным действием mcp_put;
 * токен шифруется для keyguard (HPKE) с AAD "mcp_put|<device_id>|<id>|<nonce>" — как ключ API, control-plane его
 * не прочитает. Агент личного пространства ходит к серверу через keyguard и токена не видит.
 */
import { validateApiKey } from "./apikeys";
import { b64, concat, randomId, unb64, utf8 } from "./bytes";
import { clusterDeviceId, signClusterAction } from "./cluster";
import { sha256 } from "./crypto";
import { HPKE_INFO, hpkeSeal } from "./hpke";
import type { DeviceKeys } from "./keys";
import type { ApiSession } from "./ssh";

export type McpServer = { id: string; name: string; url: string; has_token: boolean };

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export const MCP_ID = /^[a-z][a-z0-9-]{1,30}$/;

/** id из названия: латиница и цифры через дефис; не вышло — «mcp-» и случайный хвост. */
export function mcpIdFrom(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[0-9-]+/, "").slice(0, 31).replace(/-+$/, "");
  return MCP_ID.test(s) ? s : `mcp-${randomId(6).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
}

/** Те же правила, что у keyguard (mcpURL): https, имя хоста (не IP), порт 443, без логина в адресе. */
export function mcpUrlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return "Адрес вида https://имя-хоста/путь";
  }
  if (u.protocol !== "https:") return "Только https://";
  if (u.username || u.password) return "Без логина и пароля в адресе — токен вводится отдельно";
  if (u.port && u.port !== "443") return "Только порт 443";
  if (/^[\d.]+$/.test(u.hostname) || u.hostname.startsWith("[") || !u.hostname.includes(".")) return "Нужно имя хоста, а не IP-адрес";
  if (u.hash) return "Без # в адресе";
  if (!/^https:\/\/[!-~]+$/.test(raw.trim()) || raw.trim().length > 300) return "Адрес без пробелов и не длиннее 300 символов";
  return null;
}

export const listMcp = (s: ApiSession) => s.request<{ servers: McpServer[] }>("GET", "/v1/mcp/list");

export async function putMcp(s: ApiSession, keys: DeviceKeys, hpkePub: string, o: { id: string; name: string; url: string; token?: string }) {
  const url = o.url.trim();
  const bad = mcpUrlProblem(url);
  if (bad) throw new Error(bad);
  if (!MCP_ID.test(o.id)) throw new Error("id сервера: латиница, цифры, дефис; 2–31 знак");
  const name = o.name.trim().slice(0, 60) || o.id;
  const token = (o.token ?? "").trim();
  const nonce = randomId(16);
  if (!token) {
    const signed = await signClusterAction(keys, { type: "mcp_put", id: o.id, name, url, token_hint: null, ct_sha256: null }, { nonce });
    return s.request<McpServer & { ok: boolean }>("POST", "/v1/mcp", signed);
  }
  const tb = validateApiKey(token);
  if (tb) throw new Error(tb.replace("Ключ", "Токен").replace("ключа", "токена"));
  const aad = utf8(`mcp_put|${clusterDeviceId(keys)}|${o.id}|${nonce}`);
  const { enc, ct } = hpkeSeal(unb64(hpkePub), utf8(HPKE_INFO), aad, utf8(token));
  const signed = await signClusterAction(
    keys, { type: "mcp_put", id: o.id, name, url, token_hint: token.slice(-4), ct_sha256: hex(sha256(concat(enc, ct))) }, { nonce });
  return s.request<McpServer & { ok: boolean }>("POST", "/v1/mcp", { ...signed, enc: b64(enc), ct: b64(ct) });
}

export async function deleteMcp(s: ApiSession, keys: DeviceKeys, id: string) {
  return s.request<{ ok: boolean }>("POST", "/v1/mcp/delete", await signClusterAction(keys, { type: "mcp_delete", id }));
}
