/**
 * Устройства и приглашения в кластере (control-plane: /v1/devices, /v1/invites).
 * Подтвердить или отозвать устройство и выпустить приглашение можно только действием, подписанным ключом
 * подтверждения (биометрия). Подпись проверяет keyguard, поэтому сервер между телефоном и ним подделать её не может.
 */
import { signClusterAction } from "./cluster";
import type { DeviceKeys } from "./keys";

export type ClusterDevice = {
  id: string;
  user: string;
  name: string;
  status: "pending" | "active" | "revoked";
  key_storage?: string;
  attested?: string;
};

export type DeviceList = { devices: ClusterDevice[]; admin: boolean; user: string; device_id: string };
export type IssuedInvite = { nick: string; link: string; expires: string };

/** То, что нужно от сессии кластера (api.<домен>): запрос с mTLS, токеном и DPoP. */
export type ApiSession = { request<T = any>(method: string, path: string, body?: unknown): Promise<T> };

export const listDevices = (s: ApiSession) => s.request<DeviceList>("GET", "/v1/devices");

/** Подтвердить ожидающее устройство: подписывается то, что видно на экране, — пользователь, имя и ID устройства. */
export async function confirmDevice(s: ApiSession, keys: DeviceKeys, d: ClusterDevice): Promise<void> {
  await s.request("POST", "/v1/devices/confirm", await signClusterAction(keys, { type: "device_approve", user: d.user, target: d.id, name: d.name }));
}

/** Отозвать устройство: оно сразу теряет право подписывать действия. */
export async function revokeDevice(s: ApiSession, keys: DeviceKeys, d: ClusterDevice): Promise<void> {
  await s.request("POST", "/v1/devices/revoke", await signClusterAction(keys, { type: "device_revoke", user: d.user, target: d.id }));
}

/** Ник: те же правила, что на сервере (control-plane, ValidNick) — чтобы не просить биометрию ради заведомого отказа. */
export function nickProblem(nick: string): string | null {
  return /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(nick) && !nick.includes("--")
    ? null
    : "Ник: 3–32 символа, строчные латинские буквы, цифры и дефис";
}

/** Приглашение на ник: свой — подключить ещё одно своё устройство, чужой — новый пользователь (только администратор). */
export async function createInvite(s: ApiSession, keys: DeviceKeys, nick: string): Promise<IssuedInvite> {
  const bad = nickProblem(nick);
  if (bad) throw new Error(bad);
  return s.request<IssuedInvite>("POST", "/v1/invites", await signClusterAction(keys, { type: "invite_create", user: nick }));
}

const ORDER = { pending: 0, active: 1, revoked: 2 } as const;

/** Порядок на экране: сначала ждущие решения, затем действующие (это устройство — первым), отозванные — в конце. */
export function sortDevices(l: DeviceList): ClusterDevice[] {
  return [...l.devices].sort(
    (a, b) =>
      ORDER[a.status] - ORDER[b.status] ||
      Number(b.id === l.device_id) - Number(a.id === l.device_id) ||
      a.user.localeCompare(b.user) ||
      a.id.localeCompare(b.id),
  );
}
