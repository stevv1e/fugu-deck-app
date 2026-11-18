const { app, BrowserWindow, ipcMain, Menu, net, Notification, protocol } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");

const dist = path.join(__dirname, "dist");

protocol.registerSchemesAsPrivileged([
  { scheme: "fugu-app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

function serveBundle(request) {
  const url = new URL(request.url);
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
  const file = path.resolve(dist, relative);
  if (file !== dist && !file.startsWith(dist + path.sep)) return new Response("Forbidden", { status: 403 });
  const target = path.extname(relative) ? file : path.join(dist, "index.html");
  return net.fetch(pathToFileURL(target).toString());
}

let mainWindow = null;
let pendingInvite = null;

function openInvite(raw) {
  if (typeof raw !== "string" || !/^fugudeck:\/\/join\/?\?/i.test(raw)) return;
  if (!mainWindow) {
    pendingInvite = raw;
    return;
  }
  mainWindow.loadURL("fugu-app://bundle/join" + raw.slice(raw.indexOf("?")));
  mainWindow.show();
  mainWindow.focus();
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", (_event, argv) => openInvite(argv.find((arg) => arg.startsWith("fugudeck://"))));
app.on("open-url", (event, url) => {
  event.preventDefault();
  openInvite(url);
});

function createWindow() {
  const headless = process.env.FUGU_HEADLESS === "1";
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    frame: false,
    show: !headless,
    backgroundColor: "#080b12",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      offscreen: headless,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  mainWindow.on("closed", () => { mainWindow = null; });
  const target = pendingInvite ? "fugu-app://bundle/join" + pendingInvite.slice(pendingInvite.indexOf("?")) : "fugu-app://bundle/";
  pendingInvite = null;
  mainWindow.loadURL(target);
}

ipcMain.handle("window:minimize", (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
ipcMain.handle("window:maximize", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.handle("window:close", (event) => BrowserWindow.fromWebContents(event.sender)?.close());
ipcMain.handle("run:notify", (event, title, body) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isFocused() || !Notification.isSupported()) return;
  new Notification({ title: String(title).slice(0, 120), body: String(body).slice(0, 300) }).show();
});

app.whenReady().then(() => {
  protocol.handle("fugu-app", serveBundle);
  const menu = process.env.FUGU_HEADLESS === "1" ? null : Menu.buildFromTemplate([
    { label: "Файл", submenu: [{ role: "quit", label: "Выход" }] },
    { label: "Правка", submenu: [
      { role: "undo", label: "Отменить" },
      { role: "redo", label: "Повторить" },
      { type: "separator" },
      { role: "cut", label: "Вырезать" },
      { role: "copy", label: "Копировать" },
      { role: "paste", label: "Вставить" },
      { role: "selectAll", label: "Выделить всё" },
    ] },
    { label: "Вид", submenu: [
      { role: "reload", label: "Обновить" },
      { role: "resetZoom", label: "Обычный масштаб" },
      { role: "zoomIn", label: "Увеличить" },
      { role: "zoomOut", label: "Уменьшить" },
      { type: "separator" },
      { role: "togglefullscreen", label: "Полный экран" },
    ] },
  ]);
  if (menu) Menu.setApplicationMenu(menu);
  app.setAsDefaultProtocolClient("fugudeck");
  pendingInvite = pendingInvite || process.argv.find((arg) => arg.startsWith("fugudeck://"));
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
