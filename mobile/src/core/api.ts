/** API сервера Fugu Deck для приложения. Всё идёт через DeviceSession (DPoP + подписи). */
import { uploadBody, type PickedFile, type Uploaded } from "./attachments";
import { argsHash } from "./crypto";
import type { DeviceSession } from "./session";
import type { Conversation, ConversationFull, DeviceRow, Project, RunEvent } from "./types";

/** Заметка базы знаний, как её отдаёт агент для экрана. id — для экрана (n<число>), mid — номер записи для правки. */
export type KbNote = {
  id: string; mid: number | null; area: string; title: string; body: string; days: number; source: string; src: string;
  stale: boolean; ext: boolean; pinned: boolean; tags: string; hub?: boolean;
};
export type KbGraph = {
  project: { id: string; name: string }; hub: string; notes: KbNote[]; edges: [string, string, string, number][];
  areas: Record<string, { name: string; groups: [string, string[]][] }>; sources: Record<string, string>; link_types: Record<string, string>;
};
export type NoteInput = { content: string; title?: string | null; area?: string | null; tags?: string; grp?: string | null; source_ref?: string | null; pinned?: boolean };

export type AppConfig = {
  mode: string;
  me: { id: string; username: string; display_name: string; role: string };
  models: string[];
  default_model: string;
  llm_ready: string[];
  approval_mode: string;
  providers: Record<string, { ok: boolean; login?: string; error?: string }>;
  [k: string]: unknown;
};

export type ApprovalRequest = Extract<RunEvent, { type: "approval_request" }>;

const enc = encodeURIComponent;

export class DeckApi {
  constructor(readonly s: DeviceSession) {}

  config = () => this.s.request<AppConfig>("GET", "/api/config");
  projects = () => this.s.request<Project[]>("GET", "/api/projects");
  createProject = (name: string, description = "") => this.s.request<Project>("POST", "/api/projects", { name, description });
  conversations = (pid: string) => this.s.request<Conversation[]>("GET", `/api/projects/${enc(pid)}/conversations`);
  createConversation = (pid: string, model?: string) =>
    this.s.request<Conversation>("POST", `/api/projects/${enc(pid)}/conversations`, { model: model || null });
  conversation = (cid: string) => this.s.request<ConversationFull>("GET", `/api/conversations/${enc(cid)}`);
  // ---- база знаний: заметки проекта со связями (агент: /api/projects/<id>/kb, /api/memory) ----
  kb = (pid: string) => this.s.request<KbGraph>("GET", `/api/projects/${enc(pid)}/kb`);
  addNote = (pid: string, n: NoteInput) => this.s.request<{ id: number }>("POST", `/api/projects/${enc(pid)}/memory`, n);
  updateNote = (mid: number, n: Partial<NoteInput> & { stale?: boolean }) => this.s.request("PATCH", `/api/memory/${mid}`, n);
  deleteNote = (mid: number) => this.s.request("DELETE", `/api/memory/${mid}`);
  linkNotes = (from: number, to: number, type: string) => this.s.request("POST", `/api/memory/${from}/links`, { to, type });
  unlinkNotes = (a: number, b: number) => this.s.request("DELETE", `/api/memory/${a}/links/${b}`);

  /** Удалить чат со всей перепиской и вложениями; идущее задание агента в нём останавливается. */
  deleteConversation = (cid: string) => this.s.request<{ ok: boolean }>("DELETE", `/api/conversations/${enc(cid)}`);
  send = (cid: string, content: string, model?: string, attachmentIds: string[] = []) =>
    this.s.request<{ run_id: string }>("POST", `/api/conversations/${enc(cid)}/messages`, { content, model: model || null, attachment_ids: attachmentIds });
  /** Загрузить вложение в чат; файл уходит в JSON как base64 (защищённый канал передаёт тело только текстом). */
  upload = (cid: string, f: PickedFile) =>
    // файл до 8 МБ по мобильной сети — это не полминуты обычного запроса
    this.s.request<Uploaded>("POST", `/api/conversations/${enc(cid)}/attachments/json`, uploadBody(f), { timeoutMs: 180000 });
  deleteProject = (pid: string) => this.s.request<{ ok: boolean }>("DELETE", `/api/projects/${enc(pid)}`);
  /** Сменить модель чата (личное пространство; в общем — через предложение и спонсора). */
  setModel = (cid: string, model: string) => this.s.request<{ applied: boolean }>("POST", `/api/conversations/${enc(cid)}/model`, { model });
  cancel = (rid: string) => this.s.request("POST", `/api/runs/${enc(rid)}/cancel`);

  /**
   * Подтверждение инструмента. «Разрешить» подписывается ключом подтверждения (биометрия):
   * подписываем хэш тех аргументов, которые человек видит на экране, — сервер сверит со своими.
   * «Отклонить» подписи не требует: это безопасное направление.
   */
  async approve(req: ApprovalRequest, approve: boolean, comment = "", typedServer?: string) {
    const path = `/api/approvals/${enc(req.approval_id)}`;
    if (!approve) return this.s.request("POST", path, { approve: false, comment });
    if (req.sign) {
      // Команда на сервере: подпись предназначена ssh-gateway и покрывает саму команду, а не «разрешение инструмента».
      return this.s.request("POST", path, { approve: true, comment, ...(await this.s.signCommand(req.sign, typedServer)) });
    }
    // Формат подписи зависит от того, кто её проверяет: одиночный сервер — сам, пространство кластера — через keyguard.
    const signed = await this.s.signApproval({ approvalId: req.approval_id, tool: req.name, argsHash: argsHash(req.args), title: req.title || req.name });
    return this.s.request("POST", path, { approve: true, comment, ...signed });
  }

  devices = () => this.s.request<DeviceRow[]>("GET", "/api/devices");

  async revokeDevice(did: string, name: string) {
    const signed = await this.s.signAction({ type: "revoke_device", target: did }, `Отозвать «${name}»`);
    return this.s.request("POST", `/api/devices/${enc(did)}/revoke`, signed);
  }

  renewCert = (csr: string) => this.s.request<{ cert_pem: string; ca_pem: string; expires: number }>("POST", "/api/devices/cert", { csr });
  invite = () => this.s.request<{ link: string; url: string; fingerprint: string }>("GET", "/api/server/invite");

  /** Следить за запуском агента: события с seq, после обрыва продолжаем с последнего. */
  followRun(rid: string, onEvent: (e: RunEvent) => void, on: { onEnd?(err?: Error): void; onState?(s: string): void } = {}) {
    let after = 0;
    return this.s.sse(
      () => `/api/runs/${enc(rid)}/events?after=${after}`,
      {
        onMessage: (m) => {
          if (!m.data) return;
          let e: RunEvent;
          try {
            e = JSON.parse(m.data);
          } catch {
            return;
          }
          if (typeof e.seq === "number") after = Math.max(after, e.seq + 1);
          onEvent(e);
        },
        onEnd: on.onEnd,
        onState: on.onState,
      },
    );
  }

  /** Общий поток изменений: новые чаты, запросы на подтверждение, присутствие. */
  followUpdates(onEvent: (e: any) => void, deviceTag: string) {
    return this.s.sse(() => `/api/events?device_id=${enc(deviceTag)}`, {
      onMessage: (m) => {
        try {
          onEvent(JSON.parse(m.data));
        } catch {}
      },
    });
  }
}
