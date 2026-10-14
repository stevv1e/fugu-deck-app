/**
 * Личные ключи API и расходы (control-plane → keyguard): какие ключи заданы, сколько потрачено за месяц, месячный
 * лимит. Удаление ключа и лимит — подписанные действия (key_delete, spend_limit): чей ключ и чей лимит, keyguard
 * определяет по подписавшему устройству.
 */
import { buildKeyPut, type KeyProvider } from "./apikeys";
import { unb64 } from "./bytes";
import { clusterDeviceId, signClusterAction } from "./cluster";
import type { DeviceKeys } from "./keys";
import type { ApiSession } from "./ssh";

export type KeyStatus = {
  providers: KeyProvider[];
  month: string; // ГГГГ-ММ (UTC)
  spent_usd_month: number;
  spent_usd_total: number;
  limit_usd_month: number | null;
};

export const keyStatus = (s: ApiSession) => s.request<KeyStatus>("GET", "/v1/keys/status");

export async function putKey(s: ApiSession, keys: DeviceKeys, hpkePub: string, provider: KeyProvider, apiKey: string) {
  const body = await buildKeyPut((b, n) => signClusterAction(keys, b, { nonce: n }), { hpkePub: unb64(hpkePub), deviceId: clusterDeviceId(keys), provider, apiKey });
  return s.request<{ masked: string }>("POST", "/v1/keys", body);
}

export async function deleteKey(s: ApiSession, keys: DeviceKeys, provider: KeyProvider) {
  return s.request<{ ok: boolean }>("POST", "/v1/keys/delete", await signClusterAction(keys, { type: "key_delete", provider }));
}

/** Сумма лимита из поля ввода: пусто — без лимита; иначе доллары с точностью до центов (как в схеме действий). */
export function parseLimit(text: string): { value: number | null } | { error: string } {
  const t = text.trim().replace(",", ".").replace(/^\$/, "");
  if (!t) return { value: null };
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(t)) return { error: "Лимит — сумма в долларах, не больше двух знаков после запятой" };
  const v = Number(t);
  if (v <= 0 || v > 100000) return { error: "Лимит — от $0.01 до $100 000; пустое поле — без лимита" };
  return { value: v };
}

export async function setSpendLimit(s: ApiSession, keys: DeviceKeys, limit: number | null) {
  return s.request<{ limit_usd_month: number | null; spent_usd_month: number }>(
    "POST", "/v1/limits", await signClusterAction(keys, { type: "spend_limit", limit_usd_month: limit }));
}
