const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const screens = ["chat", "models", "modules", "module-detail", "settings"];
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    useContentSize: true,
    show: false,
    backgroundColor: "#07080c",
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true },
  });
  await win.loadFile(path.join(__dirname, "index.html"), { hash: "chat" });
  for (const [index, screen] of screens.entries()) {
    await win.webContents.executeJavaScript(`show(${JSON.stringify(screen)})`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const image = await win.webContents.capturePage();
    const name = `${String(index + 1).padStart(2, "0")}-${screen}.png`;
    fs.writeFileSync(path.join(__dirname, name), image.toPNG());
  }
  win.destroy();
  app.quit();
});
