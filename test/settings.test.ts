import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, THRESHOLD_MAX, THRESHOLD_MIN } from "../src/shared/constants.ts";
import {
  SETTINGS_KEY,
  STATS_KEY,
  addStats,
  getSettings,
  getStats,
  isHostEnabled,
  normalizeHost,
  onSettingsChanged,
  resetStats,
  setHostEnabled,
  setSettings,
} from "../src/background/settings.ts";
import type { Settings } from "../src/shared/types.ts";

const store = () => (chrome as unknown as { __store: Map<string, unknown> }).__store;
const withHosts = (patch: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...patch });

beforeEach(() => {
  store().clear();
  vi.mocked(chrome.storage.local.get).mockClear();
  vi.mocked(chrome.storage.local.set).mockClear();
});

describe("getSettings", () => {
  it("returns the defaults on an empty store", async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("merges a partial stored record over the defaults", async () => {
    store().set(SETTINGS_KEY, { apiKey: "k", enabled: false });
    expect(await getSettings()).toEqual({ ...DEFAULT_SETTINGS, apiKey: "k", enabled: false });
  });

  it("clamps and repairs invalid stored values", async () => {
    store().set(SETTINGS_KEY, {
      apiKey: "  spaced  ",
      threshold: 5,
      revealKey: "Space",
      maxSentencesPerRequest: 1000,
      deniedHosts: ["WWW.Example.com", "example.com", 42, ""],
      allowedHosts: "not-a-list",
      enabled: "yes",
    });
    const s = await getSettings();
    expect(s.apiKey).toBe("spaced");
    expect(s.threshold).toBe(THRESHOLD_MAX);
    expect(s.revealKey).toBe("Shift");
    expect(s.maxSentencesPerRequest).toBe(120);
    expect(s.deniedHosts).toEqual(["example.com"]);
    expect(s.allowedHosts).toEqual([]);
    expect(s.enabled).toBe(true);
  });

  it("clamps the low side and non-numbers fall back to the default", async () => {
    store().set(SETTINGS_KEY, { threshold: -1, maxSentencesPerRequest: "many" });
    const s = await getSettings();
    expect(s.threshold).toBe(THRESHOLD_MIN);
    expect(s.maxSentencesPerRequest).toBe(DEFAULT_SETTINGS.maxSentencesPerRequest);
    store().set(SETTINGS_KEY, { maxSentencesPerRequest: 3 });
    expect((await getSettings()).maxSentencesPerRequest).toBe(10);
  });
});

describe("setSettings", () => {
  it("writes the merged, validated record and returns it", async () => {
    const s = await setSettings({ threshold: 0.95, revealKey: "Alt" });
    expect(s.threshold).toBe(THRESHOLD_MAX);
    expect(s.revealKey).toBe("Alt");
    expect(store().get(SETTINGS_KEY)).toEqual(s);
    expect(await getSettings()).toEqual(s);
  });

  it("resets apiKeyInvalid when the key changes, and keeps it otherwise", async () => {
    await setSettings({ apiKey: "old" });
    await setSettings({ apiKeyInvalid: true });
    expect((await getSettings()).apiKeyInvalid).toBe(true);
    await setSettings({ threshold: 0.7 });
    expect((await getSettings()).apiKeyInvalid).toBe(true);
    await setSettings({ apiKey: "old " });
    expect((await getSettings()).apiKeyInvalid).toBe(true);
    const s = await setSettings({ apiKey: "new" });
    expect(s.apiKeyInvalid).toBe(false);
  });

  it("does not lose patches applied concurrently", async () => {
    await Promise.all([setSettings({ apiKey: "k" }), setSettings({ threshold: 0.3 }), setSettings({ enabled: false })]);
    const s = await getSettings();
    expect(s.apiKey).toBe("k");
    expect(s.threshold).toBe(0.3);
    expect(s.enabled).toBe(false);
  });
});

describe("onSettingsChanged", () => {
  it("fires with validated settings on a write to the settings key only", async () => {
    const cb = vi.fn();
    onSettingsChanged(cb);
    await chrome.storage.local.set({ [STATS_KEY]: { pagesJudged: 1 } });
    expect(cb).not.toHaveBeenCalled();
    await setSettings({ threshold: 0.4 });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]?.[0]).toEqual({ ...DEFAULT_SETTINGS, threshold: 0.4 });
  });

  it("returns an unsubscribe that removes the listener", () => {
    const off = onSettingsChanged(() => undefined);
    off();
    expect(chrome.storage.onChanged.removeListener).toHaveBeenCalled();
  });
});

describe("normalizeHost", () => {
  it("lower-cases and strips a leading www.", () => {
    expect(normalizeHost("WWW.Example.COM")).toBe("example.com");
    expect(normalizeHost("www2.example.com")).toBe("www2.example.com");
    expect(normalizeHost(" example.com ")).toBe("example.com");
  });
});

describe("isHostEnabled", () => {
  const base = DEFAULT_SETTINGS;

  it("denies the default list, their subdomains and www. variants", () => {
    expect(isHostEnabled("mail.google.com", base)).toBe(false);
    expect(isHostEnabled("www.google.com", base)).toBe(false);
    expect(isHostEnabled("maps.google.com", base)).toBe(false);
    expect(isHostEnabled("localhost", base)).toBe(false);
  });

  it("allows an ordinary host and does not match on partial labels", () => {
    expect(isHostEnabled("example.com", base)).toBe(true);
    expect(isHostEnabled("notgoogle.com", base)).toBe(true);
    expect(isHostEnabled("", base)).toBe(false);
  });

  it("allowedHosts wins over the default deny list, including for subdomains", () => {
    const s = withHosts({ allowedHosts: ["docs.google.com"] });
    expect(isHostEnabled("docs.google.com", s)).toBe(true);
    expect(isHostEnabled("www.docs.google.com", s)).toBe(true);
    expect(isHostEnabled("drive.google.com", s)).toBe(false);
  });

  it("user deniedHosts cover subdomains and lose to an allowed subdomain", () => {
    const s = withHosts({ deniedHosts: ["example.com"] });
    expect(isHostEnabled("blog.example.com", s)).toBe(false);
    expect(isHostEnabled("example.com", s)).toBe(false);
    const t = withHosts({ deniedHosts: ["example.com"], allowedHosts: ["blog.example.com"] });
    expect(isHostEnabled("blog.example.com", t)).toBe(true);
    expect(isHostEnabled("example.com", t)).toBe(false);
  });
});

describe("setHostEnabled", () => {
  it("disabling an ordinary host adds it to deniedHosts; enabling removes it without an allow entry", async () => {
    let s = await setHostEnabled("WWW.Example.com", false);
    expect(s.deniedHosts).toEqual(["example.com"]);
    expect(isHostEnabled("example.com", s)).toBe(false);
    s = await setHostEnabled("example.com", true);
    expect(s.deniedHosts).toEqual([]);
    expect(s.allowedHosts).toEqual([]);
    expect(isHostEnabled("example.com", s)).toBe(true);
  });

  it("enabling a default-denied host adds it to allowedHosts; disabling again removes it", async () => {
    let s = await setHostEnabled("docs.google.com", true);
    expect(s.allowedHosts).toEqual(["docs.google.com"]);
    expect(isHostEnabled("docs.google.com", s)).toBe(true);
    s = await setHostEnabled("docs.google.com", false);
    expect(s.allowedHosts).toEqual([]);
    expect(s.deniedHosts).toEqual(["docs.google.com"]);
    expect(isHostEnabled("docs.google.com", s)).toBe(false);
  });

  it("enabling a subdomain under a user-denied parent allows just that subdomain", async () => {
    await setSettings({ deniedHosts: ["example.com"] });
    const s = await setHostEnabled("blog.example.com", true);
    expect(s.deniedHosts).toEqual(["example.com"]);
    expect(s.allowedHosts).toEqual(["blog.example.com"]);
    expect(isHostEnabled("blog.example.com", s)).toBe(true);
    expect(isHostEnabled("example.com", s)).toBe(false);
  });

  it("is idempotent", async () => {
    await setHostEnabled("example.com", false);
    const s = await setHostEnabled("example.com", false);
    expect(s.deniedHosts).toEqual(["example.com"]);
  });
});

describe("stats", () => {
  it("defaults to zeros", async () => {
    expect(await getStats()).toEqual({ pagesJudged: 0, sentencesJudged: 0, inputTokens: 0, ms: 0, cacheHits: 0 });
  });

  it("accumulates deltas, also when added concurrently, and resets", async () => {
    await addStats({ pagesJudged: 1, sentencesJudged: 40, inputTokens: 5000, ms: 400 });
    const s = await addStats({ pagesJudged: 1, cacheHits: 2 });
    expect(s).toEqual({ pagesJudged: 2, sentencesJudged: 40, inputTokens: 5000, ms: 400, cacheHits: 2 });
    await Promise.all(Array.from({ length: 10 }, () => addStats({ cacheHits: 1 })));
    expect((await getStats()).cacheHits).toBe(12);
    await resetStats();
    expect(await getStats()).toEqual({ pagesJudged: 0, sentencesJudged: 0, inputTokens: 0, ms: 0, cacheHits: 0 });
  });
});
