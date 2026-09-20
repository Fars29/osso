/**
 * The background router against the chrome mock and a scripted fetch: what each message answers,
 * who gets to see the key, what is cached, what the badge shows, and the three events (tab gone,
 * command, install) that need a worker.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { FromBackground, JudgeRequest, PageMeta, SentenceInput, TabState, ToBackground } from "../src/shared/types.ts";
import { SETTINGS_KEY } from "../src/background/settings.ts";
import { cacheSize } from "../src/background/cache.ts";
import "../src/background/index.ts";

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
const POPUP: Sender = {};
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
  ...patch,
});

const realFetch = globalThis.fetch;
let fetchMock: Mock<(url: unknown, init?: RequestInit) => Promise<Response>>;

beforeEach(() => {
  mock().__store.clear();
  fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => okReply(init));
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
  it("hands the key to extension pages only; a page sees a presence marker", async () => {
    const set = await send({ type: "setSettings", patch: { apiKey: "ts-secret" } }, POPUP);
    expect(set).toMatchObject({ type: "settings", settings: { apiKey: "ts-secret" } });
    expect(await send({ type: "getSettings" }, PAGE)).toMatchObject({ type: "settings", settings: { apiKey: "•" } });
    expect(await send({ type: "getSettings" }, OPTIONS)).toMatchObject({ type: "settings", settings: { apiKey: "ts-secret" } });
    expect(JSON.stringify(await send({ type: "getSettings" }, PAGE))).not.toContain("ts-secret");
  });

  it("refuses a settings write that claims to come from a page", async () => {
    await send({ type: "setSettings", patch: { threshold: 0.7 } }, POPUP);
    expect(await send({ type: "setSettings", patch: { threshold: 0.3 } }, PAGE)).toMatchObject({ type: "error" });
    expect(await send({ type: "getSettings" }, POPUP)).toMatchObject({ settings: { threshold: 0.7 } });
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
    expect(await send({ type: "isHostEnabled", host: "github.com" })).toEqual({ type: "hostEnabled", enabled: false });
    expect(await send({ type: "isHostEnabled", host: "example.com" })).toEqual({ type: "hostEnabled", enabled: true });
    expect(await send({ type: "setHostEnabled", host: "github.com", enabled: true })).toEqual({ type: "hostEnabled", enabled: true });
    expect(await send({ type: "isHostEnabled", host: "gist.github.com" })).toEqual({ type: "hostEnabled", enabled: true });
    expect(await send({ type: "setHostEnabled", host: "example.com", enabled: false })).toEqual({ type: "hostEnabled", enabled: false });
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
    expect(await send({ type: "isHostEnabled", host: "example.com" })).toEqual({ type: "hostEnabled", enabled: false });
    expect(asMock(mock().tabs.sendMessage)).toHaveBeenCalledWith(1, { type: "setEnabledHere", enabled: false });

    onCommand("toggle-site");
    await flush();
    await flush();
    expect(await send({ type: "isHostEnabled", host: "example.com" })).toEqual({ type: "hostEnabled", enabled: true });
    expect(asMock(mock().tabs.sendMessage)).toHaveBeenLastCalledWith(1, { type: "setEnabledHere", enabled: true });

    // Each toggle also broadcasts settingsChanged; only the toggles themselves are counted here.
    const toggles = () => asMock(mock().tabs.sendMessage).mock.calls.filter(([, m]) => (m as { type: string }).type === "setEnabledHere");
    expect(toggles()).toHaveLength(2);
    onCommand("something-else");
    await flush();
    expect(toggles()).toHaveLength(2);
  });

  it("writes the settings record on install and opens the options page only when there is no key", async () => {
    onInstalled({ reason: "install" });
    await flush();
    await flush();
    expect(mock().__store.get(SETTINGS_KEY)).toMatchObject({ apiKey: "", threshold: 0.5 });
    expect(asMock(mock().runtime.openOptionsPage)).toHaveBeenCalledTimes(1);

    await send({ type: "setSettings", patch: { apiKey: "ts-secret" } });
    onInstalled({ reason: "update" });
    await flush();
    await flush();
    expect(asMock(mock().runtime.openOptionsPage)).toHaveBeenCalledTimes(1);
  });
});
