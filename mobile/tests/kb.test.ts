/** База знаний: данные вставляются в страницу безопасно, сообщения от страницы разбираются строго, страница собрана. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import vm from "node:vm";

import { kbInjection, parseKbMessage } from "../src/kb/inject";
import { KB_HTML } from "../src/kb/kbHtml";

test("данные базы знаний вставляются в скрипт без возможности выйти из него", () => {
  const evil = {
    notes: [{ id: "n1", title: "</script><script>globalThis.PWNED=1</script>", body: "строка\u2028с\u2029разделителями \"кавычки\" \\ <!-- & ${x} `" }],
    hub: "p:x",
  };
  const js = kbInjection(evil, "web");
  assert.ok(!/[<>&\u2028\u2029]/.test(js), "в тексте скрипта нет символов, закрывающих тег или строку");
  const box: any = { window: {} };
  vm.runInNewContext(js, box);
  assert.deepEqual(JSON.parse(JSON.stringify(box.window.KB_DATA)), evil, "страница получает ровно те же данные");
  assert.equal(box.window.KB_VIEW, "web");
  assert.equal(box.PWNED, undefined);
  // неизвестный вид от хранилища настроек не попадает в страницу как есть
  const box2: any = { window: {} };
  vm.runInNewContext(kbInjection({ notes: [] }, '";globalThis.PWNED=1;"'), box2);
  assert.equal(box2.window.KB_VIEW, "tree");
  assert.equal(box2.PWNED, undefined);
});

test("сообщения от страницы: только известные типы и поля", () => {
  assert.deepEqual(parseKbMessage('{"type":"edit","mid":7,"extra":"x"}'), { type: "edit", mid: 7 });
  assert.deepEqual(parseKbMessage('{"type":"view","key":"brain"}'), { type: "view", key: "brain" });
  assert.deepEqual(parseKbMessage('{"type":"ready","notes":3,"edges":2}'), { type: "ready", notes: 3, edges: 2 });
  for (const bad of ['{"type":"edit","mid":"7"}', '{"type":"edit","mid":-1}', '{"type":"view","key":"../x"}', '{"type":"open","url":"https://evil"}', "не json", "null", "[]"]) {
    assert.equal(parseKbMessage(bad), null, bad);
  }
  assert.equal((parseKbMessage(JSON.stringify({ type: "error", message: "x".repeat(1000) })) as any).message.length, 300);
});

test("страница собрана из kb/kb.html, самодостаточна и принимает данные приложения", () => {
  execFileSync(process.execPath, ["scripts/build-kb.mjs", "--check"], { stdio: "pipe" });
  assert.match(KB_HTML, /window\.KB_DATA/);
  assert.match(KB_HTML, /Content-Security-Policy" content="default-src 'none'/);
  assert.doesNotMatch(KB_HTML, /(src|href)\s*=\s*["']https?:/i, "страница не подгружает ничего из сети");
  assert.doesNotMatch(KB_HTML, /fetch\(|XMLHttpRequest|WebSocket|import\(/, "и сама никуда не ходит");
});

test("свёртка сотен заметок: страница просит показать все, приложение передаёт флаг", () => {
  assert.deepEqual(parseKbMessage(JSON.stringify({ type: "all", extra: "<x>" })), { type: "all" });
  assert.match(kbInjection({ notes: [] }, "tree", true), /window\.KB_ALL=true;/);
  assert.match(kbInjection({ notes: [] }, "tree"), /window\.KB_ALL=false;/);
});
