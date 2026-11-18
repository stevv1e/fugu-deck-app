const assert = require("node:assert/strict");
const http = require("node:http");
const { test } = require("node:test");
const { registerNetwork } = require("./net");

test("desktop transport performs requests and streams only for the app window", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/stream") {
      res.write("one");
      setTimeout(() => res.end("two"), 20);
      return;
    }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => res.end(`${req.method}:${body}`));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const handlers = new Map();
  const listeners = new Map();
  const ipcMain = {
    handle: (name, fn) => handlers.set(name, fn),
    on: (name, fn) => listeners.set(name, fn),
  };
  registerNetwork(ipcMain);
  const event = { senderFrame: { url: "fugu-app://bundle/" }, sender: { getURL: () => "fugu-app://bundle/" } };
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await handlers.get("net:request")(event, { method: "POST", url: `${url}/`, headers: {}, body: "test", timeoutMs: 5000 });
    assert.deepEqual(response, { status: 200, text: "POST:test" });

    const events = [];
    const sender = { ...event.sender, isDestroyed: () => false, send: (_channel, data) => events.push(data) };
    listeners.get("net:stream")({ ...event, sender }, "test-stream", { method: "GET", url: `${url}/stream`, headers: {}, timeoutMs: 5000 });
    for (let i = 0; i < 50 && !events.some((e) => e.type === "end"); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(events.find((e) => e.type === "open")?.status, 200);
    assert.equal(events.filter((e) => e.type === "chunk").map((e) => e.text).join(""), "onetwo");
    assert.equal(events.find((e) => e.type === "end")?.status, 200);

    await assert.rejects(handlers.get("net:request")({ ...event, senderFrame: { url: "https://evil.example" } }, { method: "GET", url, headers: {} }), /не из окна/);
    await assert.rejects(handlers.get("net:request")(event, { method: "GET", url: "file:///etc/passwd", headers: {} }), /HTTP/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
