/**
 * End-to-end smoke against the live model: load dist/ into Chromium, serve the fixtures on
 * localhost, save a real key through the options page, and check that a recipe page comes back
 * with its story faded and its ingredients in ink. No test runner; a plain script that exits 1
 * on the first failed assertion and prints why.
 *
 * Run: npm run build && node --env-file=.env e2e/run.mjs
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const dist = join(root, "dist");
const shots = join(here, "screenshots");
const FIXTURE_HOST = "127.0.0.1";
/** Generous: a cold page is one or two model round-trips of 1–3 s each, plus the settle animation. */
const JUDGE_TIMEOUT_MS = 20_000;

const key = process.env.TYPESAFE_API_KEY;
if (!key) {
  console.error("[osso e2e] TYPESAFE_API_KEY is not set. Put it in .env (see .env.example) and run: node --env-file=.env e2e/run.mjs");
  process.exit(1);
}
if (!existsSync(join(dist, "manifest.json"))) {
  console.error("[osso e2e] dist/ is missing: run npm run build");
  process.exit(1);
}

class AssertionFailed extends Error {}
function assert(cond, msg) {
  if (!cond) throw new AssertionFailed(msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Counts per sentence id, not per span: a sentence split around inline markup is several spans with one data-osso. */
function countSentences() {
  const byId = new Map();
  for (const s of document.querySelectorAll(".osso-s")) {
    const id = s.getAttribute("data-osso") ?? "";
    byId.set(id, (byId.get(id) ?? false) || s.classList.contains("osso-fade"));
  }
  let faded = 0;
  for (const f of byId.values()) if (f) faded++;
  return { total: byId.size, faded, kept: byId.size - faded };
}

/** Is the sentence containing `needle` faded? null when no judged span contains it. */
function fadedByText(needle) {
  const spans = [...document.querySelectorAll(".osso-s")];
  const hit = spans.find((s) => (s.textContent ?? "").includes(needle));
  if (!hit) return null;
  const id = hit.getAttribute("data-osso");
  return spans.some((s) => s.getAttribute("data-osso") === id && s.classList.contains("osso-fade"));
}

async function launch(userDataDir) {
  const args = [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--no-first-run"];
  // New headless Chromium loads extensions; the headless shell does not. Try it, and if the
  // worker never shows up fall back to a visible window rather than guess at the cause.
  for (const opts of [{ headless: true, channel: "chromium" }, { headless: false }]) {
    const context = await chromium.launchPersistentContext(userDataDir, { ...opts, args, viewport: { width: 1200, height: 900 } });
    try {
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 5000 }));
      const id = new URL(worker.url()).host;
      console.log(`[osso e2e] extension ${id} (${opts.headless ? "headless" : "headed"})`);
      return { context, id };
    } catch {
      await context.close();
      console.log(`[osso e2e] no service worker in 5 s with ${JSON.stringify(opts)}; retrying`);
    }
  }
  throw new Error("the extension's service worker never started");
}

async function saveKey(context, id) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/options.html`);
  const input = (await page.locator("#apiKey").count()) ? page.locator("#apiKey") : page.locator("input[type=password]").first();
  if (await input.count()) {
    await input.fill(key);
    const button = (await page.locator("#saveKey").count()) ? page.locator("#saveKey") : page.getByText("Save", { exact: true }).first();
    await button.click();
    try {
      await page.getByText("Saved").first().waitFor({ timeout: 10_000 });
    } catch {
      // The confirmation may be worded differently; what matters is that the key is stored.
      const reply = await page.evaluate(() => chrome.runtime.sendMessage({ type: "getSettings" }));
      assert(reply?.settings?.apiKey === key, "options: no 'Saved' confirmation and getSettings does not return the key");
    }
  } else {
    // The options page has no key input yet; go through the contract instead so the rest still runs.
    console.log("[osso e2e] no key input on options.html; setting the key via setSettings");
    await page.evaluate((apiKey) => chrome.runtime.sendMessage({ type: "setSettings", patch: { apiKey } }), key);
  }
  // Localhost is denied by default (it is where people run their own apps); re-enable it for the fixtures.
  await page.evaluate((host) => chrome.runtime.sendMessage({ type: "setHostEnabled", host, enabled: true }), FIXTURE_HOST);
  await page.close();
}

async function waitJudged(page) {
  await page.waitForFunction(() => document.documentElement.classList.contains("osso-on"), null, { timeout: JUDGE_TIMEOUT_MS });
  await page.waitForSelector(".osso-fade", { state: "attached", timeout: JUDGE_TIMEOUT_MS });
  // Let the staggered settle finish so the screenshot shows the final greys.
  await sleep(800);
}

const rows = [];
let context = null;
let server = null;
const userDataDir = mkdtempSync(join(tmpdir(), "osso-e2e-"));
let exitCode = 0;

try {
  server = await startServer(join(here, "fixtures"));
  mkdirSync(shots, { recursive: true });
  const launched = await launch(userDataDir);
  context = launched.context;
  await saveKey(context, launched.id);

  // Recipe: story faded, ingredients kept, chrome untouched.
  const page = await context.newPage();
  let t0 = performance.now();
  await page.goto(`${server.url}/recipe.html`);
  await waitJudged(page);
  const recipe = await page.evaluate(countSentences);
  rows.push({ page: "recipe.html", ...recipe, ms: Math.round(performance.now() - t0) });
  assert(recipe.faded >= 5, `recipe: expected ≥ 5 faded sentences, got ${recipe.faded}`);
  assert(recipe.kept >= 5, `recipe: expected ≥ 5 kept sentences, got ${recipe.kept}`);
  const ingredients = await page.evaluate(() => {
    const items = [...document.querySelectorAll("#ingredients li")];
    return { total: items.length, judged: items.filter((li) => li.querySelector(".osso-s")).length, inInk: items.filter((li) => !li.querySelector(".osso-fade")).length };
  });
  assert(ingredients.inInk >= 1, `recipe: every ingredient was faded (${ingredients.total} items, ${ingredients.judged} judged)`);
  console.log(`[osso e2e] ingredients: ${ingredients.inInk}/${ingredients.total} in ink, ${ingredients.judged} judged`);
  const chromeSpans = await page.evaluate(() => document.querySelectorAll("nav .osso-s, footer .osso-s").length);
  assert(chromeSpans === 0, `recipe: ${chromeSpans} judged spans inside nav/footer`);
  await page.screenshot({ path: join(shots, "recipe-faded.png"), fullPage: true });

  // Reveal: hold Shift past REVEAL_HOLD_MS, everything is ink; release, it fades back.
  await page.keyboard.down("Shift");
  await sleep(300);
  assert(await page.evaluate(() => document.documentElement.classList.contains("osso-reveal")), "recipe: holding Shift did not add html.osso-reveal");
  await page.screenshot({ path: join(shots, "recipe-revealed.png"), fullPage: true });
  await page.keyboard.up("Shift");
  await sleep(500);
  assert(!(await page.evaluate(() => document.documentElement.classList.contains("osso-reveal"))), "recipe: releasing Shift left html.osso-reveal on");

  // Terms: the binding clauses are the substance; the auto-renewal sentence must stay in ink.
  t0 = performance.now();
  await page.goto(`${server.url}/tos.html`);
  await waitJudged(page);
  const tos = await page.evaluate(countSentences);
  rows.push({ page: "tos.html", ...tos, ms: Math.round(performance.now() - t0) });
  assert(tos.faded >= 3, `tos: expected ≥ 3 faded sentences, got ${tos.faded}`);
  const renewal = await page.evaluate(fadedByText, "automatically renew");
  assert(renewal !== null, "tos: the auto-renewal sentence was not judged at all");
  assert(renewal === false, "tos: the auto-renewal sentence was faded");
  await page.screenshot({ path: join(shots, "tos.png"), fullPage: true });

  // Blank: three sentences, below MIN_SENTENCES; nothing should be wrapped, let alone judged.
  await page.goto(`${server.url}/blank.html`);
  await sleep(3000);
  const blankSpans = await page.evaluate(() => document.querySelectorAll(".osso-s").length);
  rows.push({ page: "blank.html", total: blankSpans, kept: 0, faded: 0, ms: 0 });
  assert(blankSpans === 0, `blank: expected no judged spans, got ${blankSpans}`);

  // Reload the recipe: served from the cache, the first fade should land well inside a second.
  t0 = performance.now();
  await page.goto(`${server.url}/recipe.html`);
  await page.waitForSelector(".osso-fade", { state: "attached", timeout: JUDGE_TIMEOUT_MS });
  const firstFadeMs = Math.round(performance.now() - t0);
  const again = await page.evaluate(countSentences);
  rows.push({ page: "recipe.html (reload)", ...again, ms: firstFadeMs });
  console.log(`[osso e2e] time to first fade on reload: ${firstFadeMs} ms`);

  await page.close();
} catch (err) {
  exitCode = 1;
  if (err instanceof AssertionFailed) console.error(`\n[osso e2e] FAILED: ${err.message}`);
  else console.error("\n[osso e2e] ERROR:", err);
} finally {
  if (rows.length) {
    console.log("");
    console.table(rows.map((r) => ({ page: r.page, total: r.total, kept: r.kept, faded: r.faded, ms: r.ms })));
    console.log(`screenshots in ${shots}`);
  }
  await context?.close().catch(() => {});
  await server?.close().catch(() => {});
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 });
}

console.log(exitCode === 0 ? "[osso e2e] OK" : "[osso e2e] FAILED");
process.exit(exitCode);
