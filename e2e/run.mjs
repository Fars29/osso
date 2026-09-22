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
  // The front only passes over what is on screen, and the first chunk to come back may be one from
  // further down the page: wait for the front itself, not for the first grey.
  await page.waitForSelector(".osso-sweep", { state: "attached", timeout: JUDGE_TIMEOUT_MS });
  const sweeping = await page.evaluate(() => {
    const swept = [...document.querySelectorAll(".osso-sweep")];
    const onScreen = swept.every((s) => { const r = s.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; });
    return { count: swept.length, onScreen, front: swept[0] ? ["--osso-y0", "--osso-y1", "--osso-front-ms"].map((n) => swept[0].style.getPropertyValue(n)) : [] };
  });
  await waitJudged(page);
  await sampling;
  assert(sweeping.count > 0 && sweeping.onScreen, `recipe: the front should pass over on-screen sentences only, got ${JSON.stringify(sweeping)}`);
  assert(sweeping.front.every((v) => v !== ""), `recipe: the front has no start, end or duration: ${JSON.stringify(sweeping.front)}`);
  assert(partials.length >= 1, "recipe: no partial counts were seen while judging (chunks are not painted as they land)");
  console.log(`[osso e2e] progressive paint: ${partials.length} partial states seen (${partials.join(" → ")} judged), front ${sweeping.front.join(" → ")} over ${sweeping.count} spans on screen`);
  await probe.evaluate(() => chrome.runtime.sendMessage({ type: "setSettings", patch: { maxSentencesPerRequest: 60 } }));
  await probe.close();
  // What is further down waits in ink for the reader, and goes grey in front of them as they scroll.
  const held = await page.evaluate(() => {
    const of = (el) => (el ? getComputedStyle(el).getPropertyValue("--osso-strike").trim() : null);
    const waiting = [...document.querySelectorAll(".osso-wait")];
    const seen = document.querySelector(".osso-fade:not(.osso-wait)");
    return {
      waiting: waiting.length,
      allBelow: waiting.every((w) => w.getBoundingClientRect().top >= innerHeight || w.getBoundingClientRect().bottom <= 0),
      waitingInk: waiting[0] ? getComputedStyle(waiting[0]).color === getComputedStyle(waiting[0].closest("[data-osso-block]")).color : null,
      waitingStrike: of(waiting[0]),
      grey: of(seen),
      ink: of(document.querySelector(".osso-s:not(.osso-fade)")),
      margin: document.querySelectorAll(".osso-why").length,
    };
  });
  assert(held.grey === "100%" && held.ink === "0%", `recipe: the strike should be drawn on grey and absent on ink, got ${JSON.stringify(held)}`);
  assert(held.waiting > 0 && held.allBelow, `recipe: faded sentences off screen should wait for the reader, got ${JSON.stringify(held)}`);
  assert(held.waitingInk === true && held.waitingStrike === "0%", `recipe: a waiting sentence should still be in ink and unstruck, got ${JSON.stringify(held)}`);
  assert(held.margin === 0, "recipe: a reason was put in the margin");
  let swept = 0;
  for (let y = 0, h = await page.evaluate(() => document.documentElement.scrollHeight); y < h; y += 300) {
    await page.mouse.wheel(0, 300);
    await sleep(120);
    swept = Math.max(swept, await page.evaluate(() => document.querySelectorAll(".osso-arrive").length));
  }
  await sleep(300);
  const after = await page.evaluate(() => ({ waiting: document.querySelectorAll(".osso-wait").length, faded: document.querySelectorAll(".osso-fade").length }));
  assert(swept > 0, "recipe: nothing was animated while scrolling down the page");
  assert(after.waiting === 0, `recipe: ${after.waiting} sentences still waiting after the whole page was scrolled through`);
  console.log(`[osso e2e] scroll: ${held.waiting} spans waited in ink below the fold, all went grey as the page was scrolled (up to ${swept} mid-pass at once)`);
  await sleep(2500);
  await page.evaluate(() => scrollTo(0, 0));
  await sleep(300);
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
  await sleep(300);
  assert((await page.evaluate(() => getComputedStyle(document.querySelector(".osso-fade")).getPropertyValue("--osso-strike").trim())) === "0%", "recipe: the strike stayed on while revealed");
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

  // The marker: a term of the reader's, found on the page and painted over the words themselves.
  // The browser paints it from a registry, so what is asserted is what it was given, not a class of ours.
  const TERM = "ingredients and their quantities";
  await ext.evaluate((highlights) => chrome.runtime.sendMessage({ type: "setSettings", patch: { highlights } }), [TERM]);
  let marks = { count: 0, texts: [] };
  for (let i = 0; i < 80 && marks.count === 0; i++) {
    await sleep(500);
    marks = await page.evaluate(() => {
      const h = CSS.highlights?.get("osso-mark");
      const texts = [];
      if (h) for (const r of h) texts.push(r.toString().replace(/\s+/g, " ").trim());
      return { count: h ? h.size : 0, texts };
    });
  }
  assert(marks.count > 0, `recipe: the highlight term marked nothing`);
  const ingredientWords = ["flour", "orzo", "lemon", "stock", "onion", "garlic", "butter", "chicken", "parsley", "salt", "oil", "Parmigiano"];
  const sensible = marks.texts.filter((t) => ingredientWords.some((w) => t.toLowerCase().includes(w.toLowerCase())) || /\d/.test(t));
  assert(sensible.length >= 4, `recipe: the marks do not look like ingredients: ${JSON.stringify(marks.texts.slice(0, 10))}`);
  // A marked sentence is never struck: asking to see a thing and then greying it is two answers to one question.
  const struckMark = await page.evaluate(() => {
    const h = CSS.highlights?.get("osso-mark");
    if (!h) return -1;
    let n = 0;
    for (const r of h) {
      const el = r.startContainer.parentElement?.closest(".osso-s");
      if (el?.classList.contains("osso-fade")) n++;
    }
    return n;
  });
  assert(struckMark === 0, `recipe: ${struckMark} marked stretch(es) sit on struck text`);
  console.log(`[osso e2e] highlight "${TERM}": ${marks.count} marks, e.g. ${JSON.stringify(marks.texts.slice(0, 4))}`);

  // Taken away, the marker comes off the page at once and costs nothing to put back.
  await ext.evaluate(() => chrome.runtime.sendMessage({ type: "setSettings", patch: { highlights: [] } }));
  let cleared = 1;
  for (let i = 0; i < 20 && cleared > 0; i++) {
    await sleep(200);
    cleared = await page.evaluate(() => CSS.highlights?.get("osso-mark")?.size ?? 0);
  }
  assert(cleared === 0, "recipe: the marks stayed after the term was removed");

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

  const ctl = await context.newPage();
  await ctl.goto(`chrome-extension://${launched.id}/options.html`);
  await page.bringToFront();
  // The popup, pointed at the fixture's tab the way Chrome points it at the tab it is opened on.
  const stateOf = (host) =>
    ctl.evaluate(async (host) => {
      for (const t of await chrome.tabs.query({})) {
        const r = await chrome.runtime.sendMessage({ type: "getTabState", tabId: t.id });
        if (r?.state?.host === host) return r.state;
      }
      return null;
    }, host);
  const popupOn = async (needle, host = FIXTURE_HOST) => {
    // Without the tabs permission a tab has no url here: the fixture's tab is the one whose content script answers for the fixture host.
    const id = await ctl.evaluate(async (host) => {
      for (const t of await chrome.tabs.query({})) {
        const r = await chrome.runtime.sendMessage({ type: "getTabState", tabId: t.id });
        if (r?.state?.host === host) return t.id;
      }
      return null;
    }, host);
    const tab = id === null ? null : { id, url: page.url() };
    assert(tab, `no tab for ${needle}`);
    const popup = await context.newPage();
    await popup.addInitScript((tab) => {
      const query = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = (q) => (q && q.active ? Promise.resolve([tab]) : query(q));
    }, tab);
    await popup.goto(`chrome-extension://${launched.id}/popup.html`);
    return popup;
  };
  const untouched = () => page.evaluate(() => document.querySelectorAll(".osso-s").length === 0 && !document.documentElement.classList.contains("osso-on"));

  // A page whose address is somebody's account: nothing is read and nothing is sent; the popup says
  // why, and reads it once when the reader says so.
  await page.goto(`${server.url}/account/orders.html`);
  await sleep(2500);
  const heldBack = await fixtureTabState(ctl);
  assert(heldBack?.status === "held" && heldBack.reason === "private-path:account", `account: expected Osso to hold back, got ${JSON.stringify(heldBack)}`);
  assert(await untouched(), "account: a held page was wrapped");
  let popup = await popupOn("/account/orders.html");
  await popup.getByText("Osso held back here").waitFor({ timeout: 5000 });
  await popup.screenshot({ path: join(shots, "popup-held.png") });
  await popup.getByRole("button", { name: "Read this page once" }).click();
  await page.bringToFront();
  await waitJudged(page);
  const account = await page.evaluate(countSentences);
  rows.push({ page: "account/orders.html (asked)", ...account, ms: 0 });
  assert(account.total >= 8, `account: asked for, the page should have been read, got ${JSON.stringify(account)}`);
  await popup.close();

  // Run mode "click": a page is left alone until the reader opens Osso on it, and opening it is the
  // asking. The fixtures' host cannot show this (the e2e has to put 127.0.0.1 on the "always" list to
  // run there at all, and "always" sites are read as they load), so it is shown on a host nobody listed.
  await ctl.evaluate(() => chrome.runtime.sendMessage({ type: "setSettings", patch: { mode: "click" } }));
  await page.goto("https://example.com/", { waitUntil: "domcontentloaded" });
  await sleep(2000);
  const ready = await stateOf("example.com");
  assert(ready?.status === "ready", `click mode: expected the page to wait, got ${JSON.stringify(ready)}`);
  assert(await untouched(), "click mode: the page was touched before anyone asked");
  popup = await popupOn("example.com", "example.com");
  // Asked, Osso looks at the page: this one is too short to strip, and saying so is the proof it looked.
  let looked = null;
  for (let i = 0; i < 40 && (!looked || looked.status === "ready" || looked.status === "idle"); i++) {
    await sleep(150);
    looked = await stateOf("example.com");
  }
  assert(looked?.status === "skipped" && looked.reason === "too little text", `click mode: opening the popup should have started Osso, got ${JSON.stringify(looked)}`);
  await popup.close();
  await ctl.evaluate(() => chrome.runtime.sendMessage({ type: "setSettings", patch: { mode: "auto" } }));

  // And on a site the reader marked "always", click mode reads as the page loads.
  await ctl.evaluate(() => chrome.runtime.sendMessage({ type: "setSettings", patch: { mode: "click" } }));
  await page.goto(`${server.url}/tos.html`);
  await waitJudged(page);
  const always = await page.evaluate(countSentences);
  rows.push({ page: "tos.html (click mode, always)", ...always, ms: 0 });
  assert(always.faded >= 2, `click mode: a site on the always list should be read as it loads, got ${JSON.stringify(always)}`);
  await ctl.evaluate(() => chrome.runtime.sendMessage({ type: "setSettings", patch: { mode: "auto" } }));
  await ctl.close();
  console.log("[osso e2e] held back on /account/, read when asked; click mode waited for the popup");

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
