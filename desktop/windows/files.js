const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const MAX_CHUNK = 2 * 1024 * 1024;
const sessions = new Map();

const MIME = {
  ".aac": "audio/aac", ".csv": "text/csv", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".flac": "audio/flac", ".gif": "image/gif", ".heic": "image/heic", ".jpeg": "image/jpeg", ".jpg": "image/jpeg",
  ".json": "application/json", ".m4a": "audio/mp4", ".md": "text/markdown", ".mkv": "video/x-matroska",
  ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".mpeg": "video/mpeg", ".ogg": "audio/ogg",
  ".pdf": "application/pdf", ".png": "image/png", ".txt": "text/plain", ".wav": "audio/wav", ".webm": "video/webm",
  ".webp": "image/webp", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".zip": "application/zip",
};

function checked(event) {
  const sender = event.senderFrame?.url || event.sender.getURL();
  if (!sender.startsWith("fugu-app://bundle")) throw new Error("Файловая операция не из окна Fugu Deck");
  return event.sender;
}

function session(event, create = false) {
  const sender = checked(event);
  let value = sessions.get(sender.id);
  if (!value && create) {
    value = { reads: new Map(), writes: new Map() };
    sessions.set(sender.id, value);
    sender.once("destroyed", () => {
      const current = sessions.get(sender.id);
      sessions.delete(sender.id);
      if (current) for (const item of current.writes.values()) void discard(item);
    });
  }
  return value;
}

async function discard(item) {
  try { await item.handle.close(); } catch {}
  await fs.promises.unlink(item.part).catch(() => {});
}

function safeName(name) {
  return String(name || "file").replace(/[/\\:*?"<>|\x00-\x1f]+/g, "_").slice(0, 120) || "file";
}

async function grantPaths(event, paths, limit) {
  const state = session(event, true);
  if (!Number.isInteger(limit) || limit < 1 || limit > 6 || !Array.isArray(paths) || paths.length > limit) throw new Error("Некорректный список файлов");
  const result = [];
  for (const filePath of paths) {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) throw new Error("Некорректный путь к файлу");
    const stat = await fs.promises.stat(filePath, { bigint: true });
    if (!stat.isFile()) throw new Error("Выбранный объект не является файлом");
    const id = randomUUID();
    const name = path.basename(filePath);
    const size = Number(stat.size);
    state.reads.set(id, { path: filePath, size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs });
    result.push({ id, name, mime: MIME[path.extname(name).toLowerCase()] || "application/octet-stream", size, uri: `desktop-file://${id}` });
  }
  return result;
}

function readGrant(event, id) {
  const item = session(event)?.reads.get(id);
  if (!item) throw new Error("Файл не выбран в этом окне");
  return item;
}

function writeGrant(event, id) {
  const item = session(event)?.writes.get(id);
  if (!item) throw new Error("Файл для сохранения не открыт");
  return item;
}

async function finishWrite(item) {
  await item.handle.close();
  await fs.promises.rename(item.part, item.target);
  return item.target;
}

function registerFiles(ipcMain, dialog, shell, tempDir) {
  ipcMain.handle("files:pick", async (event, limit) => {
    checked(event);
    const result = await dialog.showOpenDialog({ properties: ["openFile", "multiSelections"] });
    return result.canceled ? [] : grantPaths(event, result.filePaths.slice(0, limit), Math.min(limit, result.filePaths.length));
  });
  ipcMain.handle("files:drop", (event, paths, limit) => grantPaths(event, paths, limit));
  ipcMain.handle("files:read", async (event, id, position, length) => {
    const item = readGrant(event, id);
    if (!Number.isInteger(position) || !Number.isInteger(length) || position < 0 || length < 1 || length > MAX_CHUNK || position + length > item.size) {
      throw new Error("Некорректный диапазон чтения");
    }
    const stat = await fs.promises.stat(item.path, { bigint: true });
    if (!stat.isFile() || stat.size !== BigInt(item.size) || stat.mtimeNs !== item.mtimeNs || stat.ctimeNs !== item.ctimeNs) throw new Error("Файл изменился после выбора — выберите его заново");
    const handle = await fs.promises.open(item.path, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead).toString("base64");
    } finally {
      await handle.close();
    }
  });
  ipcMain.handle("files:save", async (event, name, temporary) => {
    const state = session(event, true);
    const filename = safeName(name);
    let target;
    if (temporary) {
      target = path.join(tempDir(), `fugu-${randomUUID()}-${filename}`);
    } else {
      const result = await dialog.showSaveDialog({ defaultPath: filename });
      if (result.canceled || !result.filePath) return null;
      target = result.filePath;
    }
    const id = randomUUID();
    const part = `${target}.${randomUUID()}.part`;
    const handle = await fs.promises.open(part, "wx");
    state.writes.set(id, { target, part, handle });
    return id;
  });
  ipcMain.handle("files:write", async (event, id, data) => {
    const item = writeGrant(event, id);
    if (typeof data !== "string" || !data || data.length > MAX_CHUNK * 4 / 3 + 16) throw new Error("Некорректная часть файла");
    const raw = Buffer.from(data, "base64");
    if (!raw.length || raw.length > MAX_CHUNK || raw.toString("base64") !== data) throw new Error("Часть файла повреждена");
    await item.handle.write(raw);
  });
  ipcMain.handle("files:finish", async (event, id) => {
    const state = session(event);
    const item = writeGrant(event, id);
    state.writes.delete(id);
    try { return await finishWrite(item); } catch (error) {
      await discard(item);
      throw error;
    }
  });
  ipcMain.handle("files:cancel", async (event, id) => {
    const state = session(event);
    const item = writeGrant(event, id);
    state.writes.delete(id);
    await discard(item);
  });
  ipcMain.handle("files:open", async (event, id) => {
    const state = session(event);
    const item = writeGrant(event, id);
    state.writes.delete(id);
    let target;
    try { target = await finishWrite(item); } catch (error) {
      await discard(item);
      throw error;
    }
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
  });
}

module.exports = { registerFiles };
