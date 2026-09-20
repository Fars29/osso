/**
 * Settings and stats over chrome.storage.local. Everything read from storage passes through
 * `validate`, so a hand-edited or half-migrated record can never put the worker in a state the
 * rest of the code did not plan for: the worst case is a field falling back to its default.
 */
import type { RevealKey, Settings, Stats } from "../shared/types.ts";
import { DEFAULT_DENIED_HOSTS, DEFAULT_SETTINGS, THRESHOLD_MAX, THRESHOLD_MIN } from "../shared/constants.ts";

export const SETTINGS_KEY = "osso:settings";
export const STATS_KEY = "osso:stats";

const REVEAL_KEYS: readonly RevealKey[] = ["Shift", "Alt", "Control"];
const SENTENCES_MIN = 10;
const SENTENCES_MAX = 120;

const ZERO_STATS: Stats = { pagesJudged: 0, sentencesJudged: 0, inputTokens: 0, ms: 0, cacheHits: 0 };

/**
 * Read-modify-write on a storage key from several tabs at once would lose patches; every write
 * to settings and stats waits for the previous one. The chain never rejects: a failed step is
 * caught so the next caller still runs.
 */
let writeChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn);
  writeChain = next.catch(() => undefined);
  return next;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Host lists are compared by suffix, so they must be stored exactly as `normalizeHost` reads them. */
function hostList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const v of value) {
    if (typeof v !== "string") continue;
    const h = normalizeHost(v);
    if (h) seen.add(h);
  }
  return [...seen];
}

export function validate(raw: unknown): Settings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  return {
    apiKey: typeof r.apiKey === "string" ? r.apiKey.trim() : d.apiKey,
    apiKeyInvalid: boolOr(r.apiKeyInvalid, d.apiKeyInvalid),
    enabled: boolOr(r.enabled, d.enabled),
    threshold: clamp(finiteOr(r.threshold, d.threshold), THRESHOLD_MIN, THRESHOLD_MAX),
    revealKey: REVEAL_KEYS.includes(r.revealKey as RevealKey) ? (r.revealKey as RevealKey) : d.revealKey,
    animations: boolOr(r.animations, d.animations),
    deniedHosts: hostList(r.deniedHosts),
    allowedHosts: hostList(r.allowedHosts),
    maxSentencesPerRequest: Math.round(
      clamp(finiteOr(r.maxSentencesPerRequest, d.maxSentencesPerRequest), SENTENCES_MIN, SENTENCES_MAX),
    ),
  };
}

export async function getSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  return validate(got[SETTINGS_KEY]);
}

export function setSettings(patch: Partial<Settings>): Promise<Settings> {
  return serialized(async () => {
    const current = await getSettings();
    const next = validate({ ...current, ...patch });
    // A 401 marks the key invalid; typing a new key is the only thing that can clear it.
    if (next.apiKey !== current.apiKey) next.apiKeyInvalid = false;
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  });
}

export function onSettingsChanged(cb: (s: Settings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== "local") return;
    const change = changes[SETTINGS_KEY];
    if (change) cb(validate(change.newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** `www.` is a presentation detail, never a different site. */
export function normalizeHost(host: string): string {
  const h = host.trim().toLowerCase();
  return h.startsWith("www.") ? h.slice(4) : h;
}

/** A rule covers a host when it is the host itself or one of its parent domains. */
function matchesRule(host: string, rules: readonly string[]): boolean {
  return rules.some((rule) => host === rule || host.endsWith("." + rule));
}

export function isHostEnabled(host: string, settings: Settings): boolean {
  const h = normalizeHost(host);
  if (!h) return false;
  if (matchesRule(h, settings.allowedHosts)) return true;
  return !matchesRule(h, settings.deniedHosts) && !matchesRule(h, DEFAULT_DENIED_HOSTS);
}

/**
 * The user's lists stay minimal: a host only enters `allowedHosts` when nothing else would let it
 * run, so turning a normal site off and on again leaves no trace.
 */
export function setHostEnabled(host: string, enabled: boolean): Promise<Settings> {
  const h = normalizeHost(host);
  return serialized(async () => {
    const current = await getSettings();
    let deniedHosts = current.deniedHosts.filter((x) => x !== h);
    let allowedHosts = current.allowedHosts.filter((x) => x !== h);
    if (enabled) {
      if (!isHostEnabled(h, { ...current, deniedHosts, allowedHosts })) allowedHosts = [...allowedHosts, h];
    } else {
      deniedHosts = [...deniedHosts, h];
    }
    const next = validate({ ...current, deniedHosts, allowedHosts });
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  });
}

function validateStats(raw: unknown): Stats {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = { ...ZERO_STATS };
  for (const k of Object.keys(ZERO_STATS) as (keyof Stats)[]) out[k] = Math.max(0, finiteOr(r[k], 0));
  return out;
}

export async function getStats(): Promise<Stats> {
  const got = await chrome.storage.local.get(STATS_KEY);
  return validateStats(got[STATS_KEY]);
}

export function addStats(delta: Partial<Stats>): Promise<Stats> {
  return serialized(async () => {
    const current = await getStats();
    const next = { ...current };
    for (const k of Object.keys(ZERO_STATS) as (keyof Stats)[]) next[k] += finiteOr(delta[k], 0);
    await chrome.storage.local.set({ [STATS_KEY]: next });
    return next;
  });
}

export function resetStats(): Promise<void> {
  return serialized(async () => {
    await chrome.storage.local.set({ [STATS_KEY]: { ...ZERO_STATS } });
  });
}
