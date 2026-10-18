/** Чаты и настройки на устройстве. Список чатов — одной записью, сообщения каждого чата — отдельной. */
import { DEFAULT_MODELS, type Msg, type Usage } from "@/core/providers";
import { getJson, remove, setJson } from "@/platform/storage";

export type ChatMeta = { id: string; title: string; model: string; updated: number };
export type StoredMsg = Msg & { model?: string; usage?: Usage; reasoning?: string; error?: string; at: number };

const LIST = "fl:chats";
const chatKey = (id: string) => `fl:chat:${id}`;

// Подписка на изменения списка (боковая панель компьютера) и открытый сейчас чат.
const subs = new Set<() => void>();
export function onChatsChanged(f: () => void): () => void {
  subs.add(f);
  return () => void subs.delete(f);
}
const changed = () => subs.forEach((f) => f());
let open: string | null = null;
export const openChatId = () => open;
export function setOpenChat(id: string | null): void {
  if (open === id) return;
  open = id;
  changed();
}

/** Адрес экрана нового чата. */
export const newChatHref = () => ({ pathname: "/c/[id]" as const, params: { id: `new-${Date.now().toString(36)}` } });

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const listChats = async () => (await getJson<ChatMeta[]>(LIST, [])).sort((a, b) => b.updated - a.updated);
export const getMessages = (id: string) => getJson<StoredMsg[]>(chatKey(id), []);

export async function saveChat(meta: ChatMeta, msgs: StoredMsg[]): Promise<void> {
  await setJson(chatKey(meta.id), msgs);
  const all = (await getJson<ChatMeta[]>(LIST, [])).filter((c) => c.id !== meta.id);
  await setJson(LIST, [meta, ...all]);
  changed();
}

export async function getChat(id: string): Promise<ChatMeta | null> {
  return (await getJson<ChatMeta[]>(LIST, [])).find((c) => c.id === id) ?? null;
}

export async function deleteChat(id: string): Promise<void> {
  await remove(chatKey(id));
  await setJson(LIST, (await getJson<ChatMeta[]>(LIST, [])).filter((c) => c.id !== id));
  changed();
}

export type Settings = { models: string[]; defaultModel: string; system: string };

const DEFAULT_SYSTEM = "Ты — помощник. Отвечай по-русски, если пользователь пишет по-русски. Будь точным и кратким.";

export async function getSettings(): Promise<Settings> {
  const s = await getJson<Partial<Settings>>("fl:settings", {});
  const models = s.models?.length ? s.models : DEFAULT_MODELS;
  return { models, defaultModel: s.defaultModel && models.includes(s.defaultModel) ? s.defaultModel : models[0], system: s.system ?? DEFAULT_SYSTEM };
}

export const saveSettings = (s: Settings) => setJson("fl:settings", s);
