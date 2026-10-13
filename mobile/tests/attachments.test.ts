/** Вложения чата: проверки до загрузки и тело запроса. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { attachProblem, base64Bytes, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, sizeText, uploadBody } from "../src/core/attachments";

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
  assert.match(attachProblem({ name: "video.mp4", size: MAX_ATTACHMENT_BYTES + 1 }, 0)!, /video\.mp4.*до 8,0 МБ/);
  assert.match(attachProblem({ name: "empty.txt", size: 0 }, 0)!, /пустой/);
  assert.match(attachProblem({ name: "a.png", size: 10 }, MAX_ATTACHMENTS)!, /не больше 6/);
});

test("тело запроса: имя, тип и содержимое как есть", () => {
  assert.deepEqual(uploadBody({ name: "фото 1.jpg", mime: "image/jpeg", size: 3, base64: "QUJD" }), { filename: "фото 1.jpg", mime: "image/jpeg", data: "QUJD" });
  assert.equal(uploadBody({ name: "", mime: "", size: 1, base64: "QQ==" }).filename, "file");
  assert.equal(uploadBody({ name: "x".repeat(400), mime: "", size: 1, base64: "QQ==" }).filename.length, 255);
});
