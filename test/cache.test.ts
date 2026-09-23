import { beforeEach, describe, expect, it, vi } from "vitest";
import { CACHE_MAX_PAGES } from "../src/shared/constants.ts";
import {
  CACHE_INDEX_KEY,
  CACHE_PREFIX,
  type CacheEntry,
  cacheSize,
  clearCache,
  getCached,
  mergeRules,
  putCached,
  setCacheMaxPages,
} from "../src/background/cache.ts";
import type { PageJudgment } from "../src/shared/types.ts";

const store = () => (chrome as unknown as { __store: Map<string, unknown> }).__store;
const index = () => store().get(CACHE_INDEX_KEY) as CacheEntry[];
const hashes = () => index().map((e) => e.hash);

function judgment(n = 3, failedIds: number[] = []): PageJudgment {
  return {
    packId: "recipe",
    pageKind: "recipe",
    pageKindConfidence: 0.9,
    sentences: Array.from({ length: n }, (_, id) => ({ id, keep: id / n, kind: "aside", kindConfidence: 0.8 })),
    inputTokens: 1234,
    ms: 480,
    cached: false,
    failedIds,
  };
}

beforeEach(() => {
  store().clear();
  setCacheMaxPages(CACHE_MAX_PAGES);
  vi.mocked(chrome.storage.local.get).mockClear();
  vi.mocked(chrome.storage.local.set).mockClear();
  vi.mocked(chrome.storage.local.remove).mockClear();
});

describe("put and get", () => {
  it("misses on an unknown hash without touching the index", async () => {
    expect(await getCached("nope")).toBeNull();
    expect(store().has(CACHE_INDEX_KEY)).toBe(false);
    expect(await cacheSize()).toBe(0);
  });

  it("round-trips a judgment, served with cached=true and ms=0", async () => {
    const j = judgment();
    await putCached("h1", j);
    expect(store().get(CACHE_PREFIX + "h1")).toEqual(j);
    const back = await getCached("h1");
    expect(back).toEqual({ ...j, cached: true, ms: 0 });
    expect(await cacheSize()).toBe(1);
  });

  it("uses one get and one set per put, and per hit", async () => {
    await putCached("h1", judgment());
    expect(chrome.storage.local.get).toHaveBeenCalledTimes(1);
    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
    expect(chrome.storage.local.remove).not.toHaveBeenCalled();
    vi.mocked(chrome.storage.local.get).mockClear();
    vi.mocked(chrome.storage.local.set).mockClear();
    await getCached("h1");
    expect(chrome.storage.local.get).toHaveBeenCalledTimes(1);
    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
  });

  it("refuses a judgment whose every sentence failed, or that has no sentences", async () => {
    await putCached("all-failed", judgment(3, [0, 1, 2]));
    await putCached("empty", judgment(0));
    expect(await cacheSize()).toBe(0);
    expect(store().has(CACHE_PREFIX + "all-failed")).toBe(false);
    await putCached("partial", judgment(3, [2]));
    expect(await cacheSize()).toBe(1);
  });

  it("re-putting the same hash replaces the record and keeps one index entry", async () => {
    await putCached("h1", judgment(3));
    await putCached("h2", judgment(3));
    await putCached("h1", judgment(5));
    expect(hashes()).toEqual(["h2", "h1"]);
    expect((await getCached("h1"))?.sentences).toHaveLength(5);
  });

  it("re-adopts a record the index lost", async () => {
    store().set(CACHE_PREFIX + "orphan", judgment());
    expect(await getCached("orphan")).not.toBeNull();
    expect(hashes()).toEqual(["orphan"]);
  });
});

describe("LRU", () => {
  it("evicts the least recently used page and removes its key", async () => {
    setCacheMaxPages(3);
    await putCached("a", judgment());
    await putCached("b", judgment());
    await putCached("c", judgment());
    await getCached("a"); // a is now the most recent; b is the oldest
    await putCached("d", judgment());
    expect(hashes()).toEqual(["c", "a", "d"]);
    expect(store().has(CACHE_PREFIX + "b")).toBe(false);
    expect(await getCached("b")).toBeNull();
    expect(await cacheSize()).toBe(3);
  });

  it("recency ticks are strictly increasing and independent of the clock", async () => {
    vi.useFakeTimers();
    try {
      await putCached("a", judgment());
      await putCached("b", judgment());
      await getCached("a");
      const ats = index().map((e) => e.at);
      expect(ats).toEqual([...ats].sort((x, y) => x - y));
      expect(new Set(ats).size).toBe(ats.length);
      expect(hashes()).toEqual(["b", "a"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts several at once when the cap shrinks", async () => {
    setCacheMaxPages(5);
    for (const h of ["a", "b", "c", "d", "e"]) await putCached(h, judgment());
    setCacheMaxPages(2);
    await putCached("f", judgment());
    expect(hashes()).toEqual(["e", "f"]);
    for (const h of ["a", "b", "c", "d"]) expect(store().has(CACHE_PREFIX + h)).toBe(false);
  });
});

describe("a full store", () => {
  it("drops the older half of the cache and retries once when a write is refused", async () => {
    for (const h of ["h1", "h2", "h3", "h4"]) await putCached(h, judgment());
    const set = vi.mocked(chrome.storage.local.set);
    const quota = new Error("QUOTA_BYTES quota exceeded");
    set.mockRejectedValueOnce(quota);
    await putCached("h5", judgment());
    expect(hashes()).toEqual(["h3", "h4", "h5"]);
    expect(store().has(CACHE_PREFIX + "h1")).toBe(false);
    expect(store().has(CACHE_PREFIX + "h2")).toBe(false);
    expect(store().get(CACHE_PREFIX + "h5")).toEqual(judgment());
    expect(await getCached("h5")).toMatchObject({ cached: true });

    // Refused twice in a row: the put rejects and the caller shrugs; the next put still runs.
    set.mockRejectedValueOnce(quota).mockRejectedValueOnce(quota);
    await expect(putCached("h6", judgment())).rejects.toThrow(/quota/i);
    await putCached("h7", judgment());
    expect(hashes()).toContain("h7");
    expect(await getCached("h7")).toMatchObject({ cached: true });
  });
});

describe("clearCache", () => {
  it("removes every cache key and the index, nothing else", async () => {
    await putCached("a", judgment());
    await putCached("b", judgment());
    store().set("osso:settings", { apiKey: "k" });
    await clearCache();
    expect([...store().keys()]).toEqual(["osso:settings"]);
    expect(await cacheSize()).toBe(0);
  });
});

describe("concurrency", () => {
  it("concurrent puts all land in the index in order", async () => {
    const names = Array.from({ length: 20 }, (_, i) => `p${i}`);
    await Promise.all(names.map((h) => putCached(h, judgment())));
    expect(hashes()).toEqual(names);
    expect(await cacheSize()).toBe(20);
    for (const h of names) expect(store().has(CACHE_PREFIX + h)).toBe(true);
  });

  it("concurrent puts and gets under a small cap keep index and keys consistent", async () => {
    setCacheMaxPages(4);
    const names = Array.from({ length: 12 }, (_, i) => `p${i}`);
    await Promise.all([...names.map((h) => putCached(h, judgment())), getCached("p0"), getCached("p3")]);
    expect(await cacheSize()).toBe(4);
    const stored = [...store().keys()].filter((k) => k.startsWith(CACHE_PREFIX)).map((k) => k.slice(CACHE_PREFIX.length));
    expect(stored.sort()).toEqual([...hashes()].sort());
  });
});

describe("rules", () => {
  it("merges rule maps into a cached page one rule at a time and serves them with the judgment", async () => {
    await putCached("h1", judgment(3));
    expect(await mergeRules("h1", { prices: { 0: 0.9, 2: 0.2 } })).toBe(true);
    expect(await mergeRules("h1", { deadlines: { 1: 0.7 } })).toBe(true);
    expect((await getCached("h1"))?.rules).toEqual({ prices: { 0: 0.9, 2: 0.2 }, deadlines: { 1: 0.7 } });
    // A rule judged again replaces its own map only.
    await mergeRules("h1", { prices: { 1: 0.5 } });
    expect((await getCached("h1"))?.rules).toEqual({ prices: { 1: 0.5 }, deadlines: { 1: 0.7 } });
    // A record stored with rules keeps them, and a record from before rules existed reads as having none.
    await putCached("h2", { ...judgment(2), rules: { allergens: { 0: 0.8 } } });
    expect((await getCached("h2"))?.rules).toEqual({ allergens: { 0: 0.8 } });
    expect((await getCached("h1"))?.sentences).toHaveLength(3);
  });

  it("reports a page that is not cached and leaves the index alone", async () => {
    await putCached("h1", judgment());
    const before = index().map((e) => ({ ...e }));
    expect(await mergeRules("nope", { prices: { 0: 1 } })).toBe(false);
    expect(store().has(CACHE_PREFIX + "nope")).toBe(false);
    await mergeRules("h1", { prices: { 0: 1 } });
    expect(index()).toEqual(before);
  });
});
