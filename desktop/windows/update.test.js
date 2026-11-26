const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { generateKeyPairSync, createHash, sign } = require("node:crypto");
const { test } = require("node:test");
const { registerUpdates, verifyManifest, newer } = require("./update");

const pair = generateKeyPairSync("ed25519");
const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");

function manifest(version, data, changes = {}) {
  const payload = Buffer.from(JSON.stringify({
    format: "fugu-deck-update/1", platform: "windows", channel: "stable", version,
    url: `https://github.com/stevv1e/fugu-deck-app/releases/download/v${version}/Fugu-Deck-Setup-${version}.exe`,
    size: data.length, sha256: createHash("sha256").update(data).digest("hex"), ...changes,
  }));
  return JSON.stringify({ payload: payload.toString("base64"), signature: sign(null, payload, pair.privateKey).toString("base64") });
}

function fixture(data, changes = {}, remoteVersion = "1.0.0") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fugu-update-test-"));
  const handlers = new Map();
  const listeners = new Map();
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => listeners.set(name, fn) };
  const progress = [];
  const sender = { id: 7, getURL: () => "fugu-app://bundle/", send: (_channel, value) => progress.push(value), isDestroyed: () => false, once: () => {} };
  const event = { senderFrame: { url: "fugu-app://bundle/" }, sender };
  let quit = false;
  const app = { getVersion: () => "0.15.0", getPath: () => dir, quit: () => { quit = true; } };
  const fetchImpl = async (url) => url.endsWith(".json") ? new Response(manifest(remoteVersion, data, changes)) : new Response(data);
  const spawned = [];
  const spawnImpl = (...args) => {
    spawned.push(args);
    return { once: () => {}, unref: () => {} };
  };
  const execFileImpl = (_file, _args, options, callback) => {
    const content = fs.readFileSync(options.env.FUGU_UPDATE_PATH, "utf8");
    const status = content.includes("unsigned") ? "NotSigned" : "Valid";
    const subject = content.includes("other publisher") ? "CN=Other Publisher" : "CN=Fugu Deck Test";
    callback(null, JSON.stringify({ Status: status, Subject: subject, Thumbprint: "A".repeat(40) }), "");
  };
  registerUpdates(ipcMain, app, { fetchImpl, spawnImpl, execFileImpl, publicKey, publisher: "CN=Fugu Deck Test" });
  return { dir, handlers, event, progress, spawned, quit: () => quit };
}

test("signed Windows update downloads with progress and only verified handle installs", async () => {
  const data = Buffer.from("verified installer");
  const f = fixture(data);
  const downloaded = await f.handlers.get("update:download")(f.event, "1.0.0");
  assert.equal(downloaded.size, data.length);
  assert.equal(f.progress.at(-1).done, data.length);
  assert.equal(f.progress.at(-1).total, data.length);
  await assert.rejects(f.handlers.get("update:install")(f.event, "unknown"), /не было скачано/);
  assert.equal((await f.handlers.get("update:install")(f.event, downloaded.id)).installing, true);
  assert.equal(f.spawned[0][1][0], "/S");
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(f.quit(), true);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test("wrong hash, wrong URL, old version and foreign window are rejected", async () => {
  const wrongHash = fixture(Buffer.from("actual"), { sha256: "0".repeat(64) });
  await assert.rejects(wrongHash.handlers.get("update:download")(wrongHash.event, "1.0.0"), /целостности/);
  assert.equal(wrongHash.spawned.length, 0);
  fs.rmSync(wrongHash.dir, { recursive: true, force: true });

  const f = fixture(Buffer.from("actual"));
  await assert.rejects(f.handlers.get("update:download")(f.event, "0.14.0"), /не новее/);
  await assert.rejects(f.handlers.get("update:download")({ ...f.event, senderFrame: { url: "https://evil.example" } }, "1.0.0"), /не из окна/);
  const good = verifyManifest(manifest("1.0.0", Buffer.from("actual")), "1.0.0", "0.15.0", publicKey);
  assert.equal(good.version, "1.0.0");
  assert.throws(() => verifyManifest(manifest("1.0.0", Buffer.from("actual"), { url: "https://evil.example/update.exe" }), "1.0.0", "0.15.0", publicKey), /не соответствует/);
  assert.equal(newer("1.0.1", "1.0.0"), true);
  assert.equal(newer("1.0.0", "1.0.0"), false);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test("beta channel and explicit rollback require their own signed manifests", async () => {
  const beta = fixture(Buffer.from("beta installer"), { channel: "beta" });
  await assert.rejects(beta.handlers.get("update:download")(beta.event, "1.0.0"), /не соответствует/);
  const downloadedBeta = await beta.handlers.get("update:download")(beta.event, "1.0.0", { channel: "beta" });
  assert.equal(downloadedBeta.version, "1.0.0");
  fs.rmSync(beta.dir, { recursive: true, force: true });

  const previous = fixture(Buffer.from("previous stable installer"), {}, "0.14.0");
  await assert.rejects(previous.handlers.get("update:download")(previous.event, "0.14.0"), /не новее/);
  const downloaded = await previous.handlers.get("update:download")(previous.event, "0.14.0", { mode: "rollback" });
  assert.equal(downloaded.version, "0.14.0");
  assert.equal((await previous.handlers.get("update:install")(previous.event, downloaded.id)).installing, true);
  assert.equal(previous.spawned[0][1][0], "/S");
  await assert.rejects(previous.handlers.get("update:download")(previous.event, "1.0.0", { mode: "rollback" }), /более раннюю/);
  fs.rmSync(previous.dir, { recursive: true, force: true });
});

test("unsigned or foreign-publisher installer is deleted instead of executed", async () => {
  for (const [data, error] of [["unsigned installer", /недействительна/], ["other publisher installer", /Издатель/]]) {
    const f = fixture(Buffer.from(data));
    const downloaded = await f.handlers.get("update:download")(f.event, "1.0.0");
    await assert.rejects(f.handlers.get("update:install")(f.event, downloaded.id), error);
    assert.equal(f.spawned.length, 0);
    assert.equal(f.quit(), false);
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
