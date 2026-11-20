import assert from "node:assert/strict";
import { test } from "node:test";

import { appendModuleEvent, type ModuleSecurityEvent } from "../src/core/security";

test("module security journal is newest-first and bounded", () => {
  let events: ModuleSecurityEvent[] = [];
  for (let i = 0; i < 510; i++) events = appendModuleEvent(events, { module: "demo", action: "network.get", ok: i % 2 === 0, details: `request-${i}` }, 1000 + i);
  assert.equal(events.length, 500);
  assert.equal(events[0].details, "request-509");
  assert.equal(events[499].details, "request-10");
});
