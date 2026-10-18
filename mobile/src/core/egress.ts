/**
 * Домены для агента (keyguard, egress.go; D65): с них агент личного пространства читает страницы через keyguard.
 * Список целиком задаёт подписанное действие egress_set — агент сам его не расширит.
 */
import { DOMAIN } from "./actions";
import { signClusterAction } from "./cluster";
import type { DeviceKeys } from "./keys";
import type { ApiSession } from "./ssh";

export const MAX_DOMAINS = 50;

/** Из того, что вставил человек (адрес или домен), — имя домена; не вышло — null. */
export function domainFrom(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s.includes("://")) {
    try {
      s = new URL(s).hostname;
    } catch {
      return null;
    }
  }
  s = s.replace(/\/.*$/, "").replace(/\.$/, "");
  return DOMAIN.test(s) && s.length <= 253 ? s : null;
}

export const listEgress = (s: ApiSession) => s.request<{ domains: string[] }>("GET", "/v1/egress/list");

export async function setEgress(s: ApiSession, keys: DeviceKeys, domains: string[]): Promise<string[]> {
  const out = await s.request<{ domains: string[] }>("POST", "/v1/egress", await signClusterAction(keys, { type: "egress_set", domains }));
  return out.domains;
}
