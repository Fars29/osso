/**
 * The content orchestrator end to end in jsdom: the recipe fixture as the page, a scripted
 * background behind chrome.runtime.sendMessage, and the real segment and render modules in
 * between. Each test boots a fresh module instance; the previous one is switched off first so
 * its observer and listeners stay inert.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { FromBackground, FromContent, JudgeRequest, PageJudgment, RuleResults, Settings, TabState, ToBackground, ToContent } from "../src/shared/types.ts";
import { DEFAULT_SETTINGS, MUTATION_DEBOUNCE_MS } from "../src/shared/constants.ts";

type ChromeMock = ReturnType<typeof import("./setup.ts").installChromeMock>;
type Listener = (...args: unknown[]) => unknown;
const mock = () => (globalThis as unknown as { chrome: ChromeMock }).chrome;
const runtimeSend = () => mock().runtime.sendMessage as unknown as Mock<(...args: unknown[]) => Promise<unknown>>;

function fixture(name: string): { head: string; body: string } {
  const html = readFileSync(resolve(__dirname, "fixtures", `${name}.html`), "utf8");
  return {
    head: /<head>([\s\S]*)<\/head>/.exec(html)?.[1] ?? "",
    body: /<body[^>]*>([\s\S]*)<\/body>/.exec(html)?.[1] ?? "",
  };
}

/** Sentences with a number in them are the substance; the rest is story. */
function judgmentFor(req: JudgeRequest): PageJudgment {
  return {
    packId: req.packId,
    pageKind: "recipe",
    pageKindConfidence: 0.9,
    sentences: req.sentences.map((s) => {
      const keep = /\d/.test(s.text) ? 0.9 : 0.1;
      return { id: s.id, keep, kind: keep > 0.5 ? "fact" : "anecdote_or_story", kindConfidence: 0.8 };
    }),
    inputTokens: 1234,
    ms: 321,
    cached: false,
    failedIds: [],
  };
}

interface Script {
  settings: Settings;
  hostEnabled: boolean;
  judge: (req: JudgeRequest) => FromBackground | Promise<FromBackground>;
  rules: (contentHash: string, rules: string[]) => FromBackground | Promise<FromBackground>;
}

/** What each rule catches, for the scripted background: the sentence text against a pattern. */
const RULE_PATTERNS: Record<string, RegExp> = { grandmothers: /nonna/i, prices: /\d+ ?g\b|%/, nothing: /(?!)/ };

/** Rule results over the sentences of every judge request seen so far under this hash. */
function rulesFor(contentHash: string, rules: string[]): FromBackground {
  const req = judged.find((r) => r.contentHash === contentHash);
  if (!req) return { type: "error", code: "unknown-page", error: "This page has not been judged yet" };
  const out: RuleResults = {};
  for (const rule of rules) {
    const pattern = RULE_PATTERNS[rule] ?? /(?!)/;
    out[rule] = Object.fromEntries(req.sentences.map((s) => [s.id, pattern.test(s.text) ? 0.9 : 0.1]));
  }
  return { type: "ruleJudgment", contentHash, rules: out };
}

/** Mirrors src/content/index.ts; importing the module statically would boot a second orchestrator. */
const MUTATION_MIN_INTERVAL_MS = 5_000;
const MAX_MUTATION_REQUESTS = 12;

const withKey: Settings = { ...DEFAULT_SETTINGS, apiKey: "•" };
let script: Script;
let states: TabState[];
let judged: JudgeRequest[];
let ruled: { contentHash: string; rules: string[] }[];
let listener: Listener | null = null;

function scriptBackground(patch: Partial<Script> = {}) {
  script = { settings: withKey, hostEnabled: true, judge: (req) => ({ type: "judgment", judgment: judgmentFor(req) }), rules: rulesFor, ...patch };
  runtimeSend().mockImplementation(async (...args: unknown[]) => {
    const msg = args[0] as ToBackground;
    switch (msg.type) {
      case "getSettings":
        return { type: "settings", settings: script.settings } satisfies FromBackground;
      case "isHostEnabled":
        return { type: "hostEnabled", enabled: script.hostEnabled } satisfies FromBackground;
      case "judge":
        judged.push(msg.req);
        return script.judge(msg.req);
      case "judgeRules":
        ruled.push({ contentHash: msg.contentHash, rules: msg.rules });
        return script.rules(msg.contentHash, msg.rules);
      case "tabState":
        states.push(msg.state);
        return { type: "ok" } satisfies FromBackground;
      default:
        return { type: "ok" } satisfies FromBackground;
    }
  });
}

async function boot(name = "recipe") {
  const { head, body } = fixture(name);
  document.head.innerHTML = head;
  document.body.innerHTML = body;
  document.documentElement.className = "";
  document.documentElement.lang = "en";
  vi.resetModules();
  await import("../src/content/index.ts");
  listener = mock().__messageListeners.at(-1) as Listener;
}

function tell(msg: ToContent): FromContent {
  let reply: FromContent = { type: "ok" };
  listener?.(msg, {}, (r: FromContent) => (reply = r));
  return reply;
}

async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const last = () => states[states.length - 1];
const spans = (sel = "") => Array.from(document.querySelectorAll<HTMLElement>(`${sel} .osso-s`.trim()));
const ids = (els: Element[]) => new Set(els.map((s) => s.getAttribute("data-osso")));
const on = () => document.documentElement.classList.contains("osso-on");
const untilDone = () => until(() => last()?.status === "done");
const untilStatus = (status: TabState["status"]) => until(() => last()?.status === status);

beforeEach(() => {
  states = [];
  judged = [];
  ruled = [];
  scriptBackground();
});

afterEach(() => {
  vi.useRealTimers();
  history.replaceState({}, "", "/");
  // Off: unwraps, uninstalls interactions, leaves the observer with nothing to do.
  tell({ type: "setEnabledHere", enabled: false });
  const list = mock().__messageListeners;
  if (listener) list.splice(list.indexOf(listener), 1);
  listener = null;
  runtimeSend().mockReset();
  vi.restoreAllMocks();
});

describe("the flow", () => {
  it("segments, judges and fades the recipe, then reports done", async () => {
    await boot();
    await untilDone();
    expect(on()).toBe(true);
    expect(states.map((s) => s.status)).toEqual(["idle", "judging", "done"]);

    expect(judged).toHaveLength(1);
    const req = judged[0]!;
    expect(req.packId).toBe("recipe");
    expect(req.sentences[0]?.id).toBe(0);
    expect(req.sentences).toHaveLength(29);
    expect(req.meta.host).toBe("localhost");
    expect(req.meta.jsonLdTypes).toContain("recipe");
    expect(req.contentHash).toMatch(/^[0-9a-f]{16}$/);

    const faded = ids(spans().filter((s) => s.classList.contains("osso-fade")));
    const all = ids(spans());
    expect(faded.size).toBeGreaterThan(0);
    expect(faded.size).toBeLessThan(all.size);
    // The 750 ml of stock stays in ink; the grandmother fades.
    const stock = spans().find((s) => s.textContent?.includes("750 ml"));
    const nonna = spans().find((s) => s.textContent?.includes("Every summer"));
    expect(stock?.classList.contains("osso-fade")).toBe(false);
    expect(nonna?.classList.contains("osso-fade")).toBe(true);
    for (const sel of ["nav", "header", "footer", "aside", "#comments"]) expect(spans(sel), sel).toHaveLength(0);

    expect(last()).toMatchObject({
      host: "localhost",
      status: "done",
      packId: "recipe",
      pageKind: "recipe",
      total: 29,
      faded: faded.size,
      kept: 29 - faded.size,
      ms: 321,
      inputTokens: 1234,
      cached: false,
      revealed: false,
    });
    expect(last()?.reason).toBeUndefined();
  });

  it("moves the threshold from stored probabilities, reveals, and answers getTabState", async () => {
    await boot();
    await untilDone();
    const before = judged.length;

    const strict = tell({ type: "setThreshold", value: 0.95 });
    expect(strict).toMatchObject({ type: "tabState", state: { status: "done", total: 29, faded: 29, kept: 0 } });
    expect(spans().every((s) => s.classList.contains("osso-fade"))).toBe(true);
    const gentle = tell({ type: "setThreshold", value: 0.05 });
    expect(gentle).toMatchObject({ type: "tabState", state: { faded: 0, kept: 29 } });
    expect(spans().some((s) => s.classList.contains("osso-fade"))).toBe(false);
    expect(judged).toHaveLength(before);

    expect(tell({ type: "reveal", on: true })).toMatchObject({ type: "tabState", state: { revealed: true } });
    expect(document.documentElement.classList.contains("osso-reveal")).toBe(true);
    tell({ type: "reveal", on: false });
    expect(document.documentElement.classList.contains("osso-reveal")).toBe(false);
    expect(last()?.revealed).toBe(false);

    expect(tell({ type: "getTabState" })).toEqual({ type: "tabState", state: last() });
  });

  it("switching the site off puts the page back exactly and reports disabled; on runs the flow again", async () => {
    const { body } = fixture("recipe");
    document.body.innerHTML = body;
    const pristine = document.body.innerHTML;
    await boot();
    await untilDone();
    expect(document.body.innerHTML).not.toBe(pristine);

    expect(tell({ type: "setEnabledHere", enabled: false })).toMatchObject({ type: "tabState", state: { status: "disabled", reason: "Off on this site" } });
    expect(spans()).toHaveLength(0);
    expect(on()).toBe(false);
    expect(document.body.innerHTML).toBe(pristine);

    tell({ type: "setEnabledHere", enabled: true });
    await until(() => judged.length === 2);
    await untilDone();
    expect(on()).toBe(true);
  });

  it("settingsChanged re-renders with the new threshold, tears down when Osso is switched off, and re-checks the host when it comes back", async () => {
    await boot();
    await untilDone();
    tell({ type: "settingsChanged", settings: { ...withKey, threshold: 0.95 } });
    await until(() => last()?.faded === 29);
    expect(spans().every((s) => s.classList.contains("osso-fade"))).toBe(true);

    tell({ type: "settingsChanged", settings: { ...withKey, enabled: false } });
    expect(last()).toMatchObject({ status: "disabled", reason: "Osso is off" });
    expect(spans()).toHaveLength(0);
    expect(on()).toBe(false);

    // Back on, but this host has been denied meanwhile: the guard runs again and says so.
    script.hostEnabled = false;
    tell({ type: "settingsChanged", settings: withKey });
    await until(() => last()?.reason === "Off on this site");
    expect(last()?.status).toBe("disabled");
    expect(spans()).toHaveLength(0);
    expect(judged).toHaveLength(1);
  });
});

describe("the guard", () => {
  it("without a key the page is untouched and the popup is told; a key arriving starts the flow", async () => {
    scriptBackground({ settings: { ...DEFAULT_SETTINGS, apiKey: "" } });
    await boot();
    await untilStatus("no-key");
    expect(spans()).toHaveLength(0);
    expect(judged).toHaveLength(0);

    script.settings = withKey;
    tell({ type: "settingsChanged", settings: withKey });
    await untilDone();
    expect(on()).toBe(true);
  });

  it("a denied host and a switched-off extension both report disabled with a reason", async () => {
    scriptBackground({ hostEnabled: false });
    await boot();
    await untilStatus("disabled");
    expect(last()?.reason).toBe("Off on this site");
    expect(spans()).toHaveLength(0);
    tell({ type: "setEnabledHere", enabled: false });

    states = [];
    scriptBackground({ settings: { ...withKey, enabled: false } });
    await boot();
    await untilStatus("disabled");
    expect(last()?.reason).toBe("Osso is off");
    expect(judged).toHaveLength(0);
  });

  it("skips a page with too little text and an app-like page, unwrapped", async () => {
    await boot("app");
    await untilStatus("skipped");
    expect(last()?.reason).toBe("looks like an app");
    expect(spans()).toHaveLength(0);
    tell({ type: "setEnabledHere", enabled: false });

    states = [];
    document.body.innerHTML = "<main><p>One short page here. It says almost nothing at all. Three sentences are not a page.</p></main>";
    vi.resetModules();
    await import("../src/content/index.ts");
    listener = mock().__messageListeners.at(-1) as Listener;
    await untilStatus("skipped");
    expect(last()?.reason).toBe("too little text");
    expect(spans()).toHaveLength(0);
    expect(document.querySelectorAll("[data-osso-block]")).toHaveLength(0);
    expect(judged).toHaveLength(0);
  });
});

describe("navigation", () => {
  it("a route change that rebuilds the container's contents is judged as a new page, from id 0, under its own title", async () => {
    await boot();
    await untilDone();
    const container = document.querySelector("article.post")!;
    history.pushState({}, "", "/second-post");
    document.title = "A second post on the same site";
    container.innerHTML = Array.from({ length: 10 }, (_, i) => `<p>Paragraph ${i} of the second post states a plain fact about ${i * 3} things.</p>`).join("");
    await until(() => judged.length === 2, MUTATION_DEBOUNCE_MS * 4);
    await untilDone();
    const second = judged[1]!;
    expect(second.sentences[0]?.id).toBe(0);
    expect(second.sentences).toHaveLength(10);
    expect(second.meta.url).toMatch(/\/second-post$/);
    expect(second.meta.title).toBe("A second post on the same site");
    expect(second.contentHash).not.toBe(judged[0]!.contentHash);
    expect(last()).toMatchObject({ status: "done", total: 10 });
  });

  it("popstate alone restarts the flow when the URL no longer matches the judged page", async () => {
    await boot();
    await untilDone();
    history.replaceState({}, "", "/back-here");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await until(() => judged.length === 2, MUTATION_DEBOUNCE_MS * 4);
    expect(judged[1]!.sentences[0]?.id).toBe(0);
    expect(judged[1]!.meta.url).toMatch(/\/back-here$/);
  });
});

describe("errors", () => {
  it("an error reply unwraps the page and reports the human reason", async () => {
    scriptBackground({ judge: () => ({ type: "error", code: "rate-limited", error: "Rate limited" }) });
    await boot();
    await untilStatus("error");
    expect(last()?.reason).toBe("Rate limited by TypeSafe, try again in a minute");
    expect(spans()).toHaveLength(0);
    expect(on()).toBe(false);
    tell({ type: "setEnabledHere", enabled: false });

    states = [];
    scriptBackground({ judge: () => ({ type: "error", code: "invalid-key", error: "Invalid key" }) });
    await boot();
    await untilStatus("error");
    expect(last()?.reason).toBe("API key rejected");

    states = [];
    scriptBackground({ judge: () => ({ type: "error", error: "Something odd" }) });
    await boot();
    await untilStatus("error");
    expect(last()?.reason).toBe("Something odd");
  });

  it("a silent background leaves the page as the author left it", async () => {
    runtimeSend().mockResolvedValue(undefined);
    const { body } = fixture("recipe");
    document.body.innerHTML = body;
    const pristine = document.body.innerHTML;
    await boot();
    await new Promise((r) => setTimeout(r, 50));
    expect(document.body.innerHTML).toBe(pristine);
    expect(on()).toBe(false);
  });

  it("an exception on the way is contained: unwrap, one warning, error state", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // A judgment with no sentence list breaks render; the orchestrator must catch it.
    scriptBackground({ judge: (req) => ({ type: "judgment", judgment: { ...judgmentFor(req), sentences: null as unknown as [] } }) });
    await boot();
    await untilStatus("error");
    expect(last()?.reason).toMatch(/^Osso hit an error on this page/);
    expect(spans()).toHaveLength(0);
    expect(on()).toBe(false);
    expect(warn).toHaveBeenCalledWith("[osso]", expect.anything());
  });
});

describe("mutations", () => {
  it("judges only the blocks the page adds, in a request of their own, and merges them", async () => {
    await boot();
    await untilDone();
    const container = document.querySelector("article.post")!;
    const p = document.createElement("p");
    p.textContent = "Reader question: can I double this for a bigger crowd? Yes, use a 32 cm pan and add 5 minutes.";
    container.appendChild(p);

    await until(() => judged.length === 2, MUTATION_DEBOUNCE_MS * 4);
    const partial = judged[1]!;
    expect(partial.sentences.map((s) => s.id)).toEqual([29, 30]);
    expect(partial.contentHash).not.toBe(judged[0]!.contentHash);
    expect(partial.packId).toBe("recipe");

    await until(() => last()?.total === 31);
    const added = Array.from(p.querySelectorAll<HTMLElement>(".osso-s"));
    expect(ids(added)).toEqual(new Set(["29", "30"]));
    const fadedNew = added.filter((s) => s.classList.contains("osso-fade"));
    expect(ids(fadedNew)).toEqual(new Set(["29"]));
    expect(last()).toMatchObject({ status: "done", total: 31, inputTokens: 1234 * 2 });
  });

  it("holds what arrives inside the interval for one request, and stops asking once the budget is spent", async () => {
    await boot();
    await untilDone();
    const container = document.querySelector("article.post")!;
    const add = (text: string) => {
      const p = document.createElement("p");
      p.textContent = text;
      container.appendChild(p);
    };
    vi.useFakeTimers();
    add("The first addition brings one more sentence to judge.");
    await vi.advanceTimersByTimeAsync(MUTATION_DEBOUNCE_MS + 50);
    expect(judged).toHaveLength(2);

    add("The second addition comes too soon after the first one.");
    await vi.advanceTimersByTimeAsync(MUTATION_DEBOUNCE_MS + 50);
    add("The third addition still waits with the second one.");
    await vi.advanceTimersByTimeAsync(MUTATION_DEBOUNCE_MS + 50);
    expect(judged).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(MUTATION_MIN_INTERVAL_MS);
    expect(judged).toHaveLength(3);
    expect(judged[2]!.sentences.map((s) => s.text)).toEqual([
      "The second addition comes too soon after the first one.",
      "The third addition still waits with the second one.",
    ]);
    await vi.advanceTimersByTimeAsync(50);
    expect(last()).toMatchObject({ status: "done", total: 32 });

    // Past the budget, new text stays in the author's ink and costs nothing.
    for (let i = judged.length - 1; i < MAX_MUTATION_REQUESTS; i++) {
      add(`Addition number ${i} keeps the page growing and growing.`);
      await vi.advanceTimersByTimeAsync(MUTATION_MIN_INTERVAL_MS + MUTATION_DEBOUNCE_MS + 50);
    }
    expect(judged).toHaveLength(1 + MAX_MUTATION_REQUESTS);
    add("One addition past the budget is never sent anywhere.");
    await vi.advanceTimersByTimeAsync(MUTATION_MIN_INTERVAL_MS + MUTATION_DEBOUNCE_MS + 50);
    expect(judged).toHaveLength(1 + MAX_MUTATION_REQUESTS);
    const lastSpan = container.lastElementChild?.querySelector(".osso-s");
    expect(lastSpan).not.toBeNull();
    expect(lastSpan?.classList.contains("osso-fade")).toBe(false);
  });

  it("text the page changes under a wrapper is judged again, as new sentences with new ids", async () => {
    await boot();
    await untilDone();
    const nonna = spans().find((s) => s.textContent?.includes("Every summer"))!;
    const block = nonna.closest("[data-osso-block]")!;
    const oldIds = ids(Array.from(block.querySelectorAll(".osso-s")));
    (nonna.firstChild as Text).data = "Preheat the oven to 220 degrees before anything else. ";
    await until(() => judged.length === 2, MUTATION_DEBOUNCE_MS * 4);
    const partial = judged[1]!;
    expect(partial.sentences.every((s) => s.id >= 29)).toBe(true);
    expect(partial.sentences.some((s) => s.text.startsWith("Preheat the oven to 220 degrees"))).toBe(true);
    await until(() => last()?.total === 29 - oldIds.size + partial.sentences.length);
    const now = ids(Array.from(block.querySelectorAll(".osso-s")));
    for (const id of oldIds) expect(now.has(id)).toBe(false);
    for (const id of oldIds) expect(document.querySelectorAll(`.osso-s[data-osso="${id}"]`)).toHaveLength(0);
  });

  it("our own spans and chip never count as a page mutation", async () => {
    await boot();
    await untilDone();
    const before = judged.length;
    tell({ type: "setThreshold", value: 0.95 });
    const chip = document.createElement("div");
    chip.className = "osso-chip";
    document.body.appendChild(chip);
    await new Promise((r) => setTimeout(r, MUTATION_DEBOUNCE_MS + 200));
    expect(judged).toHaveLength(before);
  });
});

describe("rules", () => {
  const nonna = () => spans().find((s) => s.textContent?.includes("Every summer"))!;
  const faded = (el: Element) => el.classList.contains("osso-fade");
  const withRules = (rules: string[]): Settings => ({ ...withKey, rules });

  it("on load the rules go out beside the judgment; what they catch stays in ink, underlined and counted", async () => {
    scriptBackground({ settings: withRules(["grandmothers"]) });
    await boot();
    await untilDone();
    // Both requests were sent before the judgment came back, under the page's own hash.
    expect(ruled).toEqual([{ contentHash: judged[0]!.contentHash, rules: ["grandmothers"] }]);
    await until(() => last()?.ruleHits.grandmothers !== undefined);
    expect(faded(nonna())).toBe(false);
    expect(nonna().classList.contains("osso-rule-hit")).toBe(true);
    expect(last()?.ruleHits).toEqual({ grandmothers: 1 });
    expect(last()).toMatchObject({ status: "done", total: 29, kept: last()!.total - last()!.faded });
    // The sentence the rule keeps is not among the faded any more.
    expect(last()!.faded).toBe(ids(spans().filter(faded)).size);
    expect(judged).toHaveLength(1);
  });

  it("rulesChanged judges only the new rule, drops a removed one for free, and brings it back for free", async () => {
    await boot();
    await untilDone();
    expect(faded(nonna())).toBe(true);
    const doneReports = states.length;

    tell({ type: "rulesChanged", rules: ["grandmothers"] });
    await until(() => last()?.ruleHits.grandmothers !== undefined);
    expect(ruled).toEqual([{ contentHash: judged[0]!.contentHash, rules: ["grandmothers"] }]);
    expect(faded(nonna())).toBe(false);
    expect(nonna().classList.contains("osso-rule-hit")).toBe(true);
    expect(last()?.ruleHits).toEqual({ grandmothers: 1 });

    tell({ type: "rulesChanged", rules: ["grandmothers", "prices"] });
    await until(() => ruled.length === 2);
    expect(ruled[1]).toEqual({ contentHash: judged[0]!.contentHash, rules: ["prices"] });
    await until(() => last()?.ruleHits.prices !== undefined);
    expect(last()?.ruleHits.prices).toBeGreaterThan(0);

    // Off: no request, back in grey at once.
    tell({ type: "rulesChanged", rules: ["prices"] });
    await until(() => last()?.ruleHits.grandmothers === undefined);
    expect(faded(nonna())).toBe(true);
    expect(ruled).toHaveLength(2);
    // On again: its results were kept, so still no request.
    tell({ type: "rulesChanged", rules: ["prices", "grandmothers"] });
    await until(() => last()?.ruleHits.grandmothers !== undefined);
    expect(faded(nonna())).toBe(false);
    expect(ruled).toHaveLength(2);
    expect(judged).toHaveLength(1);
    // A rule that catches nothing counts zero, and is not asked twice.
    tell({ type: "rulesChanged", rules: ["prices", "grandmothers", "nothing"] });
    await until(() => last()?.ruleHits.nothing !== undefined);
    expect(last()?.ruleHits.nothing).toBe(0);
    expect(ruled).toHaveLength(3);
    tell({ type: "settingsChanged", settings: withRules(["prices", "grandmothers", "nothing"]) });
    await new Promise((r) => setTimeout(r, 50));
    expect(ruled).toHaveLength(3);
    expect(states.length).toBeGreaterThan(doneReports);
  });

  it("a rule added while the page is still being judged waits for the judgment and goes out once", async () => {
    let release: ((r: FromBackground) => void) | null = null;
    scriptBackground({ judge: () => new Promise<FromBackground>((resolve) => (release = resolve)) });
    await boot();
    await untilStatus("judging");
    tell({ type: "rulesChanged", rules: ["grandmothers"] });
    await new Promise((r) => setTimeout(r, 30));
    expect(ruled).toHaveLength(0);
    release!({ type: "judgment", judgment: judgmentFor(judged[0]!) });
    await untilDone();
    await until(() => last()?.ruleHits.grandmothers !== undefined);
    expect(ruled).toEqual([{ contentHash: judged[0]!.contentHash, rules: ["grandmothers"] }]);
    expect(faded(nonna())).toBe(false);
  });

  it("when the worker has forgotten the page, the request is sent again from the cache and the rule judged after", async () => {
    let forgotten = 1;
    scriptBackground({
      rules: (hash, rules) => (forgotten-- > 0 ? { type: "error", code: "unknown-page", error: "forgotten" } : rulesFor(hash, rules)),
    });
    await boot();
    await untilDone();
    tell({ type: "rulesChanged", rules: ["grandmothers"] });
    await until(() => last()?.ruleHits.grandmothers !== undefined);
    expect(ruled).toHaveLength(2);
    expect(judged).toHaveLength(2);
    expect(judged[1]).toEqual(judged[0]);
    expect(faded(nonna())).toBe(false);
  });

  it("a failed rule judgment leaves the rule unjudged, the page as it was, and asks again on the next change", async () => {
    let failures = 1;
    scriptBackground({ rules: (hash, rules) => (failures-- > 0 ? { type: "error", code: "server", error: "down" } : rulesFor(hash, rules)) });
    await boot();
    await untilDone();
    tell({ type: "rulesChanged", rules: ["grandmothers"] });
    await until(() => ruled.length === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(last()?.ruleHits).toEqual({});
    expect(faded(nonna())).toBe(true);
    tell({ type: "rulesChanged", rules: ["grandmothers", "prices"] });
    await until(() => last()?.ruleHits.grandmothers !== undefined);
    expect(ruled[1]).toEqual({ contentHash: judged[0]!.contentHash, rules: ["grandmothers", "prices"] });
    expect(faded(nonna())).toBe(false);
  });

  it("sentences a mutation adds are asked about the rules in force too", async () => {
    scriptBackground({ settings: withRules(["grandmothers"]) });
    await boot();
    await untilDone();
    await until(() => last()?.ruleHits.grandmothers === 1);
    const container = document.querySelector("article.post")!;
    const p = document.createElement("p");
    p.textContent = "My nonna would have laughed at the pearl couscous. She used what she had and never apologised for it.";
    container.appendChild(p);
    await until(() => judged.length === 2, MUTATION_DEBOUNCE_MS * 4);
    await until(() => ruled.length === 2);
    expect(ruled[1]).toEqual({ contentHash: judged[1]!.contentHash, rules: ["grandmothers"] });
    await until(() => last()?.ruleHits.grandmothers === 2);
    const added = Array.from(p.querySelectorAll<HTMLElement>(".osso-s"));
    const laughed = added.find((s) => s.textContent?.includes("laughed"))!;
    expect(faded(laughed)).toBe(false);
    expect(laughed.classList.contains("osso-rule-hit")).toBe(true);
  });

  it("switching the site off drops the rule state with everything else", async () => {
    scriptBackground({ settings: withRules(["grandmothers"]) });
    await boot();
    await untilDone();
    await until(() => last()?.ruleHits.grandmothers === 1);
    tell({ type: "setEnabledHere", enabled: false });
    expect(last()?.ruleHits).toEqual({});
    expect(document.querySelectorAll(".osso-rule-hit")).toHaveLength(0);
  });
});
