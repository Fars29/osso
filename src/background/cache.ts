/**
 * Judgment cache: one record per page content hash, an LRU index beside them. The probe showed a
 * repeat request moves p by at most 0.01, so a stored judgment is as good as a fresh one and costs
 * nothing; the cache is what makes reopening a page free.
 *
 * Recency is a counter carried in the index rather than Date.now: two puts in the same
 * millisecond would otherwise tie, and tests could not pin the eviction order.
 */
import type { PageJudgment, RuleResults } from "../shared/types.ts";
import { CACHE_MAX_PAGES } from "../shared/constants.ts";

export const CACHE_PREFIX = "osso:cache:";
export const CACHE_INDEX_KEY = "osso:cacheIndex";

export interface CacheEntry {
  hash: string;
  at: number;
}

let maxPages = CACHE_MAX_PAGES;

/** Tests shrink the cap to see eviction without four hundred puts. */
export function setCacheMaxPages(n: number): void {
  maxPages = Math.max(1, Math.floor(n));
}

/**
 * Several tabs may finish judging at once; each put is a read-modify-write on the index, so they
 * run one after another. A failing step must not wedge the chain for the callers behind it.
 */
let chain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn);
  chain = next.catch(() => undefined);
  return next;
}

function keyFor(hash: string): string {
  return CACHE_PREFIX + hash;
}

function readIndex(raw: unknown): CacheEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is CacheEntry =>
      !!e && typeof e === "object" && typeof (e as CacheEntry).hash === "string" && Number.isFinite((e as CacheEntry).at),
  );
}

/** The newest entry is never evicted, so the next tick is always one past the largest `at`. */
function nextTick(index: CacheEntry[]): number {
  let max = 0;
  for (const e of index) if (e.at > max) max = e.at;
  return max + 1;
}

function isJudgment(raw: unknown): raw is PageJudgment {
  return !!raw && typeof raw === "object" && Array.isArray((raw as PageJudgment).sentences);
}

/** A judgment where every sentence failed carries nothing worth serving again. */
function isEmpty(judgment: PageJudgment): boolean {
  if (judgment.sentences.length === 0) return true;
  const failed = new Set(judgment.failedIds);
  return judgment.sentences.every((s) => failed.has(s.id));
}

export function getCached(contentHash: string): Promise<PageJudgment | null> {
  const key = keyFor(contentHash);
  return serialized(async () => {
    const got = await chrome.storage.local.get([key, CACHE_INDEX_KEY]);
    const stored = got[key];
    if (!isJudgment(stored)) return null;
    // Touching recency is the whole point of an LRU; a record the index lost is re-adopted.
    const index = readIndex(got[CACHE_INDEX_KEY]).filter((e) => e.hash !== contentHash);
    index.push({ hash: contentHash, at: nextTick(index) });
    await chrome.storage.local.set({ [CACHE_INDEX_KEY]: index });
    return { ...stored, cached: true, ms: 0 };
  });
}

export function putCached(contentHash: string, judgment: PageJudgment): Promise<void> {
  if (isEmpty(judgment)) return Promise.resolve();
  return serialized(async () => {
    const got = await chrome.storage.local.get(CACHE_INDEX_KEY);
    const index = readIndex(got[CACHE_INDEX_KEY]).filter((e) => e.hash !== contentHash);
    index.push({ hash: contentHash, at: nextTick(index) });
    index.sort((a, b) => a.at - b.at);
    const evicted = index.length > maxPages ? index.splice(0, index.length - maxPages) : [];
    const record = () => ({ [keyFor(contentHash)]: judgment, [CACHE_INDEX_KEY]: index });
    try {
      await chrome.storage.local.set(record());
    } catch (err) {
      // Storage refused the write (full, or a profile in trouble): drop the older half of the cache
      // and try once more. A second refusal is the caller's to shrug off; it has the judgment in
      // hand and only the memory of it is lost.
      const dropped = index.splice(0, Math.floor(index.length / 2));
      if (dropped.length === 0) throw err;
      await chrome.storage.local.remove(dropped.map((e) => keyFor(e.hash)));
      await chrome.storage.local.set(record());
    }
    if (evicted.length) await chrome.storage.local.remove(evicted.map((e) => keyFor(e.hash)));
  });
}

/**
 * Adds rule results to a page's record, rule by rule (a rule judged again replaces its own map,
 * the others stay). False when the page is not cached: the caller's in-memory copy is then the
 * only one, and the next load judges the rule again. No index touch: merging is not a read of
 * the page.
 */
export function mergeRules(contentHash: string, rules: RuleResults): Promise<boolean> {
  const key = keyFor(contentHash);
  return serialized(async () => {
    const got = await chrome.storage.local.get(key);
    const stored = got[key];
    if (!isJudgment(stored)) return false;
    const merged: PageJudgment = { ...stored, rules: { ...stored.rules, ...rules } };
    await chrome.storage.local.set({ [key]: merged });
    return true;
  });
}

export function clearCache(): Promise<void> {
  return serialized(async () => {
    // Walk every key rather than trust the index: a record the index lost must go too.
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX) || k === CACHE_INDEX_KEY);
    if (keys.length) await chrome.storage.local.remove(keys);
  });
}

export async function cacheSize(): Promise<number> {
  const got = await chrome.storage.local.get(CACHE_INDEX_KEY);
  return readIndex(got[CACHE_INDEX_KEY]).length;
}
