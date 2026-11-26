const assert = require("node:assert/strict");
const { test } = require("node:test");
const { signingConfiguration } = require("./configure-signing");

test("unsigned validation build is explicit and release requires a certificate", () => {
  assert.deepEqual(signingConfiguration({}), { windowsPublisher: "" });
  assert.throws(() => signingConfiguration({ DECK_REQUIRE_AUTHENTICODE: "true" }), /WIN_CSC_LINK/);
});

test("signed build pins the publisher and rejects incomplete configuration", () => {
  const publisher = "CN=Fugu Deck, O=Fugu Deck";
  assert.deepEqual(signingConfiguration({ WIN_CSC_LINK: "base64-pfx", DECK_WINDOWS_PUBLISHER: publisher }), { windowsPublisher: publisher });
  assert.throws(() => signingConfiguration({ WIN_CSC_LINK: "base64-pfx" }), /DECK_WINDOWS_PUBLISHER/);
  assert.throws(() => signingConfiguration({ WIN_CSC_LINK: "base64-pfx", DECK_WINDOWS_PUBLISHER: "x".repeat(513) }), /слишком длинный/);
});
