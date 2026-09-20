/**
 * The content orchestrator: the flow from "should Osso run here?" to a judged page, and the
 * messages that move it afterwards. It owns no rendering and no segmentation; it owns the order
 * things happen in, the tab state the popup reads, and the promise that the page is never left
 * half-done: any exception on the way unwraps everything and says so once in the console.
 *
 * The API key never comes here. The background answers `getSettings` with the key redacted to a
 * presence marker, which is all this side needs to know.
 */
import { MIN_SENTENCES, MUTATION_DEBOUNCE_MS, REVEAL_HOLD_MS } from "../shared/constants.ts";
import { hashText } from "../shared/hash.ts";
import type {
  FromBackground,
  FromContent,
  JudgeRequest,
  PageJudgment,
  PageKind,
  PageMeta,
  SentenceInput,
  Settings,
  TabState,
  ToBackground,
  ToContent,
} from "../shared/types.ts";
import { route } from "../packs/index.ts";
import { applyJudgment, clearRender, counts, installInteractions, setReveal, setThreshold } from "./render.ts";
import { isAppLikePage, segmentNewBlocks, segmentPage, unwrapAll, unwrapBlock } from "./segment.ts";

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
 * A page that arrives with too little text is often still rendering its content; each time it
 * grows, segmentation runs again, up to this many times so a page that never settles stops
 * costing anything.
 */
const MAX_GROWTH_RETRIES = 5;
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
  /** Ids continue from here for sentences a mutation adds, so no id is ever reused on one page view. */
  nextId: number;
  uninstall: () => void;
}

const host = location.hostname;
let settings: Settings | null = null;
let state: TabState = blank();
let mounted: Mounted | null = null;
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

function renderOptions(s: Settings): { threshold: number; animations: boolean } {
  return { threshold: s.threshold, animations: s.animations };
}

function interactions(s: Settings): () => void {
  return installInteractions(document, {
    revealKey: s.revealKey,
    holdMs: REVEAL_HOLD_MS,
    onPinChange: (c) => report(c),
    onRevealChange: (on) => report({ revealed: on }),
  });
}

// ---------------------------------------------------------------------------------------------
// The flow

async function start(): Promise<void> {
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
    settings = got.settings;
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
    if (!settings.apiKey) {
      report({ status: "no-key" });
      return;
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
    const packId = route(seg.meta);
    report({ status: "judging", packId, pageKind: null, total: seg.sentences.length, kept: 0, faded: 0 });
    const req: JudgeRequest = { meta: seg.meta, packId, contentHash: seg.contentHash, sentences: seg.sentences };
    const reply = await ask({ type: "judge", req });
    if (!live()) return;
    if (reply?.type !== "judgment") {
      wrapped(() => unwrapAll(document));
      report({ status: "error", packId: null, total: 0 }, reasonOf(reply));
      return;
    }
    mount(seg.container, seg.meta, packId, seg.sentences.length, reply.judgment);
  } catch (err) {
    if (live()) fail(err);
  } finally {
    if (live()) starting = false;
  }
}

function mount(container: Element, meta: PageMeta, packId: PageKind, count: number, judgment: PageJudgment): void {
  const s = settings;
  if (!s) throw new Error("settings missing at mount");
  const c = applyJudgment(document, judgment, renderOptions(s));
  mounted = { container, meta, packId, pageKind: judgment.pageKind, nextId: count, uninstall: interactions(s) };
  report({
    status: "done",
    packId,
    pageKind: judgment.pageKind,
    ...c,
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
// Mutations

/**
 * Outside a segment write (whose records the observer never sees) the only nodes we add or remove
 * are the hover chip and its text. Our wrappers appearing or disappearing anywhere else is the
 * page's doing: a framework re-rendering a paragraph, a router bringing a cached view back.
 */
function isChip(n: Node): boolean {
  return n.nodeType === 1 && (n as Element).matches(".osso-chip");
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
function onMutations(records: MutationRecord[]): void {
  if (wrapping) return;
  if (mounted) {
    const container = mounted.container;
    if (!container.isConnected || navigated()) {
      schedule(restart);
      return;
    }
    let changed = false;
    for (const r of records) {
      if (!container.contains(r.target)) continue;
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
  if (state.status === "skipped" && state.reason === TOO_LITTLE_TEXT && growthRetries < MAX_GROWTH_RETRIES && records.some(foreign)) {
    schedule(regrow);
  }
}

function restart(): void {
  teardown();
  state = blank();
  void start();
}

function regrow(): void {
  growthRetries++;
  void start();
}

/**
 * New blocks under the container get the next ids and a request of their own; the background never
 * caches those. A block whose text changed is unwrapped first and comes back as new, so the model
 * judges what is on screen and the old ids fall out of the counts.
 */
async function onSettled(): Promise<void> {
  const m = mounted;
  if (!m) return;
  if (navigated()) {
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
    pending.push(...added);
    if (pending.length === 0 || mutationRequests >= MAX_MUTATION_REQUESTS) {
      // Nothing to ask, or nothing more we will ask on this view: the counts the popup shows may still have moved.
      pending = [];
      report(counts(document));
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
    const reply = await ask({ type: "judge", req });
    if (gen !== generation || !mounted) return;
    // A failed partial leaves its sentences in ink, like a failed chunk; the page is still readable.
    if (reply?.type !== "judgment" || !settings) return;
    const c = applyJudgment(document, reply.judgment, renderOptions(settings));
    report({ ...c, ms: state.ms + reply.judgment.ms, inputTokens: state.inputTokens + reply.judgment.inputTokens });
  } catch (err) {
    if (gen === generation) fail(err);
  }
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
    report(applyJudgment(document, empty, renderOptions(next)));
    return;
  }
  // A key was added, Osso was switched back on, or this host was allowed: the guard runs again.
  if (state.status === "disabled" || state.status === "no-key") void start();
}

function onMessage(msg: ToContent): FromContent {
  switch (msg.type) {
    case "getTabState":
      return { type: "tabState", state };
    case "setThreshold":
      if (settings) settings = { ...settings, threshold: msg.value };
      if (mounted) report(setThreshold(document, msg.value));
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
  observer.observe(document.body ?? document.documentElement, { childList: true, subtree: true, characterData: true });
  // A router that changes the URL before it touches the view is caught here; one that rebuilds
  // the view first is caught by the observer. Either way the new page gets its own judgment.
  window.addEventListener("popstate", () => {
    if (navigated()) schedule(restart);
  });
  void start();
}

main();
