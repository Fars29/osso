/**
 * The marker: which words are worth asking about, which of them are one thing, and turning the
 * answers into stretches of the page. The offsets come back as positions in the sentence the model
 * read, and the page holds the same text with its own whitespace, so the mapping is the risky part.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { highlightWords, stitchSpans } from "../src/background/api.ts";
import { normalizeColour, normalizeHighlights } from "../src/background/settings.ts";
import { MAX_HIGHLIGHTS } from "../src/shared/constants.ts";
import { applyHighlights, clearRender, markHits } from "../src/content/render.ts";
import type { PageJudgment, SentenceJudgment } from "../src/shared/types.ts";
import { applyJudgment } from "../src/content/render.ts";

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
    expect(highlightWords("Serves 4 people, approx. 20 min.").map((w) => w.word)).toEqual(["Serves", "people", "approx", "20", "min"]);
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
const S = (id: number, keep: number): SentenceJudgment => ({ id, keep, kind: "fact", kindConfidence: 0.9 });
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
