/**
 * What did Osso do to this page, sentence by sentence? Loads dist/ into Chromium, opens each URL,
 * waits for the judgment, and prints every sentence with the model's p(keep), its kind and whether
 * it ended up grey, in page order. The tool for judging the judgments: run it on a real article
 * and read down the list.
 *
 * Run: npm run build && node --env-file=.env e2e/review.mjs <url> [url…] [--kept] [--shot]
 *   --kept  list the kept sentences too (by default only the faded ones and the borderline kept)
 *   --brief one screen per page: the grey (cut to 120 characters, 45 at most), then the suspects
 *           among the kept, those the model itself calls opinion, story, filler or promo
 *   --shot  save a full-page screenshot to e2e/screenshots/review-<host>.png
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JUDGE_TIMEOUT_MS, here, launch, preflight, saveKey, sleep } from "./harness.mjs";

const key = preflight("review.mjs");
const urls = process.argv.slice(2).filter((a) => /^https?:/.test(a));
const showKept = process.argv.includes("--kept");
const shot = process.argv.includes("--shot");
const brief = process.argv.includes("--brief");
const SOFT_KINDS = new Set(["opinion", "anecdote_or_story", "filler_or_transition", "promotion_or_appeal"]);
if (urls.length === 0) {
  console.error("usage: node --env-file=.env e2e/review.mjs <url> [url…] [--kept] [--shot]");
  process.exit(1);
}

// A desktop Chrome's user agent: several publishers serve an "access issue" page to anything that says Headless.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const userDataDir = mkdtempSync(join(tmpdir(), "osso-review-"));
let context = null;
try {
  const launched = await launch(userDataDir, { userAgent: UA, locale: "en-US" });
  context = launched.context;
  await saveKey(context, launched.id, key);
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${launched.id}/options.html`);

  for (const url of urls) {
    const host = new URL(url).hostname;
    // Hosts Osso skips by default (social, search…) are switched on for the review.
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
      if ((state && !["judging", "idle"].includes(state.status) && !provisional) || elapsed > JUDGE_TIMEOUT_MS + 10_000) break;
      await sleep(250);
    }

    console.log(`\n${"=".repeat(100)}\n${url}`);
    const live = await page.evaluate(() => ({ title: document.title.slice(0, 80), chars: (document.body?.innerText ?? "").length }));
    console.log(`title: ${live.title}  |  text on page: ${live.chars} chars`);
    console.log(`status: ${state?.status ?? "(none)"}${state?.reason ? `, ${state.reason}` : ""}  |  kind: ${state?.pageKind ?? "-"} (pack ${state?.packId ?? "-"})  |  ${state?.kept ?? 0} kept / ${state?.faded ?? 0} faded of ${state?.total ?? 0}  |  ${state?.ms ?? 0} ms, ${state?.inputTokens ?? 0} tokens`);
    if (state?.status !== "done") {
      await page.close();
      continue;
    }

    // The sentences as the page has them, in order, and what block each lives in.
    const dom = await page.evaluate(() => {
      const byId = new Map();
      for (const s of document.querySelectorAll(".osso-s")) {
        const id = Number(s.getAttribute("data-osso"));
        const e = byId.get(id) ?? { id, text: "", faded: false, block: s.closest("[data-osso-block]")?.localName ?? "?" };
        e.text += s.textContent ?? "";
        e.faded = e.faded || s.classList.contains("osso-fade");
        byId.set(id, e);
      }
      return [...byId.values()].sort((a, b) => a.id - b.id);
    });
    // The model's numbers, from the judgment cache.
    const judged = await ext.evaluate(async () => {
      const all = await chrome.storage.local.get(null);
      const out = [];
      for (const [k, v] of Object.entries(all)) if (k.startsWith("osso:cache:") && v?.sentences) out.push(v);
      return out;
    });
    const byText = new Map();
    const best = judged.sort((a, b) => b.sentences.length - a.sentences.length).find((j) => j.sentences.length === dom.length) ?? judged[0];
    const numbers = new Map((best?.sentences ?? []).map((s) => [s.id, s]));

    const line = (d) => {
      const n = numbers.get(d.id);
      const p = n ? n.keep.toFixed(2) : " ?  ";
      return `${d.faded ? "GREY" : "ink "}  p=${p}  ${(n?.kind ?? "?").replace(/_or_.*/, "").padEnd(12)} <${d.block}>  ${d.text.replace(/\s+/g, " ").trim().slice(0, brief ? 120 : 170)}`;
    };
    const faded = dom.filter((d) => d.faded);
    const kept = dom.filter((d) => !d.faded);
    console.log(`\n--- GREY (${faded.length}) ---`);
    for (const d of brief ? faded.slice(0, 45) : faded) console.log(line(d));
    if (brief && faded.length > 45) console.log(`     … and ${faded.length - 45} more`);
    if (brief) {
      // The suspects among the kept: what the model itself calls opinion, story, filler or promo.
      const suspects = kept.filter((d) => SOFT_KINDS.has(numbers.get(d.id)?.kind));
      console.log(`\n--- kept, though the model calls it opinion/story/filler/promo (${suspects.length}) ---`);
      for (const d of suspects.slice(0, 25)) console.log(line(d));
      if (suspects.length > 25) console.log(`     … and ${suspects.length - 25} more`);
    }
    const borderline = kept.filter((d) => (numbers.get(d.id)?.keep ?? 1) < 0.75);
    console.log(`\n--- kept but borderline, p < 0.75 (${borderline.length}) ---`);
    for (const d of borderline) console.log(line(d));
    if (showKept) {
      console.log(`\n--- ink (${kept.length}) ---`);
      for (const d of kept) console.log(line(d));
    }
    if (shot) {
      // What is below the fold waits in ink for the reader: walk the page so the picture shows it as read.
      for (let y = 0, h = await page.evaluate(() => document.documentElement.scrollHeight); y < h; y += 600) {
        await page.mouse.wheel(0, 600);
        await sleep(80);
      }
      await sleep(3000);
      mkdirSync(join(here, "screenshots"), { recursive: true });
      await page.screenshot({ path: join(here, "screenshots", `review-${host}.png`), fullPage: true });
    }
    await page.close();
    // One page's numbers at a time: the next page must not read this one's cache entry.
    await ext.evaluate(() => chrome.runtime.sendMessage({ type: "clearCache" }));
  }
  await ext.close();
} finally {
  await context?.close().catch(() => {});
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 });
}
