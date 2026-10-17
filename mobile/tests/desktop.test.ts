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
