/**
 * Render on a jsdom page that segment could have produced: six sentences, one crossing inline markup
 * (two spans, same id), one holding a link, one whose chunk failed. jsdom has no layout and reports
 * empty backgrounds, so backgrounds are stubbed where a test needs them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageJudgment, SentenceJudgment } from "../src/shared/types.ts";
import {
  applyJudgment,
  clearRender,
  counts,
  effectiveBackground,
  installInteractions,
  pickGrey,
  setReveal,
  setThreshold,
} from "../src/content/render.ts";

const PAGE = `
<main>
  <p data-osso-block=""><span class="osso-s" data-osso="0">The council voted 24 to 9 on Tuesday.</span>
  <span class="osso-s" data-osso="1">Please <a href="#tag">tag me</a> on Instagram!</span></p>
  <p data-osso-block=""><span class="osso-s" data-osso="2">Construction begins in March 2027.</span>
  <span class="osso-s" data-osso="3">There is something </span><em><span class="osso-s" data-osso="3">magical</span></em><span class="osso-s" data-osso="3"> about one pot.</span></p>
  <div id="dark" data-osso-block=""><span class="osso-s" data-osso="4">Fares will be €1.70 per ride.</span>
  <span class="osso-s" data-osso="5">Thank you for your patience.</span></div>
</main>`;

const S = (id: number, keep: number, kind: SentenceJudgment["kind"]): SentenceJudgment => ({ id, keep, kind, kindConfidence: 0.9 });

function judgment(overrides: Partial<PageJudgment> = {}): PageJudgment {
  return {
    packId: "article",
    pageKind: "article",
    pageKindConfidence: 0.9,
    sentences: [
      S(0, 0.9, "fact"),
      S(1, 0.1, "promotion_or_appeal"),
      S(2, 0.6, "figure_or_date"),
      S(3, 0.2, "anecdote_or_story"),
      S(4, 0.95, "figure_or_date"),
    ],
    inputTokens: 1000,
    ms: 400,
    cached: false,
    failedIds: [5],
    ...overrides,
  };
}

const spans = (id: number) => Array.from(document.querySelectorAll<HTMLElement>(`.osso-s[data-osso="${id}"]`));
const fadedIds = () =>
  Array.from(new Set(Array.from(document.querySelectorAll(".osso-fade")).map((s) => Number(s.getAttribute("data-osso"))))).sort();
const root = () => document.documentElement;

function key(type: "keydown" | "keyup", k: string, init: KeyboardEventInit = {}, target: EventTarget = document) {
  target.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true, ...init }));
}
function mouse(type: string, target: EventTarget, init: MouseEventInit = {}) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
}

beforeEach(() => {
  document.body.innerHTML = PAGE;
  root().className = "";
});

afterEach(() => {
  clearRender(document);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("applyJudgment", () => {
  it("fades below the threshold, leaves kept sentences untouched and failed ones alone", () => {
    const c = applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    expect(c).toEqual({ total: 5, kept: 3, faded: 2 });
    expect(fadedIds()).toEqual([1, 3]);
    expect(root().classList.contains("osso-on")).toBe(true);
    // Every span of a multi-span sentence fades together.
    expect(spans(3)).toHaveLength(3);
    for (const s of spans(3)) expect(s.classList.contains("osso-fade")).toBe(true);
    // Kept: the author's ink, no class beyond osso-s, no inline style.
    for (const id of [0, 2, 4]) for (const s of spans(id)) {
      expect(s.className).toBe("osso-s");
      expect(s.getAttribute("style")).toBeNull();
    }
    // Failed chunk: untouched and not counted.
    for (const s of spans(5)) expect(s.className).toBe("osso-s");
    expect(counts(document)).toEqual(c);
  });

  it("counts at several thresholds", () => {
    expect(applyJudgment(document, judgment(), { threshold: 0.2, animations: true })).toEqual({ total: 5, kept: 4, faded: 1 });
    expect(fadedIds()).toEqual([1]);
    expect(applyJudgment(document, judgment(), { threshold: 0.95, animations: true })).toEqual({ total: 5, kept: 1, faded: 4 });
    expect(fadedIds()).toEqual([0, 1, 2, 3]);
    expect(applyJudgment(document, judgment(), { threshold: 0.5, animations: true })).toEqual({ total: 5, kept: 3, faded: 2 });
    expect(fadedIds()).toEqual([1, 3]);
  });

  it("staggers the first fade down the page and drops the delays once settled", () => {
    vi.useFakeTimers();
    applyJudgment(document, judgment(), { threshold: 0.95, animations: true });
    // Faded in document order: 0, 1, 2, 3 → 0, 10, 20, 30 ms; all spans of a sentence share its delay.
    expect(spans(0)[0]!.style.getPropertyValue("--osso-delay")).toBe("0ms");
    expect(spans(1)[0]!.style.getPropertyValue("--osso-delay")).toBe("10ms");
    expect(spans(2)[0]!.style.getPropertyValue("--osso-delay")).toBe("20ms");
    for (const s of spans(3)) expect(s.style.getPropertyValue("--osso-delay")).toBe("30ms");
    expect(spans(4)[0]!.style.getPropertyValue("--osso-delay")).toBe("");
    expect(root().classList.contains("osso-settled")).toBe(false);
    vi.advanceTimersByTime(30 + 550 + 50);
    expect(root().classList.contains("osso-settled")).toBe(true);
    for (const id of [0, 1, 2, 3]) for (const s of spans(id)) expect(s.style.getPropertyValue("--osso-delay")).toBe("");
  });

  it("caps the wave at 500 ms", () => {
    document.body.innerHTML = `<p data-osso-block="">${Array.from({ length: 60 }, (_, i) => `<span class="osso-s" data-osso="${i}">s${i}.</span>`).join(" ")}</p>`;
    const sentences = Array.from({ length: 60 }, (_, i) => S(i, 0.1, "filler_or_transition"));
    applyJudgment(document, judgment({ sentences, failedIds: [] }), { threshold: 0.5, animations: true });
    expect(spans(49)[0]!.style.getPropertyValue("--osso-delay")).toBe("490ms");
    expect(spans(50)[0]!.style.getPropertyValue("--osso-delay")).toBe("500ms");
    expect(spans(59)[0]!.style.getPropertyValue("--osso-delay")).toBe("500ms");
  });

  it("uses no delay with animations off, and marks the root still", () => {
    applyJudgment(document, judgment(), { threshold: 0.5, animations: false });
    for (const s of document.querySelectorAll<HTMLElement>(".osso-fade")) expect(s.style.getPropertyValue("--osso-delay")).toBe("");
    expect(root().classList.contains("osso-still")).toBe(true);
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    expect(root().classList.contains("osso-still")).toBe(false);
  });

  it("uses no delay under prefers-reduced-motion", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q } as MediaQueryList));
    try {
      applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
      for (const s of document.querySelectorAll<HTMLElement>(".osso-fade")) expect(s.style.getPropertyValue("--osso-delay")).toBe("");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("merges a later judgment and clears a formerly failed id once judged", () => {
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    const c = applyJudgment(document, judgment({ sentences: [S(5, 0.05, "filler_or_transition")], failedIds: [] }), { threshold: 0.5, animations: true });
    expect(c).toEqual({ total: 6, kept: 3, faded: 3 });
    expect(fadedIds()).toEqual([1, 3, 5]);
  });
});

describe("setThreshold", () => {
  it("re-renders from the stored judgment with no delay and marks the change instant", () => {
    vi.useFakeTimers();
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    vi.advanceTimersByTime(2000);
    expect(setThreshold(document, 0.95)).toEqual({ total: 5, kept: 1, faded: 4 });
    expect(fadedIds()).toEqual([0, 1, 2, 3]);
    expect(spans(0)[0]!.style.getPropertyValue("--osso-delay")).toBe("");
    expect(spans(2)[0]!.style.getPropertyValue("--osso-delay")).toBe("");
    expect(root().classList.contains("osso-instant")).toBe(true);
    vi.advanceTimersByTime(300);
    expect(root().classList.contains("osso-instant")).toBe(false);
    expect(setThreshold(document, 0.2)).toEqual({ total: 5, kept: 4, faded: 1 });
    expect(fadedIds()).toEqual([1]);
    expect(counts(document)).toEqual({ total: 5, kept: 4, faded: 1 });
  });
});

describe("setReveal", () => {
  it("toggles the root class", () => {
    setReveal(document, true);
    expect(root().classList.contains("osso-reveal")).toBe(true);
    setReveal(document, false);
    expect(root().classList.contains("osso-reveal")).toBe(false);
  });
});

describe("pin", () => {
  it("toggles osso-pin on every span of the sentence and counts pinned as kept", () => {
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    const onPinChange = vi.fn();
    const off = installInteractions(document, { revealKey: "Shift", holdMs: 120, onPinChange });
    mouse("click", spans(3)[1]!);
    for (const s of spans(3)) expect(s.classList.contains("osso-pin")).toBe(true);
    expect(onPinChange).toHaveBeenLastCalledWith({ total: 5, kept: 4, faded: 1 });
    expect(counts(document)).toEqual({ total: 5, kept: 4, faded: 1 });
    mouse("click", spans(3)[2]!);
    for (const s of spans(3)) expect(s.classList.contains("osso-pin")).toBe(false);
    expect(onPinChange).toHaveBeenLastCalledWith({ total: 5, kept: 3, faded: 2 });
    off();
  });

  it("survives a threshold re-render", () => {
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    const off = installInteractions(document, { revealKey: "Shift", holdMs: 120 });
    mouse("click", spans(1)[0]!);
    expect(setThreshold(document, 0.95)).toEqual({ total: 5, kept: 2, faded: 3 });
    expect(spans(1)[0]!.classList.contains("osso-pin")).toBe(true);
    off();
  });

  it("ignores clicks on links, kept sentences and non-collapsed selections", () => {
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    const onPinChange = vi.fn();
    const off = installInteractions(document, { revealKey: "Shift", holdMs: 120, onPinChange });
    mouse("click", document.querySelector("a")!);
    mouse("click", spans(0)[0]!);
    expect(document.querySelectorAll(".osso-pin")).toHaveLength(0);
    vi.spyOn(document, "getSelection").mockReturnValue({ isCollapsed: false } as Selection);
    mouse("click", spans(3)[0]!);
    expect(document.querySelectorAll(".osso-pin")).toHaveLength(0);
    expect(onPinChange).not.toHaveBeenCalled();
    off();
  });
});

describe("reveal key", () => {
  it("reveals only after a real hold, and un-reveals on keyup or blur", () => {
    vi.useFakeTimers();
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    const onRevealChange = vi.fn();
    const off = installInteractions(document, { revealKey: "Shift", holdMs: 120, onRevealChange });

    // A tap for capitalisation.
    key("keydown", "Shift");
    vi.advanceTimersByTime(50);
    key("keyup", "Shift");
    vi.advanceTimersByTime(200);
    expect(root().classList.contains("osso-reveal")).toBe(false);
    expect(onRevealChange).not.toHaveBeenCalled();

    // A hold.
    key("keydown", "Shift");
    vi.advanceTimersByTime(150);
    expect(root().classList.contains("osso-reveal")).toBe(true);
    expect(onRevealChange).toHaveBeenLastCalledWith(true);
    key("keyup", "Shift");
    expect(root().classList.contains("osso-reveal")).toBe(false);
    expect(onRevealChange).toHaveBeenLastCalledWith(false);

    // Losing the window mid-hold.
    key("keydown", "Shift");
    vi.advanceTimersByTime(150);
    expect(root().classList.contains("osso-reveal")).toBe(true);
    window.dispatchEvent(new Event("blur"));
    expect(root().classList.contains("osso-reveal")).toBe(false);
    expect(onRevealChange).toHaveBeenCalledTimes(4);
    off();
  });

  it("ignores key repeats, other keys and editable targets", () => {
    vi.useFakeTimers();
    document.body.insertAdjacentHTML("beforeend", '<input id="in"><div id="ed" contenteditable="true">x</div>');
    const off = installInteractions(document, { revealKey: "Shift", holdMs: 120 });
    key("keydown", "Shift", { repeat: true });
    key("keydown", "Alt");
    key("keydown", "Shift", {}, document.getElementById("in")!);
    key("keydown", "Shift", {}, document.getElementById("ed")!);
    vi.advanceTimersByTime(500);
    expect(root().classList.contains("osso-reveal")).toBe(false);
    off();
    // Uninstalled: a hold does nothing.
    key("keydown", "Shift");
    vi.advanceTimersByTime(500);
    expect(root().classList.contains("osso-reveal")).toBe(false);
  });
});

describe("chip", () => {
  it("appears after 250 ms of hover with kind and p(keep), and hides on mouseout", () => {
    vi.useFakeTimers();
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    const off = installInteractions(document, { revealKey: "Shift", holdMs: 120 });
    mouse("mouseover", spans(3)[0]!);
    vi.advanceTimersByTime(249);
    expect(document.querySelector(".osso-chip.osso-chip-show")).toBeNull();
    vi.advanceTimersByTime(1);
    const chip = document.querySelector<HTMLElement>(".osso-chip")!;
    expect(chip.classList.contains("osso-chip-show")).toBe(true);
    expect(chip.textContent).toBe("story · 0.20");
    expect(chip.getAttribute("aria-hidden")).toBe("true");
    expect(chip.style.position || "").toBe("");
    // Moving to another span of the same sentence keeps it; leaving hides it.
    mouse("mouseout", spans(3)[0]!, { relatedTarget: spans(3)[1]! });
    mouse("mouseover", spans(3)[1]!);
    expect(chip.classList.contains("osso-chip-show")).toBe(true);
    mouse("mouseout", spans(3)[1]!, { relatedTarget: document.body });
    expect(chip.classList.contains("osso-chip-show")).toBe(false);
    // One chip, reused, for every sentence.
    mouse("mouseover", spans(4)[0]!);
    vi.advanceTimersByTime(250);
    expect(document.querySelectorAll(".osso-chip")).toHaveLength(1);
    expect(chip.textContent).toBe("figure · 0.95");
    // Scroll and keys hide it.
    document.dispatchEvent(new Event("scroll"));
    expect(chip.classList.contains("osso-chip-show")).toBe(false);
    mouse("mouseover", spans(4)[0]!);
    vi.advanceTimersByTime(250);
    expect(chip.classList.contains("osso-chip-show")).toBe(true);
    key("keydown", "a");
    expect(chip.classList.contains("osso-chip-show")).toBe(false);
    off();
  });

  it("does nothing for an unjudged sentence or after uninstall", () => {
    vi.useFakeTimers();
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    const off = installInteractions(document, { revealKey: "Shift", holdMs: 120 });
    mouse("mouseover", spans(5)[0]!);
    vi.advanceTimersByTime(300);
    expect(document.querySelector(".osso-chip.osso-chip-show")).toBeNull();
    off();
    mouse("mouseover", spans(3)[0]!);
    vi.advanceTimersByTime(300);
    expect(document.querySelector(".osso-chip.osso-chip-show")).toBeNull();
  });
});

describe("pickGrey", () => {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = (c: { r: number; g: number; b: number }) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const hexToGrey = (h: string) => parseInt(h.slice(1, 3), 16);

  it("lands on the spec's colours", () => {
    expect(pickGrey({ r: 255, g: 255, b: 255 })).toBe("#b9b9b9");
    expect(pickGrey({ r: 0x11, g: 0x11, b: 0x11 })).toBe("#5c5c5c");
    expect(pickGrey({ r: 0xf5, g: 0xf0, b: 0xe8 })).toBe("#aeaeae");
    expect(pickGrey({ r: 0x22, g: 0x22, b: 0x22 })).toBe("#676767");
  });

  it("is darker than light grounds, lighter than dark grounds, at a steady contrast", () => {
    for (const bg of [
      { r: 255, g: 255, b: 255 },
      { r: 0xf5, g: 0xf0, b: 0xe8 },
      { r: 0xe0, g: 0xe8, b: 0xf0 },
    ]) {
      const g = hexToGrey(pickGrey(bg));
      expect(lum({ r: g, g, b: g })).toBeLessThan(lum(bg));
      expect(ratio(lum({ r: g, g, b: g }), lum(bg))).toBeCloseTo(1.96, 1);
    }
    for (const bg of [
      { r: 0x11, g: 0x11, b: 0x11 },
      { r: 0x22, g: 0x22, b: 0x22 },
      { r: 0x1a, g: 0x1f, b: 0x2e },
    ]) {
      const g = hexToGrey(pickGrey(bg));
      expect(lum({ r: g, g, b: g })).toBeGreaterThan(lum(bg));
      expect(ratio(lum({ r: g, g, b: g }), lum(bg))).toBeCloseTo(2.81, 1);
    }
    expect(pickGrey({ r: 200, g: 30, b: 30 })).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("effectiveBackground", () => {
  function stubBackgrounds(map: Map<Element, string>) {
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      (el: Element) => ({ backgroundColor: map.get(el) ?? "rgba(0, 0, 0, 0)" }) as CSSStyleDeclaration,
    );
  }

  it("walks up to the first opaque ancestor and defaults to white", () => {
    const dark = document.getElementById("dark")!;
    stubBackgrounds(new Map([[dark, "rgb(17, 17, 17)"]]));
    expect(effectiveBackground(spans(5)[0]!, window)).toEqual({ r: 17, g: 17, b: 17 });
    expect(effectiveBackground(spans(0)[0]!, window)).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("composites a translucent layer over what is beneath it", () => {
    const dark = document.getElementById("dark")!;
    stubBackgrounds(new Map([[document.body, "rgb(0, 0, 0)"], [dark, "rgba(255, 255, 255, 0.5)"]]));
    expect(effectiveBackground(spans(5)[0]!, window)).toEqual({ r: 128, g: 128, b: 128 });
  });

  it("gives each block its grey and flags dark blocks for the chip", () => {
    const dark = document.getElementById("dark")!;
    stubBackgrounds(new Map([[dark, "rgb(17, 17, 17)"]]));
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    const blocks = document.querySelectorAll<HTMLElement>("[data-osso-block]");
    expect(blocks[0]!.style.getPropertyValue("--osso-grey")).toBe("#b9b9b9");
    expect(blocks[0]!.classList.contains("osso-dark")).toBe(false);
    expect(dark.style.getPropertyValue("--osso-grey")).toBe("#5c5c5c");
    expect(dark.classList.contains("osso-dark")).toBe(true);
  });

  it("gives the chip its light variant over a dark block", () => {
    vi.useFakeTimers();
    const dark = document.getElementById("dark")!;
    stubBackgrounds(new Map([[dark, "rgb(17, 17, 17)"]]));
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    const off = installInteractions(document, { revealKey: "Shift", holdMs: 120 });
    mouse("mouseover", spans(4)[0]!);
    vi.advanceTimersByTime(250);
    expect(document.querySelector(".osso-chip")!.classList.contains("osso-chip-light")).toBe(true);
    mouse("mouseout", spans(4)[0]!, { relatedTarget: document.body });
    mouse("mouseover", spans(0)[0]!);
    vi.advanceTimersByTime(250);
    expect(document.querySelector(".osso-chip")!.classList.contains("osso-chip-light")).toBe(false);
    off();
  });
});

describe("clearRender", () => {
  it("removes every class, property and the chip, and leaves the spans intact", () => {
    vi.useFakeTimers();
    const before = Array.from(document.querySelectorAll(".osso-s")).map((s) => s.textContent);
    applyJudgment(document, judgment(), { threshold: 0.95, animations: true });
    const off = installInteractions(document, { revealKey: "Shift", holdMs: 120 });
    mouse("click", spans(1)[0]!);
    mouse("mouseover", spans(3)[0]!);
    vi.advanceTimersByTime(250);
    setReveal(document, true);
    expect(document.querySelector(".osso-chip")).not.toBeNull();

    clearRender(document);
    expect(root().className).toBe("");
    expect(document.querySelector(".osso-chip")).toBeNull();
    expect(document.querySelectorAll(".osso-fade, .osso-pin, .osso-dark")).toHaveLength(0);
    const after = Array.from(document.querySelectorAll<HTMLElement>(".osso-s"));
    expect(after.map((s) => s.textContent)).toEqual(before);
    for (const s of after) expect(s.getAttribute("style")).toBeNull();
    for (const b of document.querySelectorAll<HTMLElement>("[data-osso-block]")) expect(b.style.getPropertyValue("--osso-grey")).toBe("");
    expect(document.querySelector("main")!.textContent).toContain("There is something magical about one pot.");
    expect(counts(document)).toEqual({ total: 0, kept: 0, faded: 0 });
    off();
  });
});
