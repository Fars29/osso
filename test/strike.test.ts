/**
 * The strike, and the sentences that wait for the reader: on a jsdom page with rectangles given by
 * hand (jsdom has no layout) and an IntersectionObserver the test fires itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageJudgment, SentenceJudgment } from "../src/shared/types.ts";
import { FRONT_LEAD_PX, FRONT_MAX_MS, SETTLE_MS, STRIKE_LAG_MS, STRIKE_MAX_MS, STRIKE_MIN_MS, STRIKE_MS_PER_CHAR, applyJudgment, clearRender, counts, installInteractions, setThreshold } from "../src/content/render.ts";

const PAGE = `
<main>
  <p id="a" data-osso-block=""><span class="osso-s" data-osso="0">Every summer my grandmother opened the windows.</span>
  <span class="osso-s" data-osso="1">Use 300 g of orzo.</span></p>
  <p id="b" data-osso-block=""><span class="osso-s" data-osso="2">Please </span><a href="#"><span class="osso-s" data-osso="2">tag me</span></a><span class="osso-s" data-osso="2"> on Instagram!</span>
  <span class="osso-s" data-osso="3">I still remember the smell.</span></p>
  <p id="c" data-osso-block=""><span class="osso-s" data-osso="4">Get 15% off with my code.</span>
  <span class="osso-s" data-osso="5">Simmer for 12 minutes.</span></p>
</main>`;

const S = (id: number, keep: number, kind: SentenceJudgment["kind"]): SentenceJudgment => ({ id, keep, kind, kindConfidence: 0.9 });
const judgment = (): PageJudgment => ({
  packId: "recipe",
  pageKind: "recipe",
  pageKindConfidence: 0.9,
  sentences: [S(0, 0.1, "anecdote_or_story"), S(1, 0.95, "instruction_or_step"), S(2, 0.1, "promotion_or_appeal"), S(3, 0.1, "anecdote_or_story"), S(4, 0.1, "promotion_or_appeal"), S(5, 0.95, "instruction_or_step")],
  inputTokens: 1,
  ms: 1,
  cached: false,
  failedIds: [],
});

const spans = (id: number) => Array.from(document.querySelectorAll<HTMLElement>(`.osso-s[data-osso="${id}"]`));
const px = (el: HTMLElement, name: string) => parseInt(el.style.getPropertyValue(name), 10);
const rect = (top: number) => ({ left: 280, top, width: 700, height: 24, right: 980, bottom: top + 24, x: 280, y: top, toJSON: () => ({}) }) as DOMRect;
const waiting = () => Array.from(document.querySelectorAll<HTMLElement>(".osso-wait"));

/** An 800 px window; each sentence one 24 px line at `tops[id]`. Call again to "scroll". */
function layOut(tops: Record<number, number>) {
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  for (const [id, top] of Object.entries(tops)) for (const s of spans(Number(id))) s.getBoundingClientRect = () => rect(top);
}

/** The browser's observer, reduced to what the test needs: what is watched, and a way to say "these came into view". */
class FakeWatcher {
  static last: FakeWatcher | null = null;
  watched = new Set<Element>();
  constructor(private cb: (entries: Array<{ isIntersecting: boolean; target: Element }>) => void) {
    FakeWatcher.last = this;
  }
  observe(el: Element) {
    this.watched.add(el);
  }
  unobserve(el: Element) {
    this.watched.delete(el);
  }
  disconnect() {
    this.watched.clear();
  }
  see(els: Element[]) {
    this.cb(els.filter((e) => this.watched.has(e)).map((target) => ({ isIntersecting: true, target })));
  }
}

const withWatcher = () => Object.defineProperty(window, "IntersectionObserver", { value: FakeWatcher, configurable: true, writable: true });

beforeEach(() => {
  document.body.innerHTML = PAGE;
  FakeWatcher.last = null;
});

afterEach(() => {
  clearRender(document);
  vi.useRealTimers();
  Reflect.deleteProperty(window, "IntersectionObserver");
});

describe("the strike", () => {
  it("is on unless the reader turned it off", () => {
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    expect(document.documentElement.classList.contains("osso-strike")).toBe(true);
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true, strike: false });
    expect(document.documentElement.classList.contains("osso-strike")).toBe(false);
  });

  it("starts a moment after the front reaches the sentence, and takes as long as the sentence is long", () => {
    layOut({ 0: 100, 1: 130, 2: 300, 3: 330, 4: 500, 5: 530 });
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    const s0 = spans(0)[0]!;
    expect(px(s0, "--osso-strike-delay")).toBe(px(s0, "--osso-delay") + STRIKE_LAG_MS);
    expect(px(s0, "--osso-strike-ms")).toBe(Math.max(STRIKE_MIN_MS, s0.textContent!.length * STRIKE_MS_PER_CHAR));
    expect(px(s0, "--osso-strike-ms")).toBeLessThanOrEqual(STRIKE_MAX_MS);
    // Lower on the page, later.
    expect(px(spans(4)[0]!, "--osso-strike-delay")).toBeGreaterThan(px(spans(3)[0]!, "--osso-strike-delay"));
    // A kept sentence has no stroke to time.
    expect(spans(1)[0]!.style.getPropertyValue("--osso-strike-delay")).toBe("");
  });

  it("is one stroke across a sentence in several wrappers: each takes over where the last one stops, at one pace", () => {
    layOut({ 0: 100, 1: 130, 2: 300, 3: 330, 4: 500, 5: 530 });
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    const [a, b, c] = spans(2) as [HTMLElement, HTMLElement, HTMLElement];
    expect(px(b, "--osso-strike-delay")).toBe(px(a, "--osso-strike-delay") + px(a, "--osso-strike-ms"));
    expect(Math.abs(px(c, "--osso-strike-delay") - (px(b, "--osso-strike-delay") + px(b, "--osso-strike-ms")))).toBeLessThanOrEqual(1);
    for (const s of [a, b, c]) expect(s.style.getPropertyValue("--osso-strike-ease")).toBe("linear");
    // A sentence in one wrapper keeps the stylesheet's ease.
    expect(spans(0)[0]!.style.getPropertyValue("--osso-strike-ease")).toBe("");
  });

  it("leaves nothing on the spans once the wave has settled", () => {
    vi.useFakeTimers();
    layOut({ 0: 100, 1: 130, 2: 300, 3: 330, 4: 500, 5: 530 });
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    vi.advanceTimersByTime(FRONT_MAX_MS + SETTLE_MS + STRIKE_MAX_MS + 100);
    for (const s of document.querySelectorAll<HTMLElement>(".osso-s")) expect(s.getAttribute("style") || "").toBe("");
    expect(document.documentElement.classList.contains("osso-settled")).toBe(true);
  });

  it("puts no word in the margin: the reason is the hover chip's to give", () => {
    layOut({ 0: 100, 1: 130, 2: 300, 3: 330, 4: 500, 5: 530 });
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    expect(document.body.querySelectorAll(":scope > :not(main)").length).toBe(0);
  });
});

describe("what is further down waits for the reader", () => {
  it("stays in ink until it comes into view, faded in every other sense", () => {
    withWatcher();
    layOut({ 0: 100, 1: 130, 2: 1300, 3: 1330, 4: 2500, 5: 2530 });
    const c = applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    // On screen: the front, now.
    expect(spans(0)[0]!.classList.contains("osso-sweep")).toBe(true);
    expect(spans(0)[0]!.classList.contains("osso-wait")).toBe(false);
    // Below the fold: faded, counted, waiting, watched; nothing animating.
    for (const id of [2, 3, 4]) for (const s of spans(id)) {
      expect(s.classList.contains("osso-fade"), String(id)).toBe(true);
      expect(s.classList.contains("osso-wait"), String(id)).toBe(true);
      expect(s.classList.contains("osso-sweep"), String(id)).toBe(false);
      expect(FakeWatcher.last!.watched.has(s)).toBe(true);
    }
    expect(c).toEqual({ total: 6, kept: 2, faded: 4 });
    expect(counts(document)).toEqual(c);
    // A kept sentence below the fold has nothing to wait for.
    expect(spans(5)[0]!.classList.contains("osso-wait")).toBe(false);
    expect(FakeWatcher.last!.watched.has(spans(5)[0]!)).toBe(false);
  });

  it("goes grey in front of the reader: its own front, from just above it, and its strike", () => {
    withWatcher();
    layOut({ 0: 100, 1: 130, 2: 1300, 3: 1330, 4: 2500, 5: 2530 });
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    // The reader scrolls 600 px: the second paragraph comes up from the bottom edge.
    layOut({ 0: -500, 1: -470, 2: 700, 3: 730, 4: 1900, 5: 1930 });
    FakeWatcher.last!.see([...spans(2), ...spans(3)]);
    for (const s of [...spans(2), ...spans(3)]) {
      expect(s.classList.contains("osso-wait")).toBe(false);
      expect(s.classList.contains("osso-sweep")).toBe(true);
      expect(s.style.getPropertyValue("--osso-y0")).toBe(`${700 - FRONT_LEAD_PX}px`);
      expect(s.style.getPropertyValue("--osso-strike-delay")).not.toBe("");
      expect(FakeWatcher.last!.watched.has(s)).toBe(false);
    }
    // The last paragraph is still further down, still waiting.
    expect(spans(4)[0]!.classList.contains("osso-wait")).toBe(true);
    expect(waiting().length).toBe(1);
  });

  it("cleans up after itself without unsettling the page, and never cuts another front short", () => {
    vi.useFakeTimers();
    withWatcher();
    layOut({ 0: 100, 1: 130, 2: 1300, 3: 1330, 4: 2500, 5: 2530 });
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    vi.advanceTimersByTime(FRONT_MAX_MS + SETTLE_MS + STRIKE_MAX_MS + 100);
    expect(document.documentElement.classList.contains("osso-settled")).toBe(true);
    layOut({ 2: 700, 3: 730 });
    FakeWatcher.last!.see(spans(3));
    expect(document.documentElement.classList.contains("osso-settled")).toBe(true);
    vi.advanceTimersByTime(400);
    layOut({ 4: 760 });
    FakeWatcher.last!.see(spans(4));
    // The first of the two is still mid-pass when the second starts.
    expect(spans(3)[0]!.classList.contains("osso-sweep")).toBe(true);
    vi.advanceTimersByTime(FRONT_MAX_MS + SETTLE_MS + STRIKE_MAX_MS + 100);
    for (const s of [...spans(3), ...spans(4)]) {
      expect(s.classList.contains("osso-sweep")).toBe(false);
      expect(s.getAttribute("style") || "").toBe("");
      expect(s.classList.contains("osso-fade")).toBe(true);
    }
  });

  it("follows the slider while it waits: a sentence no longer grey arrives as ink, with nothing to play", () => {
    withWatcher();
    layOut({ 0: 100, 1: 130, 2: 1300, 3: 1330, 4: 2500, 5: 2530 });
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    setThreshold(document, 0.05);
    layOut({ 2: 700, 3: 730 });
    FakeWatcher.last!.see(spans(3));
    expect(spans(3)[0]!.classList.contains("osso-wait")).toBe(false);
    expect(spans(3)[0]!.classList.contains("osso-fade")).toBe(false);
    expect(spans(3)[0]!.classList.contains("osso-sweep")).toBe(false);
  });

  it("cannot be pinned or explained before it has been seen to go", () => {
    withWatcher();
    layOut({ 0: 100, 1: 130, 2: 1300, 3: 1330, 4: 2500, 5: 2530 });
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    const off = installInteractions(document, { revealKey: "Shift", holdMs: 150 });
    spans(3)[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(spans(3)[0]!.classList.contains("osso-pin")).toBe(false);
    off();
  });

  it("waits for nothing with animations off, or where the browser cannot say when it comes into view", () => {
    layOut({ 0: 100, 1: 130, 2: 1300, 3: 1330, 4: 2500, 5: 2530 });
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    expect(waiting().length).toBe(0);
    expect(spans(3)[0]!.classList.contains("osso-fade")).toBe(true);

    clearRender(document);
    document.body.innerHTML = PAGE;
    withWatcher();
    layOut({ 0: 100, 1: 130, 2: 1300, 3: 1330, 4: 2500, 5: 2530 });
    applyJudgment(document, judgment(), { threshold: 0.5, animations: false });
    expect(waiting().length).toBe(0);

    // Switched off while some were waiting: they are released at once.
    clearRender(document);
    document.body.innerHTML = PAGE;
    layOut({ 0: 100, 1: 130, 2: 1300, 3: 1330, 4: 2500, 5: 2530 });
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    expect(waiting().length).toBeGreaterThan(0);
    applyJudgment(document, { ...judgment(), sentences: [] }, { threshold: 0.5, animations: false });
    expect(waiting().length).toBe(0);
  });

  it("leaves no class behind when Osso leaves the page", () => {
    withWatcher();
    layOut({ 0: 100, 1: 130, 2: 1300, 3: 1330, 4: 2500, 5: 2530 });
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    const watcher = FakeWatcher.last!;
    clearRender(document);
    expect(waiting().length).toBe(0);
    expect(watcher.watched.size).toBe(0);
  });
});
