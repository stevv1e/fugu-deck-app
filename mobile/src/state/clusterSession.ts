/** Сессии кластера: одна — к api.<домен> (пространство, ключи), другая — к пространству за ним (чаты). */
import { refresh, signClusterAction, type ClusterInvite } from "@/core/cluster";
import { ClusterSession } from "@/core/session";
import type { ServerRecord } from "@/core/types";
import { mtlsHttp, nativeMtlsAvailable, plainHttp } from "@/platform/http";
import { keyProvider } from "@/platform/keys";

import { loadRefresh, saveRefresh, spaceSid, spaceTitle, type ClusterRecord } from "./cluster";

/** Адрес пространства за api.<домен>: личного (по нику) или общего (по его id). */
export const spaceUrl = (c: ClusterRecord, team?: string | null) => `${c.api}/s/${team || c.user}`;

/** Как пространство названо в подписанных действиях: u-<ник> или t-<id>. */
export const spaceKey = (c: ClusterRecord, team?: string | null) => team || `u-${c.user}`;

/** Пространство кластера в виде записи сервера: экраны проектов и чатов работают с ним как с обычным сервером. */
export function spaceServerRecord(c: ClusterRecord, team?: string | null): ServerRecord {
  const sid = spaceSid(c.id, team);
  return {
    id: sid, url: spaceUrl(c, team), name: team ? spaceTitle(sid) || "Общее пространство" : new URL(c.api).host,
    identityKey: "", fingerprint: "", verifiedBy: "qr",
    addedAt: 0, mtls: "required",
    device: {
      id: c.deviceId, keyAlias: c.alias, keyStorage: "strongbox", enrolledAt: 0, certPem: c.certPem ?? null,
      user: { id: c.user, username: c.user, display_name: c.user, role: "owner" },
    },
  };
}

// Токен Keycloak один на кластер: его делят сессия api и сессия пространства, обновление — одно на всех.
const tokens = new Map<string, { accessToken: string; expiresIn: number; at: number }>();
const pending = new Map<string, Promise<{ accessToken: string; expiresIn: number }>>();

async function clusterToken(c: ClusterRecord, now: number): Promise<{ accessToken: string; expiresIn: number }> {
  const cur = tokens.get(c.id);
  if (cur && cur.at + cur.expiresIn - now > 30) return { accessToken: cur.accessToken, expiresIn: cur.at + cur.expiresIn - now };
  let p = pending.get(c.id);
  if (!p) {
    p = (async () => {
      const keys = await (await keyProvider()).load(c.alias);
      if (!keys) throw new Error("Ключи устройства не найдены — зарегистрируйтесь заново по приглашению");
      const rt = await loadRefresh(c.id);
      if (!rt) throw new Error("Сессия истекла — войдите заново по приглашению");
      const t = await refresh(plainHttp(), c as unknown as ClusterInvite, keys, rt, now);
      await saveRefresh(c.id, t.refreshToken);
      tokens.set(c.id, { accessToken: t.accessToken, expiresIn: t.expiresIn || 300, at: now });
      return { accessToken: t.accessToken, expiresIn: t.expiresIn || 300 };
    })().finally(() => pending.delete(c.id));
    pending.set(c.id, p);
  }
  return p;
}

/** Сессия устройства в кластере с базовым адресом baseUrl (api.<домен> или пространство за ним). */
export async function openClusterSession(c: ClusterRecord, baseUrl: string): Promise<ClusterSession> {
  if (c.status !== "active") throw new Error("Устройство ещё не подтверждено в этом кластере");
  if (!c.certPem || !nativeMtlsAvailable()) throw new Error("Нет сертификата устройства: откройте экран кластера и получите его");
  const keys = await (await keyProvider()).load(c.alias);
  if (!keys) throw new Error("Ключи устройства не найдены — зарегистрируйтесь заново по приглашению");
  const server = { ...spaceServerRecord(c), url: baseUrl };
  // Подписи действий в пространстве (разрешение агенту) — для того пространства, с которым сессия работает.
  const name = baseUrl.startsWith(`${c.api}/s/`) ? baseUrl.slice(`${c.api}/s/`.length) : null;
  const space = name === null ? undefined : name === c.user ? `u-${c.user}` : name;
  return new ClusterSession(mtlsHttp(c.alias + ".s"), server, keys, { deviceId: c.deviceId, space, token: (now) => clusterToken(c, now) });
}

export type SpaceState = {
  exists: boolean; id?: string; phase?: string; message?: string; url?: string;
  /** Запрошено удаление; delete_at — оператор принял подпись и удалит в этот момент; delete_error — отклонил. */
  delete_requested?: boolean; delete_at?: string; delete_error?: string;
};

/** Состояние личного пространства (GET) или запрос на его создание (POST) — control-plane, /v1/space. */
export async function spaceState(c: ClusterRecord, create = false): Promise<SpaceState> {
  const s = await openClusterSession(c, c.api);
  return s.request<SpaceState>(create ? "POST" : "GET", "/v1/space");
}

/**
 * Запросить удаление личного пространства: действие space_delete, подписанное ключом подтверждения (биометрия).
 * Подпись проверяет space-operator через keyguard; он же отсчитывает срок, до которого удаление можно отменить.
 */
export async function requestSpaceDelete(c: ClusterRecord): Promise<SpaceState> {
  const s = await openClusterSession(c, c.api);
  const signed = await signClusterAction(s.keys, { type: "space_delete" }, { space: `u-${c.user}` });
  return s.request<SpaceState>("POST", "/v1/space/delete", signed);
}

/** Отменить удаление, пока срок не вышел. */
export async function restoreSpace(c: ClusterRecord): Promise<SpaceState> {
  const s = await openClusterSession(c, c.api);
  return s.request<SpaceState>("POST", "/v1/space/restore");
}
