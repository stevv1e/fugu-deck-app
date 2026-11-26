const fs = require("node:fs");

function signingConfiguration(env) {
  const required = env.DECK_REQUIRE_AUTHENTICODE === "true";
  const certificate = (env.WIN_CSC_LINK || "").trim();
  const publisher = (env.DECK_WINDOWS_PUBLISHER || "").trim();
  if (!certificate) {
    if (required) throw new Error("Для GitHub Release нужен секрет WIN_CSC_LINK с base64 PFX-сертификатом");
    return { windowsPublisher: "" };
  }
  if (!publisher) throw new Error("Для Authenticode нужна переменная DECK_WINDOWS_PUBLISHER с точным subject сертификата");
  if (Buffer.byteLength(publisher) > 512) throw new Error("DECK_WINDOWS_PUBLISHER слишком длинный");
  return { windowsPublisher: publisher };
}

if (require.main === module) {
  const output = process.argv[2];
  if (!output) throw new Error("Использование: node configure-signing.js <output.json>");
  fs.writeFileSync(output, JSON.stringify(signingConfiguration(process.env), null, 2) + "\n", { mode: 0o600 });
}

module.exports = { signingConfiguration };
