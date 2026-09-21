/**
 * Osso on real pages: loads dist/ into Chromium, opens each URL, waits for the content script to
 * settle, and prints what it did and why: status, the skip reason, sentences wrapped, faded, the
 * container it chose. The tool for "it does nothing on site X": run it on X and read the row.
 *
 * Run: npm run build && node --env-file=.env e2e/sites.mjs [url ...]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.mjs";
import { JUDGE_TIMEOUT_MS, here, launch, preflight, saveKey, sleep } from "./harness.mjs";

const key = preflight("sites.mjs");
/** Prose pages of different builds: server-rendered, Tailwind (react.dev), BEM (MDN), old hand-written HTML, legal, recipes. */
const DEFAULT_URLS = [
  "https://en.wikipedia.org/wiki/Focaccia",
  "https://www.bbc.com/news/articles/c0k3700zljjo",
  "https://react.dev/learn",
  "https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver",
  "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Introduction",
  "https://docs.python.org/3/tutorial/introduction.html",
  "https://www.gnu.org/philosophy/free-sw.html",
  "https://paulgraham.com/greatwork.html",
  "https://ricette.giallozafferano.it/Focaccia-genovese.html",
  "https://www.simplyrecipes.com/recipes/focaccia_bread/",
  "https://www.apple.com/legal/internet-services/itunes/",
  "https://stripe.com/legal/ssa",
];
const urls = process.argv.slice(2).filter((a) => /^https?:/.test(a));
const server = await startServer(join(here, "fixtures"));
// The single-page-app fixture renders its article 2.5 s after load: the late-content path, every run.
const list = [...(urls.length ? urls : DEFAULT_URLS), `${server.url}/spa.html`];

const userDataDir = mkdtempSync(join(tmpdir(), "osso-sites-"));
let context = null;
const rows = [];
try {
  const launched = await launch(userDataDir);
  context = launched.context;
  await saveKey(context, launched.id, key);
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${launched.id}/options.html`);

  for (const url of list) {
    const page = await context.newPage();
    const t0 = performance.now();
    let row = { url: url.replace(/^https?:\/\//, "").slice(0, 48) };
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((e) => (row.nav = String(e.message).slice(0, 40)));
      // Poll the background's copy of the tab state until it settles or the judge timeout passes.
      let state = null;
      for (;;) {
        state = await ext.evaluate(async (host) => {
          for (const t of await chrome.tabs.query({})) {
            const r = await chrome.runtime.sendMessage({ type: "getTabState", tabId: t.id });
            if (r?.state?.host === host) return r.state;
          }
          return null;
        }, new URL(url).hostname);
        // "Too little text" in the first seconds is often a page still rendering; give it the grace the content script gives it.
        const elapsed = performance.now() - t0;
        const provisional = state?.status === "skipped" && state.reason === "too little text" && elapsed < 8000;
        const settled = state && !["judging", "idle"].includes(state.status) && !provisional;
        if (settled || elapsed > JUDGE_TIMEOUT_MS) break;
        await sleep(250);
      }
      const dom = await page.evaluate(() => {
        const spans = document.querySelectorAll(".osso-s");
        const ids = new Set([...spans].map((s) => s.getAttribute("data-osso")));
        const faded = new Set([...document.querySelectorAll(".osso-fade")].map((s) => s.getAttribute("data-osso")));
        const block = document.querySelector("[data-osso-block]");
        const container = block ? (() => { let e = block.parentElement; while (e && !e.matches("article, main, [role=main], body, section")) e = e.parentElement; return e ? e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (e.className && typeof e.className === "string" ? "." + e.className.split(/\s+/)[0] : "") : "?"; })() : "";
        return { paragraphs: document.querySelectorAll("p").length, bodyChars: (document.body?.innerText ?? "").length, sentences: ids.size, faded: faded.size, container, inputs: document.querySelectorAll("input, textarea, select").length, editable: document.querySelectorAll("[contenteditable]").length };
      }).catch(() => ({}));
      row = { ...row, status: state?.status ?? "(no state)", reason: state?.reason ?? "", kind: state?.pageKind ?? "", total: state?.total ?? dom.sentences, kept: state?.kept ?? "", faded: state?.faded ?? dom.faded, ms: Math.round(performance.now() - t0), p: dom.paragraphs, chars: dom.bodyChars, inputs: dom.inputs, container: dom.container };
    } catch (e) {
      row.status = "error";
      row.reason = String(e.message).slice(0, 60);
    }
    rows.push(row);
    console.log(`${row.status.padEnd(9)} ${String(row.total ?? "").padStart(4)} sent ${String(row.faded ?? "").padStart(4)} faded  ${row.reason.padEnd(28)} ${row.url}`);
    await page.close();
  }
  await ext.close();
} finally {
  console.log("");
  console.table(rows);
  await context?.close().catch(() => {});
  await server.close().catch(() => {});
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 });
}
