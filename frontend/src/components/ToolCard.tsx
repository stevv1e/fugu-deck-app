import { useState } from "react";
import type { Item } from "../timeline";

type ToolItem = Extract<Item, { kind: "tool" }>;

const TITLES: Record<string, string> = {
  memory_search: "Поиск в памяти",
  memory_save: "Запомнил",
  memory_update: "Обновил память",
  memory_delete: "Удалить из памяти",
  load_skill: "Скил",
  read_skill_file: "Файл скила",
  list_repos: "Репозитории",
  repo_info: "О репозитории",
  list_files: "Файлы",
  read_file: "Чтение файла",
  ci_status: "Статус CI",
  list_attachments: "Вложения",
  read_attachment: "Чтение вложения",
  create_repo: "Создать репозиторий",
  create_branch: "Создать ветку",
  commit_files: "Коммит",
  create_pull_request: "Pull / Merge Request",
};

const STATUS: Record<string, string> = {
  pending: "ждёт",
  running: "идёт",
  ok: "ok",
  error: "ошибка",
  denied: "отклонено",
};

function subtitle(name: string, a: any): string {
  if (!a) return "";
  const where = a.provider ? `${a.provider}` : "";
  switch (name) {
    case "list_repos":
      return [where, a.query].filter(Boolean).join(" · ");
    case "create_repo":
      return `${where} · ${a.name}`;
    case "commit_files":
      return `${a.repo} · ${a.base_branch ? `${a.base_branch} → ` : ""}${a.branch}`;
    case "create_branch":
      return `${a.repo} · ${a.branch}`;
    case "create_pull_request":
      return `${a.repo} · ${a.source_branch} → ${a.target_branch || "default"}`;
    case "read_file":
      return `${a.repo}/${a.path}`;
    case "read_attachment":
      return a.attachment_id;
    case "memory_save":
    case "memory_update":
      return (a.content || "").slice(0, 60);
    case "memory_search":
      return a.query + (a.project ? ` · ${a.project}` : "");
    case "load_skill":
    case "read_skill_file":
      return a.name;
    default:
      return [a.repo, a.path].filter(Boolean).join("/") || where;
  }
}

function size(s: string) {
  const b = new Blob([s]).size;
  return b > 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`;
}

function Details({ name, args }: { name: string; args: any }) {
  if (name === "commit_files") {
    return (
      <>
        <dl className="kv">
          <dt>repo</dt><dd>{args.provider} · {args.repo}</dd>
          <dt>ветка</dt><dd>{args.base_branch ? `${args.base_branch} → ` : ""}{args.branch}</dd>
          <dt>коммит</dt><dd>{args.message}</dd>
        </dl>
        <div className="files">
          {(args.files || []).map((f: any, i: number) => (
            <details className="file" key={i}>
              <summary>
                <span className={`op ${f.delete ? "del" : f.attachment_id ? "bin" : "add"}`}>
                  {f.delete ? "−" : f.attachment_id ? "⇪" : "+"}
                </span>
                <span className="p">{f.path}</span>
                <span className="sz">{f.delete ? "удалить" : f.attachment_id ? "вложение" : size(f.content || "")}</span>
              </summary>
              {f.content != null && <pre>{f.content}</pre>}
            </details>
          ))}
        </div>
      </>
    );
  }
  const entries = Object.entries(args || {});
  if (!entries.length) return null;
  return (
    <dl className="kv">
      {entries.map(([k, v]) => (
        <FragmentKV key={k} k={k} v={v} />
      ))}
    </dl>
  );
}

function FragmentKV({ k, v }: { k: string; v: any }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{typeof v === "string" ? v : JSON.stringify(v)}</dd>
    </>
  );
}

function ResultLink({ result }: { result: any }) {
  const url = result?.url;
  if (!url || typeof url !== "string") return null;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 12 }}>
      ↗ {url.replace(/^https?:\/\//, "")}
    </a>
  );
}

export function ToolCard({
  item,
  onDecide,
  canDecide = true,
}: {
  item: ToolItem;
  onDecide: (approvalId: string, approve: boolean) => Promise<void>;
  canDecide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const title = TITLES[item.name] || item.title || item.name;

  if (item.status === "pending" && item.approvalId) {
    const danger = item.risk === "dangerous";
    const decide = async (ok: boolean) => {
      setBusy(true);
      try {
        await onDecide(item.approvalId!, ok);
      } finally {
        setBusy(false);
      }
    };
    return (
      <div className={`tool approval cut ${danger ? "danger" : ""}`}>
        <div className="approval-title">
          <span className="risk">{danger ? "DANGER" : "WRITE"}</span>
          <h4>{title}</h4>
        </div>
        <div className="tool-body" style={{ borderTop: 0 }}>
          <Details name={item.name} args={item.args} />
        </div>
        {!canDecide ? (
          <div className="approval-actions"><span className="label">// ждёт подтверждения редактора</span></div>
        ) : (
        <div className="approval-actions">
          <button className="btn danger" disabled={busy} onClick={() => decide(false)}>Отклонить</button>
          <button className="btn primary" disabled={busy} onClick={() => decide(true)}>Разрешить</button>
        </div>
        )}
      </div>
    );
  }

  return (
    <div className={`tool ${open ? "open" : ""}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className="chev">›</span>
        <span className="nm">
          {title} <em>{subtitle(item.name, item.args)}</em>
        </span>
        <span className={`st ${item.status}`}>{STATUS[item.status]}</span>
      </button>
      {item.status === "ok" && !open && item.result?.url && (
        <div style={{ padding: "0 12px 10px 32px" }}>
          <ResultLink result={item.result} />
        </div>
      )}
      {open && (
        <div className="tool-body">
          <Details name={item.name} args={item.args} />
          {item.error && <div className="err-line">✕ {item.error}</div>}
          {item.result !== undefined && (
            <>
              <ResultLink result={item.result} />
              <pre className="json">{JSON.stringify(item.result, null, 2)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
