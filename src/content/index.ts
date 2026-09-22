/**
 * The content orchestrator: the flow from "should Osso run here?" to a judged page, and the
 * messages that move it afterwards. It owns no rendering and no segmentation; it owns the order
 * things happen in, the tab state the popup reads, and the promise that the page is never left
 * half-done: any exception on the way unwraps everything and says so once in the console.
 *
 * The API key never comes here. The background answers `getSettings` with the key redacted to a
 * presence marker, which is all this side needs to know.
 */
import { MAX_SENTENCES_PER_PAGE, MIN_SENTENCES, MUTATION_DEBOUNCE_MS, REVEAL_HOLD_MS, withDefaults } from "../shared/constants.ts";
import { hashText } from "../shared/hash.ts";
import type {
  FromBackground,
  FromContent,
  HighlightSpans,
  JudgeRequest,
  PageJudgment,
  PageKind,
  PageMeta,
  RuleResults,
  SentenceInput,
  Settings,
  TabState,
  ToBackground,
  ToContent,
} from "../shared/types.ts";
import { route } from "../packs/index.ts";
import {
  applyHighlights,
  applyJudgment,
  applyRules,
  clearRender,
  counts,
  installInteractions,
  markHits as readMarkHits,
  markedCount,
  ruleHits,
  setReveal,
  setThreshold,
  type Counts,
} from "./render.ts";
import { isAppLikePage, segmentNewBlocks, segmentPage, textLength, unwrapAll, unwrapBlock } from "./segment.ts";
import { ACCOUNT_NUMBERS_FOR_A_STATEMENT, assessPrivacy, carriesAccountNumber } from "./privacy.ts";

/** What the popup says for each failure the background can report. */
const REASONS: Record<string, string> = {
  "no-key": "No API key",
  "invalid-key": "API key rejected",
  "rate-limited": "Rate limited by TypeSafe, try again in a minute",
  network: "Couldn't reach TypeSafe (network error or timeout)",
  server: "TypeSafe returned an error",
};

const TOO_LITTLE_TEXT = "too little text";
/**
 * A page that arrives with too little text is often still rendering its content; each time its
 * text grows or something is shown or hidden, segmentation runs again, up to this many times so a
 * page that never settles stops costing anything.
 */
const MAX_GROWTH_RETRIES = 8;
/**
 * A judged page whose world changes outside the container is started over: the container was
 * hidden (a consent wall dismissed, a modal closed) or at least this much new text, and more than
 * the container itself holds, appeared elsewhere (the page the wall was covering). Otherwise the
 * first thing a page showed would be the only thing ever judged.
 */
const OUTGROWN_MIN_CHARS = 2000;
/**
 * Judging what a page adds after the first paint is budgeted per page view: a live blog, a comment
 * stream or a chat widget inside the container must not become an unbounded stream of requests.
 * Sentences that arrive faster than the interval wait and go out together; past the budget, new
 * text stays in the author's ink.
 */
export const MAX_MUTATION_REQUESTS = 12;
export const MUTATION_MIN_INTERVAL_MS = 5_000;

interface Mounted {
  container: Element;
  meta: PageMeta;
  packId: PageKind;
  pageKind: PageKind;
  /** The whole-page request, kept so a rule can be judged over it later, and resent if the worker forgot it. */
  req: JudgeRequest;
  /** Ids continue from here for sentences a mutation adds, so no id is ever reused on one page view. */
  nextId: number;
  /** Every rule result this view has, active or not; a rule missing here is one to ask for. */
  ruleResults: RuleResults;
  /** Every highlight this view has, and the terms last painted, so a term unchanged is not asked again. */
  markResults: HighlightSpans;
  appliedTerms: string[];
  /** What finding those marks cost on this page view, for the popup. */
  markTokens: number;
  markMs: number;
  /** Sentence id → its text, which a mark needs to line its offsets up with the page. */
  sentenceText: Map<number, string>;
  /** The rules last painted, so a settings change that left them alone repaints nothing. */
  applied: string[];
  /** Characters of text outside the container at mount, the baseline for `outgrown`. */
  outsideChars: number;
  uninstall: () => void;
}

const host = location.hostname;
let settings: Settings | null = null;
let state: TabState = blank();
let mounted: Mounted | null = null;
/** The whole-page request the model is answering right now; its chunks are painted as they arrive. */
let inflight: { contentHash: string; gen: number; packId: PageKind } | null = null;
let observer: MutationObserver | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/** Bumped whenever a page view is torn down: a judge reply carrying an older number belongs to spans that no longer exist. */
let generation = 0;
let starting = false;
/** True while segment is splitting or unwrapping; the observer must not mistake our own edits for the page's. */
let wrapping = false;
let growthRetries = 0;
/** Sentences the page added that have not gone out yet, held back by the request interval. */
let pending: SentenceInput[] = [];
let mutationRequests = 0;
let lastMutationRequestAt = 0;
/** Judged blocks whose text the page changed under our wrappers: what was judged is no longer what is on screen. */
const stale = new Set<Element>();
/**
 * Rule work runs one step at a time: a rule added while the page is still being judged, or while
 * an earlier rule is out with the model, waits its turn instead of racing it. Every step re-reads
 * the current rules, so a step queued behind another never acts on a stale list.
 */
let ruleChain: Promise<void> = Promise.resolve();

function blank(): TabState {
  return {
    host,
    status: "idle",
    packId: null,
    pageKind: null,
    total: 0,
    kept: 0,
    faded: 0,
    ms: 0,
    inputTokens: 0,
    cached: false,
    revealed: false,
    ruleHits: {},
  };
}

function isMessage(x: unknown): x is { type: string } {
  return typeof x === "object" && x !== null && typeof (x as { type?: unknown }).type === "string";
}

async function ask(msg: ToBackground): Promise<FromBackground | null> {
  try {
    const reply: unknown = await chrome.runtime.sendMessage(msg);
    return isMessage(reply) ? (reply as FromBackground) : null;
  } catch {
    // No worker to talk to (the extension was reloaded under this page, or it never woke).
    return null;
  }
}

/** Merge into the tab state and tell the background. A status change drops the old reason unless a new one comes with it. */
function report(patch: Partial<TabState>, reason?: string): void {
  const next: TabState = { ...state, ...patch };
  if ("status" in patch) delete next.reason;
  if (reason !== undefined) next.reason = reason;
  state = next;
  void ask({ type: "tabState", state });
}

/** Counts as the popup wants them: the numbers, plus what each rule keeps. */
function tally(c: Counts): Partial<TabState> {
  return {
    ...c,
    ruleHits: ruleHits(document),
    markHits: readMarkHits(document),
    markedSentences: markedCount(document),
    markTokens: mounted?.markTokens ?? 0,
    markMs: mounted?.markMs ?? 0,
  };
}

function reasonOf(reply: FromBackground | null): string {
  if (!reply) return "Osso's background worker did not answer";
  if (reply.type !== "error") return "Unexpected reply from the background worker";
  return (reply.code && REASONS[reply.code]) || reply.error || "Something went wrong";
}

/**
 * Runs a segment write. The records our own splitting queues are taken before the flag drops, so
 * the observer callback, which runs later as a microtask, never sees them.
 */
function wrapped<T>(fn: () => T): T {
  wrapping = true;
  try {
    return fn();
  } finally {
    observer?.takeRecords();
    wrapping = false;
  }
}

function renderOptions(s: Settings): { threshold: number; animations: boolean; strike: boolean; markColor: string; fadeColor: string } {
  return { threshold: s.threshold, animations: s.animations, strike: s.strike, markColor: s.markColor, fadeColor: s.fadeColor };
}

function interactions(s: Settings): () => void {
  return installInteractions(document, {
    revealKey: s.revealKey,
    holdMs: REVEAL_HOLD_MS,
    onPinChange: (c) => report(tally(c)),
    onRevealChange: (on) => report({ revealed: on }),
  });
}

// ---------------------------------------------------------------------------------------------
// The flow

/**
 * `asked`: the reader opened the popup on this page and wants it read now. That is what lifts the
 * two things Osso otherwise waits for: run mode `click`, and a page that looks private (`ask`).
 * It lifts nothing else: a page showing a password or a card field is never read.
 */
async function start(asked = false): Promise<void> {
  if (mounted || starting) return;
  const gen = ++generation;
  const live = () => gen === generation;
  starting = true;
  report({ status: "idle" });
  try {
    const got = await ask({ type: "getSettings" });
    if (!live()) return;
    // Without a worker there is nobody to report to either; the page stays as the author left it.
    if (got?.type !== "settings") return;
    settings = withDefaults(got.settings);
    if (!settings.enabled) {
      report({ status: "disabled" }, "Osso is off");
      return;
    }
    const allowed = await ask({ type: "isHostEnabled", host });
    if (!live()) return;
    if (allowed?.type !== "hostEnabled" || !allowed.enabled) {
      report({ status: "disabled" }, "Off on this site");
      return;
    }
    state = { ...state, always: allowed.always };
    if (!settings.apiKey) {
      report({ status: "no-key" });
      return;
    }
    const privacy = assessPrivacy(document, location);
    if (privacy?.level === "never") {
      report({ status: "skipped" }, privacy.reason);
      return;
    }
    if (!asked) {
      // Nothing is read and nothing is sent until the reader asks: by their choice of run mode, or
      // because the page looks like theirs rather than the world's.
      if (privacy?.level === "ask") {
        report({ status: "held" }, privacy.reason);
        return;
      }
      if (settings.mode === "click" && !allowed.always) {
        report({ status: "ready" });
        return;
      }
    }
    if (isAppLikePage(document)) {
      report({ status: "skipped" }, "looks like an app");
      return;
    }
    const seg = wrapped(() => segmentPage(document));
    if (seg.sentences.length < MIN_SENTENCES) {
      wrapped(() => unwrapAll(document));
      report({ status: "skipped" }, TOO_LITTLE_TEXT);
      return;
    }
    // A sentence that carries an account number is never sent, on any page; a page with several is
    // a statement, and is the reader's to offer.
    const sendable = seg.sentences.filter((s) => !carriesAccountNumber(s.text));
    if (!asked && seg.sentences.length - sendable.length >= ACCOUNT_NUMBERS_FOR_A_STATEMENT) {
      wrapped(() => unwrapAll(document));
      report({ status: "held" }, "account-numbers");
      return;
    }
    const packId = route(seg.meta);
    // A page longer than the cap: what was wrapped is its beginning, and the popup says so.
    const capped = seg.sentences.length >= MAX_SENTENCES_PER_PAGE;
    report({ status: "judging", packId, pageKind: null, total: sendable.length, kept: 0, faded: 0, ruleHits: {}, capped });
    const req: JudgeRequest = { meta: seg.meta, packId, contentHash: seg.contentHash, sentences: sendable };
    // Chunks of this request are painted as they land (see onChunk); anything else is ignored.
    inflight = { contentHash: req.contentHash, gen, packId };
    // Rules go out beside the keep question, not after it, so they never hold the settle up; the
    // background remembers the request before it awaits anything, so the order they land in is free.
    const judging = ask({ type: "judge", req });
    const rules = settings.rules;
    const ruling = rules.length > 0 ? ask({ type: "judgeRules", contentHash: req.contentHash, rules }) : null;
    const reply = await judging;
    inflight = null;
    if (!live()) return;
    if (reply?.type !== "judgment") {
      wrapped(() => {
        clearRender(document);
        unwrapAll(document);
      });
      report({ status: "error", packId: null, total: 0 }, reasonOf(reply));
      return;
    }
    mount(seg.container, seg.meta, packId, req, reply.judgment);
    if (ruling) queueRules(() => firstRules(ruling, gen));
    queueRules(syncRules);
    queueRules(syncHighlights);
  } catch (err) {
    if (live()) fail(err);
  } finally {
    if (live()) starting = false;
  }
}

function mount(container: Element, meta: PageMeta, packId: PageKind, req: JudgeRequest, judgment: PageJudgment): void {
  const s = settings;
  if (!s) throw new Error("settings missing at mount");
  const ruleResults: RuleResults = { ...judgment.rules };
  const c = wrapped(() => {
    let counts = applyJudgment(document, judgment, renderOptions(s));
    // A cached page carries its rules: they apply in the same breath as the fade, so a sentence a
    // rule keeps never goes grey at all.
    if (s.rules.length > 0) counts = applyRules(document, ruleResults, s.rules);
    return counts;
  });
  mounted = {
    container,
    meta,
    packId,
    pageKind: judgment.pageKind,
    req,
    nextId: req.sentences.length,
    ruleResults,
    applied: [...s.rules],
    markResults: {},
    appliedTerms: [],
    markTokens: 0,
    markMs: 0,
    sentenceText: new Map(req.sentences.map((x) => [x.id, x.text])),
    outsideChars: Math.max(0, textLength(document.body) - textLength(container)),
    uninstall: interactions(s),
  };
  report({
    status: "done",
    packId,
    pageKind: judgment.pageKind,
    ...tally(c),
    ms: judgment.ms,
    inputTokens: judgment.inputTokens,
    cached: judgment.cached,
    revealed: false,
  });
  // Anything the page added while the model was thinking went unobserved; one pass picks it up.
  schedule(onSettled);
}

/** Back to the author's page. Every later reply from a request in flight is discarded. */
function teardown(): void {
  generation++;
  starting = false;
  if (timer) clearTimeout(timer);
  timer = null;
  pending = [];
  stale.clear();
  mutationRequests = 0;
  lastMutationRequestAt = 0;
  if (mounted) {
    mounted.uninstall();
    mounted = null;
  }
  wrapped(() => {
    clearRender(document);
    unwrapAll(document);
  });
}

function stop(reason: string): void {
  teardown();
  state = blank();
  report({ status: "disabled" }, reason);
}

function fail(err: unknown): void {
  console.warn("[osso]", err);
  try {
    teardown();
  } catch {
    // The page is already in an unknown state; there is nothing more to undo.
  }
  state = blank();
  report({ status: "error" }, `Osso hit an error on this page: ${err instanceof Error ? err.message : String(err)}`);
}

// ---------------------------------------------------------------------------------------------
// Rules

function queueRules(step: () => Promise<void>): void {
  ruleChain = ruleChain.then(step).catch((err: unknown) => {
    if (mounted) fail(err);
  });
}

function sameRules(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((r, i) => r === b[i]);
}

/** Paints the rules in force with every result the page has, and tells the popup what they keep. */
function paintRules(m: Mounted): void {
  const s = settings;
  if (!s || mounted !== m) return;
  m.applied = [...s.rules];
  report(tally(applyRules(document, m.ruleResults, s.rules)));
}

/** Paints the terms in force with every mark the page has, and tells the popup how many each one found. */
function paintMarks(m: Mounted): void {
  const s = settings;
  if (!s || mounted !== m) return;
  m.appliedTerms = [...s.highlights];
  report(tally(applyHighlights(document, m.markResults, s.highlights, m.sentenceText)));
}

/**
 * Brings the page in line with the highlight terms in force. A term with no answer yet is asked
 * for (two rounds in the worker: the sentences first, then the words inside them); a term taken
 * away stops being painted at once and costs nothing to put back.
 */
async function syncHighlights(): Promise<void> {
  const m = mounted;
  const s = settings;
  if (!m || !s) return;
  const gen = generation;
  const active = s.highlights;
  const missing = active.filter((t) => !Object.prototype.hasOwnProperty.call(m.markResults, t));
  if (missing.length === 0 && sameRules(active, m.appliedTerms)) return;
  if (missing.length > 0) {
    let reply = await ask({ type: "judgeHighlights", contentHash: m.req.contentHash, terms: missing });
    if (gen !== generation) return;
    if (reply?.type === "error" && reply.code === "unknown-page") {
      // The worker restarted and forgot this page's sentences; the cache still has the judgment, so asking again jogs its memory.
      await ask({ type: "judge", req: m.req });
      if (gen !== generation) return;
      reply = await ask({ type: "judgeHighlights", contentHash: m.req.contentHash, terms: missing });
      if (gen !== generation) return;
    }
    if (reply?.type === "highlightJudgment") {
      Object.assign(m.markResults, reply.spans);
      m.markTokens += reply.inputTokens ?? 0;
      m.markMs += reply.ms ?? 0;
    }
  }
  paintMarks(m);
}

/** The rule reply that went out with the first judgment lands here, on the page it was asked for. */
async function firstRules(ruling: Promise<FromBackground | null>, gen: number): Promise<void> {
  const reply = await ruling;
  const m = mounted;
  if (gen !== generation || !m || reply?.type !== "ruleJudgment") return;
  Object.assign(m.ruleResults, reply.rules);
  paintRules(m);
}

/**
 * Brings the page in line with the rules in force: rules with no result yet are judged (one
 * request, over the sentences the background remembers), rules taken away come off at once,
 * and the counts go to the popup. Removing a rule costs nothing: its results stay on the page.
 * Rules that are as they were last painted are left alone.
 */
async function syncRules(): Promise<void> {
  const m = mounted;
  const s = settings;
  if (!m || !s) return;
  const gen = generation;
  const active = s.rules;
  const missing = active.filter((r) => !Object.prototype.hasOwnProperty.call(m.ruleResults, r));
  if (missing.length === 0 && sameRules(active, m.applied)) return;
  if (missing.length > 0) {
    let reply = await ask({ type: "judgeRules", contentHash: m.req.contentHash, rules: missing });
    if (gen !== generation) return;
    if (reply?.type === "error" && reply.code === "unknown-page") {
      // The worker has restarted since this page was judged and forgot its sentences; the cache
      // still has the judgment, so sending the request again costs nothing and jogs its memory.
      await ask({ type: "judge", req: m.req });
      if (gen !== generation) return;
      reply = await ask({ type: "judgeRules", contentHash: m.req.contentHash, rules: missing });
      if (gen !== generation) return;
    }
    if (reply?.type === "ruleJudgment") Object.assign(m.ruleResults, reply.rules);
    // Anything else: the rule stays unjudged on this view and the popup keeps showing "…" for it.
  }
  paintRules(m);
}

// ---------------------------------------------------------------------------------------------
// Mutations

/**
 * Outside a segment write (whose records the observer never sees) the only nodes we add or remove
 * are the hover chip and its text. Our wrappers appearing or disappearing anywhere else is the
 * page's doing: a framework re-rendering a paragraph, a router bringing a cached view back.
 */
/** Ours, not the page's: the hover chip and anything inside it. */
function isChip(n: Node): boolean {
  const el = n.nodeType === 1 ? (n as Element) : n.parentElement;
  return !!el && el.closest(".osso-chip") !== null;
}

function foreign(r: MutationRecord): boolean {
  if (isChip(r.target)) return false;
  for (const n of r.addedNodes) if (!isChip(n)) return true;
  for (const n of r.removedNodes) if (!isChip(n)) return true;
  return false;
}

/** The judged block a mutation landed inside, when it landed inside one of our wrappers. */
function staleBlockOf(target: Node): Element | null {
  const el = target.nodeType === 1 ? (target as Element) : target.parentElement;
  const span = el?.closest(".osso-s");
  return span?.closest("[data-osso-block]") ?? null;
}

function stripHash(url: string): string {
  const i = url.indexOf("#");
  return i < 0 ? url : url.slice(0, i);
}

/**
 * A client-side navigation that reuses the container (a persistent <main> whose route view is
 * swapped) is a new page, not a page that grew: it needs its own container search, pack, hash and
 * cache lookup, not a partial request carrying the old title.
 */
function navigated(): boolean {
  return mounted !== null && stripHash(location.href) !== stripHash(mounted.meta.url);
}

function schedule(fn: () => void | Promise<void>, delay = MUTATION_DEBOUNCE_MS): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void fn();
  }, delay);
}

/**
 * The observer sits on the body for the life of the page and acts by state: judged, it watches
 * the main container for new blocks, for text changing under our wrappers, and for a navigation
 * that swaps the container or its contents out; skipped for too little text, it waits for the
 * page to grow.
 */
/** Whether the container, or anything above it, is hidden now: attribute, or computed style (one read per ancestor, on a settle only). */
function concealed(el: Element): boolean {
  const win = document.defaultView;
  for (let e: Element | null = el; e; e = e.parentElement) {
    if (e.hasAttribute("hidden") || e.getAttribute("aria-hidden") === "true") return true;
    if (win) {
      const cs = win.getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden") return true;
    }
  }
  return false;
}

function outgrown(m: Mounted): boolean {
  const own = textLength(m.container);
  const outside = Math.max(0, textLength(document.body) - own);
  return outside - m.outsideChars > Math.max(OUTGROWN_MIN_CHARS, own);
}

/** How much text the page had when segmentation last ran while skipped, so attribute noise alone does not spend the retries. */
let lastBodyChars = -1;

/**
 * A record of something Osso did itself, after the fact and outside `wrapped`: the chip, a class
 * or a property coming off a wrapper when the front has passed. The
 * page knows nothing of these elements, so an attribute changing on one is always ours. Left in,
 * they re-armed the debounce on every frame and a pending restart never came.
 */
function ours(r: MutationRecord): boolean {
  const el = r.target.nodeType === 1 ? (r.target as Element) : r.target.parentElement;
  if (!el) return false;
  if (el.closest(".osso-chip")) return true;
  return r.type === "attributes" && el.matches(".osso-s");
}

function onMutations(all: MutationRecord[]): void {
  if (wrapping) return;
  const records = all.filter((r) => !ours(r));
  if (records.length === 0) return;
  if (mounted) {
    const container = mounted.container;
    if (!container.isConnected || navigated()) {
      schedule(restart);
      return;
    }
    let changed = false;
    for (const r of records) {
      // Something shown or hidden, or added elsewhere: the settle checks whether the world moved.
      if (r.type === "attributes") {
        changed = true;
        continue;
      }
      if (!container.contains(r.target)) {
        if (foreign(r)) changed = true;
        continue;
      }
      if (r.type === "characterData") {
        const block = staleBlockOf(r.target);
        if (block) {
          stale.add(block);
          changed = true;
        }
        continue;
      }
      if (!foreign(r)) continue;
      changed = true;
      const block = staleBlockOf(r.target);
      if (block) stale.add(block);
    }
    if (changed) schedule(onSettled);
    return;
  }
  if (state.status === "skipped" && state.reason === TOO_LITTLE_TEXT && growthRetries < MAX_GROWTH_RETRIES && records.some((r) => r.type === "attributes" || foreign(r))) {
    schedule(regrow);
  }
}

function restart(): void {
  teardown();
  state = blank();
  void start();
}

/** Only a page that changed since the last attempt is segmented again; a class flickering on a spinner is not a change. */
function regrow(): void {
  const chars = document.body ? textLength(document.body) : 0;
  const shown = document.body ? document.body.querySelectorAll("[hidden], [aria-hidden='true']").length : 0;
  const signature = chars * 31 + shown;
  if (signature === lastBodyChars) return;
  lastBodyChars = signature;
  growthRetries++;
  void start();
}

/**
 * New blocks under the container get the next ids and a request of their own; the background never
 * caches those. A block whose text changed is unwrapped first and comes back as new, so the model
 * judges what is on screen and the old ids fall out of the counts. The rules in force are asked
 * about the new sentences too, in a request of their own, so a live page keeps what the reader
 * asked for.
 */
async function onSettled(): Promise<void> {
  const m = mounted;
  if (!m) return;
  if (navigated() || concealed(m.container) || outgrown(m)) {
    restart();
    return;
  }
  const gen = generation;
  try {
    const added = wrapped(() => {
      for (const block of stale) if (block.isConnected) unwrapBlock(block);
      stale.clear();
      return segmentNewBlocks(document, m.container, m.nextId);
    });
    m.nextId += added.length;
    for (const x of added) m.sentenceText.set(x.id, x.text);
    pending.push(...added.filter((s) => !carriesAccountNumber(s.text)));
    if (pending.length === 0 || mutationRequests >= MAX_MUTATION_REQUESTS) {
      // Nothing to ask, or nothing more we will ask on this view: the counts the popup shows may still have moved.
      pending = [];
      report(tally(counts(document)));
      return;
    }
    const wait = lastMutationRequestAt + MUTATION_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) {
      schedule(onSettled, wait);
      return;
    }
    const batch = pending;
    pending = [];
    mutationRequests++;
    lastMutationRequestAt = Date.now();
    const req: JudgeRequest = {
      meta: { ...m.meta, sentenceCount: batch.length },
      packId: m.packId,
      contentHash: hashText(batch.map((s) => s.text).join("\n")),
      sentences: batch,
    };
    const rules = settings?.rules ?? [];
    const judging = ask({ type: "judge", req });
    const ruling = rules.length > 0 ? ask({ type: "judgeRules", contentHash: req.contentHash, rules }) : null;
    const reply = await judging;
    if (gen !== generation || !mounted) return;
    // A failed partial leaves its sentences in ink, like a failed chunk; the page is still readable.
    if (reply?.type !== "judgment" || !settings) return;
    const c = applyJudgment(document, reply.judgment, renderOptions(settings));
    report({ ...tally(c), ms: state.ms + reply.judgment.ms, inputTokens: state.inputTokens + reply.judgment.inputTokens });
    if (ruling) queueRules(() => partialRules(ruling, gen));
  } catch (err) {
    if (gen === generation) fail(err);
  }
}

/** Rule results for sentences a mutation added join the page's, sentence by sentence. */
async function partialRules(ruling: Promise<FromBackground | null>, gen: number): Promise<void> {
  const reply = await ruling;
  const m = mounted;
  if (gen !== generation || !m || !settings || reply?.type !== "ruleJudgment") return;
  for (const [rule, byId] of Object.entries(reply.rules)) m.ruleResults[rule] = { ...m.ruleResults[rule], ...byId };
  paintRules(m);
}

// ---------------------------------------------------------------------------------------------
// Messages from the popup and the background

async function onSettingsChanged(next: Settings): Promise<void> {
  settings = next;
  if (!next.enabled) {
    if (state.status !== "disabled") stop("Osso is off");
    return;
  }
  if (mounted) {
    const allowed = await ask({ type: "isHostEnabled", host });
    if (!mounted) return;
    if (allowed?.type === "hostEnabled" && !allowed.enabled) {
      stop("Off on this site");
      return;
    }
    mounted.uninstall();
    mounted.uninstall = interactions(next);
    // An empty judgment merges nothing and re-renders with the new threshold and animation setting.
    const empty: PageJudgment = {
      packId: mounted.packId,
      pageKind: mounted.pageKind,
      pageKindConfidence: 0,
      sentences: [],
      inputTokens: 0,
      ms: 0,
      cached: true,
      failedIds: [],
    };
    report(tally(applyJudgment(document, empty, renderOptions(next))));
    // The rules travel with the settings too; `rulesChanged` usually gets here first, and then this is a no-op.
    queueRules(syncRules);
    return;
  }
  // A key was added, Osso was switched back on, or this host was allowed: the guard runs again.
  if (state.status === "disabled" || state.status === "no-key") void start();
}

/**
 * A chunk of the request in flight: painted now, with its own wave, so the grey is seen running
 * down the page as the model answers. The counts go to the popup as they grow. The full judgment
 * that follows merges over this and animates nothing twice.
 */
function onChunk(msg: Extract<ToContent, { type: "judgmentChunk" }>): void {
  const s = settings;
  if (!inflight || !s || msg.contentHash !== inflight.contentHash || inflight.gen !== generation) return;
  const partial: PageJudgment = {
    packId: inflight.packId,
    pageKind: inflight.packId,
    pageKindConfidence: 0,
    sentences: msg.sentences,
    inputTokens: 0,
    ms: 0,
    cached: false,
    failedIds: msg.failedIds,
  };
  const c = wrapped(() => applyJudgment(document, partial, renderOptions(s)));
  report({ status: "judging", kept: c.kept, faded: c.faded });
}

function onMessage(msg: ToContent): FromContent {
  switch (msg.type) {
    case "getTabState":
      return { type: "tabState", state };
    case "setThreshold":
      if (settings) settings = { ...settings, threshold: msg.value };
      if (mounted) report(tally(setThreshold(document, msg.value)));
      return { type: "tabState", state };
    case "reveal":
      if (mounted) {
        setReveal(document, msg.on);
        report({ revealed: msg.on });
      }
      return { type: "tabState", state };
    case "setEnabledHere":
      if (msg.enabled) {
        if (!mounted) {
          growthRetries = 0;
          void start();
        }
      } else {
        stop("Off on this site");
      }
      return { type: "tabState", state };
    case "run":
      if (!mounted && !starting) {
        growthRetries = 0;
        void start(true);
      }
      return { type: "tabState", state };
    case "highlightsChanged":
      if (settings) settings = { ...settings, highlights: msg.highlights };
      queueRules(syncHighlights);
      return { type: "tabState", state };
    case "rulesChanged":
      if (settings) settings = { ...settings, rules: msg.rules };
      queueRules(syncRules);
      return { type: "tabState", state };
    case "judgmentChunk":
      onChunk(msg);
      return { type: "tabState", state };
    case "settingsChanged":
      void onSettingsChanged(msg.settings);
      return { type: "ok" };
  }
}

function main(): void {
  if (window.top !== window) return;
  if (!/^https?:$/.test(location.protocol)) return;
  if (document.contentType !== "text/html") return;
  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse: (reply: FromContent) => void) => {
    let reply: FromContent = { type: "ok" };
    try {
      if (isMessage(msg)) reply = onMessage(msg as ToContent);
    } catch (err) {
      fail(err);
    }
    sendResponse(reply);
    return false;
  });
  observer = new MutationObserver(onMutations);
  observer.observe(document.body ?? document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    // Shown and hidden: a consent wall going away, a page coming out from behind it.
    attributes: true,
    attributeFilter: ["hidden", "aria-hidden", "style", "class", "open"],
  });
  // A router that changes the URL before it touches the view is caught here; one that rebuilds
  // the view first is caught by the observer. Either way the new page gets its own judgment.
  window.addEventListener("popstate", () => {
    if (navigated()) schedule(restart);
  });
  void start();
}

main();
