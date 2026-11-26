const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { registerFiles } = require("./files");

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fugu-files-test-"));
  const handlers = new Map();
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn) };
  const opened = [];
  const dialog = {
    showOpenDialog: async () => ({ canceled: false, filePaths: [] }),
    showSaveDialog: async (options) => ({ canceled: false, filePath: path.join(dir, options.defaultPath) }),
  };
  registerFiles(ipcMain, dialog, { openPath: async (target) => { opened.push(target); return ""; } }, () => dir);
  const sender = { id: Math.floor(Math.random() * 1e9), getURL: () => "fugu-app://bundle/", once: () => {} };
  const event = { senderFrame: { url: "fugu-app://bundle/" }, sender };
  return { dir, handlers, dialog, event, opened };
}

test("native picker grants only selected files and reads exact Unicode-named chunks", async () => {
  const f = fixture();
  const first = path.join(f.dir, "отчёт.txt");
  const second = path.join(f.dir, "видео.mp4");
  const raw = Buffer.from("0123456789abcdef");
  fs.writeFileSync(first, raw);
  fs.writeFileSync(second, Buffer.alloc(16, 2));
  f.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [first, second] });
  const picked = await f.handlers.get("files:pick")(f.event, 2);
  assert.equal(picked.length, 2);
  assert.equal(picked[0].name, "отчёт.txt");
  assert.equal(picked[0].mime, "text/plain");
  assert.equal(picked[1].mime, "video/mp4");
  assert.equal(await f.handlers.get("files:read")(f.event, picked[0].id, 3, 5), raw.subarray(3, 8).toString("base64"));
  await assert.rejects(f.handlers.get("files:read")(f.event, "not-granted", 0, 1), /не выбран/);
  await assert.rejects(f.handlers.get("files:read")({ ...f.event, senderFrame: { url: "https://evil.example" } }, picked[0].id, 0, 1), /не из окна/);
  await assert.rejects(f.handlers.get("files:read")(f.event, picked[0].id, 0, 2 * 1024 * 1024 + 1), /диапазон/);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test("changed file and cancelled picker are safe", async () => {
  const f = fixture();
  const target = path.join(f.dir, "a.txt");
  fs.writeFileSync(target, "before");
  const [picked] = await f.handlers.get("files:drop")(f.event, [target], 1);
  fs.writeFileSync(target, "after!");
  fs.utimesSync(target, new Date(), new Date(Date.now() + 2000));
  await assert.rejects(f.handlers.get("files:read")(f.event, picked.id, 0, 6), /изменился/);
  f.dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  assert.deepEqual(await f.handlers.get("files:pick")(f.event, 6), []);
  await assert.rejects(f.handlers.get("files:drop")(f.event, ["relative.txt"], 1), /путь/);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test("save, open and cancellation use main-process destinations", async () => {
  const f = fixture();
  const id = await f.handlers.get("files:save")(f.event, "результат.txt", false);
  await f.handlers.get("files:write")(f.event, id, Buffer.from("готово").toString("base64"));
  const saved = await f.handlers.get("files:finish")(f.event, id);
  assert.equal(fs.readFileSync(saved, "utf8"), "готово");

  const temporary = await f.handlers.get("files:save")(f.event, "open.txt", true);
  await f.handlers.get("files:write")(f.event, temporary, Buffer.from("open").toString("base64"));
  await f.handlers.get("files:open")(f.event, temporary);
  assert.equal(fs.readFileSync(f.opened[0], "utf8"), "open");

  const cancelled = await f.handlers.get("files:save")(f.event, "cancel.txt", false);
  await f.handlers.get("files:write")(f.event, cancelled, Buffer.from("partial").toString("base64"));
  await f.handlers.get("files:cancel")(f.event, cancelled);
  assert.equal(fs.existsSync(path.join(f.dir, "cancel.txt")), false);
  assert.equal(fs.readdirSync(f.dir).some((name) => name.endsWith(".part")), false);
  await assert.rejects(f.handlers.get("files:write")(f.event, cancelled, "QQ=="), /не открыт/);
  fs.rmSync(f.dir, { recursive: true, force: true });
});
