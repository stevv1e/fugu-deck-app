import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { b64, fromUtf8, randomBytes, unb64, utf8 } from "@/core/bytes";
import { validManifest, type InstalledModule } from "@/core/modules";

const MAX_BACKUP = 8_000_000;
const ROUNDS = 200_000;

type Envelope = { format: "fugu-e2ee/1"; kdf: "PBKDF2-SHA256-200000"; cipher: "XChaCha20-Poly1305"; salt: string; nonce: string; data: string };

const hex = (value: Uint8Array) => [...value].map((x) => x.toString(16).padStart(2, "0")).join("");

export function serializeBackup(modules: InstalledModule[]): string {
  return JSON.stringify({ format: "fugu-backup/1", createdAt: Date.now(), modules: validateModules(modules) }, null, 2);
}

function validateModules(value: unknown): InstalledModule[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("В резервной копии должно быть не больше 100 модулей");
  return value.map((item: any) => {
    const manifest = validManifest(item?.manifest);
    if (typeof item.code !== "string" || utf8(item.code).length > 256_000 || hex(sha256(utf8(item.code))) !== manifest.sha256) throw new Error("Код модуля не совпадает с SHA-256");
    if (!/^[a-f0-9]{40}$/.test(item.commit) || typeof item.repository !== "string" || typeof item.path !== "string" || item.path.split("/").includes("..")) throw new Error("Некорректный источник модуля");
    return {
      manifest, code: item.code, commit: item.commit, repository: item.repository.slice(0, 300), path: item.path.slice(0, 200),
      installedAt: Number(item.installedAt) || Date.now(), enabled: item.enabled !== false,
    };
  });
}

export function parseBackup(text: string): InstalledModule[] {
  if (utf8(text).length > MAX_BACKUP) throw new Error("Резервная копия больше 8 МБ");
  const value = JSON.parse(text);
  if (value?.format !== "fugu-backup/1") throw new Error("Нужен файл fugu-backup/1");
  return validateModules(value.modules);
}

async function key(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
  if (passphrase.length < 10) throw new Error("Парольная фраза должна содержать не меньше 10 символов");
  return pbkdf2Async(sha256, utf8(passphrase), salt, { c: ROUNDS, dkLen: 32 });
}

export async function encryptBackup(modules: InstalledModule[], passphrase: string): Promise<string> {
  const salt = randomBytes(16);
  const nonce = randomBytes(24);
  const data = xchacha20poly1305(await key(passphrase, salt), nonce).encrypt(utf8(serializeBackup(modules)));
  const envelope: Envelope = { format: "fugu-e2ee/1", kdf: "PBKDF2-SHA256-200000", cipher: "XChaCha20-Poly1305", salt: b64(salt), nonce: b64(nonce), data: b64(data) };
  return JSON.stringify(envelope);
}

export async function decryptBackup(text: string, passphrase: string): Promise<InstalledModule[]> {
  if (utf8(text).length > MAX_BACKUP) throw new Error("Резервная копия больше 8 МБ");
  let envelope: Envelope;
  try { envelope = JSON.parse(text); }
  catch { throw new Error("Некорректный зашифрованный файл"); }
  if (envelope?.format !== "fugu-e2ee/1" || envelope.kdf !== "PBKDF2-SHA256-200000" || envelope.cipher !== "XChaCha20-Poly1305") throw new Error("Неподдерживаемый формат E2EE");
  try {
    const salt = unb64(envelope.salt);
    const nonce = unb64(envelope.nonce);
    if (salt.length !== 16 || nonce.length !== 24) throw new Error("bad nonce");
    const plain = xchacha20poly1305(await key(passphrase, salt), nonce).decrypt(unb64(envelope.data));
    return parseBackup(fromUtf8(plain));
  } catch (e) {
    if (e instanceof Error && e.message.includes("Парольная")) throw e;
    throw new Error("Неверная парольная фраза или повреждённый файл");
  }
}

export function isEncryptedBackup(text: string): boolean {
  try { return JSON.parse(text)?.format === "fugu-e2ee/1"; }
  catch { return false; }
}
