import assert from "node:assert/strict";
import test from "node:test";

import { mobileSection, mobileSectionPath, showMobileNavigation } from "../src/core/mobileNavigation";

test("mobile navigation keeps every main section distinct", () => {
  assert.equal(mobileSection("/s/one/chats"), "chats");
  assert.equal(mobileSection("/s/one/p/general"), "chats");
  assert.equal(mobileSection("/s/one/kb/general"), "chats");
  assert.equal(mobileSection("/s/one/workspace"), "workspace");
  assert.equal(mobileSection("/s/one/tasks"), "tasks");
  assert.equal(mobileSection("/modules"), "modules");
  assert.equal(mobileSection("/s/one/prefs"), "more");
  assert.equal(mobileSection("/settings"), "more");
});

test("conversation and enrollment remain full-screen", () => {
  assert.equal(showMobileNavigation("/s/one/c/chat"), false);
  assert.equal(showMobileNavigation("/s/one/login"), false);
  assert.equal(showMobileNavigation("/scan"), false);
  assert.equal(showMobileNavigation("/s/one/chats"), true);
  assert.equal(showMobileNavigation("/modules"), true);
});

test("main tabs preserve the current space and have a safe home fallback", () => {
  assert.equal(mobileSectionPath("chats", "one"), "/s/one/chats");
  assert.equal(mobileSectionPath("workspace", "one"), "/s/one/workspace");
  assert.equal(mobileSectionPath("tasks", "one"), "/s/one/tasks");
  assert.equal(mobileSectionPath("modules", "one"), "/modules");
  assert.equal(mobileSectionPath("workspace"), "/");
  assert.equal(mobileSectionPath("more", "one"), null);
});
