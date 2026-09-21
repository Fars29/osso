/**
 * The strike and the reason in the margin, on a jsdom page with rectangles given by hand (jsdom has
 * no layout): what each span is told about its stroke, where a reason goes, and that none of it is
 * left behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageJudgment, SentenceJudgment } from "../src/shared/types.ts";
import { FRONT_MAX_MS, SETTLE_MS, STRIKE_LAG_MS, STRIKE_MAX_MS, STRIKE_MIN_MS, STRIKE_MS_PER_CHAR, WHY_MS, applyJudgment, clearRender } from "../src/content/render.ts";

const PAGE = `
<main>
  <p id="a" data-osso-block=""><span class="osso-s" data-osso="0">Every summer my grandmother opened the windows.</span>
  <span class="osso-s" data-osso="1">Use 300 g of orzo.</span></p>
  <p id="b" data-osso-block=""><span class="osso-s" data-osso="2">Please </span><a href="#"><span class="osso-s" data-osso="2">tag me</span></a><span class="osso-s" data-osso="2"> on Instagram!</span>
  <span class="osso-s" data-osso="3">I still remember the smell.</span></p>
  <p id="c" data-osso-block=""><span class="osso-s" data-osso="4">Get 15% off with my code.</span></p>
</main>`;

const S = (id: number, keep: number, kind: SentenceJudgment["kind"]): SentenceJudgment => ({ id, keep, kind, kindConfidence: 0.9 });
const judgment = (): PageJudgment => ({
  packId: "recipe",
  pageKind: "recipe",
  pageKindConfidence: 0.9,
  sentences: [S(0, 0.1, "anecdote_or_story"), S(1, 0.95, "instruction_or_step"), S(2, 0.1, "promotion_or_appeal"), S(3, 0.1, "anecdote_or_story"), S(4, 0.1, "promotion_or_appeal")],
  inputTokens: 1,
  ms: 1,
  cached: false,
  failedIds: [],
});

const spans = (id: number) => Array.from(document.querySelectorAll<HTMLElement>(`.osso-s[data-osso="${id}"]`));
const px = (el: HTMLElement, name: string) => parseInt(el.style.getPropertyValue(name), 10);
const whys = () => Array.from(document.querySelectorAll<HTMLElement>(".osso-why"));
const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

/** A 1280 × 800 window with the text column from `left` to `left + 700`; each sentence one 24 px line at `tops[id]`. */
function layOut(tops: Record<number, number>, left = 280) {
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
  Object.defineProperty(document.documentElement, "clientWidth", { value: 1280, configurable: true });
  for (const [id, top] of Object.entries(tops)) {
    for (const s of spans(Number(id))) {
      s.getBoundingClientRect = () => rect(left, top, 700, 24);
      s.getClientRects = () => [rect(left, top, 700, 24)] as unknown as DOMRectList;
    }
  }
  for (const p of document.querySelectorAll<HTMLElement>("[data-osso-block]")) p.getBoundingClientRect = () => rect(left, 0, 700, 100);
}

beforeEach(() => {
  document.body.innerHTML = PAGE;
});

afterEach(() => {
  clearRender(document);
  vi.useRealTimers();
  Reflect.deleteProperty(document, "elementFromPoint");
});

describe("the strike", () => {
  it("is on unless the reader turned it off", () => {
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    expect(document.documentElement.classList.contains("osso-strike")).toBe(true);
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true, strike: false });
    expect(document.documentElement.classList.contains("osso-strike")).toBe(false);
  });

  it("starts a moment after the front reaches the sentence, and takes as long as the sentence is long", () => {
    layOut({ 0: 100, 1: 130, 2: 300, 3: 330, 4: 500 });
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
    layOut({ 0: 100, 1: 130, 2: 300, 3: 330, 4: 500 });
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
    layOut({ 0: 100, 1: 130, 2: 300, 3: 330, 4: 500 });
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    vi.advanceTimersByTime(FRONT_MAX_MS + SETTLE_MS + STRIKE_MAX_MS + 100);
    for (const s of document.querySelectorAll<HTMLElement>(".osso-s")) expect(s.getAttribute("style") || "").toBe("");
    expect(document.documentElement.classList.contains("osso-settled")).toBe(true);
  });
});

describe("the reason in the margin", () => {
  it("names why each paragraph lost sentences, beside its first grey line, as the front gets there", () => {
    layOut({ 0: 100, 1: 130, 2: 300, 3: 330, 4: 500 });
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    expect(whys().map((w) => w.textContent)).toEqual(["story", "promo · story", "promo"]);
    const [first, second] = whys() as [HTMLElement, HTMLElement];
    // In the left margin: its right edge a gap away from the column, whatever its width.
    expect(first.classList.contains("osso-why-left")).toBe(true);
    expect(parseInt(first.style.right, 10)).toBe(1280 - (280 - 14));
    // Centred on the line.
    expect(parseInt(first.style.top, 10)).toBe(Math.round(100 + (24 - 10.5) / 2));
    expect(px(first, "--osso-why-delay")).toBe(px(spans(0)[0]!, "--osso-delay"));
    expect(px(second, "--osso-why-delay")).toBeGreaterThan(px(first, "--osso-why-delay"));
    for (const w of whys()) expect(w.getAttribute("aria-hidden")).toBe("true");
  });

  it("goes to the right margin when the left has no room, and nowhere when neither has", () => {
    layOut({ 0: 100, 1: 130, 2: 300, 3: 330, 4: 500 }, 20);
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    expect(whys().length).toBe(3);
    for (const w of whys()) {
      expect(w.classList.contains("osso-why-right")).toBe(true);
      expect(parseInt(w.style.left, 10)).toBe(20 + 700 + 14);
    }
    clearRender(document);
    document.body.innerHTML = PAGE;
    layOut({ 0: 100, 1: 130, 2: 300, 3: 330, 4: 500 }, 20);
    Object.defineProperty(document.documentElement, "clientWidth", { value: 740, configurable: true });
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    expect(whys().length).toBe(0);
  });

  it("never sits on something else: a margin with a sidebar in it is not a margin", () => {
    layOut({ 0: 100, 1: 130, 2: 300, 3: 330, 4: 500 });
    const sidebar = document.createElement("nav");
    document.body.appendChild(sidebar);
    // The sidebar fills the left of the window; the right is the page's own background.
    (document as unknown as { elementFromPoint: (x: number, y: number) => Element }).elementFromPoint = (x) => (x < 280 ? sidebar : document.body);
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    expect(whys().length).toBe(3);
    for (const w of whys()) expect(w.classList.contains("osso-why-right")).toBe(true);
  });

  it("does not repeat itself down a list: the same word close below the last says nothing new", () => {
    layOut({ 0: 100, 1: 130, 2: 1000, 3: 1000, 4: 160 });
    applyJudgment(
      document,
      { ...judgment(), sentences: [S(0, 0.1, "promotion_or_appeal"), S(1, 0.9, "instruction_or_step"), S(4, 0.1, "promotion_or_appeal")] },
      { threshold: 0.5, animations: true },
    );
    expect(whys().map((w) => w.textContent)).toEqual(["promo"]);
  });

  it("is gone when it has played, and at once if the page scrolls under it", () => {
    vi.useFakeTimers();
    layOut({ 0: 100, 1: 130, 2: 300, 3: 330, 4: 500 });
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    expect(whys().length).toBe(3);
    vi.advanceTimersByTime(FRONT_MAX_MS + WHY_MS + 100);
    expect(whys().length).toBe(0);

    clearRender(document);
    document.body.innerHTML = PAGE;
    layOut({ 0: 100, 1: 130, 2: 300, 3: 330, 4: 500 });
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    expect(whys().length).toBe(3);
    document.dispatchEvent(new Event("scroll"));
    expect(whys().length).toBe(0);
  });

  it("is part of the animation: with animations off there is none", () => {
    layOut({ 0: 100, 1: 130, 2: 300, 3: 330, 4: 500 });
    applyJudgment(document, judgment(), { threshold: 0.5, animations: false });
    expect(whys().length).toBe(0);
    expect(spans(0)[0]!.classList.contains("osso-fade")).toBe(true);
  });
});
