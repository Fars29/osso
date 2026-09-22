/**
 * The background router against the chrome mock and a scripted fetch: what each message answers,
 * who gets to see the key, what is cached, what the badge shows, and the three events (tab gone,
 * command, install) that need a worker.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { FromBackground, JudgeRequest, PageMeta, SentenceInput, TabState, ToBackground } from "../src/shared/types.ts";
import { DEFAULT_SETTINGS, HIGHLIGHT_VERSION } from "../src/shared/constants.ts";
import { SETTINGS_KEY } from "../src/background/settings.ts";
import { cacheSize, getCached, putCached } from "../src/background/cache.ts";
import { forgetRecentPages } from "../src/background/index.ts";

type ChromeMock = ReturnType<typeof import("./setup.ts").installChromeMock>;
type AnyMock = Mock<(...args: unknown[]) => unknown>;
type Listener = (...args: unknown[]) => unknown;
type Sender = chrome.runtime.MessageSender;

const mock = () => (globalThis as unknown as { chrome: ChromeMock }).chrome;
const asMock = (fn: unknown) => fn as AnyMock;
/** The listener a `vi.fn()` addListener received on import; read here, before clearMocks wipes the record. */
const registered = (addListener: unknown): Listener => asMock(addListener).mock.calls[0]![0] as Listener;

const router = mock().__messageListeners.at(-1) as Listener;
const onRemoved = registered(mock().tabs.onRemoved.addListener);
const onUpdated = registered(mock().tabs.onUpdated.addListener);
const onCommand = registered(mock().commands.onCommand.addListener);
const onInstalled = registered(mock().runtime.onInstalled.addListener);

const PAGE: Sender = { tab: { id: 7 } as chrome.tabs.Tab, url: "https://example.com/orzo" };
/** The action popup: an extension page with no tab of its own. */
const POPUP: Sender = { url: "chrome-extension://osso/popup.html" };
const OPTIONS: Sender = { tab: { id: 3 } as chrome.tabs.Tab, url: "chrome-extension://osso/options.html" };

/** MV3 contract: the listener returns true and answers through sendResponse later. */
function send(msg: ToBackground | { type: string }, sender: Sender = POPUP): Promise<FromBackground> {
  return new Promise((resolve) => {
    const keepOpen = router(msg, sender, resolve);
    expect(keepOpen).toBe(true);
  });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const meta: PageMeta = {
  url: "https://example.com/orzo",
  host: "example.com",
  title: "One-Pot Lemon Chicken Orzo",
  lang: "en",
  jsonLdTypes: ["recipe"],
  ogType: "article",
  sample: "Every summer…",
  sentenceCount: 12,
};

const sents = (n: number, from = 0): SentenceInput[] =>
  Array.from({ length: n }, (_, i) => ({ id: from + i, text: `Sentence ${from + i} of the page.` }));
const request = (sentences: SentenceInput[], contentHash = "hash-1"): JudgeRequest => ({ meta, packId: "recipe", contentHash, sentences });

function reply(status: number, body: unknown): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text } as unknown as Response;
}

/** Answers every question in the request, as the API does: even ids are substance, odd ids filler. */
function okReply(init: RequestInit | undefined): Response {
  const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
  const answers: Record<string, unknown> = {};
  for (const k of Object.keys(body.questions)) {
    if (!k.startsWith("keep_")) continue;
    const id = Number(k.slice(5));
    answers[`keep_${id}`] = { noul: id % 2 === 0 ? 0.9 : 0.1 };
    answers[`kind_${id}`] = { choice: id % 2 === 0 ? "fact" : "anecdote_or_story", confidence: 0.8 };
  }
  if ("page_kind" in body.questions) answers.page_kind = { choice: "recipe", confidence: 0.93 };
  return reply(200, { answers, usage: { input_tokens: 100 } });
}

/** Answers rule questions the way the API does: rule 0 hits even ids, any later rule hits ids divisible by 3. */
function ruleReply(init: RequestInit | undefined): Response {
  const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
  const answers: Record<string, unknown> = {};
  for (const k of Object.keys(body.questions)) {
    if (!k.startsWith("rule_")) continue;
    const [ri, id] = k.split("_").slice(1).map(Number) as [number, number];
    answers[k] = { noul: (ri === 0 ? id % 2 === 0 : id % 3 === 0) ? 0.9 : 0.1 };
  }
  return reply(200, { answers, usage: { input_tokens: 40 } });
}

/**
 * Answers highlight questions: round one finds the thing in sentence 2 only, round two in its
 * first word. "Sentence 2 of the page." asks about "Sentence" and "page", so the mark is [0, 8].
 */
function highlightReply(init: RequestInit | undefined): Response {
  const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
  const answers: Record<string, unknown> = {};
  for (const k of Object.keys(body.questions)) {
    if (k.startsWith("g")) answers[k] = { noul: Number(k.split("_")[1]) === 2 ? 0.9 : 0.1 };
    else if (k.startsWith("w")) answers[k] = { noul: k === "w0" ? 0.9 : 0.1 };
  }
  return reply(200, { answers, usage: { input_tokens: 30 } });
}

/** Keep, rule or highlight request, by what the body asks. */
function anyReply(init: RequestInit | undefined): Response {
  const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
  const keys = Object.keys(body.questions);
  if (keys.some((k) => k.startsWith("rule_"))) return ruleReply(init);
  if (keys.some((k) => /^(g\d+_\d+|w\d+)$/.test(k))) return highlightReply(init);
  return okReply(init);
}

const ruleKeysOf = (init: RequestInit | undefined) =>
  Object.keys((JSON.parse(String(init?.body)) as { questions: Record<string, unknown> }).questions).filter((k) => k.startsWith("rule_"));

const state = (patch: Partial<TabState>): TabState => ({
  host: "example.com",
  status: "done",
  packId: "recipe",
  pageKind: "recipe",
  total: 20,
  kept: 14,
  faded: 6,
  ms: 900,
  inputTokens: 3000,
  cached: false,
  revealed: false,
  ruleHits: {},
  ...patch,
});

const realFetch = globalThis.fetch;
let fetchMock: Mock<(url: unknown, init?: RequestInit) => Promise<Response>>;

beforeEach(() => {
  mock().__store.clear();
  fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => anyReply(init));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  asMock(mock().tabs.sendMessage).mockClear();
  asMock(mock().tabs.query).mockResolvedValue([{ id: 1, url: "https://example.com/", active: true }]);
  asMock(mock().action.setBadgeText).mockClear();
  asMock(mock().action.setBadgeBackgroundColor).mockClear();
  asMock(mock().runtime.openOptionsPage).mockClear();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("settings and the key", () => {
  it("hands the key to the options page only; the popup and a page see a presence marker", async () => {
    await send({ type: "setSettings", patch: { apiKey: "ts-secret", deniedHosts: ["example.org"] } }, OPTIONS);
    expect(await send({ type: "getSettings" }, OPTIONS)).toMatchObject({ type: "settings", settings: { apiKey: "ts-secret", deniedHosts: ["example.org"] } });
    // The popup only asks whether a key exists; the answer to a write is redacted the same way.
    expect(await send({ type: "getSettings" }, POPUP)).toMatchObject({ type: "settings", settings: { apiKey: "•" } });
    expect(await send({ type: "setSettings", patch: { threshold: 0.6 } }, POPUP)).toMatchObject({ type: "settings", settings: { apiKey: "•", threshold: 0.6 } });
    // A page gets the marker and none of the host lists, which only the worker consults.
    const page = await send({ type: "getSettings" }, PAGE);
    expect(page).toMatchObject({ type: "settings", settings: { apiKey: "•", deniedHosts: [], allowedHosts: [] } });
    for (const sender of [PAGE, POPUP]) expect(JSON.stringify(await send({ type: "getSettings" }, sender))).not.toContain("ts-secret");
    // An empty key is reported as empty, not as present.
    await send({ type: "setSettings", patch: { apiKey: "" } }, OPTIONS);
    expect(await send({ type: "getSettings" }, PAGE)).toMatchObject({ settings: { apiKey: "" } });
  });

  it("refuses a settings write that claims to come from a page", async () => {
    await send({ type: "setSettings", patch: { threshold: 0.7 } }, POPUP);
    expect(await send({ type: "setSettings", patch: { threshold: 0.3 } }, PAGE)).toMatchObject({ type: "error" });
    expect(await send({ type: "getSettings" }, POPUP)).toMatchObject({ settings: { threshold: 0.7 } });
  });

  it("lets a page ask only what a page needs; the rest is refused before it runs", async () => {
    await send({ type: "setSettings", patch: { apiKey: "ts-secret" } }, OPTIONS);
    await send({ type: "tabState", state: state({}) }, PAGE);
    const refused: (ToBackground | { type: string })[] = [
      { type: "testKey", apiKey: "ts-probe" },
      { type: "setHostEnabled", host: "github.com", enabled: true },
      { type: "clearCache" },
      { type: "resetStats" },
      { type: "getTabState", tabId: 7 },
    ];
    for (const msg of refused) expect(await send(msg, PAGE), msg.type).toMatchObject({ type: "error", error: "Not allowed from a page" });
    // None of them did anything: no probe went out, the deny list is as it was, the tab state is still there.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await send({ type: "isHostEnabled", host: "github.com" }, PAGE)).toMatchObject({ type: "hostEnabled", enabled: false });
    expect(await send({ type: "getTabState", tabId: 7 }, POPUP)).toMatchObject({ state: { status: "done" } });
    // What a page may send still answers.
    expect(await send({ type: "getSettings" }, PAGE)).toMatchObject({ type: "settings" });
    expect(await send({ type: "isHostEnabled", host: "example.com" }, PAGE)).toMatchObject({ type: "hostEnabled", enabled: true });
    expect(await send({ type: "tabState", state: state({ kept: 3 }) }, PAGE)).toEqual({ type: "ok" });
    expect((await send({ type: "judge", req: request(sents(12)) }, PAGE)).type).toBe("judgment");
  });

  it("broadcasts every settings change to every tab, key redacted", async () => {
    await send({ type: "setSettings", patch: { apiKey: "ts-secret", threshold: 0.6 } }, OPTIONS);
    await flush();
    expect(asMock(mock().tabs.sendMessage)).toHaveBeenCalledWith(1, {
      type: "settingsChanged",
      settings: expect.objectContaining({ apiKey: "•", threshold: 0.6 }),
    });
  });

  it("answers isHostEnabled and setHostEnabled from the merged deny list", async () => {
    expect(await send({ type: "isHostEnabled", host: "github.com" })).toMatchObject({ type: "hostEnabled", enabled: false });
    expect(await send({ type: "isHostEnabled", host: "example.com" })).toMatchObject({ type: "hostEnabled", enabled: true });
    expect(await send({ type: "setHostEnabled", host: "github.com", enabled: true })).toMatchObject({ type: "hostEnabled", enabled: true });
    expect(await send({ type: "isHostEnabled", host: "gist.github.com" })).toMatchObject({ type: "hostEnabled", enabled: true });
    expect(await send({ type: "setHostEnabled", host: "example.com", enabled: false })).toMatchObject({ type: "hostEnabled", enabled: false });
  });

  it("serves stats, resets them, clears the cache, and names an unknown message", async () => {
    expect(await send({ type: "getStats" })).toMatchObject({ type: "stats", stats: { pagesJudged: 0 } });
    expect(await send({ type: "resetStats" })).toEqual({ type: "ok" });
    expect(await send({ type: "clearCache" })).toEqual({ type: "ok" });
    expect(await send({ type: "bogus" })).toMatchObject({ type: "error", error: expect.stringContaining("bogus") });
  });

  it("tests a key with one small request and reports the verdict", async () => {
    expect(await send({ type: "testKey", apiKey: "ts-x" })).toMatchObject({ type: "keyTest", ok: true, ms: expect.any(Number) });
    fetchMock.mockResolvedValueOnce(reply(401, "no"));
    expect(await send({ type: "testKey", apiKey: "ts-x" })).toMatchObject({ type: "keyTest", ok: false, error: "Invalid key" });
    expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith("https://api.typesafe.ai/"))).toBe(true);
  });
});

describe("judge", () => {
  it("refuses without a key and never fetches", async () => {
    expect(await send({ type: "judge", req: request(sents(12)) }, PAGE)).toMatchObject({ type: "error", code: "no-key" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("judges a full page with the user's key, caches it and counts it", async () => {
    await send({ type: "setSettings", patch: { apiKey: "ts-secret" } });
    const first = await send({ type: "judge", req: request(sents(12)) }, PAGE);
    expect(first.type).toBe("judgment");
    if (first.type !== "judgment") return;
    expect(first.judgment).toMatchObject({ packId: "recipe", pageKind: "recipe", cached: false, inputTokens: 100, failedIds: [] });
    expect(first.judgment.sentences).toHaveLength(12);
    expect(first.judgment.sentences.find((s) => s.id === 3)).toMatchObject({ keep: 0.1, kind: "anecdote_or_story" });
    expect("chunkErrors" in first.judgment).toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer ts-secret");
    const body = JSON.parse(String(init?.body)) as { state: { page_kind_hint: string; text: string }; questions: Record<string, unknown> };
    expect(body.state.page_kind_hint).toBe("recipe page");
    expect(body.state.text).toContain("Sentence 0 of the page.");
    expect(body.questions.page_kind).toBeDefined();

    expect(await cacheSize()).toBe(1);
    expect(await send({ type: "getStats" })).toMatchObject({ stats: { pagesJudged: 1, sentencesJudged: 12, inputTokens: 100, cacheHits: 0 } });

    const again = await send({ type: "judge", req: request(sents(12)) }, PAGE);
    expect(again).toMatchObject({ type: "judgment", judgment: { cached: true, ms: 0 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await send({ type: "getStats" })).toMatchObject({ stats: { pagesJudged: 1, cacheHits: 1 } });
  });

  it("judges the sentences a mutation adds without caching them or counting a page", async () => {
    await send({ type: "setSettings", patch: { apiKey: "ts-secret" } });
    const partial = await send({ type: "judge", req: request(sents(4, 30), "hash-partial") }, PAGE);
    expect(partial).toMatchObject({ type: "judgment", judgment: { cached: false } });
    if (partial.type !== "judgment") return;
    expect(partial.judgment.sentences.map((s) => s.id)).toEqual([30, 31, 32, 33]);
    expect(await cacheSize()).toBe(0);
    expect(await send({ type: "getStats" })).toMatchObject({ stats: { pagesJudged: 0, sentencesJudged: 4 } });
    // Asking again is a fresh request: nothing was stored under the partial's hash.
    await send({ type: "judge", req: request(sents(4, 30), "hash-partial") }, PAGE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("marks the key invalid on a 401 and clears the mark when the key changes", async () => {
    await send({ type: "setSettings", patch: { apiKey: "ts-bad" } });
    fetchMock.mockResolvedValue(reply(401, "unauthorised"));
    expect(await send({ type: "judge", req: request(sents(12)) }, PAGE)).toMatchObject({ type: "error", code: "invalid-key" });
    expect(await send({ type: "getSettings" })).toMatchObject({ settings: { apiKeyInvalid: true } });
    expect(await cacheSize()).toBe(0);
    await send({ type: "setSettings", patch: { apiKey: "ts-new" } });
    expect(await send({ type: "getSettings" })).toMatchObject({ settings: { apiKeyInvalid: false } });
  });

  it("reports the chunk failure when nothing at all could be judged, and stores nothing", async () => {
    await send({ type: "setSettings", patch: { apiKey: "ts-secret" } });
    // 400 is final on first sight: no backoff to wait through.
    fetchMock.mockResolvedValue(reply(400, "bad request"));
    expect(await send({ type: "judge", req: request(sents(12)) }, PAGE)).toMatchObject({ type: "error", code: "server" });
    expect(await cacheSize()).toBe(0);
    expect(await send({ type: "getStats" })).toMatchObject({ stats: { pagesJudged: 0 } });
  });

  it("still serves the judgment when storage refuses the cache and stats writes", async () => {
    await send({ type: "setSettings", patch: { apiKey: "ts-secret" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const quota = new Error("QUOTA_BYTES quota exceeded");
    // The settings write above went through; from here every write is refused, as a full profile would.
    asMock(mock().storage.local.set).mockRejectedValue(quota);
    try {
      const r = await send({ type: "judge", req: request(sents(12)) }, PAGE);
      expect(r.type).toBe("judgment");
      if (r.type !== "judgment") return;
      expect(r.judgment.sentences).toHaveLength(12);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await cacheSize()).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("[osso]");
      // Once is enough: the next page says nothing more.
      expect((await send({ type: "judge", req: request(sents(12), "hash-2") }, PAGE)).type).toBe("judgment");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      // mockReset puts the store-backed implementation from setup.ts back.
      asMock(mock().storage.local.set).mockReset();
      warn.mockRestore();
    }
  });

  it("does not cache a page with a failed chunk, so it is judged afresh next time", async () => {
    await send({ type: "setSettings", patch: { apiKey: "ts-secret", maxSentencesPerRequest: 10 } });
    // Two chunks: the first answers, the second is rejected.
    fetchMock.mockImplementationOnce(async (_u, init) => okReply(init)).mockImplementationOnce(async () => reply(400, "bad"));
    const r = await send({ type: "judge", req: request(sents(20)) }, PAGE);
    expect(r.type).toBe("judgment");
    if (r.type !== "judgment") return;
    expect(r.judgment.sentences).toHaveLength(10);
    expect(r.judgment.failedIds).toHaveLength(10);
    expect(await cacheSize()).toBe(0);
  });
});

describe("tab state and badge", () => {
  it("keeps one state per tab and paints the badge from it", async () => {
    expect(await send({ type: "tabState", state: state({ kept: 14 }) }, PAGE)).toEqual({ type: "ok" });
    await flush();
    expect(await send({ type: "getTabState", tabId: 7 })).toMatchObject({ type: "tabState", state: { status: "done", kept: 14 } });
    expect(asMock(mock().action.setBadgeText)).toHaveBeenLastCalledWith({ tabId: 7, text: "14" });
    expect(asMock(mock().action.setBadgeBackgroundColor)).toHaveBeenLastCalledWith({ tabId: 7, color: "#fbfaf7" });

    await send({ type: "tabState", state: state({ status: "error", reason: "Rate limited" }) }, PAGE);
    await flush();
    expect(asMock(mock().action.setBadgeText)).toHaveBeenLastCalledWith({ tabId: 7, text: "!" });
    expect(asMock(mock().action.setBadgeBackgroundColor)).toHaveBeenLastCalledWith({ tabId: 7, color: "#d95d39" });

    await send({ type: "tabState", state: state({ status: "no-key" }) }, PAGE);
    await flush();
    expect(asMock(mock().action.setBadgeText)).toHaveBeenLastCalledWith({ tabId: 7, text: "!" });

    for (const status of ["skipped", "disabled", "judging"] as const) {
      await send({ type: "tabState", state: state({ status }) }, PAGE);
      await flush();
      expect(asMock(mock().action.setBadgeText)).toHaveBeenLastCalledWith({ tabId: 7, text: "" });
    }
  });

  it("ignores a tab state that does not come from a tab, and answers null for an unknown tab", async () => {
    expect(await send({ type: "tabState", state: state({}) }, POPUP)).toEqual({ type: "ok" });
    expect(await send({ type: "getTabState", tabId: 999 })).toEqual({ type: "tabState", state: null });
  });

  it("forgets a tab when it closes or starts loading a new page", async () => {
    await send({ type: "tabState", state: state({}) }, PAGE);
    onRemoved(7);
    expect(await send({ type: "getTabState", tabId: 7 })).toEqual({ type: "tabState", state: null });

    await send({ type: "tabState", state: state({}) }, PAGE);
    asMock(mock().action.setBadgeText).mockClear();
    onUpdated(7, { status: "loading" });
    await flush();
    expect(await send({ type: "getTabState", tabId: 7 })).toEqual({ type: "tabState", state: null });
    expect(asMock(mock().action.setBadgeText)).toHaveBeenCalledWith({ tabId: 7, text: "" });
  });
});

describe("command and install", () => {
  it("toggle-site flips the active tab's host and tells its content script", async () => {
    onCommand("toggle-site");
    await flush();
    await flush();
    expect(await send({ type: "isHostEnabled", host: "example.com" })).toMatchObject({ type: "hostEnabled", enabled: false });
    expect(asMock(mock().tabs.sendMessage)).toHaveBeenCalledWith(1, { type: "setEnabledHere", enabled: false });

    onCommand("toggle-site");
    await flush();
    await flush();
    expect(await send({ type: "isHostEnabled", host: "example.com" })).toMatchObject({ type: "hostEnabled", enabled: true });
    expect(asMock(mock().tabs.sendMessage)).toHaveBeenLastCalledWith(1, { type: "setEnabledHere", enabled: true });

    // Each toggle also broadcasts settingsChanged; only the toggles themselves are counted here.
    const toggles = () => asMock(mock().tabs.sendMessage).mock.calls.filter(([, m]) => (m as { type: string }).type === "setEnabledHere");
    expect(toggles()).toHaveLength(2);
    onCommand("something-else");
    await flush();
    expect(toggles()).toHaveLength(2);
  });

  it("writes the settings record on install and opens the welcome only when there is no key", async () => {
    onInstalled({ reason: "install" });
    await flush();
    await flush();
    expect(mock().__store.get(SETTINGS_KEY)).toMatchObject({ apiKey: "", threshold: DEFAULT_SETTINGS.threshold, mode: "auto" });
    const created = asMock((mock().tabs as unknown as { create: unknown }).create);
    expect(created).toHaveBeenCalledTimes(1);
    expect(String((created.mock.calls[0]![0] as { url: string }).url)).toContain("welcome.html");

    await send({ type: "setSettings", patch: { apiKey: "ts-secret" } });
    onInstalled({ reason: "update" });
    await flush();
    await flush();
    expect(created).toHaveBeenCalledTimes(1);
  });

  it("keeps the reader's own list of sites where Osso reads without being asked", async () => {
    expect(await send({ type: "setHostAlways", host: "www.Example.com", always: true })).toEqual({ type: "hostEnabled", enabled: true, always: true });
    expect(await send({ type: "isHostEnabled", host: "example.com" })).toMatchObject({ always: true });
    expect(await send({ type: "isHostEnabled", host: "other.org" })).toMatchObject({ enabled: true, always: false });
    // A site Osso skips by default becomes readable by being put on the list, and goes back when taken off it.
    expect(await send({ type: "setHostAlways", host: "github.com", always: true })).toEqual({ type: "hostEnabled", enabled: true, always: true });
    expect(await send({ type: "setHostAlways", host: "github.com", always: false })).toEqual({ type: "hostEnabled", enabled: false, always: false });
  });

  it("takes a run mode of auto or click and nothing else", async () => {
    await send({ type: "setSettings", patch: { mode: "click" } });
    expect(mock().__store.get(SETTINGS_KEY)).toMatchObject({ mode: "click" });
    await send({ type: "setSettings", patch: { mode: "sometimes" as never } });
    expect(mock().__store.get(SETTINGS_KEY)).toMatchObject({ mode: "auto" });
  });
});

describe("rules", () => {
  const evens = (n: number) => Array.from({ length: n }, (_, i) => i).filter((i) => i % 2 === 0);

  it("judges rules over the remembered page, stores them beside the judgment, and answers from memory after that", async () => {
    await send({ type: "setSettings", patch: { apiKey: "ts-secret" } });
    await send({ type: "judge", req: request(sents(12)) }, PAGE);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const first = await send({ type: "judgeRules", contentHash: "hash-1", rules: ["prices"] }, PAGE);
    expect(first.type).toBe("ruleJudgment");
    if (first.type !== "ruleJudgment") return;
    expect(first.contentHash).toBe("hash-1");
    expect(Object.keys(first.rules)).toEqual(["prices"]);
    expect(Object.keys(first.rules.prices!)).toHaveLength(12);
    expect(Object.entries(first.rules.prices!).filter(([, p]) => p >= 0.5).map(([id]) => Number(id))).toEqual(evens(12));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init] = fetchMock.mock.calls[1]!;
    expect(ruleKeysOf(init)).toHaveLength(12);
    expect(ruleKeysOf(init)[0]).toBe("rule_0_0");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer ts-secret");
    expect(await send({ type: "getStats" })).toMatchObject({ stats: { inputTokens: 140, pagesJudged: 1 } });

    // The cache record carries the rule now.
    const hit = await send({ type: "judge", req: request(sents(12)) }, PAGE);
    expect(hit).toMatchObject({ type: "judgment", judgment: { cached: true, rules: { prices: expect.any(Object) } } });

    // Asking again costs nothing; asking for one more judges only the one more.
    expect(await send({ type: "judgeRules", contentHash: "hash-1", rules: ["prices"] }, PAGE)).toMatchObject({ type: "ruleJudgment" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const both = await send({ type: "judgeRules", contentHash: "hash-1", rules: ["prices", "deadlines"] }, PAGE);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(ruleKeysOf(fetchMock.mock.calls[2]![1]).every((k) => k.startsWith("rule_0_"))).toBe(true);
    expect(both).toMatchObject({ type: "ruleJudgment" });
    if (both.type !== "ruleJudgment") return;
    expect(Object.keys(both.rules).sort()).toEqual(["deadlines", "prices"]);
    // Sent on its own, "deadlines" was rule 0 of that request: the mock's even ids hit.
    expect(both.rules.deadlines![4]).toBe(0.9);
    expect(both.rules.deadlines![3]).toBe(0.1);
    // Removing a rule is the page's business; the record still has both for when it comes back.
    const again = await send({ type: "judge", req: request(sents(12)) }, PAGE);
    if (again.type === "judgment") expect(Object.keys(again.judgment.rules ?? {}).sort()).toEqual(["deadlines", "prices"]);
  });

  it("rules asked in the same breath as the first judgment land in the cache with it", async () => {
    await send({ type: "setSettings", patch: { apiKey: "ts-secret" } });
    const [judgment, rules] = await Promise.all([
      send({ type: "judge", req: request(sents(12), "hash-2") }, PAGE),
      send({ type: "judgeRules", contentHash: "hash-2", rules: ["prices"] }, PAGE),
    ]);
    expect(judgment.type).toBe("judgment");
    expect(rules).toMatchObject({ type: "ruleJudgment", rules: { prices: expect.any(Object) } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const hit = await send({ type: "judge", req: request(sents(12), "hash-2") }, PAGE);
    expect(hit).toMatchObject({ type: "judgment", judgment: { cached: true } });
    if (hit.type === "judgment") expect(Object.keys(hit.judgment.rules?.prices ?? {})).toHaveLength(12);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("an unknown hash is refused as unknown-page without a request, and an empty ask answers empty", async () => {
    await send({ type: "setSettings", patch: { apiKey: "ts-secret" } });
    expect(await send({ type: "judgeRules", contentHash: "never-seen", rules: ["prices"] }, PAGE)).toMatchObject({ type: "error", code: "unknown-page" });
    expect(fetchMock).not.toHaveBeenCalled();
    await send({ type: "judge", req: request(sents(12), "hash-3") }, PAGE);
    expect(await send({ type: "judgeRules", contentHash: "hash-3", rules: [] }, PAGE)).toEqual({ type: "ruleJudgment", contentHash: "hash-3", rules: {} });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("without a key the rules are refused too; a 401 marks the key invalid", async () => {
    await send({ type: "setSettings", patch: { apiKey: "ts-secret" } });
    await send({ type: "judge", req: request(sents(12), "hash-4") }, PAGE);
    await send({ type: "setSettings", patch: { apiKey: "" } });
    expect(await send({ type: "judgeRules", contentHash: "hash-4", rules: ["prices"] }, PAGE)).toMatchObject({ type: "error", code: "no-key" });
    await send({ type: "setSettings", patch: { apiKey: "ts-bad" } });
    fetchMock.mockResolvedValue(reply(401, "unauthorised"));
    expect(await send({ type: "judgeRules", contentHash: "hash-4", rules: ["prices"] }, PAGE)).toMatchObject({ type: "error", code: "invalid-key" });
    expect(await send({ type: "getSettings" })).toMatchObject({ settings: { apiKeyInvalid: true } });
  });

  it("when nothing could be judged the reply is an error and the rule is asked again next time", async () => {
    await send({ type: "setSettings", patch: { apiKey: "ts-secret" } });
    await send({ type: "judge", req: request(sents(12), "hash-5") }, PAGE);
    fetchMock.mockResolvedValueOnce(reply(400, "bad"));
    expect(await send({ type: "judgeRules", contentHash: "hash-5", rules: ["prices"] }, PAGE)).toMatchObject({ type: "error", code: "server" });
    expect(await send({ type: "judgeRules", contentHash: "hash-5", rules: ["prices"] }, PAGE)).toMatchObject({ type: "ruleJudgment" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("a partial page's rules are judged but not stored", async () => {
    await send({ type: "setSettings", patch: { apiKey: "ts-secret" } });
    await send({ type: "judge", req: request(sents(4, 30), "hash-partial") }, PAGE);
    const r = await send({ type: "judgeRules", contentHash: "hash-partial", rules: ["prices"] }, PAGE);
    expect(r).toMatchObject({ type: "ruleJudgment" });
    if (r.type === "ruleJudgment") expect(Object.keys(r.rules.prices!).map(Number)).toEqual([30, 31, 32, 33]);
    expect(await cacheSize()).toBe(0);
  });

  it("a settings write that changes the rules tells every tab the rules, and only the rules; other writes do not", async () => {
    await send({ type: "setSettings", patch: { apiKey: "ts-secret" } });
    await flush();
    asMock(mock().tabs.sendMessage).mockClear();
    await send({ type: "setSettings", patch: { rules: [" prices", "Prices"] } }, POPUP);
    await flush();
    const rulesMsgs = () => asMock(mock().tabs.sendMessage).mock.calls.filter(([, m]) => (m as { type: string }).type === "rulesChanged");
    expect(rulesMsgs()).toEqual([[1, { type: "rulesChanged", rules: ["prices"] }]]);
    expect(JSON.stringify(rulesMsgs())).not.toContain("ts-secret");
    await send({ type: "setSettings", patch: { threshold: 0.6 } }, POPUP);
    await send({ type: "setSettings", patch: { rules: ["prices"] } }, POPUP);
    await flush();
    expect(rulesMsgs()).toHaveLength(1);
    await send({ type: "setSettings", patch: { rules: [] } }, OPTIONS);
    await flush();
    expect(rulesMsgs()).toHaveLength(2);
    expect(rulesMsgs()[1]).toEqual([1, { type: "rulesChanged", rules: [] }]);
  });
});

describe("highlights", () => {
  it("marks found once are served from the cache after the worker has forgotten the page", async () => {
    await send({ type: "setSettings", patch: { apiKey: "ts-secret" } });
    await send({ type: "judge", req: request(sents(12), "hash-hl") }, PAGE);
    const first = await send({ type: "judgeHighlights", contentHash: "hash-hl", terms: ["ingredients"] }, PAGE);
    expect(first).toMatchObject({ type: "highlightJudgment", contentHash: "hash-hl", spans: { ingredients: { 2: [[0, 8]] } } });
    // What it cost comes back with it, for the popup: the mock bills 30 tokens a request.
    if (first.type === "highlightJudgment") expect(first.inputTokens).toBeGreaterThanOrEqual(60);
    const asked = fetchMock.mock.calls.length;
    expect(asked).toBeGreaterThan(1);

    // A worker stopped and started again: only the cache remembers the page now.
    forgetRecentPages();
    expect(await send({ type: "judge", req: request(sents(12), "hash-hl") }, PAGE)).toMatchObject({ judgment: { cached: true } });
    const again = await send({ type: "judgeHighlights", contentHash: "hash-hl", terms: ["ingredients"] }, PAGE);
    expect(again).toEqual({ ...first, inputTokens: 0, ms: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(asked);
  });

  it("marks found with an older question are asked again, and dropped from the record rather than merged", async () => {
    await send({ type: "setSettings", patch: { apiKey: "ts-secret" } });
    await send({ type: "judge", req: request(sents(12), "hash-old") }, PAGE);
    const stored = await getCached("hash-old");
    expect(stored).not.toBeNull();
    // What an older wording left behind: a term marked somewhere else, and one no longer asked for.
    await putCached("hash-old", { ...stored!, spans: { ingredients: { 5: [[0, 8]] }, prices: { 1: [[0, 8]] } }, spansVersion: HIGHLIGHT_VERSION - 1 });
    forgetRecentPages();
    await send({ type: "judge", req: request(sents(12), "hash-old") }, PAGE);
    const before = fetchMock.mock.calls.length;
    const r = await send({ type: "judgeHighlights", contentHash: "hash-old", terms: ["ingredients"] }, PAGE);
    expect(r).toMatchObject({ spans: { ingredients: { 2: [[0, 8]] } } });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
    const after = await getCached("hash-old");
    expect(after?.spansVersion).toBe(HIGHLIGHT_VERSION);
    expect(after?.spans).toEqual({ ingredients: { 2: [[0, 8]] } });
  });
});
