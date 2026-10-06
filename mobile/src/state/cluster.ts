/** Кластеры v2: запись хранится в prefs, refresh-токен — в защищённом хранилище (Keychain/Keystore). */
import type { ClusterInvite, DeviceStatus } from "@/core/cluster";
import { prefs, secrets } from "@/platform/storage";

export type ClusterRecord = {
  id: string;                                   // хост Keycloak
  api: string; issuer: string; join: string; hpke: string;
  alias: string;                                // псевдоним ключей устройства
  deviceId: string; user: string; name: string;
  status: DeviceStatus["status"];
  certPem?: string;
};

const KEY = "fd.clusters";
export const clusterId = (c: Pick<ClusterInvite, "issuer">) => new URL(c.issuer).host;
export const listClusters = () => prefs.get<ClusterRecord[]>(KEY, []);
export async function getCluster(id: string) { return (await listClusters()).find((c) => c.id === id) ?? null; }
export async function saveCluster(r: ClusterRecord) {
  const all = (await listClusters()).filter((c) => c.id !== r.id);
  await prefs.set(KEY, [...all, r]);
}
export const saveRefresh = (id: string, t: string | undefined) => (t ? secrets.set(`cluster.${id}.refresh`, t) : Promise.resolve());
export const loadRefresh = (id: string) => secrets.get(`cluster.${id}.refresh`);
