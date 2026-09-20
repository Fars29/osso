import { beforeEach, describe, expect, it, vi } from "vitest";
import { CACHE_MAX_PAGES } from "../src/shared/constants.ts";
import {
  CACHE_INDEX_KEY,
  CACHE_PREFIX,
  type CacheEntry,
  cacheSize,
  clearCache,
  getCached,
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
    sentences: Array.from({ length: n }, (_, id) => ({ id, keep: id / n, kind: "fact", kindConfidence: 0.8 })),
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
