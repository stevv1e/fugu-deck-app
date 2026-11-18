const http = require("node:http");
const https = require("node:https");
const { createPrivateKey } = require("node:crypto");

const streams = new Map();

function checkedRequest(event, req) {
  const sender = event.senderFrame?.url || event.sender.getURL();
  if (!sender.startsWith("fugu-app://bundle")) throw new Error("Сетевой запрос не из окна Fugu Deck");
  if (!req || typeof req.url !== "string" || typeof req.method !== "string") throw new Error("Некорректный запрос");
  const url = new URL(req.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Разрешены только HTTP(S)");
  if (!req.headers || typeof req.headers !== "object" || Array.isArray(req.headers)) throw new Error("Некорректные заголовки");
  if (req.body !== undefined && typeof req.body !== "string") throw new Error("Некорректное тело запроса");
  if (!!req.certPem !== !!req.keyJwk) throw new Error("Для mTLS нужны сертификат и ключ");
  return url;
}

function perform(event, req, onResponse, onError) {
  const url = checkedRequest(event, req);
  const options = { method: req.method, headers: req.headers };
  if (req.certPem) {
    options.cert = req.certPem;
    options.key = createPrivateKey({ key: req.keyJwk, format: "jwk" }).export({ type: "pkcs8", format: "pem" });
  }
  const transport = url.protocol === "https:" ? https : http;
  const out = transport.request(url, options, (res) => onResponse(res, out));
  out.on("error", onError);
  const timeout = Number(req.timeoutMs ?? 30000);
  if (timeout > 0) out.setTimeout(timeout, () => out.destroy(new Error("Сервер не ответил вовремя")));
  if (req.body) out.write(req.body);
  out.end();
  return out;
}

function registerNetwork(ipcMain) {
  ipcMain.handle("net:request", async (event, req) => {
    return new Promise((resolve, reject) => {
      try {
        perform(event, req, (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString("utf8") }));
          res.on("error", reject);
        }, reject);
      } catch (error) {
        reject(error);
      }
    });
  });

  ipcMain.on("net:stream", (event, id, req) => {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{4,40}$/.test(id) || streams.has(id)) return;
    const channel = `net:stream:${id}`;
    const send = (data) => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, data);
    };
    try {
      const out = perform(event, req, (res) => {
        const status = res.statusCode || 0;
        send({ type: "open", status });
        const decoder = new TextDecoder();
        res.on("data", (chunk) => send({ type: "chunk", text: decoder.decode(chunk, { stream: true }) }));
        res.on("end", () => {
          streams.delete(id);
          send({ type: "end", status });
        });
        res.on("error", (error) => {
          streams.delete(id);
          send({ type: "end", status, error: error.message });
        });
      }, (error) => {
        streams.delete(id);
        send({ type: "end", status: 0, error: error.message });
      });
      streams.set(id, out);
    } catch (error) {
      send({ type: "end", status: 0, error: error.message });
    }
  });

  ipcMain.on("net:stream:close", (_event, id) => {
    streams.get(id)?.destroy();
    streams.delete(id);
  });
}

module.exports = { registerNetwork };
