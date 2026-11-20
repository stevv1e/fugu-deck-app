import assert from "node:assert/strict";
import { test } from "node:test";

import { decryptBackup, encryptBackup, isEncryptedBackup, parseBackup, serializeBackup } from "../src/core/backup";
import { draftFromTemplate, draftModule } from "../src/core/moduleStudio";

function installed() {
  return { ...draftModule(draftFromTemplate("panel")), commit: "a".repeat(40), repository: "https://github.com/acme/modules", path: "modules/panel" };
}

test("standalone backup round-trips modules without unknown secret fields", () => {
  const module = { ...installed(), token: "must-not-export" };
  const text = serializeBackup([module]);
  assert.ok(!text.includes("must-not-export"));
  assert.deepEqual(parseBackup(text)[0].manifest, module.manifest);
  assert.throws(() => parseBackup(text.replace(module.manifest.sha256, "0".repeat(64))), /SHA-256/);
});

test("E2EE backup authenticates passphrase and ciphertext", async () => {
  const encrypted = await encryptBackup([installed()], "correct horse battery staple");
  assert.ok(isEncryptedBackup(encrypted));
  assert.ok(!encrypted.includes("local-panel"));
  const restored = await decryptBackup(encrypted, "correct horse battery staple");
  assert.equal(restored[0].manifest.id, "local-panel");
  await assert.rejects(decryptBackup(encrypted, "wrong password"), /Неверная парольная/);
  const value = JSON.parse(encrypted);
  value.data = value.data.slice(0, -4) + (value.data.endsWith("AAAA") ? "BBBB" : "AAAA");
  await assert.rejects(decryptBackup(JSON.stringify(value), "correct horse battery staple"), /Неверная парольная/);
});
