/**
 * Every screen as a picture, for the README and for looking at the product with one's own eyes:
 * the page settled, a chip, the reveal, a rule's catch; the popup with nothing to say, with a
 * judged page in light and in dark; the options page. Same harness as the e2e, same live model.
 *
 * Run: npm run build && node --env-file=.env e2e/screens.mjs [--docs]
 * Without --docs the pictures go to e2e/screenshots/screens/; with it they replace docs/screenshots/.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.mjs";
import { FIXTURE_HOST, JUDGE_TIMEOUT_MS, here, launch, preflight, root, saveKey, sleep, waitJudged } from "./harness.mjs";

const key = preflight("screens.mjs");
const out = process.argv.includes("--docs") ? join(root, "docs", "screenshots") : join(here, "screenshots", "screens");
const RULES = ["prices", "sponsor discount codes"];

/** The popup opened as a tab has no toolbar click behind it, so it is told which tab it belongs to. */
async function openPopup(context, id, tab, { dark = false } = {}) {
  const popup = await context.newPage();
  await popup.emulateMedia({ colorScheme: dark ? "dark" : "light" });
  await popup.setViewportSize({ width: 320, height: 600 });
  if (tab) {
    await popup.addInitScript((tab) => {
      const query = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = (q) => (q && q.active ? Promise.resolve([tab]) : query(q));
    }, tab);
  }
  await popup.goto(`chrome-extension://${id}/popup.html`);
  return popup;
}

async function shoot(page, name, opts = {}) {
  if (opts.card) {
    const h = await page.evaluate(() => Math.ceil(document.querySelector("main")?.getBoundingClientRect().bottom ?? document.body.scrollHeight));
    opts = { clip: { x: 0, y: 0, width: 320, height: h } };
  }
  await page.screenshot({ path: join(out, name), ...opts });
  console.log(`[osso screens] ${name}`);
}

const userDataDir = mkdtempSync(join(tmpdir(), "osso-screens-"));
let context = null;
let server = null;
let exitCode = 0;

try {
  server = await startServer(join(here, "fixtures"));
  mkdirSync(out, { recursive: true });
  const launched = await launch(userDataDir);
  context = launched.context;
  const id = launched.id;

  // Before any key: what a new install sees.
  const fresh = await openPopup(context, id, null);
  await sleep(600);
  await shoot(fresh, "popup-nokey.png", { card: true });
  await fresh.close();

  await saveKey(context, id, key);

  // The page, settled.
  const page = await context.newPage();
  await page.goto(`${server.url}/recipe.html`);
  await waitJudged(page);
  await shoot(page, "page-faded.png");

  // A chip on the first faded sentence.
  await page.locator(".osso-fade").first().hover();
  await page.waitForSelector(".osso-chip.osso-chip-show", { state: "visible", timeout: 5000 });
  await sleep(250);
  await shoot(page, "page-chip.png");
  await page.mouse.move(0, 0);
  await sleep(300);

  // Holding Shift.
  await page.keyboard.down("Shift");
  await sleep(400);
  await shoot(page, "page-revealed.png");
  await page.keyboard.up("Shift");
  await sleep(600);

  // Rules, set the way the popup sets them; the sponsor sentence comes back with its underline.
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${id}/options.html`);
  await page.bringToFront();
  await ext.evaluate((rules) => chrome.runtime.sendMessage({ type: "setSettings", patch: { rules } }), RULES);
  await page.waitForFunction(
    () => [...document.querySelectorAll(".osso-s")].some((s) => (s.textContent ?? "").includes("THYME15") && !s.classList.contains("osso-fade")),
    null,
    { timeout: JUDGE_TIMEOUT_MS, polling: 50 },
  );
  await page.evaluate(() => document.querySelector(".osso-rule-hit")?.scrollIntoView({ block: "center" }));
  await sleep(150);
  await shoot(page, "page-rule.png");

  // The popup for that page, once both rules have their counts.
  const tab = await ext.evaluate(async (host) => {
    for (const t of await chrome.tabs.query({})) {
      const r = await chrome.runtime.sendMessage({ type: "getTabState", tabId: t.id });
      if (r?.state?.host === host) return { id: t.id, active: true };
    }
    return null;
  }, FIXTURE_HOST);
  if (!tab) throw new Error("the recipe tab was not found through the background");
  tab.url = `${server.url}/recipe.html`;
  const t0 = performance.now();
  for (;;) {
    const s = await ext.evaluate((tabId) => chrome.runtime.sendMessage({ type: "getTabState", tabId }).then((r) => r?.state), tab.id);
    if (s && RULES.every((r) => typeof s.ruleHits?.[r] === "number")) break;
    if (performance.now() - t0 > JUDGE_TIMEOUT_MS) throw new Error("rule counts never arrived");
    await sleep(100);
  }

  const popup = await openPopup(context, id, tab);
  await sleep(1500);
  await shoot(popup, "popup-done.png", { card: true });
  await popup.close();

  const dark = await openPopup(context, id, tab, { dark: true });
  await sleep(1500);
  await shoot(dark, "popup-dark.png", { card: true });
  await dark.close();

  // Options, with a key and two rules in place.
  await ext.evaluate(() => chrome.runtime.sendMessage({ type: "setSettings", patch: { allowedHosts: [] } }));
  await ext.setViewportSize({ width: 760, height: 900 });
  await ext.emulateMedia({ colorScheme: "light" });
  await ext.reload();
  await sleep(800);
  await shoot(ext, "options.png", { fullPage: true });
  await ext.emulateMedia({ colorScheme: "dark" });
  await sleep(300);
  await shoot(ext, "options-dark.png", { fullPage: true });

  await ext.evaluate(() => chrome.runtime.sendMessage({ type: "setSettings", patch: { rules: [] } }));
  await ext.close();
  await page.close();
} catch (err) {
  exitCode = 1;
  console.error("\n[osso screens] ERROR:", err);
} finally {
  await context?.close().catch(() => {});
  await server?.close().catch(() => {});
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 });
}

console.log(exitCode === 0 ? `[osso screens] OK → ${out}` : "[osso screens] FAILED");
process.exit(exitCode);
