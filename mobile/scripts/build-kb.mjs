// Страница базы знаний (kb/kb.html) попадает в приложение строкой: WebView получает её без сети и без файлов.
//   node scripts/build-kb.mjs          пересобрать src/kb/kbHtml.ts
//   node scripts/build-kb.mjs --check  убедиться, что собранный файл соответствует kb/kb.html (для тестов)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "kb/kb.html"), "utf8");
const out = "// Собрано из kb/kb.html командой `node scripts/build-kb.mjs` — руками не править.\n" +
  "/* eslint-disable */\nexport const KB_HTML: string = " + JSON.stringify(html) + ";\n";
const target = join(root, "src/kb/kbHtml.ts");
if (process.argv.includes("--check")) {
  let cur = "";
  try { cur = readFileSync(target, "utf8"); } catch {}
  if (cur !== out) { console.error("src/kb/kbHtml.ts отстал от kb/kb.html: запустите node scripts/build-kb.mjs"); process.exit(1); }
} else {
  writeFileSync(target, out);
  console.log(`src/kb/kbHtml.ts: ${(out.length / 1024).toFixed(0)} КБ`);
}
