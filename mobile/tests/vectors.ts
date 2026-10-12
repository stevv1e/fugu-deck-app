/**
 * Общие векторы подписанных действий для приложения (TypeScript) и keyguard (Go).
 *   npx tsx tests/vectors.ts            — пересоздать ../../fugu-deck-keyguard/testdata/action-vectors.json
 *   npx tsx tests/vectors.ts --check    — проверить, что файл совпадает с тем, что даёт текущий код
 * Канонические байты и JWS делает ровно тот код, что работает в приложении (actions.ts, canonical.ts, cluster.ts).
 * Ключ и nonce фиксированы, подпись детерминирована (RFC 6979) — файл воспроизводится байт в байт.
 * Go-тест (vectors_test.go) обязан принять каждый vectors[] и отклонить каждый invalid[]; здесь проверяется то же
 * для схемы приложения — так две реализации схемы не расходятся.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { describeAction, validateEnvelope, type ActionEnvelope } from "../src/core/actions";
import { fromUtf8, unb64 } from "../src/core/bytes";
import { canonicalString } from "../src/core/canonical";
import { clusterDeviceId, signClusterAction } from "../src/core/cluster";
import { jwkFromPoint, softPoint, softSign } from "../src/core/crypto";
import { makeKey, type DeviceKeys } from "../src/core/keys";

const FILE = path.join(import.meta.dirname, "../../../fugu-deck-keyguard/testdata/action-vectors.json");
const TS = 1790856000; // 2026-10-01T12:00:00Z
const CT = "a".repeat(64);
const TARGET = "d-Zm9vYmFyMTIzNDU2";
const JKT = "q7Xo0Yb1mC3nD5pF7rH9tJ1vL3xN5zP7bR9dT1fV3hA";

const secret = (fill: number) => Uint8Array.from({ length: 32 }, (_, i) => fill + i);
const keys: DeviceKeys = {
  alias: "vectors", storage: "software", attestation: null,
  session: makeKey(jwkFromPoint(softPoint(secret(101))), async (d) => softSign(secret(101), d)),
  confirm: makeKey(jwkFromPoint(softPoint(secret(1))), async (d) => softSign(secret(1), d)),
};
const DEVICE = clusterDeviceId(keys);

const GRANT = {
  type: "grant", chat: "c-42", provider: "sakana", model: "fugu-max-v1.0", limit_usd: 20, limit_tokens: null,
  until: "2026-10-04", key_until: "2026-10-04", per_member_usd_day: 5, members: ["anna", "bob"], proposal: "p-7",
};

/** [название, пространство (или null — действие вне пространства), тело] */
const valid: [string, string | null, Record<string, unknown>][] = [
  ["key_put", null, { type: "key_put", provider: "anthropic", key_hint: "6789", ct_sha256: CT }],
  ["key_delete", null, { type: "key_delete", provider: "sakana" }],
  ["grant целая сумма", "t-shop", GRANT],
  ["grant с копейками и без дневного лимита", "t-shop", { ...GRANT, provider: "anthropic", model: "claude-x", limit_usd: 12.5, key_until: "2026-10-03", per_member_usd_day: null, members: ["anna"], proposal: "p-8" }],
  ["grant 0.25", "t-shop", { ...GRANT, chat: "c-1", limit_usd: 0.25, until: "2026-10-02", key_until: "2026-10-02", per_member_usd_day: 0.05, members: ["bob"], proposal: "p-9" }],
  ["grant на Git-токен", "t-shop", { ...GRANT, provider: "github", model: "git", per_member_usd_day: null, proposal: "p-10" }],
  ["grant_revoke", "t-shop", { type: "grant_revoke", chat: "c-42", proposal: "p-7" }],
  ["server_add", "u-anna", { type: "server_add", server: "prod-1", host: "app.example.kz", port: 22, user: "deck-agent", host_key: "SHA256:" + "A".repeat(43) }],
  ["agent_rights", "u-anna", { type: "agent_rights", agent: "duty", servers: ["prod-1"], read_without_confirm: true, limit_usd_month: 30 }],
  ["ssh_write: кавычки, обратная косая, кириллица, <>&", "u-anna", { type: "ssh_write", agent: "duty", server: "prod-1", command: "echo \"привет\" > /tmp/a\\b && grep -c '<x>' f & 😀" }],
  ["ssh_danger", "u-anna", { type: "ssh_danger", agent: "duty", server: "prod-1", command: "sudo reboot", typed_server: "prod-1" }],
  ["role_change", "t-shop", { type: "role_change", member: "bob", role: "editor" }],
  ["role_change: исключить", "t-shop", { type: "role_change", member: "bob", role: "none" }],
  ["device_enroll", null, { type: "device_enroll", session_jkt: JKT, confirm_jkt: JKT, name: "iPhone 17 Pro — Анна" }],
  ["device_approve", null, { type: "device_approve", user: "anna", target: TARGET, name: "iPhone 17 Pro — Анна" }],
  ["device_revoke", null, { type: "device_revoke", user: "anna", target: TARGET }],
  ["account_delete", null, { type: "account_delete", user: "anna" }],
  ["invite_create", null, { type: "invite_create", user: "dave" }],
  ["space_delete", "t-shop", { type: "space_delete" }],
  ["tool_approve", "u-anna", { type: "tool_approve", approval: "a1b2c3d4e5f6", tool: "github_create_file", args_sha256: JKT }],
];

const env = (body: Record<string, unknown>, space: string | null = null, i = 0) => ({
  ...body, ...(space === null ? {} : { space }), device_id: DEVICE, nonce: `vector-nonce-${String(i).padStart(9, "0")}`, ts: TS,
});
const SSH = { type: "ssh_write", agent: "duty", server: "prod-1", command: "ls" };

/** Конверты, которые обязаны отклонить ОБЕ реализации схемы (подпись тут ни при чём — до неё дело не доходит). */
const invalid: [string, Record<string, unknown>][] = [
  ["неизвестный тип", env({ type: "transfer_all" })],
  ["лишнее поле (не показано человеку)", env({ type: "key_delete", provider: "sakana", also: "x" })],
  ["нет обязательного поля", env({ type: "device_approve", user: "anna", target: TARGET })],
  ["space у действия вне пространства", env({ type: "key_delete", provider: "sakana" }, "t-shop")],
  ["нет space у действия в пространстве", env(GRANT)],
  ["невидимый символ (zero-width space) в команде", env({ ...SSH, command: "ls​; rm -rf /" }, "u-anna")],
  ["bidi-переворот в имени устройства", env({ type: "device_enroll", session_jkt: JKT, confirm_jkt: JKT, name: "iPhone‮gpj.exe" })],
  ["перевод строки в команде", env({ ...SSH, command: "ls\nrm -rf /" }, "u-anna")],
  ["пробел по краям", env({ type: "device_enroll", session_jkt: JKT, confirm_jkt: JKT, name: " iPhone" })],
  ["строка длиннее лимита", env({ type: "device_enroll", session_jkt: JKT, confirm_jkt: JKT, name: "я".repeat(81) })],
  ["key_hint из 5 символов", env({ type: "key_put", provider: "anthropic", key_hint: "56789", ct_sha256: CT })],
  ["неизвестный провайдер", env({ type: "key_delete", provider: "openai" })],
  ["сумма с тремя знаками", env({ ...GRANT, limit_usd: 12.345 }, "t-shop")],
  ["нулевая сумма", env({ ...GRANT, limit_usd: 0 }, "t-shop")],
  ["сумма строкой", env({ ...GRANT, limit_usd: "20" }, "t-shop")],
  ["limit_tokens = 0", env({ ...GRANT, limit_tokens: 0 }, "t-shop")],
  ["повтор участника", env({ ...GRANT, members: ["anna", "anna"] }, "t-shop")],
  ["пустой список участников", env({ ...GRANT, members: [] }, "t-shop")],
  ["несуществующая дата", env({ ...GRANT, until: "2026-02-30", key_until: "2026-02-28" }, "t-shop")],
  ["доступ к ключу дольше спонсорства", env({ ...GRANT, key_until: "2026-10-05" }, "t-shop")],
  ["Git-провайдер с моделью не git", env({ ...GRANT, provider: "github" }, "t-shop")],
  ["модель git у провайдера моделей", env({ ...GRANT, model: "git" }, "t-shop")],
  ["ssh_danger: имя сервера введено неверно", env({ ...SSH, type: "ssh_danger", typed_server: "prod-2" }, "u-anna")],
  ["порт вне диапазона", env({ type: "server_add", server: "prod-1", host: "app.example.kz", port: 70000, user: "deck-agent", host_key: "SHA256:" + "A".repeat(43) }, "u-anna")],
  ["неизвестная роль", env({ type: "role_change", member: "bob", role: "admin" }, "t-shop")],
  ["короткий nonce", { ...env({ type: "key_delete", provider: "sakana" }), nonce: "short" }],
  ["короткий device_id", { ...env({ type: "key_delete", provider: "sakana" }), device_id: "d-1" }],
  ["дробное время", { ...env({ type: "key_delete", provider: "sakana" }), ts: TS + 0.5 }],
];

async function build() {
  const vectors = [];
  for (const [i, [name, space, body]] of valid.entries()) {
    const { jws } = await signClusterAction(keys, body, { space: space ?? undefined, nonce: `vector-nonce-${String(i).padStart(9, "0")}`, nowMs: TS * 1000 });
    const canonical = fromUtf8(unb64(jws.split(".")[1]));
    describeAction(validateEnvelope(JSON.parse(canonical)) as ActionEnvelope); // текст для человека строится из тех же полей
    vectors.push({ name, canonical, jws });
  }
  const bad = invalid.map(([name, e]) => {
    let rejected = false;
    try { validateEnvelope(JSON.parse(JSON.stringify(e))); } catch { rejected = true; }
    if (!rejected) throw new Error(`схема приложения ПРИНЯЛА невалидный конверт: ${name}`);
    return { name, canonical: canonicalString(e) };
  });
  return JSON.stringify({
    comment: "Создано fugu-deck-app/mobile/tests/vectors.ts кодом приложения. Не править вручную.",
    device_id: DEVICE, ts: TS, confirm_jwk: keys.confirm.jwk, vectors, invalid: bad,
  }, null, 1) + "\n";
}

build().then((out) => {
  if (process.argv.includes("--check")) {
    if (fs.readFileSync(FILE, "utf8") !== out) {
      console.error("векторы устарели: npx tsx tests/vectors.ts (и прогоните go test в fugu-deck-keyguard)");
      process.exit(1);
    }
    console.log(`векторы актуальны: ${valid.length} принимаются, ${invalid.length} отклоняются`);
    return;
  }
  fs.writeFileSync(FILE, out);
  console.log(`записано: ${valid.length} принимаются, ${invalid.length} отклоняются → ${FILE}`);
}).catch((e) => { console.error(e); process.exit(1); });
