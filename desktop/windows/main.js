const { app, BrowserWindow, ipcMain, Menu, net, protocol } = require("electron");
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
  mainWindow.loadURL("fugu-app://bundle/");
}

ipcMain.handle("window:minimize", (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
ipcMain.handle("window:maximize", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.handle("window:close", (event) => BrowserWindow.fromWebContents(event.sender)?.close());

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
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
