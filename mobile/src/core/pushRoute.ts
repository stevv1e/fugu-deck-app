/** Куда вести по нажатию на уведомление: чат пространства или экран устройств кластера. */
export type PushData = { api?: unknown; kind?: unknown; space?: unknown; cid?: unknown };
type ClusterRef = { id: string; api: string };

export function pushRoute(data: PushData | undefined, clusters: ClusterRef[], sidOf: (cluster: string, team: string | null) => string): string | null {
  if (!data || typeof data.api !== "string") return null;
  const c = clusters.find((x) => x.api === data.api); // уведомление от кластера, которого на телефоне нет, — никуда
  if (!c) return null;
  if (data.kind === "device") return `/devices/${c.id}`;
  const space = typeof data.space === "string" ? data.space : "";
  const sid = sidOf(c.id, /^t-[a-z0-9]{6,20}$/.test(space) ? space : null);
  const cid = typeof data.cid === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(data.cid) ? data.cid : "";
  return cid ? `/s/${sid}/c/${cid}` : `/s/${sid}`;
}
