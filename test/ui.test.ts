/**
 * The UI against the chrome mock: messaging degrades to null instead of throwing, and the popup
 * renders each state from a scripted background without ever leaving the hero blank.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { FromBackground, Settings, TabState, ToBackground } from "../src/shared/types.ts";
import { DEFAULT_SETTINGS, MAX_RULES } from "../src/shared/constants.ts";
import { getSettings, sendToBackground, sendToTab } from "../src/ui/messaging.ts";

type ChromeMock = ReturnType<typeof import("./setup.ts").installChromeMock>;
type AnyMock = Mock<(...args: unknown[]) => Promise<unknown>>;
const mock = () => (globalThis as unknown as { chrome: ChromeMock }).chrome;
// setup.ts types the stubs by their no-arg defaults; the tests script replies by message.
const runtimeSend = () => mock().runtime.sendMessage as unknown as AnyMock;
const tabsSend = () => mock().tabs.sendMessage as unknown as AnyMock;
const tabsQuery = () => mock().tabs.query as unknown as AnyMock;

const html = readFileSync(resolve(__dirname, "../src/ui/popup/index.html"), "utf8");
const popupBody = html.slice(html.indexOf("<body>") + 6, html.indexOf("<script"));
const optionsHtml = readFileSync(resolve(__dirname, "../src/ui/options/index.html"), "utf8");
const optionsBody = optionsHtml.slice(optionsHtml.indexOf("<body>") + 6, optionsHtml.indexOf("<script"));

const done: TabState = {
  host: "example.com",
  status: "done",
  packId: "recipe",
  pageKind: "recipe",
  total: 41,
  kept: 14,
  faded: 27,
  ms: 912,
  inputTokens: 28_000,
  cached: false,
  revealed: false,
  ruleHits: {},
};

function scriptBackground(settings: Settings, state: TabState | null) {
  runtimeSend().mockImplementation(async (...args: unknown[]) => {
    const msg = args[0] as ToBackground;
    const reply: FromBackground | undefined =
      msg.type === "getSettings"
        ? { type: "settings", settings }
        : msg.type === "getTabState"
          ? { type: "tabState", state }
          : msg.type === "getStats"
            ? { type: "stats", stats: { pagesJudged: 0, sentencesJudged: 0, inputTokens: 0, ms: 0, cacheHits: 0 } }
            : { type: "ok" };
    return reply;
  });
}

async function openPopup() {
  document.body.innerHTML = popupBody;
  vi.resetModules();
  await import("../src/ui/popup/index.ts");
  // main() awaits three round trips; let the microtasks drain.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

async function openOptions() {
  document.body.innerHTML = optionsBody;
  vi.resetModules();
  await import("../src/ui/options/index.ts");
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

const text = (id: string) => document.getElementById(id)?.textContent?.trim();
/** The chips as the reader sees them: "prices · 3", one per rule, in order. */
const chipsShown = () =>
  Array.from(document.querySelectorAll("#rule-list .rule")).map((li) =>
    `${li.querySelector(".rule-text")?.textContent ?? ""} ${li.querySelector<HTMLElement>(".rule-count")?.hidden ? "" : li.querySelector(".rule-count")?.textContent ?? ""}`.trim(),
  );
const keydown = (el: HTMLElement, key: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
const patches = () => runtimeSend().mock.calls.map(([m]) => m as ToBackground).filter((m): m is Extract<ToBackground, { type: "setSettings" }> => m.type === "setSettings");
const visible = (id: string) => !document.getElementById(id)?.hidden;
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  runtimeSend().mockReset();
  tabsSend().mockReset();
  tabsQuery().mockResolvedValue([{ id: 1, url: "https://example.com/", active: true }]);
  // Content script absent unless a test says otherwise.
  tabsSend().mockRejectedValue(new Error("Could not establish connection. Receiving end does not exist."));
  (globalThis as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false });
  (globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = (cb: (t: number) => void) => {
    cb(performance.now() + 1000);
    return 1;
  };
  (globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = () => undefined;
});

describe("messaging", () => {
  it("sendToBackground rejects when the worker gives no reply", async () => {
    runtimeSend().mockResolvedValue(undefined);
    await expect(sendToBackground({ type: "getStats" })).rejects.toThrow(/did not answer/);
    expect(await getSettings()).toBeNull();
  });

  it("sendToTab resolves null when the tab has no content script", async () => {
    expect(await sendToTab(1, { type: "getTabState" })).toBeNull();
  });

  it("sendToTab passes other errors through", async () => {
    tabsSend().mockRejectedValue(new Error("boom"));
    await expect(sendToTab(1, { type: "reveal", on: true })).rejects.toThrow("boom");
  });
});

describe("popup", () => {
  it("shows the kept count, the chip and the cost line when judged", async () => {
    scriptBackground({ ...DEFAULT_SETTINGS, apiKey: "ts-x" }, done);
    await openPopup();
    expect(document.getElementById("popup")?.dataset.state).toBe("done");
    expect(text("kept")).toBe("14");
    expect(text("total")).toBe("/ 41");
    expect(text("caption")).toBe("sentences kept");
    expect(text("status")).toBe("judged in 0.9 s · ≈ $0.0012");
    expect(text("chip")).toBe("Recipe");
    expect(visible("chip")).toBe(true);
  });

  it("says 'from cache' and singular 'sentence' when so", async () => {
    scriptBackground({ ...DEFAULT_SETTINGS, apiKey: "ts-x" }, { ...done, kept: 1, cached: true });
    await openPopup();
    expect(text("caption")).toBe("sentence kept");
    expect(text("status")).toBe("from cache");
  });

  it("asks for a key when there is none", async () => {
    scriptBackground(DEFAULT_SETTINGS, null);
    await openPopup();
    expect(document.getElementById("popup")?.dataset.state).toBe("no-key");
    expect(text("note-title")).toBe("Osso needs your TypeSafe key.");
    expect(text("note-action")).toBe("Add key");
  });

  it("explains a skipped page with its reason", async () => {
    scriptBackground({ ...DEFAULT_SETTINGS, apiKey: "ts-x" }, { ...done, status: "skipped", reason: "fewer than 8 sentences" });
    await openPopup();
    expect(text("note-title")).toBe("Nothing to strip here");
    expect(text("note-sub")).toBe("fewer than 8 sentences");
  });

  it("cannot run on a chrome:// tab and hides the controls", async () => {
    scriptBackground({ ...DEFAULT_SETTINGS, apiKey: "ts-x" }, null);
    tabsQuery().mockResolvedValue([{ id: 2, url: "chrome://extensions", active: true }]);
    await openPopup();
    expect(text("note-title")).toBe("Osso can't run here");
    expect(visible("controls")).toBe(false);
  });

  it("renders a neutral state when the background never answers", async () => {
    runtimeSend().mockResolvedValue(undefined);
    await openPopup();
    expect(text("note-title")).toBe("Osso is waking up");
    expect(document.getElementById("popup")?.dataset.state).toBe("cannot");
  });

  it("keeps the slider and the reveal inert until a page is judged; the site switch stays live", async () => {
    scriptBackground(DEFAULT_SETTINGS, null);
    await openPopup();
    expect(input("threshold").disabled).toBe(true);
    expect(input("reveal").disabled).toBe(true);
    expect(visible("hint")).toBe(false);
    expect(input("site").disabled).toBe(false);

    scriptBackground({ ...DEFAULT_SETTINGS, apiKey: "ts-x" }, done);
    await openPopup();
    expect(input("threshold").disabled).toBe(false);
    expect(input("reveal").disabled).toBe(false);
    expect(visible("hint")).toBe(true);
  });

  it("shows the reveal key as a keycap", async () => {
    scriptBackground({ ...DEFAULT_SETTINGS, apiKey: "ts-x", revealKey: "Alt" }, done);
    await openPopup();
    expect(document.querySelector("#hint kbd")?.textContent).toBe("Alt");
    expect(text("hint")).toBe("Hold Alt to peek");
  });

  it("says a skip reason the way a person would", async () => {
    scriptBackground({ ...DEFAULT_SETTINGS, apiKey: "ts-x" }, { ...done, status: "skipped", reason: "too little text" });
    await openPopup();
    expect(text("note-sub")).toBe("Fewer than 8 sentences of body text.");
  });

  it("shows the total, pulsing, while judging", async () => {
    scriptBackground({ ...DEFAULT_SETTINGS, apiKey: "ts-x" }, { ...done, status: "judging", kept: 0, faded: 0 });
    await openPopup();
    expect(text("kept")).toBe("41");
    expect(text("total")).toBe("");
    expect(text("caption")).toBe("sentences, judging…");
    expect(document.getElementById("kept")?.classList.contains("pulse")).toBe(true);
    window.dispatchEvent(new Event("pagehide"));
  });

  it("disables the site switch and offers to turn Osso on when it is off everywhere", async () => {
    scriptBackground({ ...DEFAULT_SETTINGS, apiKey: "ts-x", enabled: false }, { ...done, status: "disabled", reason: "Osso is off" });
    await openPopup();
    expect(text("note-title")).toBe("Osso is off");
    expect(text("note-action")).toBe("Turn on");
    expect(input("site").disabled).toBe(true);
    tabsSend().mockResolvedValue({ type: "tabState", state: { ...done, status: "judging" } });
    (document.getElementById("note-action") as HTMLButtonElement).click();
    await settle();
    expect(runtimeSend()).toHaveBeenCalledWith({ type: "setSettings", patch: { enabled: true } });
    expect(tabsSend()).toHaveBeenCalledWith(1, { type: "setEnabledHere", enabled: true });
    window.dispatchEvent(new Event("pagehide"));
  });

  it("sends setThreshold to the tab on slider input and setSettings on change", async () => {
    scriptBackground({ ...DEFAULT_SETTINGS, apiKey: "ts-x" }, done);
    tabsSend().mockImplementation(async (...args: unknown[]) => {
      const msg = args[1] as { type: string; value?: number };
      if (msg.type === "getTabState") return { type: "tabState", state: done };
      if (msg.type === "setThreshold") return { type: "tabState", state: { ...done, kept: 9, faded: 32 } };
      return { type: "ok" };
    });
    await openPopup();
    const slider = document.getElementById("threshold") as HTMLInputElement;
    slider.value = "0.7";
    slider.dispatchEvent(new Event("input"));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(tabsSend()).toHaveBeenCalledWith(1, { type: "setThreshold", value: 0.7 });
    expect(text("kept")).toBe("9");
    slider.dispatchEvent(new Event("change"));
    expect(runtimeSend()).toHaveBeenCalledWith({ type: "setSettings", patch: { threshold: 0.7 } });
  });
});

describe("options", () => {
  it("tells a first-run user the one thing to do, then what happens once the key is saved", async () => {
    scriptBackground(DEFAULT_SETTINGS, null);
    await openOptions();
    expect(visible("notice")).toBe(true);
    expect(text("notice")).toContain("paste a TypeSafe key");
    expect(document.activeElement?.id).toBe("key");
    expect(text("key-result")).toBe("");

    input("key").value = "ts-new";
    (document.getElementById("key-save") as HTMLButtonElement).click();
    await settle();
    expect(runtimeSend()).toHaveBeenCalledWith({ type: "setSettings", patch: { apiKey: "ts-new" } });
    expect(visible("notice")).toBe(false);
    expect(text("key-result")).toMatch(/^Saved\. Open any article/);
    expect(document.getElementById("key-result")?.className).toBe("key-result ok");
  });

  it("re-reads settings only when the settings record changes, not on every cache or stats write", async () => {
    const added = vi.spyOn(chrome.storage.onChanged, "addListener");
    scriptBackground({ ...DEFAULT_SETTINGS, apiKey: "ts-x" }, null);
    await openOptions();
    const listener = added.mock.calls.at(-1)![0] as (changes: Record<string, unknown>, area: string) => void;
    expect(visible("notice")).toBe(false);
    const getSettingsCalls = () => runtimeSend().mock.calls.filter(([m]) => (m as { type: string }).type === "getSettings").length;
    const before = getSettingsCalls();
    listener({ "osso:cache:abc": { newValue: {} }, "osso:stats": { newValue: {} } }, "local");
    listener({ "osso:settings": { newValue: {} } }, "sync");
    await settle();
    expect(getSettingsCalls()).toBe(before);
    listener({ "osso:settings": { newValue: { ...DEFAULT_SETTINGS, apiKey: "ts-x", threshold: 0.7 } } }, "local");
    await settle();
    expect(getSettingsCalls()).toBe(before + 1);
    added.mockRestore();
  });
});

describe("popup rules", () => {
  const judged = { ...done, ruleHits: { prices: 3, deadlines: 0 } };

  it("shows the field and the chips with their counts on a judged page, and focuses the field", async () => {
    scriptBackground({ ...DEFAULT_SETTINGS, apiKey: "ts-x", rules: ["prices", "deadlines", "allergens"] }, judged);
    await openPopup();
    expect(visible("rules")).toBe(true);
    expect(chipsShown()).toEqual(["prices · 3", "deadlines · 0", "allergens · …"]);
    const counts = Array.from(document.querySelectorAll<HTMLElement>("#rule-list .rule-count"));
    expect(counts.map((c) => c.classList.contains("muted"))).toEqual([false, true, true]);
    expect(document.activeElement?.id).toBe("rule");
    expect(input("rule").placeholder).toBe("prices");
    expect(input("rule").maxLength).toBe(80);
    expect(input("rule").disabled).toBe(false);
    // A rule with no count yet keeps the popup asking the page.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    window.dispatchEvent(new Event("pagehide"));
  });

  it("Enter adds a rule: the chip pops at once with an ellipsis, the list is saved, × removes it and saves again", async () => {
    scriptBackground({ ...DEFAULT_SETTINGS, apiKey: "ts-x", rules: ["prices"] }, { ...done, ruleHits: { prices: 2 } });
    await openPopup();
    const field = input("rule");
    field.value = "  Names of  people ";
    keydown(field, "Enter");
    await settle();
    expect(field.value).toBe("");
    expect(chipsShown()).toEqual(["prices · 2", "Names of people · …"]);
    expect(document.querySelector('#rule-list .rule[data-rule="Names of people"]')?.classList.contains("pop")).toBe(true);
    expect(patches().at(-1)).toEqual({ type: "setSettings", patch: { rules: ["prices", "Names of people"] } });

    // A duplicate, however spelled, adds nothing and points at the chip that is already there.
    field.value = "PRICES";
    keydown(field, "Enter");
    await settle();
    expect(chipsShown()).toEqual(["prices · 2", "Names of people · …"]);
    expect(document.querySelector('#rule-list .rule[data-rule="prices"]')?.classList.contains("flash")).toBe(true);
    expect(patches()).toHaveLength(1);

    // Escape clears an entry and keeps the popup open; on an empty field it is left to the browser.
    field.value = "half a th";
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    field.dispatchEvent(escape);
    expect(field.value).toBe("");
    expect(escape.defaultPrevented).toBe(true);
    const escapeEmpty = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    field.dispatchEvent(escapeEmpty);
    expect(escapeEmpty.defaultPrevented).toBe(false);

    (document.querySelector('#rule-list .rule[data-rule="prices"] .rule-x') as HTMLButtonElement).click();
    await settle();
    expect(chipsShown()).toEqual(["Names of people · …"]);
    expect(patches().at(-1)).toEqual({ type: "setSettings", patch: { rules: ["Names of people"] } });
    window.dispatchEvent(new Event("pagehide"));
  });

  it("disables the field with the hint once the list is full", async () => {
    const full = Array.from({ length: MAX_RULES }, (_, i) => `rule ${i}`);
    scriptBackground({ ...DEFAULT_SETTINGS, apiKey: "ts-x", rules: full }, done);
    await openPopup();
    expect(input("rule").disabled).toBe(true);
    expect(input("rule").placeholder).toBe(`${MAX_RULES} is plenty`);
    expect(chipsShown()).toHaveLength(MAX_RULES);
    expect(document.activeElement?.id).not.toBe("rule");
    (document.querySelector("#rule-list .rule .rule-x") as HTMLButtonElement).click();
    await settle();
    expect(input("rule").disabled).toBe(false);
    expect(input("rule").placeholder).toBe("prices");
    window.dispatchEvent(new Event("pagehide"));
  });

  it("keeps the field without counts where there is nothing to count, hides it without a key, and does not steal focus before the page is judged", async () => {
    scriptBackground({ ...DEFAULT_SETTINGS, apiKey: "ts-x", rules: ["prices"] }, { ...done, status: "skipped", reason: "too little text" });
    await openPopup();
    expect(visible("rules")).toBe(true);
    expect(chipsShown()).toEqual(["prices"]);
    expect(document.activeElement?.id).not.toBe("rule");

    scriptBackground({ ...DEFAULT_SETTINGS, rules: ["prices"] }, null);
    await openPopup();
    expect(visible("rules")).toBe(false);

    scriptBackground({ ...DEFAULT_SETTINGS, apiKey: "ts-x", rules: ["prices"] }, { ...done, status: "judging" });
    await openPopup();
    expect(visible("rules")).toBe(true);
    expect(chipsShown()).toEqual(["prices · …"]);
    expect(document.activeElement?.id).not.toBe("rule");
    window.dispatchEvent(new Event("pagehide"));
  });

  it("puts the list back as it really is when nobody saved it", async () => {
    scriptBackground({ ...DEFAULT_SETTINGS, apiKey: "ts-x", rules: [] }, done);
    await openPopup();
    runtimeSend().mockImplementation(async (...args: unknown[]) => {
      const msg = args[0] as ToBackground;
      if (msg.type === "setSettings") return { type: "error", error: "storage refused" } satisfies FromBackground;
      if (msg.type === "getSettings") return { type: "settings", settings: { ...DEFAULT_SETTINGS, apiKey: "ts-x", rules: [] } } satisfies FromBackground;
      return { type: "tabState", state: done } satisfies FromBackground;
    });
    input("rule").value = "prices";
    keydown(input("rule"), "Enter");
    await settle();
    expect(chipsShown()).toEqual([]);
    window.dispatchEvent(new Event("pagehide"));
  });
});

describe("options rules", () => {
  it("lists the rules under Behaviour, adds on Enter and removes with ×, saving each time", async () => {
    scriptBackground({ ...DEFAULT_SETTINGS, apiKey: "ts-x", rules: ["prices"] }, null);
    await openOptions();
    expect(document.querySelector("#s-behaviour #rule")).not.toBeNull();
    expect(chipsShown()).toEqual(["prices"]);
    input("rule").value = "deadlines";
    keydown(input("rule"), "Enter");
    await settle();
    expect(chipsShown()).toEqual(["prices", "deadlines"]);
    expect(patches().at(-1)).toEqual({ type: "setSettings", patch: { rules: ["prices", "deadlines"] } });
    expect(document.getElementById("behaviour-saved")?.classList.contains("on")).toBe(true);
    (document.querySelector('#rule-list .rule[data-rule="prices"] .rule-x') as HTMLButtonElement).click();
    await settle();
    expect(chipsShown()).toEqual(["deadlines"]);
    expect(patches().at(-1)).toEqual({ type: "setSettings", patch: { rules: ["deadlines"] } });
    window.dispatchEvent(new Event("pagehide"));
  });
});
