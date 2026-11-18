import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EMPTY_MODEL_PREFS,
  fallbackChain,
  nameOfModel,
  providerOf,
  rememberModel,
  resolveScenario,
  toggleFavorite,
  visibleModels,
} from "../src/core/models";

test("model search, favorites and recent models", () => {
  assert.equal(providerOf("openai:gpt-test"), "openai");
  assert.equal(nameOfModel("custom-my-api:model:x"), "model:x");
  assert.deepEqual(visibleModels(["openai:gpt-test", "moonshot:kimi-k3"], "OPENAI gpt"), ["openai:gpt-test"]);
  let prefs = toggleFavorite(EMPTY_MODEL_PREFS, "openai:gpt-test");
  assert.deepEqual(prefs.favorites, ["openai:gpt-test"]);
  prefs = toggleFavorite(prefs, "openai:gpt-test");
  assert.deepEqual(prefs.favorites, []);
  prefs = rememberModel(rememberModel(EMPTY_MODEL_PREFS, "openai:a"), "openai:b");
  prefs = rememberModel(prefs, "openai:a");
  assert.deepEqual(prefs.recent, ["openai:a", "openai:b"]);
});

test("fallback chain is unique and limited", () => {
  const prefs = { ...EMPTY_MODEL_PREFS, fallbacks: ["openai:a", "openai:a", "openai:b", "openai:c", "openai:d"] };
  assert.deepEqual(fallbackChain(prefs), ["openai:a", "openai:b", "openai:c"]);
});


test("scenario roles use configured and available models", () => {
  const prefs = {
    ...EMPTY_MODEL_PREFS,
    roles: { code: "moonshot:kimi", review: "anthropic:claude", summary: "openai:missing" },
  };
  assert.deepEqual(resolveScenario(prefs, "moonshot:kimi", ["moonshot:kimi", "anthropic:claude"], ["moonshot", "anthropic"]), {
    code: "moonshot:kimi", review: "anthropic:claude", summary: "anthropic:claude",
  });
});
