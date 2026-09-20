/**
 * Every screen Osso has, as pictures, for design review and the README: the popup in each of its
 * states, light and dark; the options page; the recipe fixture as the extension leaves it, settled,
 * hovered, revealed, and just after a rule caught the sponsor sentence; and the toolbar icon on a
 * light and a dark toolbar. The page shots go through the live model. The popup cannot be opened
 * from its toolbar button by Playwright, so popup.html is opened in a tab with its chrome.tabs and
 * chrome.runtime calls answered by a seed, one per state; one "live" shot reads the real recipe tab.
 *
 * Run: npm run build && node --env-file=.env e2e/screens.mjs [--docs]
 * Writes e2e/screenshots/screens/*.png; with --docs also the README's set to docs/screenshots/.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { startServer } from "./server.mjs";
import { FIXTURE_HOST, JUDGE_TIMEOUT_MS, here, launch, preflight, root, saveKey, sleep, waitJudged } from "./harness.mjs";

const out = join(here, "screenshots", "screens");
const docs = join(root, "docs", "screenshots");
const wantDocs = process.argv.includes("--docs");
const key = preflight("screens.mjs");
/** The document timeline's speed while the settle wave is photographed. */
const WAVE_RATE = 0.25;

/** The README's set: what each published name is taken from. */
const DOCS = {
  "popup-done.png": "popup-done.png",
  "popup-dark.png": "popup-done-dark.png",
  "popup-nokey.png": "popup-nokey.png",
  "options.png": "options.png",
  "page-faded.png": "page-faded.png",
  "page-chip.png": "page-chip.png",
  "page-revealed.png": "page-revealed.png",
  "page-rule.png": "page-rule.png",
};

// ---- popup seeds --------------------------------------------------------------------------

const SETTINGS = {
  apiKey: "•",
  apiKeyInvalid: false,
  enabled: true,
  threshold: 0.5,
  revealKey: "Shift",
  animations: true,
  deniedHosts: [],
  allowedHosts: [],
  maxSentencesPerRequest: 60,
  rules: [],
};
const TAB = { id: 7, url: "https://saltandthyme.example/recipes/lemon-chicken-orzo/", active: true };
const DONE = {
  host: "saltandthyme.example",
  status: "done",
  packId: "recipe",
  pageKind: "recipe",
  total: 41,
  kept: 14,
  faded: 27,
  ms: 912,
  inputTokens: 28_000,
  cached: false,
  revealed: false,
  ruleHits: { prices: 3, deadlines: 0 },
};
const RULES = ["prices", "deadlines"];

/** state → {settings, state, tab, background}. `state: null` is a tab with no content script. */
const POPUP_STATES = {
  nokey: { settings: { ...SETTINGS, apiKey: "" }, state: null },
  "invalid-key": { settings: { ...SETTINGS, apiKeyInvalid: true }, state: { ...DONE, status: "error", reason: "API key rejected" } },
  judging: { settings: { ...SETTINGS, rules: RULES }, state: { ...DONE, status: "judging", kept: 0, faded: 0, ruleHits: {} } },
  done: { settings: { ...SETTINGS, rules: RULES }, state: DONE },
  "done-cached": { settings: { ...SETTINGS, rules: [...RULES, "allergens"] }, state: { ...DONE, cached: true, kept: 1, faded: 40 } },
  "done-norules": { settings: SETTINGS, state: { ...DONE, ruleHits: {} } },
  skipped: { settings: { ...SETTINGS, rules: RULES }, state: { ...DONE, status: "skipped", reason: "too little text", total: 3, kept: 0, faded: 0, ruleHits: {} } },
  error: { settings: { ...SETTINGS, rules: RULES }, state: { ...DONE, status: "error", reason: "Couldn't reach TypeSafe (network error or timeout)", total: 0, ruleHits: {} } },
  disabled: { settings: { ...SETTINGS, rules: RULES }, state: { ...DONE, status: "disabled", reason: "Off on this site", total: 0, ruleHits: {} } },
  off: { settings: { ...SETTINGS, enabled: false, rules: RULES }, state: { ...DONE, status: "disabled", reason: "Osso is off", total: 0, ruleHits: {} } },
  cannot: { settings: SETTINGS, state: null, tab: { id: 8, url: "chrome://extensions", active: true } },
  waking: { settings: SETTINGS, state: null, background: false },
};

/** Runs in the popup page before its script: answers the calls the popup makes with the seed. */
function seedChrome(seed) {
  const c = globalThis.chrome;
  const patch = (obj, name, fn) => {
    try {
      Object.defineProperty(obj, name, { value: fn, configurable: true, writable: true });
    } catch {
      obj[name] = fn;
    }
  };
  patch(c.tabs, "query", async () => [seed.tab]);
  patch(c.tabs, "sendMessage", async (_id, msg) => {
    if (!seed.state) throw new Error("Could not establish connection. Receiving end does not exist.");
    if (msg.type === "setThreshold") return { type: "tabState", state: { ...seed.state, kept: 9, faded: seed.state.total - 9 } };
    return { type: "tabState", state: seed.state };
  });
  if (!seed.live) {
    patch(c.runtime, "sendMessage", async (msg) => {
      if (seed.background === false) return undefined;
      if (msg.type === "getSettings") return { type: "settings", settings: seed.settings };
      if (msg.type === "getTabState") return { type: "tabState", state: seed.state };
      if (msg.type === "getStats") return { type: "stats", stats: { pagesJudged: 0, sentencesJudged: 0, inputTokens: 0, ms: 0, cacheHits: 0 } };
      return { type: "ok" };
    });
  }
}

async function popupShot(context, id, name, seed, { scheme = "light", reducedMotion = "no-preference", burst = false } = {}) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 320, height: 520 });
  await page.emulateMedia({ colorScheme: scheme, reducedMotion });
  await page.addInitScript(seedChrome, { tab: TAB, ...seed });
  await page.goto(`chrome-extension://${id}/popup.html`, { waitUntil: burst ? "commit" : "load" });
  if (burst) await frames(page, `${name}-t`, 6, 90);
  // Entrance, chip pops and the count-up have all played by now.
  await sleep(1000);
  // The popup's own height: Chrome sizes the real popup to it, and caps it at 600 px.
  const height = await page.evaluate(() => Math.ceil(document.querySelector("main").getBoundingClientRect().height));
  await page.screenshot({ path: join(out, `${name}.png`), clip: { x: 0, y: 0, width: 320, height } });
  console.log(`[osso screens] popup ${name.padEnd(22)} ${height} px tall`);
  await page.close();
  return height;
}

/** A burst of viewport shots as fast as the browser will give them, named with the time since the first (in the page's own time when its timeline is slowed). */
async function frames(page, prefix, n, gapMs, rate = 1) {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const t = Math.round((performance.now() - t0) * rate);
    await page.screenshot({ path: join(out, `${prefix}${String(i).padStart(2, "0")}-${t}ms.png`) });
    const wait = gapMs - (performance.now() - t0 - t / rate);
    if (wait > 0) await sleep(wait);
  }
}

// ---- options ------------------------------------------------------------------------------

async function optionsShot(context, id, name, scheme, detail = false) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 640, height: 900 });
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto(`chrome-extension://${id}/options.html`);
  await sleep(900);
  if (detail) {
    await page.locator("#key-test").click();
    await page.getByText(/^Works/).waitFor({ timeout: 15_000 }).catch(() => {});
    // The field is shown in the clear with a made-up key: a screenshot must never carry the real one.
    await page.locator("#key").fill("apikey_0000example0000example0000example0000");
    await page.locator("#key-eye").click();
    await page.locator("details.defaults summary").click();
    await page.locator("label:has(#animations)").click();
    await sleep(400);
  }
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
  console.log(`[osso screens] options ${name}`);
  await page.close();
}

// ---- icons --------------------------------------------------------------------------------

/** 16 and 32 px over a light (#f1f3f4) and a dark (#202124) toolbar, blown up 6× with no smoothing. */
async function iconSheet() {
  const pad = 8;
  const cell = (size) => size + pad * 2;
  const width = cell(16) + cell(32);
  const rows = [
    { bg: "#f1f3f4", top: 0 },
    { bg: "#202124", top: cell(32) },
  ];
  const layers = [];
  for (const row of rows) {
    const band = await sharp({ create: { width, height: cell(32), channels: 4, background: row.bg } }).png().toBuffer();
    layers.push({ input: band, left: 0, top: row.top });
    let left = 0;
    for (const size of [16, 32]) {
      layers.push({ input: join(root, "icons", `${size}.png`), left: left + pad, top: row.top + pad });
      left += cell(size);
    }
  }
  await sharp({ create: { width, height: cell(32) * 2, channels: 4, background: "#000" } })
    .composite(layers)
    .png()
    .toBuffer()
    .then((buf) => sharp(buf).resize(width * 6, cell(32) * 12, { kernel: "nearest" }).png().toFile(join(out, "icons.png")));
  console.log("[osso screens] icons");
}

// ---- pages --------------------------------------------------------------------------------

async function pageShots(context, id, url) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1100, height: 760 });
  // The settle wave, as it plays: a screenshot takes longer than the wave, so the document's
  // timeline runs at a tenth of its speed while the frames are taken. JS timers are not slowed,
  // which is the point: the wave is CSS transitions alone.
  const cdp = await context.newCDPSession(page);
  await cdp.send("Animation.enable");
  await cdp.send("Animation.setPlaybackRate", { playbackRate: WAVE_RATE });
  await page.goto(url);
  await page.waitForFunction(() => document.documentElement.classList.contains("osso-on"), null, { timeout: JUDGE_TIMEOUT_MS });
  await frames(page, "page-wave-", 20, 300, WAVE_RATE);
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
  await cdp.detach();
  await waitJudged(page);

  await page.screenshot({ path: join(out, "page-faded.png") });

  // The chip, on a line in the middle of a faded paragraph: it hangs above the line under the pointer.
  const target = page.locator(".osso-fade", { hasText: "weeknight staple" }).first();
  await target.hover();
  await page.waitForSelector(".osso-chip.osso-chip-show", { state: "visible", timeout: 5000 });
  await sleep(200);
  await page.screenshot({ path: join(out, "page-chip.png") });
  await page.mouse.move(0, 0);
  await sleep(200);

  // Shift held: everything back in ink.
  await page.keyboard.down("Shift");
  await sleep(400);
  await page.screenshot({ path: join(out, "page-revealed.png") });
  await page.keyboard.up("Shift");
  await sleep(500);

  // The tips and the sponsor box: substance in ink beside filler in grey, on white and on the warm box.
  await page.evaluate(() => document.querySelector(".sponsor")?.scrollIntoView({ block: "center" }));
  await sleep(300);
  await page.screenshot({ path: join(out, "page-warm.png") });

  // A rule, added the way the popup adds it: the sponsor sentence comes back with its underline.
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${id}/options.html`);
  await page.bringToFront();
  const setRules = (rules) => ext.evaluate((rules) => chrome.runtime.sendMessage({ type: "setSettings", patch: { rules } }), rules);
  await setRules(["sponsor discount codes"]);
  await page.waitForFunction(
    () => {
      const hit = [...document.querySelectorAll(".osso-s")].find((s) => (s.textContent ?? "").includes("THYME15"));
      return hit && !hit.classList.contains("osso-fade");
    },
    null,
    { timeout: JUDGE_TIMEOUT_MS, polling: 30 },
  );
  // The underline draws in over 240 ms and fades from 240 ms on; catch it fully drawn.
  await sleep(230);
  await page.screenshot({ path: join(out, "page-rule.png") });
  await sleep(1400);
  await page.screenshot({ path: join(out, "page-rule-after.png") });

  // The popup over the real page: the tab's own counts, the rule's own count.
  // Without the tabs permission a tab's url is hidden from us; the background knows the recipe tab by its host.
  const tabId = await ext.evaluate(async (host) => {
    for (const t of await chrome.tabs.query({})) {
      const r = await chrome.runtime.sendMessage({ type: "getTabState", tabId: t.id });
      if (r?.state?.host === host) return t.id;
    }
    return null;
  }, FIXTURE_HOST);
  if (tabId !== null) {
    await popupShot(context, id, "popup-live", { live: true, tab: { id: tabId, url, active: true } });
    await popupShot(context, id, "popup-live-dark", { live: true, tab: { id: tabId, url, active: true } }, { scheme: "dark" });
  }
  await setRules([]);
  await ext.close();
  await page.close();

  // Dark grounds: the fixture's dark theme, served from the cache so the fade is instant.
  const dark = await context.newPage();
  await dark.setViewportSize({ width: 1100, height: 760 });
  await dark.emulateMedia({ colorScheme: "dark" });
  await dark.goto(url);
  await waitJudged(dark);
  await dark.screenshot({ path: join(out, "page-dark.png") });
  await dark.locator(".osso-fade", { hasText: "weeknight staple" }).first().hover();
  await dark.waitForSelector(".osso-chip.osso-chip-show", { state: "visible", timeout: 5000 });
  await sleep(200);
  await dark.screenshot({ path: join(out, "page-dark-chip.png") });
  await dark.evaluate(() => document.querySelector(".sponsor")?.scrollIntoView({ block: "center" }));
  await dark.mouse.move(0, 0);
  await sleep(300);
  await dark.screenshot({ path: join(out, "page-dark-warm.png") });
  await dark.close();

  // Reduced motion: the same page, no wave, nothing moves; the result must look the same.
  const still = await context.newPage();
  await still.setViewportSize({ width: 1100, height: 760 });
  await still.emulateMedia({ reducedMotion: "reduce" });
  await still.goto(url);
  await waitJudged(still);
  await still.screenshot({ path: join(out, "page-reduced-motion.png") });
  await still.close();
  console.log("[osso screens] pages");
}

// ---- main ---------------------------------------------------------------------------------

let context = null;
let server = null;
const userDataDir = mkdtempSync(join(tmpdir(), "osso-screens-"));
let exitCode = 0;

try {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  server = await startServer(join(here, "fixtures"));
  const launched = await launch(userDataDir, { deviceScaleFactor: 2 });
  context = launched.context;
  const id = launched.id;
  await saveKey(context, id, key);

  await iconSheet();
  await pageShots(context, id, `${server.url}/recipe.html`);

  // Options, with a couple of rules so the list shows, and the real usage numbers from the page above.
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${id}/options.html`);
  await ext.evaluate((rules) => chrome.runtime.sendMessage({ type: "setSettings", patch: { rules } }), RULES);
  await ext.close();
  await optionsShot(context, id, "options", "light");
  await optionsShot(context, id, "options-dark", "dark");
  await optionsShot(context, id, "options-detail", "light", true);

  const heights = {};
  for (const [name, seed] of Object.entries(POPUP_STATES)) {
    heights[name] = await popupShot(context, id, `popup-${name}`, seed, { burst: name === "done" });
    await popupShot(context, id, `popup-${name}-dark`, seed, { scheme: "dark" });
  }
  await popupShot(context, id, "popup-done-reduced", POPUP_STATES.done, { reducedMotion: "reduce" });
  // Chrome caps a popup at 600 px; past that it scrolls. The default state with two rules must sit well inside.
  const tallest = Math.max(...Object.values(heights));
  console.log(`[osso screens] tallest popup ${tallest} px (${Object.entries(heights).find(([, h]) => h === tallest)?.[0]})`);

  if (wantDocs) {
    mkdirSync(docs, { recursive: true });
    for (const [to, from] of Object.entries(DOCS)) copyFileSync(join(out, from), join(docs, to));
    console.log(`[osso screens] README set in ${docs}`);
  }
} catch (err) {
  exitCode = 1;
  console.error("\n[osso screens] ERROR:", err);
} finally {
  await context?.close().catch(() => {});
  await server?.close().catch(() => {});
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 });
}

console.log(exitCode === 0 ? `[osso screens] OK: ${out}` : "[osso screens] FAILED");
process.exit(exitCode);
