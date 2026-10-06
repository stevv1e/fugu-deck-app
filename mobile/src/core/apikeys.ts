/**
 * Ввод ключа API в кластере v2 (architecture.md 3.5): ключ шифруется на телефоне для keyguard (HPKE),
 * действие key_put подписывается ключом подтверждения (биометрия) и содержит хэш шифротекста.
 * control-plane передаёт всё как есть: прочитать ключ он не может, подменить шифротекст — тоже (хэш под подписью),
 * подставить чужой шифротекст в свой слот — тоже (AAD = key_put|устройство|провайдер|nonce).
 * Чей это ключ, keyguard определяет по устройству, подписавшему действие, — поля «пользователь» в действии нет.
 * key_hint — последние 4 символа ключа: их человек видит при подписи, keyguard сверяет с расшифрованным.
 */
import { b64, concat, randomId, utf8 } from "./bytes";
import { sha256 } from "./crypto";
import { HPKE_INFO, hpkeSeal } from "./hpke";

export const KEY_PROVIDERS = ["anthropic", "sakana", "github", "gitlab"] as const;
export type KeyProvider = (typeof KEY_PROVIDERS)[number];

export type KeyPutRequest = { jws: string; enc: string; ct: string };
type Signer = (fields: Record<string, unknown>, reason: string, nonce: string) => Promise<{ jws: string }>;

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Те же правила, что у keyguard: 8–512 печатных ASCII без пробелов (CR/LF — инъекция заголовков). */
export function validateApiKey(key: string): string | null {
  if (key.length < 8 || key.length > 512) return "Ключ должен быть от 8 до 512 символов";
  if (!/^[\x21-\x7e]+$/.test(key)) return "В ключе не должно быть пробелов, переносов строк и не-ASCII символов";
  if (!/^[A-Za-z0-9_-]{4}$/.test(key.slice(-4))) return "Последние 4 символа ключа должны быть буквами, цифрами, «_» или «-»";
  return null;
}

export async function buildKeyPut(
  sign: Signer,
  o: { hpkePub: Uint8Array; deviceId: string; provider: KeyProvider; apiKey: string },
): Promise<KeyPutRequest> {
  const apiKey = o.apiKey.trim();
  const bad = validateApiKey(apiKey);
  if (bad) throw new Error(bad);
  if (!KEY_PROVIDERS.includes(o.provider)) throw new Error(`Неизвестный провайдер ${o.provider}`);
  const nonce = randomId(16);
  const aad = utf8(`key_put|${o.deviceId}|${o.provider}|${nonce}`);
  const { enc, ct } = hpkeSeal(o.hpkePub, utf8(HPKE_INFO), aad, utf8(apiKey));
  const signed = await sign(
    { type: "key_put", provider: o.provider, key_hint: apiKey.slice(-4), ct_sha256: hex(sha256(concat(enc, ct))) },
    `Сохранить ключ ${o.provider} — его увидит только keyguard`,
    nonce,
  );
  return { ...signed, enc: b64(enc), ct: b64(ct) };
}
