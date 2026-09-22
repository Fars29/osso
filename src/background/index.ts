/**
 * The background orchestrator: one message router in front of settings, cache and the API
 * client, a badge per tab, and the two events that need a worker (install, the keyboard
 * command). It is the only side that ever holds the key, and it hands it to one place: the
 * options page, which shows it in its field. A content script asking for settings gets the key
 * replaced by a presence marker and the host lists emptied, the popup gets the same, and the
 * settings broadcast to tabs carries the same.
 *
 * MV3 delivers a reply through `sendResponse` after the listener returns `true`; every handler
 * here is a promise, so the listener always returns true and answers when the promise settles.
 */
import type {
  FromBackground,
  HighlightSpans,
  JudgeRequest,
  PageJudgment,
  RuleResults,
  Settings,
  TabState,
  ToBackground,
  ToContent,
} from "../shared/types.ts";
import { HIGHLIGHT_VERSION, MAX_SENTENCES_PER_REQUEST, RECENT_REQUESTS } from "../shared/constants.ts";
import { getPack } from "../packs/index.ts";
import { ApiError, judgeHighlights, judgePage, judgeRules, testKey, type ApiErrorCode, type JudgeOptions, type JudgeResult } from "./api.ts";
import { clearCache, getCached, mergeHighlights, mergeRules, putCached } from "./cache.ts";
import {
  addStats,
  getSettings,
  getStats,
  isHostAlways, isHostEnabled, setHostAlways,
  normalizeHighlights,
  normalizeRules,
  onSettingsChanged,
  resetStats,
  setHostEnabled,
  setSettings,
} from "./settings.ts";

/**
 * Local adapter: the options page's "Reset usage" sends a message the shared contract does not
 * yet name (see the report on `src/shared/types.ts`). It is routed here so the button works.
 */
type Inbound = ToBackground | { type: "resetStats" };

type ErrorReply = Extract<FromBackground, { type: "error" }>;
type RelayCode = NonNullable<ErrorReply["code"]>;

/** Badge colours: the kept count in ink on paper; "!" in marrow when the page needs the user. */
const BADGE = { paper: "#fbfaf7", ink: "#161616", accent: "#d95d39", white: "#ffffff" } as const;

/** What a content script sees in place of the key: enough to know one is set, nothing to send anywhere. */
const KEY_PRESENT = "•";

/**
 * What a page's content script may ask for. Everything else (writing settings, probing a key,
 * clearing the cache, reading another tab's state) belongs to our own pages; only our content
 * script can reach this listener today, so this is depth, not a door being closed.
 */
const PAGE_MAY_SEND = new Set<string>(["getSettings", "isHostEnabled", "judge", "judgeRules", "judgeHighlights", "tabState"]);

const tabStates = new Map<number, TabState>();
/** The quota warning is worth one line, not one per page. */
let storageWarned = false;

/**
 * The last pages judged, by content hash, with the rule results known for each. A rule added
 * from the popup is judged over the remembered sentences, so the page never resends its text;
 * the rules here mirror what the cache holds (or will hold, once the page's record is written),
 * so a rule the page already carries is answered without a request. Insertion order is the LRU
 * order: a hash asked for again moves to the end.
 */
const recent = new Map<string, { req: JudgeRequest; rules: RuleResults; spans: HighlightSpans }>();

/** A worker that is stopped and started again remembers no page; the tests say so with this. */
export function forgetRecentPages(): void {
  recent.clear();
}

function remember(req: JudgeRequest): { req: JudgeRequest; rules: RuleResults; spans: HighlightSpans } {
  const known = recent.get(req.contentHash);
  recent.delete(req.contentHash);
  const entry = { req, rules: known?.rules ?? {}, spans: known?.spans ?? {} };
  recent.set(req.contentHash, entry);
  while (recent.size > RECENT_REQUESTS) {
    const oldest = recent.keys().next().value;
    if (oldest === undefined) break;
    recent.delete(oldest);
  }
  return entry;
}

function isMessage(x: unknown): x is { type: string } {
  return typeof x === "object" && x !== null && typeof (x as { type?: unknown }).type === "string";
}

/**
 * A message from a page's content script, as opposed to the popup or the options page. The
 * options page opens in a tab too, so `sender.tab` alone does not decide.
 */
function fromPage(sender: chrome.runtime.MessageSender): boolean {
  if (!sender.tab) return false;
  const url = sender.url ?? "";
  return !url.startsWith(chrome.runtime.getURL(""));
}

/** The options page is the one place the key is shown, so the one sender that gets it. */
function trusted(sender: chrome.runtime.MessageSender): boolean {
  return (sender.url ?? "").startsWith(chrome.runtime.getURL("options.html"));
}

/** Settings as everyone but the options page sees them: key redacted, host lists (which only the worker consults) empty. */
function forTab(settings: Settings): Settings {
  return { ...settings, apiKey: settings.apiKey ? KEY_PRESENT : "", deniedHosts: [], allowedHosts: [] };
}

function settingsFor(sender: chrome.runtime.MessageSender, settings: Settings): Settings {
  return trusted(sender) ? settings : forTab(settings);
}

/** The transport union has no "timeout"; a timed-out chunk reads as unreachable, which is what the user can act on. */
function relayCode(code: ApiErrorCode): RelayCode {
  return code === "timeout" ? "network" : code;
}

// ---------------------------------------------------------------------------------------------
// Badge

function badgeFor(state: TabState): { text: string; background: string; color: string } {
  switch (state.status) {
    case "done":
      return { text: String(state.kept), background: BADGE.paper, color: BADGE.ink };
    case "no-key":
    case "error":
      return { text: "!", background: BADGE.accent, color: BADGE.white };
    default:
      return { text: "", background: BADGE.paper, color: BADGE.ink };
  }
}

async function setBadge(tabId: number, state: TabState | null): Promise<void> {
  const badge = state ? badgeFor(state) : { text: "", background: BADGE.paper, color: BADGE.ink };
  try {
    await chrome.action.setBadgeText({ tabId, text: badge.text });
    if (!badge.text) return;
    await chrome.action.setBadgeBackgroundColor({ tabId, color: badge.background });
    // Text colour arrived in Chrome 110; older browsers pick their own contrast.
    await chrome.action.setBadgeTextColor?.({ tabId, color: badge.color });
  } catch {
    // The tab closed between the message and the paint.
  }
}

// ---------------------------------------------------------------------------------------------
// Judge

/**
 * Serve from the cache or ask Jev. A request whose first sentence is id 0 covers the whole page
 * (segment numbers from zero, and the requests a mutation adds carry only later ids); only those
 * are looked up and stored, since a partial keyed by its own hash would never be asked for again.
 * Only a complete judgment is stored: a page with a failed chunk is judged afresh next time
 * rather than served with a hole for as long as the cache remembers it.
 *
 * The request is remembered before anything is awaited, so a `judgeRules` the page sends in the
 * same breath (it does, on load) finds it whatever the order the two settle in.
 */
async function judge(req: JudgeRequest, tabId?: number): Promise<FromBackground> {
  const entry = remember(req);
  const settings = await getSettings();
  if (!settings.apiKey) return { type: "error", code: "no-key", error: "No API key" };
  const fullPage = req.sentences[0]?.id === 0;
  if (fullPage) {
    const hit = await getCached(req.contentHash);
    if (hit) {
      entry.rules = { ...hit.rules, ...entry.rules };
      // Marks come back from the cache too, when they were found with the question asked today.
      if (hit.spans && hit.spansVersion === HIGHLIGHT_VERSION) entry.spans = { ...hit.spans, ...entry.spans };
      await addStats({ cacheHits: 1 }).catch(() => undefined);
      return { type: "judgment", judgment: { ...hit, rules: entry.rules } };
    }
  }
  let result: JudgeResult;
  try {
    const opts: JudgeOptions = {
      apiKey: settings.apiKey,
      maxSentencesPerRequest: Math.min(settings.maxSentencesPerRequest, MAX_SENTENCES_PER_REQUEST),
    };
    // Every chunk goes to the page the moment it lands, so the fade is seen travelling down the
    // page as the model answers; the whole judgment still follows as the reply, for the cache.
    if (tabId !== undefined) {
      opts.onChunk = (p) => {
        void chrome.tabs.sendMessage(tabId, { type: "judgmentChunk", contentHash: req.contentHash, sentences: p.sentences, failedIds: p.failedIds }).catch(() => undefined);
      };
    }
    result = await judgePage(req, getPack(req.packId), opts);
  } catch (err) {
    const e = err instanceof ApiError ? err : new ApiError("server", err instanceof Error ? err.message : String(err));
    if (e.code === "invalid-key") await setSettings({ apiKeyInvalid: true });
    return { type: "error", code: relayCode(e.code), error: e.message };
  }
  const { chunkErrors, ...judgment } = result;
  if (judgment.sentences.length === 0 && chunkErrors.length > 0) {
    const first = chunkErrors[0]!;
    return { type: "error", code: relayCode(first.code), error: first.message };
  }
  // Rules judged while the model was thinking (they run in parallel on first load) ride along.
  const stored: PageJudgment = { ...judgment, rules: entry.rules, spans: entry.spans, spansVersion: HIGHLIGHT_VERSION };
  // The model has answered and the user has paid for it: a full cache or a failed counter write
  // must not turn that into an error on the page, and one refusal must not cost the other write.
  if (fullPage && stored.failedIds.length === 0) await bestEffort(() => putCached(req.contentHash, stored));
  await bestEffort(() =>
    addStats({
      pagesJudged: fullPage ? 1 : 0,
      sentencesJudged: stored.sentences.length,
      inputTokens: stored.inputTokens,
      ms: fullPage ? stored.ms : 0,
    }),
  );
  return { type: "judgment", judgment: stored };
}

/**
 * Where the reader's terms are on the page. Like the rules, a term already answered for this page
 * costs nothing, and what comes back is merged into the cached judgment so a second visit is free.
 */
async function judgeHighlightsFor(contentHash: string, asked: string[]): Promise<FromBackground> {
  const entry = recent.get(contentHash);
  if (!entry) return { type: "error", code: "unknown-page", error: "This page has not been judged yet" };
  const terms = normalizeHighlights(asked);
  const missing = terms.filter((t) => !Object.prototype.hasOwnProperty.call(entry.spans, t));
  if (missing.length > 0) {
    const settings = await getSettings();
    if (!settings.apiKey) return { type: "error", code: "no-key", error: "No API key" };
    let result;
    try {
      result = await judgeHighlights(entry.req, getPack(entry.req.packId), missing, {
        apiKey: settings.apiKey,
        maxSentencesPerRequest: settings.maxSentencesPerRequest,
      });
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError("server", err instanceof Error ? err.message : String(err));
      if (e.code === "invalid-key") await setSettings({ apiKeyInvalid: true });
      return { type: "error", code: relayCode(e.code), error: e.message };
    }
    Object.assign(entry.spans, result.spans);
    const fullPage = entry.req.sentences[0]?.id === 0;
    if (fullPage && result.chunkErrors.length === 0) await bestEffort(() => mergeHighlights(contentHash, result.spans));
    await bestEffort(() => addStats({ inputTokens: result.inputTokens }));
  }
  const out: HighlightSpans = {};
  for (const t of terms) {
    const byId = entry.spans[t];
    if (byId) out[t] = byId;
  }
  return { type: "highlightJudgment", contentHash, spans: out };
}

/**
 * Judge rules over a page already judged. Rules the page's record already carries are answered
 * from memory; only the rest go to the model, in one batched request. What comes back joins the
 * remembered entry and, for a whole page with no failed chunk, the cache, so removing and
 * re-adding a rule never costs a second request.
 */
async function judgeRulesFor(contentHash: string, asked: string[]): Promise<FromBackground> {
  const entry = recent.get(contentHash);
  if (!entry) return { type: "error", code: "unknown-page", error: "This page has not been judged yet" };
  const rules = normalizeRules(asked);
  const missing = rules.filter((r) => !Object.prototype.hasOwnProperty.call(entry.rules, r));
  if (missing.length > 0) {
    const settings = await getSettings();
    if (!settings.apiKey) return { type: "error", code: "no-key", error: "No API key" };
    let result;
    try {
      result = await judgeRules(entry.req, getPack(entry.req.packId), missing, {
        apiKey: settings.apiKey,
        maxSentencesPerRequest: settings.maxSentencesPerRequest,
      });
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError("server", err instanceof Error ? err.message : String(err));
      if (e.code === "invalid-key") await setSettings({ apiKeyInvalid: true });
      return { type: "error", code: relayCode(e.code), error: e.message };
    }
    if (result.failedIds.length === entry.req.sentences.length && result.chunkErrors.length > 0) {
      const first = result.chunkErrors[0]!;
      return { type: "error", code: relayCode(first.code), error: first.message };
    }
    Object.assign(entry.rules, result.rules);
    // A partial answer serves this page view but is not remembered: the next load asks again.
    const fullPage = entry.req.sentences[0]?.id === 0;
    if (fullPage && result.failedIds.length === 0) await bestEffort(() => mergeRules(contentHash, result.rules));
    await bestEffort(() => addStats({ inputTokens: result.inputTokens }));
  }
  const out: RuleResults = {};
  for (const r of rules) {
    const byId = entry.rules[r];
    if (byId) out[r] = byId;
  }
  return { type: "ruleJudgment", contentHash, rules: out };
}

/** A storage write that may fail without consequence for the caller; the first failure is said once. */
async function bestEffort(write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (err) {
    if (storageWarned) return;
    storageWarned = true;
    console.warn("[osso] could not write to storage; the judgment was served but not remembered", err);
  }
}

// ---------------------------------------------------------------------------------------------
// Router

function sameRules(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((r, i) => r === b[i]);
}

async function handle(msg: Inbound, sender: chrome.runtime.MessageSender): Promise<FromBackground> {
  if (fromPage(sender) && !PAGE_MAY_SEND.has(msg.type)) return { type: "error", error: "Not allowed from a page" };
  switch (msg.type) {
    case "getSettings":
      return { type: "settings", settings: settingsFor(sender, await getSettings()) };
    case "setSettings": {
      const before = await getSettings();
      const after = await setSettings(msg.patch);
      // Rules are the one setting a page acts on at once, with a request; the rest ride the storage broadcast.
      if (!sameRules(before.rules, after.rules)) void toAllTabs({ type: "rulesChanged", rules: after.rules });
      if (!sameRules(before.highlights, after.highlights)) void toAllTabs({ type: "highlightsChanged", highlights: after.highlights });
      return { type: "settings", settings: settingsFor(sender, after) };
    }
    case "getStats":
      return { type: "stats", stats: await getStats() };
    case "resetStats":
      await resetStats();
      return { type: "ok" };
    case "isHostEnabled": {
      const settings = await getSettings();
      return { type: "hostEnabled", enabled: isHostEnabled(msg.host, settings), always: isHostAlways(msg.host, settings) };
    }
    case "setHostEnabled": {
      const settings = await setHostEnabled(msg.host, msg.enabled);
      return { type: "hostEnabled", enabled: isHostEnabled(msg.host, settings), always: isHostAlways(msg.host, settings) };
    }
    case "setHostAlways": {
      const settings = await setHostAlways(msg.host, msg.always === true);
      return { type: "hostEnabled", enabled: isHostEnabled(msg.host, settings), always: isHostAlways(msg.host, settings) };
    }
    case "judge":
      return judge(msg.req, sender.tab?.id);
    case "judgeRules":
      return judgeRulesFor(msg.contentHash, Array.isArray(msg.rules) ? msg.rules : []);
    case "judgeHighlights":
      return judgeHighlightsFor(msg.contentHash, Array.isArray(msg.terms) ? msg.terms : []);
    case "tabState": {
      const tabId = sender.tab?.id;
      if (tabId !== undefined) {
        tabStates.set(tabId, msg.state);
        void setBadge(tabId, msg.state);
      }
      return { type: "ok" };
    }
    case "getTabState":
      return { type: "tabState", state: tabStates.get(msg.tabId) ?? null };
    case "testKey": {
      const r = await testKey(msg.apiKey);
      return r.error === undefined ? { type: "keyTest", ok: r.ok, ms: r.ms } : { type: "keyTest", ok: r.ok, ms: r.ms, error: r.error };
    }
    case "clearCache":
      await clearCache();
      return { type: "ok" };
    default:
      return { type: "error", error: `Unknown message: ${String((msg as { type: unknown }).type)}` };
  }
}

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse: (reply: FromBackground) => void) => {
  if (!isMessage(msg)) return false;
  handle(msg as Inbound, sender).then(sendResponse, (err: unknown) => {
    sendResponse({ type: "error", error: err instanceof Error ? err.message : String(err) });
  });
  return true;
});

// ---------------------------------------------------------------------------------------------
// Settings broadcast, tabs, command, install

/** Every tab gets the message; tabs without a content script simply reject, and that is fine. */
async function toAllTabs(msg: ToContent): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map((tab) => (tab.id === undefined ? undefined : chrome.tabs.sendMessage(tab.id, msg).catch(() => undefined))),
  );
}

/** Every change to settings, whoever made it, reaches every page, key redacted. */
onSettingsChanged((settings) => {
  void toAllTabs({ type: "settingsChanged", settings: forTab(settings) });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
});

/** A navigation starts a new page: the old state and badge must not outlive it. */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  tabStates.delete(tabId);
  void setBadge(tabId, null);
});

/** The keyboard command grants activeTab, which is what lets `tab.url` be read here without host permissions. */
async function toggleSite(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined || !tab.url || !/^https?:/i.test(tab.url)) return;
  const host = new URL(tab.url).hostname;
  const enabled = !isHostEnabled(host, await getSettings());
  await setHostEnabled(host, enabled);
  const msg: ToContent = { type: "setEnabledHere", enabled };
  await chrome.tabs.sendMessage(tab.id, msg).catch(() => undefined);
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-site") void toggleSite();
});

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    // Writing the validated settings back makes sure the record exists with every field.
    const settings = await setSettings({});
    // The welcome asks for the key and, with it, for the one decision that is the reader's alone: every page, or only when asked.
    if (details.reason === "install" && !settings.apiKey) await chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  })();
});
