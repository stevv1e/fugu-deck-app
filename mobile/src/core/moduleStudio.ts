import { sha256 } from "@noble/hashes/sha2.js";

import { utf8 } from "@/core/bytes";
import { readResponseText, validManifest, type GitSource, type InstalledModule, type ModuleManifest } from "@/core/modules";

export type ModuleTemplate = "tool" | "panel" | "schedule" | "prompts";
export type ModuleDraft = { manifest: ModuleManifest; code: string };

const TEMPLATES: Record<ModuleTemplate, { name: string; id: string; description: string; storage: boolean; code: string }> = {
  tool: {
    id: "text-transformer", name: "Text Transformer", description: "Локальное преобразование текста без сети.", storage: false,
    code: `const app=document.getElementById('app');app.innerHTML='<textarea id="input" rows="7" placeholder="Текст"></textarea><p><button id="run">Преобразовать</button></p><pre id="out"></pre>';document.getElementById('run').onclick=()=>{document.getElementById('out').textContent=document.getElementById('input').value.toUpperCase()};`,
  },
  panel: {
    id: "local-panel", name: "Local Panel", description: "Панель с локальным черновиком в хранилище модуля.", storage: true,
    code: `const app=document.getElementById('app');app.innerHTML='<textarea id="draft" rows="8" placeholder="Локальный черновик"></textarea><p><button id="save">Сохранить</button> <span id="state"></span></p>';const input=document.getElementById('draft');window.fugu.call('storage.get',{key:'draft'}).then(v=>{input.value=v||''});document.getElementById('save').onclick=async()=>{await window.fugu.call('storage.set',{key:'draft',value:input.value});document.getElementById('state').textContent='Сохранено'};`,
  },
  schedule: {
    id: "visual-timer", name: "Visual Timer", description: "Таймер и расписание в открытой панели; фоновых задач не создаёт.", storage: false,
    code: `const app=document.getElementById('app');app.innerHTML='<input id="minutes" type="number" min="1" value="25" aria-label="Минуты"><button id="start">Запустить</button><h1 id="left">25:00</h1>';let timer;document.getElementById('start').onclick=()=>{clearInterval(timer);let left=Math.max(1,Number(document.getElementById('minutes').value)||25)*60;timer=setInterval(()=>{left--;document.getElementById('left').textContent=String(Math.floor(left/60)).padStart(2,'0')+':'+String(left%60).padStart(2,'0');if(left<=0)clearInterval(timer)},1000)};`,
  },
  prompts: {
    id: "prompt-pack", name: "Prompt Pack", description: "Набор локальных шаблонов запросов для копирования.", storage: false,
    code: `const prompts=['Объясни тему простыми словами: ','Составь план по теме: ','Найди риски и допущения: '];const app=document.getElementById('app');app.innerHTML='<select id="template">'+prompts.map((p,i)=>'<option value="'+i+'">'+p+'</option>').join('')+'</select><textarea id="topic" rows="4" placeholder="Тема"></textarea><p><button id="make">Собрать запрос</button></p><textarea id="result" rows="6"></textarea>';document.getElementById('make').onclick=()=>{document.getElementById('result').value=prompts[Number(document.getElementById('template').value)]+document.getElementById('topic').value};`,
  },
};

export function draftFromTemplate(template: ModuleTemplate): ModuleDraft {
  const item = TEMPLATES[template];
  return makeDraft({
    format: "fugu-module/1", id: item.id, name: item.name, version: "0.1.0", description: item.description,
    entry: "module.js", min_app: "0.1.0", permissions: { network: [], storage: item.storage },
  }, item.code);
}

export function makeDraft(input: Omit<ModuleManifest, "sha256"> | ModuleManifest, code: string): ModuleDraft {
  if (!code.trim() || utf8(code).length > 256_000) throw new Error("JS entry должен содержать от 1 байта до 256 КБ");
  const digest = [...sha256(utf8(code))].map((x) => x.toString(16).padStart(2, "0")).join("");
  return { manifest: validManifest({ ...input, sha256: digest }), code };
}

export function draftModule(draft: ModuleDraft): InstalledModule {
  return { manifest: draft.manifest, code: draft.code, commit: "local", repository: "Локальный черновик", path: "", installedAt: Date.now(), enabled: true };
}

async function githubJson(fetcher: typeof fetch, token: string, method: string, url: string, body?: unknown): Promise<any> {
  const response = await fetcher(url, {
    method, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await readResponseText(response, 256_000);
  if (!response.ok) throw new Error(`GitHub: HTTP ${response.status}`);
  return text ? JSON.parse(text) : {};
}

export async function publishDraft(source: GitSource, token: string, draft: ModuleDraft, fetcher: typeof fetch = fetch): Promise<{ commit: string; url: string }> {
  if (!token.trim()) throw new Error("Для публикации нужен GitHub token с правом Contents: Read and write");
  if (!/^[A-Za-z0-9_.\/-]{1,100}$/.test(source.ref) || source.ref.includes("..") || source.ref.startsWith("/")) throw new Error("Некорректная ветка публикации");
  const root = `https://api.github.com/repos/${source.owner}/${source.repo}`;
  const call = (method: string, path: string, body?: unknown) => githubJson(fetcher, token.trim(), method, root + path, body);
  const branch = await call("GET", `/git/refs/heads/${encodeURIComponent(source.ref)}`);
  const parent = String(branch.object?.sha || "");
  if (!/^[a-f0-9]{40}$/.test(parent)) throw new Error("Ветка не найдена; сначала создайте репозиторий и ветку");
  const current = await call("GET", `/git/commits/${parent}`);
  const prefix = source.path ? `${source.path}/` : "";
  const tree = await call("POST", "/git/trees", { base_tree: current.tree?.sha, tree: [
    { path: `${prefix}module.json`, mode: "100644", type: "blob", content: JSON.stringify(draft.manifest, null, 2) + "\n" },
    { path: `${prefix}${draft.manifest.entry}`, mode: "100644", type: "blob", content: draft.code },
  ] });
  const commit = await call("POST", "/git/commits", { message: `Publish ${draft.manifest.id} ${draft.manifest.version}`, tree: tree.sha, parents: [parent] });
  const commitSha = String(commit.sha || "");
  if (!/^[a-f0-9]{40}$/.test(commitSha)) throw new Error("GitHub не создал commit");
  await call("PATCH", `/git/refs/heads/${encodeURIComponent(source.ref)}`, { sha: commitSha, force: false });
  return { commit: commitSha, url: `${source.repository}/tree/${commitSha}/${source.path}` };
}
