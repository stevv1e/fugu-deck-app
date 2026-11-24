import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const [platform, version, asset, output] = process.argv.slice(2);
if (!["android", "windows"].includes(platform) || !/^\d+\.\d+\.\d+$/.test(version || "") || !asset || !output) {
  throw new Error("Использование: DECK_UPDATE_PRIVATE_KEY=… sign-update-manifest.mjs <android|windows> <version> <asset> <output>");
}
const expected = platform === "android" ? `Fugu-Deck-Android-${version}-arm64.apk` : `Fugu-Deck-Setup-${version}.exe`;
if (basename(asset) !== expected) throw new Error("Имя установщика не соответствует платформе и версии");
const secret = process.env.DECK_UPDATE_PRIVATE_KEY;
if (!secret) throw new Error("Нет DECK_UPDATE_PRIVATE_KEY");
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(secret, "base64")]),
  format: "der",
  type: "pkcs8",
});
const payload = Buffer.from(JSON.stringify({
  format: "fugu-deck-update/1",
  platform,
  channel: "stable",
  version,
  url: `https://github.com/stevv1e/fugu-deck-app/releases/download/v${version}/${expected}`,
  size: statSync(asset).size,
  sha256: createHash("sha256").update(readFileSync(asset)).digest("hex"),
}));
const manifest = JSON.stringify({ payload: payload.toString("base64"), signature: sign(null, payload, privateKey).toString("base64") }, null, 2) + "\n";
writeFileSync(output, manifest, { mode: 0o644 });
console.log(`${platform} ${version}: подписанный update manifest ${output}`);
