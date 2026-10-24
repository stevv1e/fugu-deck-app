import type { Jwk } from "./crypto";

/** Что сервер рассказывает о себе до входа: GET /.well-known/fugu-deck */
export type ServerInfo = {
  app: "fugu-deck";
  protocol: number;
  name: string;
  mode: "standalone";
  identity: { alg: "Ed25519"; key: string; fingerprint: string };
  auth: { password: boolean; totp: boolean };
  devices: { dpop: boolean; signed_actions: boolean; mtls: MtlsMode };
  public_url: string | null;
};

export type MtlsMode = "off" | "optional" | "required";
export type KeyStorage = "secure_enclave" | "strongbox" | "tee" | "software";

export type User = { id: string; username: string; display_name: string; role: string };

/** Сервер в списке приложения. Ключ идентичности закреплён при добавлении (пиннинг). */
export type ServerRecord = {
  id: string;
  url: string;
  name: string;
  identityKey: string;
  fingerprint: string;
  verifiedBy: "qr" | "manual";
  addedAt: number;
  mtls: MtlsMode;
  device?: EnrolledDevice;
};

export type EnrolledDevice = {
  id: string;
  user: User;
  keyAlias: string;
  keyStorage: KeyStorage;
  enrolledAt: number;
  certPem?: string | null;
  caPem?: string | null;
  certExpires?: number | null;
};

export type DeviceRow = {
  id: string;
  name: string;
  platform: string;
  key_storage: KeyStorage;
  created_at: number;
  last_seen: number | null;
  revoked_at: number | null;
  cert_expires: number | null;
  current: boolean;
};

export type Project = {
  id: string; name: string; description?: string; my_role?: string;
  repos?: { provider: "github" | "gitlab"; repo: string }[];
  [k: string]: unknown;
};

export type Conversation = {
  id: string;
  project_id: string;
  title: string;
  model: string;
  updated_at?: number;
  running?: boolean;
  agent_id?: string;
  parent_id?: string | null; // под-чат оркестратора: id родительского чата, из которого его запустили
  [k: string]: unknown;
};

export type Attachment = { id: string; filename: string; mime: string; size: number };

export type StoredMessage = {
  id: number | string;
  role: "user" | "assistant" | "tool" | "note";
  content: string | null;
  created_at: number;
  tool_calls?: { id: string; name: string; args: any }[];
  tool_call_id?: string;
  name?: string;
  ok?: boolean;
  meta?: { author?: string; author_id?: string; attachments?: Attachment[]; model?: string; [k: string]: unknown };
};

export type ConversationFull = Conversation & {
  messages: StoredMessage[];
  active_run: string | null;
  active_run_started_at?: number | null;
  my_role?: string;
  models?: string[];
  [k: string]: unknown;
};

export type RunEvent =
  | { seq: number; type: "start"; model: string }
  | { seq: number; type: "text"; delta: string }
  | { seq: number; type: "thinking"; step: number }
  | { seq: number; type: "tool_call_building"; index: number; name: string }
  | { seq: number; type: "usage"; cost_usd?: number; prompt_tokens?: number; completion_tokens?: number }
  | {
      seq: number;
      type: "approval_request";
      approval_id: string;
      call_id: string;
      name: string;
      title?: string;
      args: any;
      risk?: string;
      args_sha256?: string;
      /** Команда на сервере: подписывается не разрешение инструмента, а сама команда — это действие проверит ssh-gateway. */
      sign?: { type: "ssh_write" | "ssh_danger"; agent: string; server: string; command: string } | null;
      /** Пробный прогон команды (выполнил шлюз до подтверждения). */
      preview?: { command: string; exit_code?: number; output?: string; error?: string; truncated?: boolean } | null;
      /** Независимая проверка команды другим запросом к модели: что сделает и чем рискованна. */
      review?: string | null;
      /** Агент настроен «без подписи»: «Разрешить» — без биометрии. */
      nosign?: boolean;
    }
  | { seq: number; type: "approval_resolved"; approval_id: string; call_id: string; approved: boolean }
  | { seq: number; type: "tool_start"; call_id: string; name: string; title?: string; args: any; risk?: string }
  | { seq: number; type: "tool_end"; call_id: string; name: string; ok: boolean; result?: any; error?: string }
  | { seq: number; type: "message_saved"; has_tools: boolean }
  | { seq: number; type: "notice"; text: string }
  | { seq: number; type: "error"; message: string }
  | { seq: number; type: "done" }
  | { seq: number; type: "cancelled" };

export type EnrollResult = {
  device_id: string;
  user: User;
  receipt: Record<string, unknown>;
  server_sig: string;
  access_token: string;
  token_type: "DPoP";
  expires_in: number;
  cert_pem: string | null;
  ca_pem: string | null;
};

export type { Jwk };
