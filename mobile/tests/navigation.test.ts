import assert from "node:assert/strict";
import test from "node:test";

import { appSection, appSectionPath, ROUTE_INVENTORY, SECTION_LABELS, spaceLaunchKey } from "../src/core/navigation";
import { mobileSection, mobileSectionPath, showMobileNavigation } from "../src/core/mobileNavigation";

test("route inventory preserves every product area", () => {
  assert.ok(ROUTE_INVENTORY.length >= 18);
  for (const item of ROUTE_INVENTORY) {
    assert.ok(item.features.length > 20, item.match);
    assert.ok(SECTION_LABELS[item.section], item.match);
  }
  for (const path of ["/", "/s/one/chats", "/s/one/tasks", "/s/one", "/s/one/p/general", "/s/one/kb/general", "/s/one/workspace", "/s/one/prefs", "/servers/c1", "/keys/c1", "/mcp/c1", "/egress/c1", "/devices/c1", "/cluster/c1", "/modules", "/settings", "/s/one/usage"]) {
    assert.ok(appSection(path), path);
  }
});

test("desktop sections keep the current space and existing routes", () => {
  assert.equal(appSectionPath("home"), "/");
  assert.equal(appSectionPath("chats", { sid: "one" }), "/s/one/chats");
  assert.equal(appSectionPath("projects", { sid: "one" }), "/s/one");
  assert.equal(appSectionPath("models", { sid: "one" }), "/s/one/prefs?tab=models");
  assert.equal(appSectionPath("servers", { sid: "one", cluster: "c1" }), "/servers/c1");
  assert.equal(appSectionPath("access", { sid: "one", cluster: "c1" }), "/keys/c1");
  assert.equal(appSectionPath("permissions", { sid: "one", kind: "team" }), "/team/one");
  assert.equal(appSectionPath("permissions", { sid: "one" }), "/s/one/prefs?tab=agents");
  assert.equal(appSectionPath("parameters", { sid: "one" }), "/settings");
});

test("mobile navigation has three work tabs and a complete more menu", () => {
  assert.equal(mobileSection("/s/one/chats"), "chats");
  assert.equal(mobileSection("/s/one/tasks"), "chats");
  assert.equal(mobileSection("/s/one/p/general"), "projects");
  assert.equal(mobileSection("/s/one/kb/general"), "projects");
  assert.equal(mobileSection("/s/one/workspace"), "projects");
  assert.equal(mobileSection("/s/one/prefs"), "models");
  assert.equal(mobileSection("/modules"), "more");
  assert.equal(mobileSection("/settings"), "more");
  assert.equal(mobileSection("/keys/c1"), "more");
});

test("main menu, conversation and enrollment remain free of work navigation", () => {
  assert.equal(showMobileNavigation("/"), false);
  assert.equal(showMobileNavigation("/launch/one"), false);
  assert.equal(showMobileNavigation("/s/one/c/chat"), false);
  assert.equal(showMobileNavigation("/s/one/login"), false);
  assert.equal(showMobileNavigation("/scan"), false);
  assert.equal(showMobileNavigation("/s/one/chats"), true);
  assert.equal(showMobileNavigation("/modules"), true);
});

test("main tabs preserve the current space and have a safe home fallback", () => {
  assert.equal(mobileSectionPath("chats", "one"), "/s/one/chats");
  assert.equal(mobileSectionPath("projects", "one"), "/s/one");
  assert.equal(mobileSectionPath("models", "one"), "/s/one/prefs?tab=models");
  assert.equal(mobileSectionPath("projects"), "/");
  assert.equal(mobileSectionPath("more", "one"), null);
});

test("space launch is stable when a cluster rebuilds its derived device record", () => {
  const first = spaceLaunchKey({ id: "d-device" });
  const renderedAgain = spaceLaunchKey({ id: "d-device" });
  assert.equal(first, "d-device");
  assert.equal(renderedAgain, first);
  assert.notEqual(spaceLaunchKey({ id: "d-other" }), first);
  assert.equal(spaceLaunchKey(undefined), "");
});
