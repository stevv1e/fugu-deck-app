/** Windows-сборка: прослойка fd-secure поверх команд Rust-части (Tauri). Сам Tauri подменяем. */
import assert from "node:assert/strict";
import { test } from "node:test";

const calls: { cmd: string; args?: any }[] = [];
const callbacks = new Map<number, (e: any) => void>();
let next = 1;
(globalThis as any).__TAURI_INTERNALS__ = {
  transformCallback: (cb: (e: any) => void) => { const id = next++; callbacks.set(id, cb); return id; },
  unregisterCallback: (id: number) => callbacks.delete(id),
  async invoke(cmd: string, args?: any) {
    calls.push({ cmd, args });
    if (cmd === "capabilities") return { platform: "windows", hardware: true, strongbox: false, biometry: true, mtls: true, appAttest: false };
    if (cmd === "plugin:event|listen") return 1;
    if (cmd === "request") return { status: 200, body: "{}" };
    return null;
  },
};
(globalThis as any).window = globalThis;

test("прослойка: команды Rust и события потоков как у нативного модуля", async () => {
  const { FdSecureDesktop } = await import("../modules/fd-secure/src/FdSecureDesktop");
  const m = FdSecureDesktop!;
  await m.ready;
  assert.equal(m.capabilities().hardware, true);
  await m.sign("a.c", "AAA", "Подтвердите");
  await m.request({ url: "https://api.x/v1", method: "GET", headers: {}, certAlias: "a.s" });
  assert.deepEqual(calls.find((c) => c.cmd === "sign")!.args, { alias: "a.c", data: "AAA", prompt: "Подтвердите" });
  assert.equal(calls.find((c) => c.cmd === "request")!.args.req.certAlias, "a.s");
  // поток: события Rust раздаются слушателям по имени; снятый слушатель больше не получает
  await new Promise((r) => setTimeout(r, 20));
  const got: string[] = [];
  const sub = m.addListener("onStreamChunk", (e: any) => got.push(e.text));
  const listen = calls.find((c) => c.cmd === "plugin:event|listen")!;
  const fire = (payload: any) => callbacks.get(listen.args.handler)!({ event: "fd-stream", id: 1, payload });
  fire({ id: "s1", kind: "chunk", text: "data: 1\n\n" });
  sub.remove();
  fire({ id: "s1", kind: "chunk", text: "data: 2\n\n" });
  assert.deepEqual(got, ["data: 1\n\n"]);
});

test("боковая панель понимает, что открыто, по адресу экрана", async () => {
  const { placeOf } = await import("../src/desktop/place");
  assert.deepEqual(placeOf("/s/cluster.api.x~t-1/c/abc"), { sid: "cluster.api.x~t-1", pid: null, chat: "abc", cluster: null, section: "c" });
  assert.deepEqual(placeOf("/s/srv1/kb/general"), { sid: "srv1", pid: "general", chat: null, cluster: null, section: "kb" });
  assert.equal(placeOf("/s/srv1").section, "");
  assert.deepEqual(placeOf("/team/cluster.h~t-2"), { sid: "cluster.h~t-2", pid: null, chat: null, cluster: null, section: "team" });
  assert.deepEqual(placeOf("/keys/h?kind=llm"), { sid: null, pid: null, chat: null, cluster: "h", section: "keys" });
  assert.deepEqual(placeOf("/settings"), { sid: null, pid: null, chat: null, cluster: null, section: "settings" });
  assert.equal(placeOf("/s/a%20b/c/x").sid, "a b");
});
