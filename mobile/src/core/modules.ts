import { sha256 } from "@noble/hashes/sha2.js";
import { utf8 } from "@/core/bytes";

export const OFFICIAL_MODULES = "https://github.com/stevv1e/fugu-modules";
const HEX64 = /^[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9-]{1,60}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
const COMMIT = /^[a-f0-9]{40}$/;

export type ModuleManifest = {
  format: "fugu-module/1";
  id: string;
  name: string;
  version: string;
  description: string;
  entry: string;
  sha256: string;
  min_app: string;
  permissions: { network?: string[]; storage?: boolean };
};
export type ModuleIndexEntry = { id: string; path: string; name: string; description: string; version: string; category?: string };
export type ModuleIndex = { format: "fugu-modules/1"; modules: ModuleIndexEntry[] };
export type InstalledModule = {
  manifest: ModuleManifest;
  commit: string;
  repository: string;
  path: string;
  code: string;
  installedAt: number;
  enabled: boolean;
};
export type GitSource = { owner: string; repo: string; ref: string; path: string; repository: string };

function validManifest(value: any): ModuleManifest {
  if (!value || value.format !== "fugu-module/1" || !ID.test(value.id) || !VERSION.test(value.version)) throw new Error("Некорректный формат или ID модуля");
  if (typeof value.name !== "string" || !value.name.trim() || typeof value.description !== "string") throw new Error("У модуля должны быть имя и описание");
  if (typeof value.entry !== "string" || !value.entry.endsWith(".js") || value.entry.startsWith("/") || value.entry.split("/").includes("..")) throw new Error("Entry должен быть локальным JS-файлом");
  if (!HEX64.test(value.sha256 || "")) throw new Error("В манифесте нужен SHA-256 entry");
  if (typeof value.min_app !== "string" || !value.min_app) throw new Error("Нужна min_app");
  const permissions = value.permissions || {};
  const known = Object.keys(permissions).every((key) => ["network", "storage"].includes(key));
    if (!known || (permissions.network && (!Array.isArray(permissions.network) || permissions.network.length > 20))) throw new Error("Неизвестные разрешения модуля");
  const network = permissions.network || [];
  if (network.some((host: unknown) => typeof host !== "string" || !/^[a-z0-9.-]+(?::\d+)?$/.test(host))) throw new Error("Некорректный домен в разрешениях");
  return { ...value, name: value.name.trim(), description: value.description.slice(0, 1000), permissions: { network, storage: !!permissions.storage } };
}

export function parseGitSource(input: string, ref = "main", modulePath = ""): GitSource {
  const url = new URL(input.trim());
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || parts.length < 2) throw new Error("Нужен публичный URL GitHub или токен для приватного репозитория");
  const [owner, repoRaw] = parts;
  const repo = repoRaw.replace(/\.git$/, "");
  let sourceRef = ref || "main";
  let path = modulePath.replace(/^\/+|\/+$/g, "");
  if (parts[2] === "tree" || parts[2] === "blob") {
    if (parts.length < 4) throw new Error("В ссылке не указан ref");
    sourceRef = parts[3];
    path = parts.slice(4).join("/").replace(/\/module\.json$/, "");
  } else if (parts.length > 2) {
    throw new Error("Ссылка должна вести на репозиторий или /tree/<ref>/<папка модуля>");
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo) || path.split("/").includes("..")) throw new Error("Некорректный репозиторий или путь");
  return { owner, repo, ref: sourceRef, path, repository: `https://github.com/${owner}/${repo}` };
}

function bytesHex(value: Uint8Array): string {
  return [...value].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function responseText(response: Response, limit: number): Promise<string> {
  if (!response.ok) throw new Error(`GitHub: HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > limit) throw new Error("Файл модуля слишком большой");
  const text = await response.text();
  if (utf8(text).length > limit) throw new Error("Файл модуля слишком большой");
  return text;
}

async function fetchText(url: string, token: string, fetcher: typeof fetch, limit = 256_000): Promise<string> {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  return responseText(await fetcher(url, { headers }), limit);
}

function newerVersion(a: string, b: string): boolean {
  const left = a.split("-")[0].split(".").map(Number);
  const right = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i];
  return false;
}

export async function installModule(source: GitSource, token = "", fetcher: typeof fetch = fetch): Promise<InstalledModule> {
  const api = `https://api.github.com/repos/${source.owner}/${source.repo}/commits/${encodeURIComponent(source.ref)}`;
  const resolved = JSON.parse(await fetchText(api, token, fetcher, 64_000));
  const commit = String(resolved.sha || "");
  if (!COMMIT.test(commit)) throw new Error("GitHub не вернул commit SHA");
  const base = `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${commit}`;
  const prefix = source.path ? `${source.path}/` : "";
  const manifest = validManifest(JSON.parse(await fetchText(`${base}/${prefix}module.json`, token, fetcher)));
  if (newerVersion(manifest.min_app, "0.1.0")) throw new Error(`Для модуля нужен Fugu Deck ≥ ${manifest.min_app}`);
  const code = await fetchText(`${base}/${prefix}${manifest.entry}`, token, fetcher);
  if (bytesHex(sha256(utf8(code))) !== manifest.sha256) throw new Error("SHA-256 не совпал: модуль не установлен");
  return { manifest, commit, repository: source.repository, path: source.path, code, installedAt: Date.now(), enabled: true };
}

export async function loadOfficialCatalog(fetcher: typeof fetch = fetch): Promise<{ commit: string; entries: ModuleIndexEntry[]; sources: Record<string, GitSource> }> {
  const root = parseGitSource(OFFICIAL_MODULES);
  const commitData = JSON.parse(await fetchText(`https://api.github.com/repos/${root.owner}/${root.repo}/commits/main`, "", fetcher, 64_000));
  const commit = String(commitData.sha || "");
  if (!COMMIT.test(commit)) throw new Error("GitHub не вернул commit каталога");
  const index = JSON.parse(await fetchText(`https://raw.githubusercontent.com/${root.owner}/${root.repo}/${commit}/index.json`, "", fetcher, 256_000)) as ModuleIndex;
  if (index.format !== "fugu-modules/1" || !Array.isArray(index.modules)) throw new Error("Некорректный index.json");
  const entries = index.modules.filter((item) => ID.test(item.id) && item.path && item.name && VERSION.test(item.version)).slice(0, 100);
  const sources = Object.fromEntries(entries.map((item) => [item.id, parseGitSource(`${root.repository}/tree/${commit}/${item.path}`)]));
  return { commit, entries, sources };
}

export function modulePermissions(manifest: ModuleManifest): string[] {
  const out: string[] = [];
  if (manifest.permissions.storage) out.push("локальное хранилище модуля");
  for (const host of manifest.permissions.network || []) out.push(`GET https://${host}`);
  return out.length ? out : ["только интерфейс, без сети и хранилища"];
}
