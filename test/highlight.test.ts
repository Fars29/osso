/**
 * The marker: which words are worth asking about, which of them are one thing, and turning the
 * answers into stretches of the page. The offsets come back as positions in the sentence the model
 * read, and the page holds the same text with its own whitespace, so the mapping is the risky part.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { highlightWords, stitchSpans } from "../src/background/api.ts";
import { normalizeColour, normalizeHighlights } from "../src/background/settings.ts";
import { MAX_HIGHLIGHTS } from "../src/shared/constants.ts";
import { applyHighlights, clearRender, markHits } from "../src/content/render.ts";
import type { PageJudgment, SentenceJudgment } from "../src/shared/types.ts";
import {
  MARK_ARRIVE_MAX_MS,
  MARK_ARRIVE_MIN_MS,
  MARK_ARRIVE_STAGGER_MS,
  MARK_MAX_MS,
  MARK_MIN_MS,
  MARK_MS_PER_CHAR,
  MARK_STAGGER_MAX_MS,
  MARK_STAGGER_MS,
  applyJudgment,
} from "../src/content/render.ts";

describe("which words are worth a question", () => {
  it("skips the function words and the punctuation, and keeps what a reader could point at", () => {
    const text = "Add the flour and 300 g of white sugar to the bowl.";
    expect(highlightWords(text).map((w) => w.word)).toEqual(["Add", "flour", "300", "white", "sugar", "bowl"]);
  });

  it("gives each word its place in the sentence, and trims the punctuation that follows it", () => {
    const text = "Panetta, governor of the Bank of Italy, spoke.";
    const words = highlightWords(text);
    const first = words[0]!;
    expect(text.slice(first.start, first.end)).toBe("Panetta");
    for (const w of words) expect(text.slice(w.start, w.end)).toBe(w.word);
  });

  it("leaves the punctuation that follows a word out of it", () => {
    expect(highlightWords("Serves 4 people, approx. 20 min.").map((w) => w.word)).toEqual(["Serves", "4", "people", "approx", "20", "min"]);
  });

  it("asks about a lone digit, which a date or a quantity needs, and keeps a currency sign with its number", () => {
    const text = "The price drops from $24,900 to $22,500 on 2 November, and 1 medium onion is €1.";
    expect(highlightWords(text).map((w) => w.word)).toEqual(["price", "drops", "$24,900", "$22,500", "2", "November", "1", "medium", "onion", "€1"]);
  });

  it("keeps the percent sign with its number", () => {
    const text = "L'incremento dell'1,73% rispetto al 2024, e una flessione del 30,77%.";
    expect(highlightWords(text).map((w) => w.word)).toEqual(["L'incremento", "dell'1,73%", "rispetto", "2024", "flessione", "30,77%"]);
  });

  it("asks about Italian function words no more than English ones", () => {
    expect(highlightWords("Il governatore della Banca d'Italia ha parlato").map((w) => w.word)).toEqual(["governatore", "Banca", "d'Italia", "parlato"]);
  });
});

describe("words that are one thing", () => {
  const words = (text: string) => highlightWords(text);
  const at = (text: string, word: string): [number, number] => [text.indexOf(word), text.indexOf(word) + word.length];

  it("keeps a clause whole by stepping over the little words nobody was asked about", () => {
    const text = "Le conseguenze sarebbero un aumento dei mutui e una spesa più alta.";
    const marked = ["aumento", "mutui", "spesa", "alta"].map((w) => at(text, w));
    const out = stitchSpans(text, marked, words(text));
    expect(out).toHaveLength(1);
    expect(text.slice(out[0]![0], out[0]![1])).toBe("aumento dei mutui e una spesa più alta");
  });

  it("joins what only a space or a hyphen parts", () => {
    const text = "Add white sugar and mini-chocolate chips.";
    const out = stitchSpans(text, [at(text, "white"), at(text, "sugar")], words(text));
    expect(text.slice(out[0]![0], out[0]![1])).toBe("white sugar");
  });

  it("stops where a word was asked about and refused", () => {
    const text = "Whisk the flour with three teaspoons of milk.";
    const out = stitchSpans(text, [at(text, "flour"), at(text, "milk")], words(text));
    // "three" and "teaspoons" were asked and left out, so the two are not one thing.
    expect(out).toHaveLength(2);
  });

  it("stops at the punctuation the writer put there", () => {
    const text = "Milk: milk adds moisture, salted butter adds richness.";
    expect(stitchSpans(text, [[0, 4], [6, 10]], words(text))).toHaveLength(2);
    const comma = "Use sugar, salt and pepper.";
    expect(stitchSpans(comma, [at(comma, "sugar"), at(comma, "salt")], words(comma))).toHaveLength(2);
  });

  it("puts them in order, and folds an overlap into one", () => {
    const text = "Whisk the flour with three teaspoons of milk.";
    const flour = at(text, "flour");
    const milk = at(text, "milk");
    expect(stitchSpans(text, [milk, flour], words(text))).toEqual([flour, milk]);
    expect(stitchSpans(text, [flour, [flour[0] + 2, flour[1] + 6]], words(text))).toEqual([[flour[0], flour[1] + 6]]);
  });
});

describe("what is stored", () => {
  it("keeps the terms trimmed, unique and few", () => {
    const many = ["  candidate   names ", "CANDIDATE NAMES", "ingredients", "dates", "prices", "places"];
    const out = normalizeHighlights(many);
    expect(out[0]).toBe("candidate names");
    expect(out).toHaveLength(MAX_HIGHLIGHTS);
    expect(out).not.toContain("CANDIDATE NAMES");
    expect(normalizeHighlights("not a list")).toEqual([]);
  });

  it("takes a colour only in the one shape Osso writes into a page", () => {
    expect(normalizeColour("#FFD24A", "#000000")).toBe("#ffd24a");
    expect(normalizeColour("#abc", "#000000")).toBe("#aabbcc");
    for (const bad of ["red", "rgb(1,2,3)", "#12345", "javascript:x", "", 7, null]) {
      expect(normalizeColour(bad, "#123456"), String(bad)).toBe("#123456");
    }
  });
});

// ---- the page ------------------------------------------------------------------------------------

/** The browser's Custom Highlight API, reduced to what the renderer asks of it. */
class FakeHighlight {
  ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
  get size() {
    return this.ranges.length;
  }
}
const registry = new Map<string, FakeHighlight>();

const PAGE = `<main>
  <p data-osso-block=""><span class="osso-s" data-osso="0">Add 300 g of </span><em><span class="osso-s" data-osso="0">white sugar</span></em><span class="osso-s" data-osso="0"> to the bowl.</span>
  <span class="osso-s" data-osso="1">Serve at once.</span></p>
</main>`;
const SENTENCES = new Map([
  [0, "Add 300 g of white sugar to the bowl."],
  [1, "Serve at once."],
]);
const S = (id: number, keep: number): SentenceJudgment => ({ id, keep, kind: "aside", kindConfidence: 0.9 });
const judgment = (): PageJudgment => ({
  packId: "recipe",
  pageKind: "recipe",
  pageKindConfidence: 1,
  sentences: [S(0, 0.1), S(1, 0.9)],
  inputTokens: 1,
  ms: 1,
  cached: false,
  failedIds: [],
});
const spansOf = (id: number) => Array.from(document.querySelectorAll<HTMLElement>(`.osso-s[data-osso="${id}"]`));

beforeEach(() => {
  document.body.innerHTML = PAGE;
  registry.clear();
  Object.defineProperty(window, "Highlight", { value: FakeHighlight, configurable: true, writable: true });
  Object.defineProperty(window, "CSS", { value: { highlights: registry }, configurable: true, writable: true });
});

afterEach(() => {
  clearRender(document);
  Reflect.deleteProperty(window, "Highlight");
  Reflect.deleteProperty(window, "CSS");
});

describe("marking the page", () => {
  it("turns offsets in the sentence into stretches of the page, across the markup inside it", () => {
    applyJudgment(document, judgment(), { threshold: 0.5, animations: false });
    const sugar: [number, number] = [13, 24];
    expect(SENTENCES.get(0)!.slice(...sugar)).toBe("white sugar");
    applyHighlights(document, { ingredients: { 0: [sugar] } }, ["ingredients"], SENTENCES);
    const painted = registry.get("osso-mark");
    expect(painted?.size).toBe(1);
    expect(painted!.ranges[0]!.toString()).toBe("white sugar");
  });

  it("marks a stretch that starts in one wrapper and ends in the next", () => {
    applyJudgment(document, judgment(), { threshold: 0.5, animations: false });
    const ofText: [number, number] = [10, 24];
    expect(SENTENCES.get(0)!.slice(...ofText)).toBe("of white sugar");
    applyHighlights(document, { ingredients: { 0: [ofText] } }, ["ingredients"], SENTENCES);
    expect(registry.get("osso-mark")!.ranges[0]!.toString()).toBe("of white sugar");
  });

  it("never leaves a marked sentence struck, and counts what each term found", () => {
    applyJudgment(document, judgment(), { threshold: 0.5, animations: false });
    expect(spansOf(0)[0]!.classList.contains("osso-fade")).toBe(true);
    applyHighlights(document, { ingredients: { 0: [[13, 24]] } }, ["ingredients"], SENTENCES);
    for (const s of spansOf(0)) expect(s.classList.contains("osso-fade")).toBe(false);
    expect(markHits(document)).toEqual({ ingredients: 1 });
  });

  it("drops a term the reader took away, and keeps its answer for nothing if it comes back", () => {
    applyJudgment(document, judgment(), { threshold: 0.5, animations: false });
    applyHighlights(document, { ingredients: { 0: [[13, 24]] } }, ["ingredients"], SENTENCES);
    applyHighlights(document, {}, [], SENTENCES);
    expect(registry.has("osso-mark")).toBe(false);
    expect(spansOf(0)[0]!.classList.contains("osso-fade")).toBe(true);
    // Back again with no new answer: the page still knows where it was.
    applyHighlights(document, {}, ["ingredients"], SENTENCES);
    expect(registry.get("osso-mark")?.size).toBe(1);
  });

  it("paints a whole sentence and a word with the one marker the reader chose", () => {
    applyJudgment(document, judgment(), { threshold: 0.5, animations: false });
    applyHighlights(document, { reasons: { 1: [[0, SENTENCES.get(1)!.length]] }, ingredients: { 0: [[13, 24]] } }, ["reasons", "ingredients"], SENTENCES);
    expect(registry.get("osso-mark")!.ranges.map(String).sort()).toEqual(["Serve at once.", "white sugar"]);
    expect([...registry.keys()]).toEqual(["osso-mark"]);
    expect(markHits(document)).toEqual({ reasons: 1, ingredients: 1 });
  });

  it("marks what the page holds of a whole sentence whose run-in label the page does not wrap", () => {
    applyJudgment(document, judgment(), { threshold: 0.5, animations: false });
    const read = "Tip: Serve at once.";
    applyHighlights(document, { reasons: { 1: [[0, read.length]] } }, ["reasons"], new Map([[1, read]]));
    expect(registry.get("osso-mark")!.ranges.map(String)).toEqual(["Serve at once."]);
  });

  it("marks nothing rather than the wrong thing when the page does not hold what the model read", () => {
    applyJudgment(document, judgment(), { threshold: 0.5, animations: false });
    const elsewhere = new Map([[0, "A sentence this page does not have at all."]]);
    applyHighlights(document, { ingredients: { 0: [[2, 10]] } }, ["ingredients"], elsewhere);
    expect(registry.get("osso-mark")?.size ?? 0).toBe(0);
  });

  it("leaves the page alone where the browser has no marker to paint with", () => {
    Reflect.deleteProperty(window, "CSS");
    applyJudgment(document, judgment(), { threshold: 0.5, animations: false });
    const counts = applyHighlights(document, { ingredients: { 0: [[13, 24]] } }, ["ingredients"], SENTENCES);
    // No paint, but the sentence is still the reader's to read.
    expect(counts.faded).toBe(0);
    expect(markHits(document)).toEqual({ ingredients: 1 });
  });
});

describe("the marker draws itself", () => {
  /** The browser's clock and frames, run by the test. */
  const CLOCK: Parameters<typeof vi.useFakeTimers>[0] = { toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance", "requestAnimationFrame", "cancelAnimationFrame"] };
  /** What the reader sees marked: an empty Range (a mark whose turn has not come) paints nothing. */
  const painted = () => (registry.get("osso-mark")?.ranges ?? []).map(String).filter((s) => s !== "");

  /** The browser's IntersectionObserver, reduced to what the renderer asks of it; the test says when the reader gets somewhere. */
  const observers: FakeObserver[] = [];
  class FakeObserver {
    targets = new Set<Element>();
    constructor(readonly callback: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void) {
      observers.push(this);
    }
    observe(t: Element) {
      this.targets.add(t);
    }
    unobserve(t: Element) {
      this.targets.delete(t);
    }
    disconnect() {
      this.targets.clear();
    }
  }
  /** The reader scrolls to `el`: every observer watching it hears about it, as in a browser. */
  const reach = (el: Element) => {
    for (const o of [...observers]) if (o.targets.has(el)) o.callback([{ target: el, isIntersecting: true }]);
  };

  /**
   * Gives each sentence's wrappers a line, as layout would: `tops[id]` is where it starts, in window pixels.
   * A wrapper listed in `hidden` has no box at all, as one the site hides with its own stylesheet.
   */
  function layOut(tops: Record<number, number>, innerHeight = 600, hidden: HTMLElement[] = []) {
    Object.defineProperty(window, "innerHeight", { value: innerHeight, configurable: true });
    for (const [id, top] of Object.entries(tops)) {
      for (const s of spansOf(Number(id))) {
        const box = hidden.includes(s)
          ? ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect)
          : ({ top, bottom: top + 24, left: 0, right: 600, width: 600, height: 24, x: 0, y: top, toJSON: () => ({}) } as DOMRect);
        s.getBoundingClientRect = () => box;
        s.getClientRects = () => (hidden.includes(s) ? [] : [box]) as unknown as DOMRectList;
      }
    }
  }
  const watchRealObserver = () => Object.defineProperty(window, "IntersectionObserver", { value: FakeObserver, configurable: true, writable: true });
  const SUGAR = { ingredients: { 0: [[13, 24]] as [number, number][] } };
  const SERVE = { reasons: { 1: [[0, SENTENCES.get(1)!.length]] as [number, number][] } };

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    observers.length = 0;
    Reflect.deleteProperty(window, "IntersectionObserver");
  });

  it("draws a new mark from its first letter to its last, at a pen's pace", () => {
    vi.useFakeTimers(CLOCK);
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    applyHighlights(document, SUGAR, ["ingredients"], SENTENCES);
    // Nothing yet: the pen is at the first letter.
    expect(painted()).toEqual([]);
    vi.advanceTimersByTime(MARK_MIN_MS / 2);
    const half = painted()[0] ?? "";
    expect(half.length).toBeGreaterThan(0);
    expect(half.length).toBeLessThan("white sugar".length);
    expect("white sugar".startsWith(half)).toBe(true);
    vi.advanceTimersByTime(MARK_MIN_MS);
    expect(painted()).toEqual(["white sugar"]);
    // The count never waited for the pen.
    expect(markHits(document)).toEqual({ ingredients: 1 });
  });

  it("takes longer over a longer stretch: a whole sentence is still being drawn when a word would be done", () => {
    vi.useFakeTimers(CLOCK);
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    const sentence = SENTENCES.get(0)!;
    expect(sentence.length * MARK_MS_PER_CHAR).toBeGreaterThan(MARK_MIN_MS);
    applyHighlights(document, { reasons: { 0: [[0, sentence.length]] } }, ["reasons"], SENTENCES);
    vi.advanceTimersByTime(MARK_MIN_MS);
    const drawn = painted().join("").length;
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(sentence.length);
    vi.advanceTimersByTime(sentence.length * MARK_MS_PER_CHAR);
    expect(painted().join("")).toBe(sentence);
  });

  it("hands the browser the marks once, and moves on only the strokes in flight", () => {
    vi.useFakeTimers(CLOCK);
    const sets: unknown[] = [];
    const set = registry.set.bind(registry);
    registry.set = (name: string, value: FakeHighlight) => {
      sets.push(value);
      return set(name, value);
    };
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    applyHighlights(document, SUGAR, ["ingredients"], SENTENCES);
    const range = registry.get("osso-mark")!.ranges[0]!;
    const seen = new Set<string>();
    for (let t = 0; t < MARK_MAX_MS; t += 16) {
      vi.advanceTimersByTime(16);
      seen.add(String(range));
    }
    // One registration; the same Range grew through several lengths to the whole mark.
    expect(sets).toHaveLength(1);
    expect(seen.size).toBeGreaterThan(3);
    expect(String(range)).toBe("white sugar");
  });

  it("draws the marks on screen one after another, in reading order", () => {
    vi.useFakeTimers(CLOCK);
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    applyHighlights(document, { ...SERVE, ...SUGAR }, ["reasons", "ingredients"], SENTENCES);
    // The reader's order, not the terms': the sugar comes first on the page, so it is drawn first.
    vi.advanceTimersByTime(MARK_STAGGER_MS / 2);
    expect(painted()).toHaveLength(1);
    expect("white sugar".startsWith(painted()[0]!)).toBe(true);
    vi.advanceTimersByTime(MARK_STAGGER_MS + MARK_MAX_MS);
    expect(painted().sort()).toEqual(["Serve at once.", "white sugar"]);
  });

  it("reads the order off the screen when there is a layout: the higher line goes first", () => {
    vi.useFakeTimers(CLOCK);
    watchRealObserver();
    // A layout that puts the later sentence above the earlier one, as a float or a grid can.
    layOut({ 0: 300, 1: 100 });
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    applyHighlights(document, { ...SUGAR, ...SERVE }, ["ingredients", "reasons"], SENTENCES);
    vi.advanceTimersByTime(MARK_STAGGER_MS / 2);
    expect(painted()).toHaveLength(1);
    expect("Serve at once.".startsWith(painted()[0]!)).toBe(true);
  });

  it("leaves a mark further down unpainted until the reader gets there, then draws it in front of them", () => {
    vi.useFakeTimers(CLOCK);
    watchRealObserver();
    layOut({ 0: 1400, 1: 100 });
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    applyHighlights(document, { ...SUGAR, ...SERVE }, ["ingredients", "reasons"], SENTENCES);
    vi.advanceTimersByTime(MARK_STAGGER_MAX_MS + MARK_MAX_MS);
    expect(painted()).toEqual(["Serve at once."]);
    // Found and counted all the same: only the drawing waits.
    expect(markHits(document)).toEqual({ ingredients: 1, reasons: 1 });
    // The sugar is in the sentence's second wrapper (the <em>): the first one coming into view is not the mark.
    reach(spansOf(0)[0]!);
    vi.advanceTimersByTime(MARK_ARRIVE_MAX_MS);
    expect(painted()).toEqual(["Serve at once."]);
    reach(spansOf(0)[1]!);
    // The pen sets off at once, from the first letter, at the quicker pace of a mark the reader is looking at.
    expect(painted()).toEqual(["Serve at once."]);
    vi.advanceTimersByTime(MARK_ARRIVE_MIN_MS + 20);
    expect(painted().sort()).toEqual(["Serve at once.", "white sugar"]);
  });

  it("draws marks the reader reaches together one just after the other", () => {
    vi.useFakeTimers(CLOCK);
    watchRealObserver();
    layOut({ 0: 1400, 1: 1430 });
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    applyHighlights(document, { ...SUGAR, ...SERVE }, ["ingredients", "reasons"], SENTENCES);
    expect(painted()).toEqual([]);
    for (const o of [...observers]) o.callback([...o.targets].map((target) => ({ target, isIntersecting: true })));
    vi.advanceTimersByTime(MARK_ARRIVE_STAGGER_MS / 2);
    expect(painted()).toHaveLength(1);
    vi.advanceTimersByTime(MARK_ARRIVE_STAGGER_MS + MARK_ARRIVE_MAX_MS);
    expect(painted().sort()).toEqual(["Serve at once.", "white sugar"]);
  });

  it("does not wait on a wrapper the site hides: a mark shown nowhere is drawn at once", () => {
    vi.useFakeTimers(CLOCK);
    watchRealObserver();
    layOut({ 0: 1400, 1: 100 }, 600, [spansOf(0)[1]!]);
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    applyHighlights(document, SUGAR, ["ingredients"], SENTENCES);
    // Nobody scrolled anywhere, and it is drawn all the same.
    vi.advanceTimersByTime(MARK_MAX_MS);
    expect(painted()).toEqual(["white sugar"]);
  });

  it("watches a waiting mark again when the marks are painted anew, and still draws it when reached", () => {
    vi.useFakeTimers(CLOCK);
    watchRealObserver();
    layOut({ 0: 1400, 1: 100 });
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    applyHighlights(document, SUGAR, ["ingredients"], SENTENCES);
    applyHighlights(document, SERVE, ["ingredients", "reasons"], SENTENCES);
    vi.advanceTimersByTime(MARK_STAGGER_MAX_MS + MARK_MAX_MS);
    expect(painted()).toEqual(["Serve at once."]);
    reach(spansOf(0)[1]!);
    vi.advanceTimersByTime(MARK_ARRIVE_MAX_MS);
    expect(painted().sort()).toEqual(["Serve at once.", "white sugar"]);
  });

  it("keeps a mark already drawn whole when another term comes, and draws a term put back again", () => {
    vi.useFakeTimers(CLOCK);
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    applyHighlights(document, SUGAR, ["ingredients"], SENTENCES);
    vi.advanceTimersByTime(MARK_MAX_MS);
    applyHighlights(document, SERVE, ["ingredients", "reasons"], SENTENCES);
    expect(painted()).toEqual(["white sugar"]);
    vi.advanceTimersByTime(MARK_MAX_MS);
    expect(painted().sort()).toEqual(["Serve at once.", "white sugar"]);
    // Taken away, it goes at once; put back, it is drawn again, since the reader asked again.
    applyHighlights(document, {}, ["reasons"], SENTENCES);
    expect(painted()).toEqual(["Serve at once."]);
    applyHighlights(document, {}, ["reasons", "ingredients"], SENTENCES);
    expect(painted()).toEqual(["Serve at once."]);
    vi.advanceTimersByTime(MARK_MAX_MS);
    expect(painted().sort()).toEqual(["Serve at once.", "white sugar"]);
  });

  it("paints every mark whole at once where motion is reduced", () => {
    vi.useFakeTimers(CLOCK);
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q }) as MediaQueryList);
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    applyHighlights(document, SUGAR, ["ingredients"], SENTENCES);
    expect(painted()).toEqual(["white sugar"]);
  });

  it("paints a waiting mark whole, not drawn, when motion was reduced while it waited", () => {
    vi.useFakeTimers(CLOCK);
    watchRealObserver();
    layOut({ 0: 1400, 1: 100 });
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    applyHighlights(document, SUGAR, ["ingredients"], SENTENCES);
    expect(painted()).toEqual([]);
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q }) as MediaQueryList);
    reach(spansOf(0)[1]!);
    // Whole on the spot, and it stays so: no stroke was started.
    expect(painted()).toEqual(["white sugar"]);
    vi.advanceTimersByTime(16);
    expect(painted()).toEqual(["white sugar"]);
  });

  it("paints a mark still waiting whole once animations are switched off", () => {
    vi.useFakeTimers(CLOCK);
    watchRealObserver();
    layOut({ 0: 1400, 1: 100 });
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    applyHighlights(document, SUGAR, ["ingredients"], SENTENCES);
    expect(painted()).toEqual([]);
    applyJudgment(document, judgment(), { threshold: 0.5, animations: false });
    expect(painted()).toEqual(["white sugar"]);
  });

  it("stops drawing and watching when Osso leaves the page", () => {
    vi.useFakeTimers(CLOCK);
    watchRealObserver();
    layOut({ 0: 1400, 1: 100 });
    applyJudgment(document, judgment(), { threshold: 0.5, animations: true });
    applyHighlights(document, { ...SUGAR, ...SERVE }, ["ingredients", "reasons"], SENTENCES);
    vi.advanceTimersByTime(MARK_MIN_MS / 2);
    // One stroke in flight, one mark waiting.
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    clearRender(document);
    // No frame left to run, nothing left watched: the reader's scroll cannot bring anything back.
    expect(vi.getTimerCount()).toBe(0);
    expect(observers.every((o) => o.targets.size === 0)).toBe(true);
    expect(registry.has("osso-mark")).toBe(false);
  });
});
