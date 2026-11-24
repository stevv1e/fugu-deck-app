const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("fuguDesktop", {
  minimize: () => ipcRenderer.invoke("window:minimize"),
  pickFiles: (limit) => ipcRenderer.invoke("files:pick", limit),
  dropFiles: (files, limit) => {
    const paths = Array.from(files).map((file) => {
      const value = webUtils.getPathForFile(file);
      if (!value) throw new Error("Перетащенный объект не является файлом на диске");
      return value;
    });
    return ipcRenderer.invoke("files:drop", paths, limit);
  },
  readFile: (id, position, length) => ipcRenderer.invoke("files:read", id, position, length),
  saveFile: (name, temporary) => ipcRenderer.invoke("files:save", name, temporary),
  writeFile: (id, data) => ipcRenderer.invoke("files:write", id, data),
  finishFile: (id) => ipcRenderer.invoke("files:finish", id),
  cancelFile: (id) => ipcRenderer.invoke("files:cancel", id),
  openFile: (id) => ipcRenderer.invoke("files:open", id),
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
