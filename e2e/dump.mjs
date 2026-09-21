/**
 * The sentences of a live page as Osso segments them, in page order, each with the heading it sits
 * under, saved as JSON for `scripts/context.ts` to replay against the API with different states.
 * The page is segmented by the shipped content script, so the ids and the texts are the ones the
 * extension would send.
 *
 * Run: npm run build && node --env-file=.env e2e/dump.mjs <url> [url…]
 * Output: e2e/.scratch/pages/<host>.json
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JUDGE_TIMEOUT_MS, here, launch, preflight, saveKey, sleep } from "./harness.mjs";

const key = preflight("dump.mjs");
const urls = process.argv.slice(2).filter((a) => /^https?:/.test(a));
if (urls.length === 0) {
  console.error("usage: node --env-file=.env e2e/dump.mjs <url> [url…]");
  process.exit(1);
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const out = join(here, ".scratch", "pages");
mkdirSync(out, { recursive: true });
const userDataDir = mkdtempSync(join(tmpdir(), "osso-dump-"));
let context = null;
try {
  const launched = await launch(userDataDir, { userAgent: UA, locale: "en-US" });
  context = launched.context;
  await saveKey(context, launched.id, key);
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${launched.id}/options.html`);

  for (const url of urls) {
    const host = new URL(url).hostname;
    await ext.evaluate((h) => chrome.runtime.sendMessage({ type: "setHostEnabled", host: h, enabled: true }), host);
    const page = await context.newPage();
    await page.bringToFront();
    const t0 = performance.now();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch((e) => console.log("navigation:", String(e.message).slice(0, 80)));

    let state = null;
    for (;;) {
      state = await ext.evaluate(async (h) => {
        for (const t of await chrome.tabs.query({})) {
          const r = await chrome.runtime.sendMessage({ type: "getTabState", tabId: t.id });
          if (r?.state?.host === h) return r.state;
        }
        return null;
      }, host);
      const elapsed = performance.now() - t0;
      const provisional = state?.status === "skipped" && state.reason === "too little text" && elapsed < 10_000;
      if ((state && !["judging", "idle"].includes(state.status) && !provisional) || elapsed > JUDGE_TIMEOUT_MS + 20_000) break;
      await sleep(250);
    }
    if (state?.status !== "done") {
      console.log(`${host}: ${state?.status ?? "(none)"} ${state?.reason ?? ""}`);
      await page.close();
      continue;
    }

    const dump = await page.evaluate(() => {
      const clean = (s) => (s ?? "").replace(/\s+/g, " ").trim();
      // The heading each judged block sits under: the last h1–h6 before it in document order.
      const headingOf = new Map();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let heading = "";
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (/^H[1-6]$/.test(n.tagName)) heading = clean(n.textContent).slice(0, 120);
        if (n.hasAttribute("data-osso-block")) headingOf.set(n, heading);
      }
      const byId = new Map();
      for (const s of document.querySelectorAll(".osso-s")) {
        const id = Number(s.getAttribute("data-osso"));
        const block = s.closest("[data-osso-block]");
        const e = byId.get(id) ?? { id, text: "", heading: headingOf.get(block) ?? "", block: block?.localName ?? "?" };
        e.text += s.textContent ?? "";
        byId.set(id, e);
      }
      const sentences = [...byId.values()].sort((a, b) => a.id - b.id).map((s) => ({ ...s, text: clean(s.text) }));
      return { title: document.title, lang: document.documentElement.lang || "", sentences };
    });
    const file = join(out, `${host}.json`);
    writeFileSync(file, JSON.stringify({ url, host, packId: state.packId, pageKind: state.pageKind, ...dump }, null, 1));
    console.log(`${host}: ${dump.sentences.length} sentences, pack ${state.packId}, ${state.inputTokens} tokens shipped -> ${file}`);
    await page.close();
    await ext.evaluate(() => chrome.runtime.sendMessage({ type: "clearCache" }));
  }
  await ext.close();
} finally {
  await context?.close().catch(() => {});
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 });
}
