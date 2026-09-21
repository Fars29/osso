/**
 * What the e2e and the screenshot script share: where things are, launching Chromium with dist/
 * loaded, saving the key through the options page the way a person would, and waiting for a
 * page to be judged. No test runner; `assert` throws an AssertionFailed the callers print.
 */
import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const here = dirname(fileURLToPath(import.meta.url));
export const root = resolve(here, "..");
export const dist = join(root, "dist");
export const FIXTURE_HOST = "127.0.0.1";
/** Generous: a cold page is one or two model round-trips of 1–3 s each (up to 20 s on a slow day), plus the settle animation. */
export const JUDGE_TIMEOUT_MS = 25_000;

export class AssertionFailed extends Error {}
export function assert(cond, msg) {
  if (!cond) throw new AssertionFailed(msg);
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The key from .env and a built dist/, or a message that says which is missing and exit 1. */
export function preflight(script) {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) {
    console.error(`[osso e2e] TYPESAFE_API_KEY is not set. Put it in .env (see .env.example) and run: node --env-file=.env e2e/${script}`);
    process.exit(1);
  }
  if (!existsSync(join(dist, "manifest.json"))) {
    console.error("[osso e2e] dist/ is missing: run npm run build");
    process.exit(1);
  }
  return key;
}

export async function launch(userDataDir, extra = {}) {
  const args = [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--no-first-run"];
  // New headless Chromium loads extensions; the headless shell does not. Try it, and if the
  // worker never shows up fall back to a visible window rather than guess at the cause.
  for (const opts of [{ headless: true, channel: "chromium" }, { headless: false }]) {
    const context = await chromium.launchPersistentContext(userDataDir, { ...opts, args, viewport: { width: 1200, height: 900 }, ...extra });
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

export async function saveKey(context, id, key) {
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

export async function waitJudged(page) {
  await page.waitForFunction(() => document.documentElement.classList.contains("osso-on"), null, { timeout: JUDGE_TIMEOUT_MS });
  await page.waitForSelector(".osso-fade", { state: "attached", timeout: JUDGE_TIMEOUT_MS });
  // Let the wave finish so the screenshot shows the final greys: the root says when it has settled.
  await page.waitForFunction(() => document.documentElement.classList.contains("osso-settled"), null, { timeout: 15_000 }).catch(() => {});
  await sleep(150);
}
