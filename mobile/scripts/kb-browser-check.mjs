// Проверка страницы базы знаний (kb/kb.html) в браузере без интерфейса: три вида на разных данных — пример,
// пустая база, одна заметка, одна область, 40 и 220 заметок. Ловит ошибки страницы, сетевые запросы и то, что
// разметка из текста заметки исполнилась или отрисовалась. Снимки складывает в каталог.
// В зависимости проекта браузер не входит (CI эту проверку не запускает). Вручную:
//   npm i --no-save playwright-core && npx playwright-core install chromium-headless-shell
//   node scripts/kb-browser-check.mjs "$PWD/kb/kb.html" /tmp/kb-shots <путь к chrome-headless-shell> [данные.json]
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
const [, , htmlPath, outDir, exe] = process.argv;
const html = readFileSync(htmlPath, "utf8");
const areas = ["dec", "inf", "code", "ppl", "ops"], srcs = ["docs", "chats", "api", "web", "prod"], types = ["part", "dep", "dec", "con", "ex", "ref"];
function data(n, onlyArea) {
  const notes = [], groups = Object.fromEntries(areas.map(a => [a, {}])), edges = [];
  for (let i = 0; i < n; i++) {
    const area = onlyArea || areas[i % 5], g = "группа " + (i % 3), id = "n" + (i + 1);
    notes.push({ id, mid: i + 1, area, title: i === 0 ? "<img src=x onerror=window.PWNED=1> заметка" : "Заметка " + (i + 1), body: i === 0 ? "<script>window.PWNED=1</script><b>жирный?</b>\nвторая строка" : "Текст заметки " + (i + 1),
      days: (i * 7) % 40, source: i === 0 ? "<i>источник</i>" : "чат", src: srcs[i % 5], stale: i % 11 === 3, ext: i % 13 === 5 });
    (groups[area][i === 1 ? "<u>группа</u>" : g] ||= []).push(id);
    if (i > 0) edges.push([id, "n" + (1 + Math.floor(i / 2)), types[i % 6], 0.2 + (i % 8) / 10]);
  }
  notes.push({ id: "p:general", mid: null, area: "ppl", title: "Проект <Shop>", body: "описание", days: 0, source: "проект", src: "web", hub: true });
  return { project: { id: "general", name: "<Shop>" }, hub: "p:general", notes, edges,
    areas: Object.fromEntries(areas.map(a => [a, { name: { dec: "Решения", inf: "Инфраструктура", code: "Код", ppl: "Люди и агенты", ops: "Операции" }[a], groups: Object.entries(groups[a]) }])),
    sources: { docs: "Документы", chats: "Чаты", api: "Репозитории", web: "Вручную", prod: "Серверы" } };
}
const REAL = process.argv[5] ? JSON.parse(readFileSync(process.argv[5], "utf8")) : null;
const cases = REAL ? { real: REAL } : { sample: null, empty: data(0), one: data(1), small: data(4, "inf"), medium: data(40), large: data(220) };
const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
let failed = 0;
for (const [name, d] of Object.entries(cases)) {
  for (const view of ["tree", "web", "brain"]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2, hasTouch: true });
    const errs = [], msgs = [];
    page.on("pageerror", (e) => errs.push(String(e.stack).split("\n").slice(0, 4).join(" | ").replace(/file:[^ ]*kb.html/g, "kb")));
    page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    page.on("request", (r) => { if (!r.url().startsWith("about:") && !r.url().startsWith("data:") && !r.url().startsWith("file:")) errs.push("сетевой запрос: " + r.url()); });
    await page.addInitScript(({ d, view }) => { if (d) window.KB_DATA = d; try { localStorage.setItem("fd-kb-view", view); } catch (e) {} window.ReactNativeWebView = { postMessage: (m) => (window.__msgs ||= []).push(m) }; }, { d, view });
    await page.goto("file://" + htmlPath, { waitUntil: "load" });
    await page.evaluate((v) => document.querySelector(`#views [data-v="${v}"]`)?.click(), view);
    await page.waitForTimeout(900);
    // касание первой заметки (если есть) — открывается карточка
    if (d && d.notes.length > 1) {
      await page.evaluate((word) => { const q = document.getElementById("q"); q.value = word; q.dispatchEvent(new Event("input")); q.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); }, REAL ? "nginx" : "заметка");
      await page.waitForTimeout(500);
    }
    const st = await page.evaluate(() => ({ pwned: window.PWNED || 0, msgs: window.__msgs || [], panel: document.getElementById("panel").innerText.slice(0, 160), live: !!window.KB_DATA, card: !!document.querySelector("#panel .body"),
      tags: document.querySelectorAll("#panel .body *:not(br), #panel h2 *, #panel dd *, #panel .nm *").length }));
    await page.screenshot({ path: `${outDir}/${name}-${view}.png` });
    const ready = st.msgs.some((m) => JSON.parse(m).type === "ready"), appErr = st.msgs.filter((m) => JSON.parse(m).type === "error");
    const needCard = d && d.notes.length > 1;
    const bad = errs.length || st.pwned || !ready || appErr.length || st.tags > 0 || !!d !== st.live || (needCard && !st.card);
    if (bad) { failed++; console.log(`✗ ${name}/${view}: errs=${JSON.stringify(errs.slice(0, 3))} pwned=${st.pwned} ready=${ready} appErr=${appErr} tags=${st.tags} live=${st.live} card=${st.card}`); }
    else console.log(`✓ ${name}/${view}: ${st.panel.replace(/\s+/g, " ").slice(0, 70)}`);
    await page.close();
  }
}
await browser.close();
process.exit(failed ? 1 : 0);
