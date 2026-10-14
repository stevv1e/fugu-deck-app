import assert from "node:assert/strict";
import { test } from "node:test";

import { describeAction, prepareAction } from "../src/core/actions";
import { parseLimit } from "../src/core/personal";
import { buildSchedule, emptyForm, normTime } from "../src/core/schedule";

test("форма расписания: время, дни недели, разовое", () => {
  assert.equal(normTime("daily", "9:05"), "09:05");
  assert.equal(normTime("daily", "24:00"), null);
  assert.equal(normTime("hourly", ":15"), "00:15");
  assert.equal(normTime("hourly", "7"), "00:07");
  assert.equal(normTime("hourly", "75"), null);
  const f = { ...emptyForm("sakana:fugu-max-v1.0"), title: "Сводка", prompt: "Собери сводку", tz: "Asia/Almaty" };
  assert.deepEqual(buildSchedule({ ...f, kind: "daily", time: "8:30" }), {
    title: "Сводка", prompt: "Собери сводку", kind: "daily", at_time: "08:30", weekdays: [], tz: "Asia/Almaty", model: "sakana:fugu-max-v1.0", run_at: null,
  });
  assert.equal(buildSchedule({ ...f, kind: "weekly", weekdays: [] }), "Выберите хотя бы один день недели");
  assert.deepEqual((buildSchedule({ ...f, kind: "weekly", weekdays: [4, 0] }) as { weekdays: number[] }).weekdays, [0, 4]);
  assert.equal(buildSchedule({ ...f, title: " " }), "Нужно название");
  const now = new Date(2026, 9, 14, 12, 0).getTime();
  const once = buildSchedule({ ...f, kind: "once", date: "15.10.2026", time: "10:00" }, now) as { run_at: number };
  assert.equal(once.run_at, new Date(2026, 9, 15, 10, 0).getTime() / 1000);
  assert.equal(buildSchedule({ ...f, kind: "once", date: "14.10.2026", time: "11:00" }, now), "Это время уже прошло");
  assert.equal(buildSchedule({ ...f, kind: "once", date: "31.02.2026", time: "11:00" }, now), "Такой даты нет");
});

test("лимит расходов: ввод и подписываемое действие", () => {
  assert.deepEqual(parseLimit(""), { value: null });
  assert.deepEqual(parseLimit("$25,5"), { value: 25.5 });
  assert.ok("error" in parseLimit("0"));
  assert.ok("error" in parseLimit("1.234"));
  const p = prepareAction({ type: "spend_limit", limit_usd_month: 25.5 }, { deviceId: "d-0123456789abcdef", nonce: "n".repeat(22), nowSec: 1_790_000_000 });
  assert.equal(p.envelope.space, undefined);
  assert.deepEqual(p.description.lines[0], "Не больше $25.5 в месяц");
  const off = describeAction({ type: "spend_limit", limit_usd_month: null, device_id: "d-0123456789abcdef", nonce: "n".repeat(22), ts: 1 });
  assert.equal(off.lines[0], "Без лимита");
  assert.throws(() => prepareAction({ type: "spend_limit", limit_usd_month: 0.001 }, { deviceId: "d-0123456789abcdef", nonce: "n".repeat(22), nowSec: 1 }));
});
