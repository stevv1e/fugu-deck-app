/** Вложения чата: проверки до загрузки и тело запроса. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { attachProblem, base64Bytes, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_MEDIA_ATTACHMENT_BYTES, sizeText, SMALL_UPLOAD, uploadBody, uploadFile } from "../src/core/attachments";

test("размер по base64 и подписи размера", () => {
  for (const n of [1, 2, 3, 4, 1000, 1001, 1002]) {
    assert.equal(base64Bytes(Buffer.alloc(n, 7).toString("base64")), n, `длина ${n}`);
  }
  assert.equal(sizeText(512), "512 Б");
  assert.equal(sizeText(2048), "2 КБ");
  assert.equal(sizeText(1.5 * 1024 * 1024), "1,5 МБ");
});

test("большой, пустой и лишний файл отклоняются до загрузки", () => {
  assert.equal(attachProblem({ name: "a.png", size: 1024 }, 0), null);
  assert.equal(attachProblem({ name: "a.png", size: MAX_ATTACHMENT_BYTES }, MAX_ATTACHMENTS - 1), null);
  assert.equal(attachProblem({ name: "video.mp4", size: MAX_MEDIA_ATTACHMENT_BYTES }, 0), null);
  assert.match(attachProblem({ name: "video.mp4", size: MAX_MEDIA_ATTACHMENT_BYTES + 1 }, 0)!, /до 2048,0 МБ/);
  assert.match(attachProblem({ name: "document.txt", size: MAX_ATTACHMENT_BYTES + 1 }, 0)!, /до 50,0 МБ/);
  assert.match(attachProblem({ name: "empty.txt", size: 0 }, 0)!, /пустой/);
  assert.match(attachProblem({ name: "a.png", size: 10 }, MAX_ATTACHMENTS)!, /не больше 6/);
});

test("тело запроса: имя, тип и содержимое как есть", () => {
  assert.deepEqual(uploadBody({ name: "фото 1.jpg", mime: "image/jpeg" }, "QUJD"), { filename: "фото 1.jpg", mime: "image/jpeg", data: "QUJD" });
  assert.equal(uploadBody({ name: "", mime: "" }, "QQ==").filename, "file");
  assert.equal(uploadBody({ name: "x".repeat(400), mime: "" }, "QQ==").filename.length, 255);
});

/** Подменный сервер загрузки: принимает части по порядку, повтор принятой части не задваивает. */
function fakeServer(failOnce?: number) {
  const calls: string[] = [];
  let buf = Buffer.alloc(0);
  let failed = false;
  let expected = 0;
  const req = async <T,>(method: string, path: string, body?: any): Promise<T> => {
    calls.push(`${method} ${path.replace(/[0-9a-f]{6,}/, "ID")}`);
    if (path.endsWith("/attachments/json")) return { id: "small", filename: body.filename, mime: body.mime, size: Buffer.from(body.data, "base64").length } as T;
    if (path.endsWith("/uploads")) {
      expected = body.size;
      return { upload_id: "u1", chunk_bytes: 1000 } as T;
    }
    if (path.endsWith("/uploads/u1") && method === "GET") return { upload_id: "u1", chunk_bytes: 1000, got: buf.length, size: expected } as T;
    if (path.endsWith("/uploads/u1") && method === "DELETE") {
      buf = Buffer.alloc(0);
      return { ok: true } as T;
    }
    if (path.endsWith("/chunk")) {
      if (failOnce !== undefined && body.offset === failOnce && !failed) {
        failed = true;
        throw new Error("сеть");
      }
      if (body.offset === buf.length) buf = Buffer.concat([buf, Buffer.from(body.data, "base64")]);
      return { got: buf.length } as T;
    }
    if (path.endsWith("/finish")) return { id: "big", filename: "f", mime: "", size: buf.length } as T;
    throw new Error(path);
  };
  return { req, calls, data: () => buf };
}

test("загрузка: маленький файл одним запросом, большой — частями с повтором после обрыва", async () => {
  const file = Buffer.from(Array.from({ length: SMALL_UPLOAD + 2500 }, (_, i) => i % 251));
  const read = {
    all: async (_u: string) => file.subarray(0, 10).toString("base64"),
    chunk: async (_u: string, pos: number, len: number) => file.subarray(pos, pos + len).toString("base64"),
  };
  const s = fakeServer();
  const small = await uploadFile(s.req, "c1", { name: "a.txt", mime: "text/plain", size: 10, uri: "file:///a" }, read);
  assert.equal(small.id, "small");
  assert.deepEqual(s.calls, ["POST /api/conversations/c1/attachments/json"]);

  const b = fakeServer(1000);
  const seen: number[] = [];
  const big = await uploadFile(b.req, "c1", { name: "b.zip", mime: "", size: file.length, uri: "file:///b" }, read, (d) => seen.push(d));
  assert.equal(big.id, "big");
  assert.ok(b.data().equals(file), "собранный на сервере файл совпадает");
  assert.equal(seen.at(-1), file.length);
  assert.equal(b.calls.filter((c) => c.endsWith("/chunk")).length, Math.ceil(file.length / 1000) + 1); // +1 — повтор
});

test("загрузка: файл короче заявленного — понятная ошибка, без повторов", async () => {
  const file = Buffer.alloc(SMALL_UPLOAD + 500, 1);
  const s = fakeServer();
  const read = {
    all: async (_u: string) => "",
    // как на телефоне: за концом файла чтение возвращает пустую строку
    chunk: async (_u: string, pos: number, len: number) => file.subarray(pos, pos + len).toString("base64"),
  };
  await assert.rejects(
    uploadFile(s.req, "c1", { name: "photo.jpg", mime: "image/jpeg", size: file.length + 5000, uri: "file:///p" }, read),
    /photo\.jpg.*не целиком/,
  );
  assert.equal(s.calls.filter((c) => c.endsWith("/chunk")).length, Math.ceil(file.length / 1000));
});


test("загрузка продолжается с принятого сервером offset", async () => {
  const file = Buffer.alloc(SMALL_UPLOAD + 2500, 3);
  const s = fakeServer();
  await s.req("POST", "/api/conversations/c1/uploads", { filename: "b.bin", size: file.length });
  const first = file.subarray(0, 1000);
  await s.req("POST", "/api/uploads/u1/chunk", { offset: 0, data: first.toString("base64") });
  const read = {
    all: async () => "",
    chunk: async (_u: string, pos: number, len: number) => file.subarray(pos, pos + len).toString("base64"),
  };
  const seen: number[] = [];
  const result = await uploadFile(s.req, "c1", { name: "b.bin", mime: "", size: file.length, uri: "file:///b" }, read, (d) => seen.push(d), { resumeId: "u1" });
  assert.equal(result.id, "big");
  assert.equal(s.calls.filter((c) => c.endsWith("/uploads")).length, 1, "есть только исходная загрузка, новая не создаётся");
  assert.equal(s.calls.filter((c) => c.endsWith("/chunk")).length, Math.ceil(file.length / 1000), "первый серверный chunk плюс оставшиеся");
  assert.equal(seen[0], 1000);
  assert.ok(s.data().equals(file));
});

test("отмена прекращает части и удаляет незавершённую серверную загрузку", async () => {
  const file = Buffer.alloc(SMALL_UPLOAD + 2500, 4);
  const s = fakeServer();
  const controller = new AbortController();
  const read = {
    all: async () => "",
    chunk: async (_u: string, pos: number, len: number) => file.subarray(pos, pos + len).toString("base64"),
  };
  await assert.rejects(uploadFile(s.req, "c1", { name: "b.bin", mime: "", size: file.length, uri: "file:///b" }, read, (d) => {
    if (d > 0) controller.abort();
  }, { signal: controller.signal }), (e: any) => e.name === "AbortError");
  assert.ok(s.calls.includes("DELETE /api/uploads/u1"));
  assert.equal(s.data().length, 0);
});
