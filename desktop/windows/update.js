const fs = require("node:fs");
const path = require("node:path");
const { createHash, createPublicKey, randomUUID, verify } = require("node:crypto");
const { spawn } = require("node:child_process");

const UPDATE_PUBLIC_KEY = "h5JyYoZt7BKWxmCAPylZ41927mr9t6wlIAiciSwfVTw=";
const PUBLIC_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const MAX_MANIFEST = 64 * 1024;

function newer(a, b) {
  const parse = (value) => /^\d+\.\d+\.\d+$/.test(value) ? value.split(".").map(Number) : null;
  const left = parse(a), right = parse(b);
  if (!left || !right) return false;
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i];
  return false;
}

function verifyManifest(raw, requested, current, publicKey = UPDATE_PUBLIC_KEY) {
  if (Buffer.byteLength(raw) > MAX_MANIFEST) throw new Error("Манифест обновления слишком большой");
  const envelope = JSON.parse(raw);
  if (typeof envelope.payload !== "string" || typeof envelope.signature !== "string") throw new Error("Манифест обновления неполный");
  const payloadBytes = Buffer.from(envelope.payload, "base64");
  if (payloadBytes.toString("base64") !== envelope.payload) throw new Error("Манифест обновления повреждён");
  const key = createPublicKey({ key: Buffer.concat([PUBLIC_SPKI_PREFIX, Buffer.from(publicKey, "base64")]), format: "der", type: "spki" });
  if (!verify(null, payloadBytes, key, Buffer.from(envelope.signature, "base64"))) throw new Error("Подпись обновления недействительна");
  const payload = JSON.parse(payloadBytes.toString("utf8"));
  const filename = `Fugu-Deck-Setup-${payload.version}.exe`;
  const expectedUrl = `https://github.com/stevv1e/fugu-deck-app/releases/download/v${payload.version}/${filename}`;
  if (payload.format !== "fugu-deck-update/1" || payload.platform !== "windows" || payload.channel !== "stable" ||
    payload.version !== requested || !newer(payload.version, current) || payload.url !== expectedUrl ||
    !Number.isSafeInteger(payload.size) || payload.size <= 0 || payload.size > 512 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(payload.sha256)) {
    throw new Error("Манифест обновления не соответствует этой версии приложения");
  }
  return payload;
}

function registerUpdates(ipcMain, app, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const spawnImpl = options.spawnImpl || spawn;
  const tempDir = options.tempDir || (() => app.getPath("temp"));
  const publicKey = options.publicKey || UPDATE_PUBLIC_KEY;
  const downloads = new Map();
  const parts = new Map();

  function cleanupSender(id) {
    for (const [key, value] of downloads) if (value.sender === id) {
      fs.unlink(value.path, () => {});
      downloads.delete(key);
    }
    const part = parts.get(id);
    if (part) fs.unlink(part, () => {});
    parts.delete(id);
  }

  ipcMain.handle("update:download", async (event, version) => {
    const sender = event.senderFrame?.url || event.sender.getURL();
    if (!sender.startsWith("fugu-app://bundle")) throw new Error("Обновление не из окна Fugu Deck");
    if (!/^\d+\.\d+\.\d+$/.test(version) || !newer(version, app.getVersion())) throw new Error("Эта версия не новее установленной");
    if (parts.has(event.sender.id)) throw new Error("Обновление уже скачивается");
    const manifestUrl = `https://github.com/stevv1e/fugu-deck-app/releases/download/v${version}/update-windows.json`;
    const response = await fetchImpl(manifestUrl, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Манифест обновления недоступен: HTTP ${response.status}`);
    const manifest = verifyManifest(await response.text(), version, app.getVersion(), publicKey);
    const part = path.join(tempDir(), `fugu-update-${randomUUID()}.part`);
    parts.set(event.sender.id, part);
    event.sender.once("destroyed", () => cleanupSender(event.sender.id));
    try {
      const asset = await fetchImpl(manifest.url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
      if (!asset.ok || !asset.body) throw new Error(`Установщик недоступен: HTTP ${asset.status}`);
      const handle = await fs.promises.open(part, "wx");
      const hash = createHash("sha256");
      let done = 0;
      try {
        for await (const chunk of asset.body) {
          const buffer = Buffer.from(chunk);
          done += buffer.length;
          if (done > manifest.size) throw new Error("Установщик больше заявленного размера");
          hash.update(buffer);
          await handle.write(buffer);
          if (!event.sender.isDestroyed()) event.sender.send("update:progress", { done, total: manifest.size });
        }
      } finally {
        await handle.close();
      }
      if (done !== manifest.size || hash.digest("hex") !== manifest.sha256) throw new Error("Установщик не прошёл проверку целостности");
      const target = path.join(tempDir(), `fugu-update-${randomUUID()}.exe`);
      await fs.promises.rename(part, target);
      parts.delete(event.sender.id);
      const id = randomUUID();
      downloads.set(id, { path: target, sender: event.sender.id, version });
      return { id, version, size: done };
    } catch (error) {
      parts.delete(event.sender.id);
      await fs.promises.unlink(part).catch(() => {});
      throw error;
    }
  });

  ipcMain.handle("update:install", (event, id) => {
    const sender = event.senderFrame?.url || event.sender.getURL();
    if (!sender.startsWith("fugu-app://bundle")) throw new Error("Обновление не из окна Fugu Deck");
    const item = downloads.get(id);
    if (!item || item.sender !== event.sender.id) throw new Error("Обновление не было скачано и проверено в этом окне");
    downloads.delete(id);
    const child = spawnImpl(item.path, ["/S"], { detached: true, stdio: "ignore" });
    child.once("error", () => {});
    child.unref();
    setTimeout(() => app.quit(), 300).unref();
    return { installing: true };
  });

  ipcMain.on("update:cancel", (event) => cleanupSender(event.sender.id));
}

module.exports = { registerUpdates, verifyManifest, newer };
