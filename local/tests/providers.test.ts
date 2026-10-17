import assert from "node:assert/strict";
import { test } from "node:test";

import { ask, titleOf, type StreamFetch } from "../src/core/chat";
import { buildRequest, costUsd, errorText, parseEvent, splitModel, SseParser, Utf8Stream, validModel } from "../src/core/providers";

test("splitModel и validModel", () => {
  assert.deepEqual(splitModel("anthropic:claude-opus-5-5"), ["anthropic", "claude-opus-5-5"]);
  assert.deepEqual(splitModel("fugu-max"), ["sakana", "fugu-max"]);
  assert.equal(validModel("deepseek:deepseek-flash"), null);
  assert.ok(validModel("foo:bar"));
  assert.ok(validModel("nocolon"));
  assert.ok(validModel("sakana:bad name"));
});

test("запрос: OpenAI-совместимый и Anthropic", () => {
  const o = buildRequest("deepseek:deepseek-flash", [{ role: "user", content: "hi" }], "sys", "sk-1");
  assert.equal(o.url, "https://api.deepseek.com/chat/completions");
  assert.equal(o.headers.authorization, "Bearer sk-1");
  const ob = JSON.parse(o.body);
  assert.equal(ob.model, "deepseek-flash");
  assert.deepEqual(ob.messages[0], { role: "system", content: "sys" });
  assert.equal(ob.stream, true);

  const s = buildRequest("sakana:fugu-max-v1.0", [{ role: "user", content: "hi" }], "", "k");
  assert.equal(s.url, "https://api.sakana.ai/v1/chat/completions");
  assert.equal(JSON.parse(s.body).messages.length, 1, "пустая подсказка не отправляется");

  const a = buildRequest("anthropic:claude-haiku-4-5", [{ role: "user", content: "hi" }], "sys", "sk-ant-x");
  assert.equal(a.url, "https://api.anthropic.com/v1/messages");
  assert.equal(a.headers["x-api-key"], "sk-ant-x");
  assert.equal(a.headers.authorization, undefined, "ключ Anthropic — не в Authorization");
  const ab = JSON.parse(a.body);
  assert.equal(ab.system, "sys");
  assert.ok(ab.max_tokens > 0);
});

test("SSE: события, разрезанные где угодно, и хвост без пустой строки", () => {
  const p = new SseParser();
  assert.deepEqual(p.push("data: {\"a\""), []);
  assert.deepEqual(p.push(":1}\n\nevent: x\ndata: 2\r\n\r\ndata: [DO"), ['{"a":1}', "2"]);
  assert.deepEqual(p.push("NE]"), []);
  assert.deepEqual(p.flush(), ["[DONE]"]);
});

test("события OpenAI и Anthropic", () => {
  assert.deepEqual(parseEvent("openai", '{"choices":[{"delta":{"content":"При"}}]}'), { text: "При" });
  assert.deepEqual(parseEvent("openai", '{"choices":[{"delta":{"reasoning_content":"хм"}}]}'), { reasoning: "хм" });
  assert.deepEqual(parseEvent("openai", '{"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":7}}'), { usage: { input: 5, output: 7 } });
  assert.deepEqual(parseEvent("openai", "[DONE]"), { done: true });
  assert.deepEqual(parseEvent("openai", '{"error":{"message":"bad"}}'), { error: "bad" });
  assert.deepEqual(parseEvent("anthropic", '{"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":4}}}'), { usage: { input: 14 } });
  assert.deepEqual(parseEvent("anthropic", '{"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}'), { text: "ok" });
  assert.deepEqual(parseEvent("anthropic", '{"type":"message_delta","usage":{"output_tokens":3}}'), { usage: { output: 3 } });
  assert.deepEqual(parseEvent("anthropic", '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), { error: "Overloaded" });
  assert.deepEqual(parseEvent("anthropic", "not json"), {});
});

test("UTF-8: символ разрезан между кусками", () => {
  const bytes = new TextEncoder().encode("Привет, 🐡!");
  const d = new Utf8Stream();
  let s = "";
  for (let i = 0; i < bytes.length; i += 3) s += d.push(bytes.slice(i, i + 3));
  assert.equal(s, "Привет, 🐡!");
});

test("ошибка провайдера: текст без ключа и подсказка", () => {
  const t = errorText(401, '{"error":{"message":"invalid key sk-secret"}}', "sk-secret");
  assert.ok(t.startsWith("401: invalid key [ключ]"));
  assert.ok(t.includes("проверьте ключ"));
});

test("ask: поток собирается в ответ, расход считается", async () => {
  const chunks = ['data: {"choices":[{"delta":{"content":"Пр', 'и"}}]}\n\ndata: {"choices":[{"delta":{"content":"вет"}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":500}}\n\ndata: [DONE]\n\n'];
  let seen: { url: string; auth: string } | null = null;
  const net: StreamFetch = async (url, init, onChunk) => {
    seen = { url, auth: init.headers.authorization };
    chunks.forEach(onChunk);
    return { status: 200, text: "" };
  };
  const updates: string[] = [];
  const a = await ask(net, "deepseek:deepseek-flash", [{ role: "user", content: "hi" }], "", "sk-1", (u) => updates.push(u.text));
  assert.equal(a.text, "Привет");
  assert.deepEqual(a.usage, { input: 1000, output: 500 });
  assert.deepEqual(seen, { url: "https://api.deepseek.com/chat/completions", auth: "Bearer sk-1" });
  assert.ok(updates.length >= 2);
  assert.equal(costUsd("deepseek:deepseek-flash", a.usage), (1000 * 0.3 + 500 * 1.2) / 1e6);
});

test("ask: HTTP-ошибка и ошибка внутри потока", async () => {
  const bad: StreamFetch = async () => ({ status: 429, text: '{"error":{"message":"Rate limit"}}' });
  await assert.rejects(ask(bad, "sakana:fugu", [{ role: "user", content: "x" }], "", "k", () => {}), /429: Rate limit/);
  const mid: StreamFetch = async (_u, _i, on) => {
    on('event: error\ndata: {"type":"error","error":{"message":"Overloaded"}}\n\n');
    return { status: 200, text: "" };
  };
  await assert.rejects(ask(mid, "anthropic:claude-haiku-4-5", [{ role: "user", content: "x" }], "", "k", () => {}), /Overloaded/);
});

test("titleOf", () => {
  assert.equal(titleOf("  первая строка\nвторая"), "первая строка");
  assert.equal(titleOf(""), "Новый чат");
  assert.equal(titleOf("a".repeat(70)).length, 61);
});
