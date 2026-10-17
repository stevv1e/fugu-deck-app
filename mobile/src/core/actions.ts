/**
 * Схема подписанных действий для keyguard — единственный источник: keyguard проверяет ту же схему (schema.go),
 * общие векторы создаёт tests/vectors.ts (fugu-deck-keyguard/testdata/action-vectors.json).
 *
 * Правило отображения (ARCHITECTURE-v2.md, 3.4): текст, который видит человек при биометрии, приложение строит само
 * из полей действия. Поэтому:
 *   1) подписываются только известные типы действий;
 *   2) у каждого типа — точный набор полей, лишние запрещены (иначе можно подписать то, что не показано);
 *   3) в строках запрещены управляющие, невидимые и bidi-символы (иначе показанное ≠ подписанному);
 *   4) описание и подписываемые байты строятся из одного замороженного объекта (prepareAction).
 *
 * Конверт: поля типа + device_id (кто подписывает), nonce, ts (секунды) и — только у действий в пространстве — space.
 * Числа: целые или суммы с ≤ 2 знаками (money) — другой формы keyguard не примет.
 * key_put: ключ API шифруется HPKE (hpke.ts) с AAD "key_put|<device_id>|<provider>|<nonce конверта>";
 * ct_sha256 = SHA-256(enc||ct), key_hint — последние 4 символа ключа (keyguard сверяет их с расшифрованным).
 */

export type Provider = 'anthropic' | 'sakana' | 'deepseek' | 'github' | 'gitlab';
export type LlmProvider = 'anthropic' | 'sakana' | 'deepseek';
/** none — исключить участника из пространства. */
export type Role = 'reader' | 'editor' | 'owner' | 'none';

export type ActionBody =
  | { type: 'key_put'; provider: Provider; key_hint: string; ct_sha256: string }
  | { type: 'key_delete'; provider: Provider }
  // MCP-сервер владельца: адрес и, если нужен, токен (HPKE, AAD "mcp_put|<device_id>|<id>|<nonce>"); token_hint и
  // ct_sha256 — оба null без токена.
  | { type: 'mcp_put'; id: string; name: string; url: string; token_hint: string | null; ct_sha256: string | null }
  | { type: 'mcp_delete'; id: string }
  // Лимит личных расходов на модели в месяц (своим ключом в личном пространстве); null — без лимита.
  | { type: 'spend_limit'; limit_usd_month: number | null }
  | {
      type: 'grant';
      chat: string;
      provider: Provider;
      model: string;
      limit_usd: number;
      limit_tokens: number | null;
      until: string;
      key_until: string;
      per_member_usd_day: number | null;
      members: string[];
      proposal: string;
    }
  | { type: 'grant_revoke'; chat: string; proposal: string }
  | { type: 'server_add'; server: string; host: string; port: number; user: string; host_key: string }
  | { type: 'agent_rights'; agent: string; servers: string[]; read_without_confirm: boolean; limit_usd_month: number | null }
  | { type: 'ssh_write'; agent: string; server: string; command: string }
  | { type: 'ssh_danger'; agent: string; server: string; command: string; typed_server: string }
  | { type: 'role_change'; member: string; role: Role }
  // target, а не device_id: device_id конверта — это устройство, которое ПОДПИСЫВАЕТ (иначе оно затирало бы цель).
  // Регистрация: подписывает ключ подтверждения НОВОГО устройства; оба отпечатка связывают его с ключом сессии.
  | { type: 'device_enroll'; session_jkt: string; confirm_jkt: string; name: string }
  // user и name подтверждаемого устройства keyguard сверяет со своим реестром: подписано то, что показано.
  | { type: 'device_approve'; user: string; target: string; name: string }
  | { type: 'device_revoke'; user: string; target: string }
  // Приглашение на ник user: себе — ещё одно своё устройство, другому (только администратор) — новый пользователь.
  | { type: 'invite_create'; user: string }
  | { type: 'account_delete'; user: string }
  // Удаляется пространство из конверта (space). Подпись проверяет space-operator через keyguard: без неё
  // запрос удаления от control-plane не исполняется.
  | { type: 'space_delete' }
  // Разрешение агенту выполнить действие инструмента. Подписывается то, что человек видит на карточке:
  // какой инструмент и хеш его аргументов; агент пространства проверяет подпись через keyguard.
  | { type: 'tool_approve'; approval: string; tool: string; args_sha256: string };

export type ActionType = ActionBody['type'];
export type ActionEnvelope = ActionBody & { space?: string; device_id: string; nonce: string; ts: number };

export interface ActionDescription {
  title: string;
  lines: string[];
  danger: boolean;
}

export interface PreparedAction {
  readonly envelope: Readonly<ActionEnvelope>;
  readonly description: Readonly<ActionDescription>;
}

// ---------- проверка полей ----------

type Check = (v: unknown, name: string) => void;

const bad = (name: string, why: string) => new Error(`Поле «${name}»: ${why}`);

// C0/C1, zero-width, bidi-override/isolate, BOM, разделители строк.
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/;

const str =
  (max = 120, re?: RegExp): Check =>
  (v, n) => {
    if (typeof v !== 'string' || v.length === 0) throw bad(n, 'нужна непустая строка');
    if (v.length > max) throw bad(n, `длиннее ${max} символов`);
    if (HIDDEN.test(v)) throw bad(n, 'содержит невидимые или управляющие символы');
    if (v !== v.trim()) throw bad(n, 'пробелы по краям');
    if (re && !re.test(v)) throw bad(n, 'неверный формат');
  };

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const id = str(63, ID);
// ID устройства: отпечаток ключа (43 символа) или короткий ID keyguard (d-<16 символов отпечатка>).
const deviceId = str(64, /^[A-Za-z0-9_-]{8,64}$/);
const JKT = /^[A-Za-z0-9_-]{43}$/;
const SPACE = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;

/** Действия в пространстве несут space в конверте (и человек его видит); у остальных поля space нет вовсе. */
export const IN_SPACE: Record<ActionType, boolean> = {
  key_put: false, key_delete: false, mcp_put: false, mcp_delete: false, spend_limit: false, device_enroll: false, device_approve: false, device_revoke: false, account_delete: false, invite_create: false,
  grant: true, grant_revoke: true, server_add: true, agent_rights: true, ssh_write: true, ssh_danger: true,
  role_change: true, space_delete: true, tool_approve: true,
};
const date: Check = (v, n) => {
  str(10, /^\d{4}-\d{2}-\d{2}$/)(v, n);
  const d = new Date(`${v as string}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw bad(n, 'несуществующая дата');
};
const int =
  (min: number, max: number): Check =>
  (v, n) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw bad(n, `целое от ${min} до ${max}`);
  };
const money: Check = (v, n) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 100_000) throw bad(n, 'сумма от 0 до 100 000');
  if (Math.round(v * 100) !== v * 100) throw bad(n, 'не больше двух знаков после запятой');
};
const bool: Check = (v, n) => {
  if (typeof v !== 'boolean') throw bad(n, 'нужно true/false');
};
const oneOf =
  (...vals: string[]): Check =>
  (v, n) => {
    if (typeof v !== 'string' || !vals.includes(v)) throw bad(n, `одно из: ${vals.join(', ')}`);
  };
const nullable =
  (c: Check): Check =>
  (v, n) => {
    if (v !== null) c(v, n);
  };
const list =
  (c: Check, min: number, max: number): Check =>
  (v, n) => {
    if (!Array.isArray(v) || v.length < min || v.length > max) throw bad(n, `список из ${min}–${max} элементов`);
    v.forEach((x, i) => c(x, `${n}[${i}]`));
    if (new Set(v).size !== v.length) throw bad(n, 'повторяющиеся элементы');
  };

const MCP_ID = /^[a-z][a-z0-9-]{1,30}$/;
const PROVIDERS = ['anthropic', 'sakana', 'deepseek', 'github', 'gitlab'];
const HOST = /^(?=.{1,253}$)([A-Za-z0-9-]{1,63}\.)*[A-Za-z0-9-]{1,63}$|^\d{1,3}(\.\d{1,3}){3}$|^\[[0-9A-Fa-f:]+\]$/;

const SCHEMAS: { [T in ActionType]: Record<Exclude<keyof Extract<ActionBody, { type: T }>, 'type'>, Check> } = {
  key_put: {
    provider: oneOf(...PROVIDERS),
    key_hint: str(4, /^[A-Za-z0-9_-]{4}$/),
    ct_sha256: str(64, /^[0-9a-f]{64}$/),
  },
  key_delete: { provider: oneOf(...PROVIDERS) },
  mcp_put: {
    id: str(31, MCP_ID),
    name: str(60),
    url: str(300, /^https:\/\/[!-~]+$/),
    token_hint: nullable(str(4, /^[A-Za-z0-9_-]{4}$/)),
    ct_sha256: nullable(str(64, /^[0-9a-f]{64}$/)),
  },
  mcp_delete: { id: str(31, MCP_ID) },
  spend_limit: { limit_usd_month: nullable(money) },
  grant: {
    chat: id,
    provider: oneOf(...PROVIDERS),
    model: str(80, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    limit_usd: money,
    limit_tokens: nullable(int(1, 1_000_000_000)),
    until: date,
    key_until: date,
    per_member_usd_day: nullable(money),
    members: list(id, 1, 50),
    proposal: id,
  },
  grant_revoke: { chat: id, proposal: id },
  server_add: {
    server: id,
    host: str(253, HOST),
    port: int(1, 65535),
    user: str(32, /^[a-z_][a-z0-9_-]{0,31}$/),
    host_key: str(50, /^SHA256:[A-Za-z0-9+/]{43}$/),
  },
  agent_rights: {
    agent: id,
    servers: list(id, 0, 50),
    read_without_confirm: bool,
    limit_usd_month: nullable(money),
  },
  ssh_write: { agent: id, server: id, command: str(2000) },
  ssh_danger: { agent: id, server: id, command: str(2000), typed_server: id },
  role_change: { member: id, role: oneOf('reader', 'editor', 'owner', 'none') },
  device_approve: {
    user: id,
    target: deviceId,
    name: str(80),
  },
  device_enroll: { session_jkt: str(43, JKT), confirm_jkt: str(43, JKT), name: str(80) },
  device_revoke: { user: id, target: deviceId },
  invite_create: { user: id },
  account_delete: { user: id },
  space_delete: {},
  tool_approve: {
    approval: str(64, /^[A-Za-z0-9_-]{1,64}$/),
    tool: str(80, /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
    // SHA-256 канонической формы аргументов в base64url — то же значение, что считает агент (devices.args_hash)
    args_sha256: str(43, JKT),
  },
};

export function validateAction(input: unknown): ActionBody {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('action', 'нужен объект');
  const o = input as Record<string, unknown>;
  const type = o.type;
  if (typeof type !== 'string' || !(type in SCHEMAS)) throw bad('type', 'неизвестный тип действия');
  const schema = SCHEMAS[type as ActionType] as Record<string, Check>;
  for (const k of Object.keys(o)) {
    if (k !== 'type' && !(k in schema)) throw bad(k, 'лишнее поле');
  }
  for (const [k, check] of Object.entries(schema)) {
    if (!(k in o)) throw bad(k, 'отсутствует');
    check(o[k], k);
  }
  const a = o as unknown as ActionBody;
  if (a.type === 'grant' && a.key_until > a.until) throw bad('key_until', 'позже срока спонсорства');
  if (a.type === 'grant' && (a.provider === 'github' || a.provider === 'gitlab') !== (a.model === 'git'))
    throw bad('model', 'для GitHub/GitLab модель — «git», для остальных провайдеров — имя модели');
  if (a.type === 'mcp_put' && (a.token_hint === null) !== (a.ct_sha256 === null)) throw bad('token_hint', 'токен и его хеш — вместе');
  if (a.type === 'ssh_danger' && a.typed_server !== a.server) throw bad('typed_server', 'имя сервера введено неверно');
  return a;
}

// ---------- текст для человека ----------

const PROVIDER_NAMES: Record<Provider, string> = {
  anthropic: 'Claude (Anthropic)',
  sakana: 'Sakana Fugu',
  deepseek: 'DeepSeek',
  github: 'GitHub',
  gitlab: 'GitLab',
};
const ROLE_NAMES: Record<Role, string> = { reader: 'читатель', editor: 'редактор', owner: 'владелец', none: 'исключить из пространства' };
const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const num = (n: number) => n.toLocaleString('ru-RU');

export function describeAction(a: ActionEnvelope): ActionDescription {
  const where = `Пространство: ${a.space ?? ''}`;
  switch (a.type) {
    case 'key_put':
      return {
        title: 'Сохранить ключ API — его увидит только keyguard',
        lines: [`Провайдер: ${PROVIDER_NAMES[a.provider]}`, `Ключ: …${a.key_hint}`],
        danger: false,
      };
    case 'key_delete':
      return { title: 'Удалить ключ API', lines: [`Провайдер: ${PROVIDER_NAMES[a.provider]}`], danger: true };
    case 'mcp_put':
      return {
        title: 'Подключить MCP-сервер — агент сможет вызывать его инструменты',
        lines: [`${a.name} (${a.id})`, `Адрес: ${a.url}`, a.token_hint ? `Токен: …${a.token_hint} — его увидит только keyguard` : 'Без токена'],
        danger: false,
      };
    case 'mcp_delete':
      return { title: 'Отключить MCP-сервер', lines: [`Сервер: ${a.id}`], danger: true };
    case 'spend_limit':
      return {
        title: 'Лимит расходов на модели',
        lines: [a.limit_usd_month !== null ? `Не больше ${usd(a.limit_usd_month)} в месяц` : 'Без лимита', 'Своим ключом в личном пространстве'],
        danger: a.limit_usd_month === null,
      };
    case 'grant':
      return {
        title: 'Оплачивать модель в общем чате своим ключом',
        lines: [
          where,
          `Чат: ${a.chat}`,
          `Модель: ${PROVIDER_NAMES[a.provider]} · ${a.model}`,
          `Лимит: ${usd(a.limit_usd)}${a.limit_tokens !== null ? ` и ${num(a.limit_tokens)} токенов` : ''}`,
          `Спонсорство до: ${a.until}`,
          `Доступ к ключу до: ${a.key_until}`,
          a.per_member_usd_day !== null
            ? `Не больше ${usd(a.per_member_usd_day)} в день на участника`
            : 'Без дневного лимита на участника',
          `Участники: ${a.members.join(', ')}`,
        ],
        danger: false,
      };
    case 'grant_revoke':
      return { title: 'Отозвать оплату модели', lines: [where, `Чат: ${a.chat}`], danger: false };
    case 'server_add':
      return {
        title: 'Добавить сервер',
        lines: [where, `Имя: ${a.server}`, `Вход: ${a.user}@${a.host}:${a.port}`, `Ключ сервера: ${a.host_key}`],
        danger: false,
      };
    case 'agent_rights':
      return {
        title: 'Изменить права агента',
        lines: [
          where,
          `Агент: ${a.agent}`,
          `Серверы: ${a.servers.length ? a.servers.join(', ') : 'нет'}`,
          a.read_without_confirm ? 'Команды чтения — без подтверждения' : 'Каждая команда — с подтверждением',
          `Лимит: ${a.limit_usd_month !== null ? `${usd(a.limit_usd_month)} в месяц` : 'без отдельного лимита'}`,
        ],
        danger: a.read_without_confirm,
      };
    case 'ssh_write':
      return {
        title: 'Выполнить команду на сервере',
        lines: [`Сервер: ${a.server}`, `Агент: ${a.agent}`, 'Команда:', a.command],
        danger: false,
      };
    case 'ssh_danger':
      return {
        title: 'ОПАСНАЯ команда на сервере',
        lines: [`Сервер: ${a.server}`, `Агент: ${a.agent}`, 'Команда:', a.command],
        danger: true,
      };
    case 'role_change':
      return {
        title: 'Сменить роль участника',
        lines: [where, `Участник: ${a.member}`, `Новая роль: ${ROLE_NAMES[a.role]}`],
        danger: a.role === 'owner' || a.role === 'none',
      };
    case 'device_approve':
      return {
        title: 'Подтвердить новое устройство',
        lines: [
          `Пользователь: ${a.user}`,
          `Устройство: ${a.name}`,
          `ID: ${a.target.slice(0, 10)}…`,
          'Подтверждайте, только если человек сам сказал вам, что добавляет это устройство.',
        ],
        danger: true,
      };
    case 'device_enroll':
      return { title: 'Зарегистрировать это устройство', lines: [`Имя: ${a.name}`], danger: false };
    case 'device_revoke':
      return {
        title: 'Отозвать устройство',
        lines: [`Пользователь: ${a.user}`, `ID: ${a.target.slice(0, 10)}…`, 'Устройство сразу потеряет доступ.'],
        danger: true,
      };
    case 'invite_create':
      return {
        title: 'Выпустить приглашение',
        lines: [`Пользователь: ${a.user}`, 'По ссылке можно подключить одно устройство в течение 24 ч.'],
        danger: false,
      };
    case 'space_delete':
      return {
        title: 'Удалить пространство',
        lines: [where, 'Через 24 ч удалятся чаты, память, агенты и копии этого пространства. До этого удаление можно отменить.'],
        danger: true,
      };
    case 'tool_approve':
      return { title: 'Разрешить агенту действие', lines: [where, `Инструмент: ${a.tool}`], danger: false };
    case 'account_delete':
      return {
        title: 'Удалить аккаунт',
        lines: [
          `Аккаунт: ${a.user}`,
          'Через 24 ч удалятся ключи, устройства, агенты и личное пространство. До этого удаление можно отменить.',
        ],
        danger: true,
      };
  }
}

// ---------- подготовка ----------

const PREPARED = new WeakSet<PreparedAction>();

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.values(o as object).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
}

/** Проверка конверта целиком — то же делает keyguard перед проверкой подписи. */
export function validateEnvelope(input: unknown): ActionEnvelope {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('action', 'нужен объект');
  const { space, device_id, nonce, ts, ...body } = input as Record<string, unknown>;
  const valid = validateAction(body);
  if (IN_SPACE[valid.type]) str(80, SPACE)(space, 'space');
  else if (space !== undefined) throw bad('space', 'лишнее поле');
  deviceId(device_id, 'device_id');
  str(64, NONCE)(nonce, 'nonce');
  int(0, 4102444800)(ts, 'ts');
  return input as ActionEnvelope;
}

/**
 * Единственный путь к подписи: проверяет поля, собирает конверт и текст для человека из ОДНОГО замороженного объекта.
 * Подписать можно только результат этой функции (assertPrepared).
 */
export function prepareAction(
  body: unknown,
  ctx: { deviceId: string; nonce: string; nowSec: number; space?: string },
): PreparedAction {
  // Копия через JSON: отрезаем геттеры, прототипы и последующие изменения объекта вызывающим.
  const valid = validateAction(JSON.parse(JSON.stringify(body)) as unknown);
  const envelope = validateEnvelope({
    ...valid,
    ...(IN_SPACE[valid.type] ? { space: ctx.space } : ctx.space === undefined ? {} : { space: ctx.space }),
    device_id: ctx.deviceId,
    nonce: ctx.nonce,
    ts: Math.floor(ctx.nowSec),
  });
  const prepared: PreparedAction = deepFreeze({ envelope, description: describeAction(envelope) });
  PREPARED.add(prepared);
  return prepared;
}

export function assertPrepared(p: PreparedAction): void {
  if (!PREPARED.has(p)) throw new Error('Действие нужно подготовить через prepareAction');
}

/** Текст для запроса биометрии: заголовок и первые строки описания. */
export const promptOf = (p: PreparedAction) => [p.description.title, ...p.description.lines.slice(0, 3)].join(' · ');
