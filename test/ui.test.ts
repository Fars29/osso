/**
 * The UI against the chrome mock: messaging degrades to null instead of throwing, and the popup
 * renders each state from a scripted background without ever leaving the hero blank.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { FromBackground, Settings, TabState, ToBackground } from "../src/shared/types.ts";
import { DEFAULT_SETTINGS } from "../src/shared/constants.ts";
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
