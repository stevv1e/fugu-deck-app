import assert from "node:assert/strict";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";

import { b64, utf8 } from "../src/core/bytes";
import { verifyUpdateManifest } from "../src/core/updateManifest";

const privateKey = ed25519.utils.randomSecretKey();
const publicKey = ed25519.getPublicKey(privateKey);
const payload = {
  format: "fugu-deck-update/1", platform: "android", channel: "stable", version: "1.2.3",
  url: "https://github.com/stevv1e/fugu-deck-app/releases/download/v1.2.3/Fugu-Deck-Android-1.2.3-arm64.apk",
  size: 12345, sha256: "a".repeat(64),
};
const encoded = b64(utf8(JSON.stringify(payload)));
const manifest = JSON.stringify({ payload: encoded, signature: b64(ed25519.sign(utf8(JSON.stringify(payload)), privateKey)) });

test("beta uses a separately signed manifest and cannot replace stable", () => {
  const beta = { ...payload, channel: "beta" };
  const signed = JSON.stringify({ payload: b64(utf8(JSON.stringify(beta))), signature: b64(ed25519.sign(utf8(JSON.stringify(beta)), privateKey)) });
  assert.deepEqual(verifyUpdateManifest(signed, "android", b64(publicKey), "beta"), beta);
  assert.throws(() => verifyUpdateManifest(signed, "android", b64(publicKey)), /не соответствует/);
  assert.throws(() => verifyUpdateManifest(manifest, "android", b64(publicKey), "beta"), /не соответствует/);
});

test("update manifest verifies signature and exact release asset", () => {
  assert.deepEqual(verifyUpdateManifest(manifest, "android", b64(publicKey)), payload);
  assert.throws(() => verifyUpdateManifest(manifest, "windows", b64(publicKey)), /не соответствует/);
  const changed = JSON.stringify({ ...payload, url: "https://evil.example/update.apk" });
  const forged = JSON.stringify({ payload: b64(utf8(changed)), signature: b64(ed25519.sign(utf8(changed), ed25519.utils.randomSecretKey())) });
  assert.throws(() => verifyUpdateManifest(forged, "android", b64(publicKey)), /подпись/i);
  const wrongUrl = JSON.stringify({ ...payload, url: "https://github.com/stevv1e/fugu-deck-app/releases/download/v1.2.3/other.apk" });
  const signedWrong = JSON.stringify({ payload: b64(utf8(wrongUrl)), signature: b64(ed25519.sign(utf8(wrongUrl), privateKey)) });
  assert.throws(() => verifyUpdateManifest(signedWrong, "android", b64(publicKey)), /не соответствует/);
});
