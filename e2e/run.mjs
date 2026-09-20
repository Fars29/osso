/**
 * End-to-end smoke against the live model: load dist/ into Chromium, serve the fixtures on
 * localhost, save a real key through the options page, and check that a recipe page comes back
 * with its story faded and its ingredients in ink, and that a rule of the reader's keeps what it
 * names. No test runner; a plain script that exits 1 on the first failed assertion and prints why.
 *
 * Run: npm run build && node --env-file=.env e2e/run.mjs
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.mjs";
import { AssertionFailed, FIXTURE_HOST, JUDGE_TIMEOUT_MS, assert, here, launch, preflight, saveKey, sleep, waitJudged } from "./harness.mjs";

const shots = join(here, "screenshots");
const key = preflight("run.mjs");

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

/** Does the sentence containing `needle` wear the rule-hit underline? */
function underlinedByText(needle) {
  const spans = [...document.querySelectorAll(".osso-s")];
  const hit = spans.find((s) => (s.textContent ?? "").includes(needle));
  if (!hit) return false;
  const id = hit.getAttribute("data-osso");
  return spans.some((s) => s.getAttribute("data-osso") === id && s.classList.contains("osso-rule-hit"));
}

/**
 * Counts the worker's requests to the API by wrapping its fetch from outside: the production
 * bundle needs no debug handle, and `api.ts` looks fetch up on globalThis at call time. A worker
 * restart would drop the wrapper; `fetchCount` then reads undefined and the assertion says so.
 */
async function armFetchCounter(context) {
  const worker = context.serviceWorkers()[0];
  await worker.evaluate(() => {
    if (!globalThis.__ossoFetch) {
      globalThis.__ossoFetch = globalThis.fetch;
      globalThis.fetch = (...args) => {
        globalThis.__ossoRequests = (globalThis.__ossoRequests ?? 0) + 1;
        return globalThis.__ossoFetch(...args);
      };
    }
    globalThis.__ossoRequests = 0;
  });
}

async function fetchCount(context) {
  return context.serviceWorkers()[0].evaluate(() => globalThis.__ossoRequests);
}

/** The recipe tab's state as the popup would read it, through an extension page (the popup itself needs a real toolbar click). */
async function fixtureTabState(ext) {
  return ext.evaluate(async (host) => {
    for (const tab of await chrome.tabs.query({})) {
      const r = await chrome.runtime.sendMessage({ type: "getTabState", tabId: tab.id });
      if (r?.state?.host === host) return r.state;
    }
    return null;
  }, FIXTURE_HOST);
}

async function untilTabState(ext, predicate, what) {
  const t0 = performance.now();
  for (;;) {
    const state = await fixtureTabState(ext);
    if (state && predicate(state)) return state;
    assert(performance.now() - t0 < JUDGE_TIMEOUT_MS, `timed out waiting for the tab state: ${what} (last: ${JSON.stringify(state)})`);
    await sleep(100);
  }
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
  await saveKey(context, launched.id, key);

  // Recipe: story faded, ingredients kept, chrome untouched. Judged in chunks of ten here, so the
  // progressive paint is observable: the popup's counts climb while the status is still "judging",
  // and the first grey arrives with the sweep on it.
  const probe = await context.newPage();
  await probe.goto(`chrome-extension://${launched.id}/options.html`);
  await probe.evaluate(() => chrome.runtime.sendMessage({ type: "setSettings", patch: { maxSentencesPerRequest: 10 } }));
  const page = await context.newPage();
  await page.bringToFront();
  let t0 = performance.now();
  const partials = [];
  const sampling = (async () => {
    for (let i = 0; i < 600; i++) {
      const s = await fixtureTabState(probe);
      if (s?.status === "judging" && s.faded + s.kept > 0) partials.push(s.kept + s.faded);
      if (s?.status === "done" || s?.status === "error") break;
      await sleep(40);
    }
  })();
  await page.goto(`${server.url}/recipe.html`);
  await page.waitForSelector(".osso-fade", { state: "attached", timeout: JUDGE_TIMEOUT_MS });
  const sweeping = await page.evaluate(() => document.querySelectorAll(".osso-sweep").length);
  await waitJudged(page);
  await sampling;
  assert(sweeping > 0, "recipe: the first grey arrived without the sweep");
  assert(partials.length >= 1, "recipe: no partial counts were seen while judging (chunks are not painted as they land)");
  console.log(`[osso e2e] progressive paint: ${partials.length} partial states seen (${partials.join(" → ")} judged), ${sweeping} sentences sweeping at first grey`);
  await probe.evaluate(() => chrome.runtime.sendMessage({ type: "setSettings", patch: { maxSentencesPerRequest: 60 } }));
  await probe.close();
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

  // Hover a faded sentence: the chip gives the reason in one word, no kind-plus-number, no digits.
  await page.locator(".osso-fade").first().scrollIntoViewIfNeeded();
  await page.locator(".osso-fade").first().hover();
  await page.waitForSelector(".osso-chip.osso-chip-show", { state: "visible", timeout: 5000 });
  const chip = await page.evaluate(() => {
    const c = document.querySelector(".osso-chip.osso-chip-show");
    return { label: c?.querySelector(".osso-chip-label")?.textContent ?? "", text: c?.textContent ?? "", parts: c?.children.length ?? 0 };
  });
  assert(["opinion", "story", "filler", "promo", "aside"].includes(chip.label), `recipe: chip label "${chip.label}" is not a reason`);
  assert(chip.parts === 1 && !/\d/.test(chip.text), `recipe: chip should be one word ("${chip.text}")`);
  console.log(`[osso e2e] chip on the first faded sentence: ${chip.label}`);
  // Ink gets no chip: hovering a kept sentence shows nothing.
  await page.mouse.move(0, 0);
  await sleep(300);
  await page.locator(".osso-s:not(.osso-fade)").first().hover();
  await sleep(500);
  assert(!(await page.evaluate(() => document.querySelector(".osso-chip.osso-chip-show"))), "recipe: a kept sentence showed a chip");
  await page.screenshot({ path: join(shots, "recipe-chip.png") });
  await page.mouse.move(0, 0);

  // Reveal: hold Shift past REVEAL_HOLD_MS, everything is ink; release, it fades back.
  await page.keyboard.down("Shift");
  await sleep(300);
  assert(await page.evaluate(() => document.documentElement.classList.contains("osso-reveal")), "recipe: holding Shift did not add html.osso-reveal");
  await page.screenshot({ path: join(shots, "recipe-revealed.png"), fullPage: true });
  await page.keyboard.up("Shift");
  await sleep(500);
  assert(!(await page.evaluate(() => document.documentElement.classList.contains("osso-reveal"))), "recipe: releasing Shift left html.osso-reveal on");

  // Rules. "sponsor discount codes" names the THYME15 sentence, which the keep question fades.
  const SPONSOR = "THYME15";
  const RULE = "sponsor discount codes";
  assert((await page.evaluate(fadedByText, SPONSOR)) === true, "recipe: the sponsor code sentence was not faded before any rule");
  // Settings are written the way the popup writes them, from an extension page; the recipe stays in front.
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${launched.id}/options.html`);
  await page.bringToFront();
  const setRules = (rules) => ext.evaluate((rules) => chrome.runtime.sendMessage({ type: "setSettings", patch: { rules } }), rules);
  const waitRule = (faded, what) =>
    page.waitForFunction(
      ([needle, faded]) => {
        const spans = [...document.querySelectorAll(".osso-s")];
        const hit = spans.find((s) => (s.textContent ?? "").includes(needle));
        if (!hit) return false;
        const id = hit.getAttribute("data-osso");
        const same = spans.filter((s) => s.getAttribute("data-osso") === id);
        return same.some((s) => s.classList.contains("osso-fade")) === faded;
      },
      [SPONSOR, faded],
      { timeout: JUDGE_TIMEOUT_MS, polling: 50 },
    ).catch(() => {
      throw new AssertionFailed(`recipe: the sponsor sentence did not ${what} in ${JUDGE_TIMEOUT_MS} ms`);
    });

  await armFetchCounter(context);
  t0 = performance.now();
  await setRules([RULE]);
  await waitRule(false, "come back to ink after the rule was added");
  const ruleMs = Math.round(performance.now() - t0);
  // The underline is on for 1.44 s from the same instant the fade came off; the poll above runs every 50 ms.
  assert(await page.evaluate(underlinedByText, SPONSOR), "recipe: the sponsor sentence came back without the rule-hit underline");
  await page.screenshot({ path: join(shots, "recipe-rule.png"), fullPage: true });
  const added = await fetchCount(context);
  assert(added >= 1, `recipe: adding a rule made ${added} requests`);
  const withRule = await untilTabState(ext, (s) => typeof s.ruleHits?.[RULE] === "number", `ruleHits["${RULE}"]`);
  assert(withRule.ruleHits[RULE] >= 1, `recipe: the popup would show "${RULE} · ${withRule.ruleHits[RULE]}"`);
  assert(withRule.kept === withRule.total - withRule.faded, "recipe: kept, faded and total disagree after the rule");
  rows.push({ page: "recipe.html (rule)", total: withRule.total, kept: withRule.kept, faded: withRule.faded, ms: ruleMs });
  console.log(`[osso e2e] rule "${RULE}": ${withRule.ruleHits[RULE]} kept, ${added} request(s), ${ruleMs} ms`);

  // Removing the rule fades the sentence again with no request at all.
  await armFetchCounter(context);
  await setRules([]);
  await waitRule(true, "fade again after the rule was removed");
  await sleep(1000);
  const removed = await fetchCount(context);
  assert(removed === 0, `recipe: removing a rule made ${removed} request(s)`);
  const without = await untilTabState(ext, (s) => !(RULE in (s.ruleHits ?? {})), "the rule gone from ruleHits");
  assert(without.faded === recipe.faded, `recipe: ${without.faded} faded after the rule was removed, ${recipe.faded} before it was added`);

  // Back on: the page's record carries the rule now, so still no request.
  await armFetchCounter(context);
  await setRules([RULE]);
  await waitRule(false, "come back to ink after the rule was added again");
  const readded = await untilTabState(ext, (s) => typeof s.ruleHits?.[RULE] === "number", `ruleHits["${RULE}"] the second time`);
  assert(readded.ruleHits[RULE] === withRule.ruleHits[RULE], `recipe: the rule kept ${readded.ruleHits[RULE]} the second time, ${withRule.ruleHits[RULE]} the first`);
  const cachedRule = await fetchCount(context);
  assert(cachedRule === 0, `recipe: adding the rule back made ${cachedRule} request(s)`);
  await setRules([]);
  await waitRule(true, "fade again after the second removal");
  await ext.close();

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

  // A single-page app: the shell has nothing to judge, the article arrives 2.5 s later and must be judged then.
  t0 = performance.now();
  await page.goto(`${server.url}/spa.html`);
  await sleep(1200);
  assert((await page.evaluate(() => document.querySelectorAll(".osso-s").length)) === 0, "spa: the empty shell was wrapped");
  await waitJudged(page);
  const spa = await page.evaluate(countSentences);
  rows.push({ page: "spa.html (late content)", ...spa, ms: Math.round(performance.now() - t0) });
  assert(spa.total >= 8 && spa.faded >= 2, `spa: expected the late article judged, got ${JSON.stringify(spa)}`);

  // A consent wall: nine sentences of policy get judged first; when the wall is dismissed and the
  // page appears behind it, Osso must start over on the page, not stay on the wall.
  t0 = performance.now();
  await page.goto(`${server.url}/consent.html`);
  await page.waitForFunction(() => document.querySelectorAll("#consent .osso-s").length > 0, null, { timeout: JUDGE_TIMEOUT_MS });
  await page.waitForFunction(() => document.querySelectorAll("article .osso-s").length > 0 && document.querySelectorAll("#consent .osso-s").length === 0, null, { timeout: JUDGE_TIMEOUT_MS }).catch(() => {
    throw new AssertionFailed("consent: after the wall was dismissed the article was not judged (or the wall stayed judged)");
  });
  await waitJudged(page);
  const consent = await page.evaluate(countSentences);
  rows.push({ page: "consent.html (wall gone)", ...consent, ms: Math.round(performance.now() - t0) });
  assert(consent.total >= 8 && consent.faded >= 2, `consent: expected the article judged, got ${JSON.stringify(consent)}`);

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
