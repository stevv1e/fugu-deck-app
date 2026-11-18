const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fuguDesktop", {
  minimize: () => ipcRenderer.invoke("window:minimize"),
  maximize: () => ipcRenderer.invoke("window:maximize"),
  close: () => ipcRenderer.invoke("window:close"),
  notify: (title, body) => ipcRenderer.invoke("run:notify", title, body),
  openAuth: (url) => ipcRenderer.invoke("auth:open", url),
  request: (req) => ipcRenderer.invoke("net:request", req),
  stream: (id, req) => ipcRenderer.send("net:stream", id, req),
  closeStream: (id) => ipcRenderer.send("net:stream:close", id),
  onStream: (id, callback) => {
    const channel = `net:stream:${id}`;
    const listener = (_event, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
