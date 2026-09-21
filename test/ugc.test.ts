/**
 * What readers wrote under the page is not the page: reviews and comments are left alone, wherever
 * the publisher put them; and a tag at the end of a paragraph is a label, not a sentence.
 */
import { describe, expect, it } from "vitest";
import { segmentPage } from "../src/content/segment.ts";

function page(body: string): Document {
  return new DOMParser().parseFromString(`<!DOCTYPE html><html><head></head><body>${body}</body></html>`, "text/html");
}

const spans = (doc: Document, within = "") => Array.from(doc.querySelectorAll<HTMLElement>(`${within} .osso-s`.trim()));

const RECIPE = `<p id="intro">Every summer my grandmother made these pancakes for the whole street. This recipe has been on my list for years now.</p>
  <p id="method">Whisk 190 g of flour with 3 teaspoons of baking powder and a pinch of salt. Pour in 300 ml of milk, one egg and 45 g of melted butter. Cook on a hot griddle for two minutes a side.</p>`;
const REVIEW = `I'll be honest, I prepared this using the suggested steps left by another user and it didn't disappoint. The only difference is that I used vanilla paste. But the overall texture came out great.`;

describe("reviews and comments", () => {
  it("are left alone inside the article itself, which is where publishers put them", () => {
    const doc = page(`<main><article>${RECIPE}
      <div id="ugc_1-0" class="comp ugc mntl-block"><div class="ugc-card--review"><div id="r1">${REVIEW}</div></div><div class="ugc-card--review"><div id="r2">${REVIEW}</div></div></div>
    </article></main>`);
    segmentPage(doc);
    expect(spans(doc, "#r1")).toHaveLength(0);
    expect(spans(doc, "#r2")).toHaveLength(0);
    expect(spans(doc, "#intro").length).toBeGreaterThan(0);
    expect(spans(doc, "#method").length).toBeGreaterThan(0);
  });

  it("are known by many names, and by their microdata", () => {
    for (const open of ['<section id="comments">', '<div class="post-comments">', '<div class="customer-reviews">', '<div class="recipe-feedback">', '<div id="disqus_thread">', '<ol class="replies">', '<div itemprop="review" itemscope itemtype="https://schema.org/Review">', '<div itemscope itemtype="http://schema.org/Comment">']) {
      const tag = /^<(\w+)/.exec(open)![1];
      const doc = page(`<article>${RECIPE}${open}<div id="r">${REVIEW}</div></${tag}></article>`);
      segmentPage(doc);
      expect(spans(doc, "#r"), open).toHaveLength(0);
      expect(spans(doc, "#method").length, open).toBeGreaterThan(0);
    }
  });

  it("a name that also means an article is not one of them: a critic's review, a paper's discussion", () => {
    for (const open of ['<div class="review-body">', '<section id="discussion">', '<div class="responses-to-treatment">']) {
      const tag = /^<(\w+)/.exec(open)![1];
      const doc = page(`<article><p>${"A short opening paragraph of the page, in a sentence. "}</p>${open}<p id="r">${REVIEW}</p></${tag}></article>`);
      segmentPage(doc);
      expect(spans(doc, "#r").length, open).toBeGreaterThan(0);
    }
  });

  it("when the readers' words are the page (a thread, a Q&A), the page is read as it always was", () => {
    const thread = Array.from({ length: 6 }, (_, i) => `<div id="c${i}">${REVIEW}</div>`).join("");
    const doc = page(`<main><p id="q">How do I keep pancakes fluffy when I double the recipe for a crowd?</p><div class="comments">${thread}</div></main>`);
    segmentPage(doc);
    expect(spans(doc, "#c0").length).toBeGreaterThan(0);
    expect(spans(doc, "#c5").length).toBeGreaterThan(0);
  });
});

describe("a tag at the end of a paragraph", () => {
  it("is a label, not a sentence: it is never wrapped", () => {
    const doc = page(`<article>${RECIPE}<p id="p">The vanilla didn't shine through as I would like. But the overall texture came out great. <span class="status-chip" id="chip">Edited</span></p>
      <p id="more">The batter keeps in the fridge overnight, covered. Stir it before using, and thin it with milk. <a id="link" href="#">Read more</a></p></article>`);
    segmentPage(doc);
    expect(spans(doc, "#chip")).toHaveLength(0);
    expect(spans(doc, "#link")).toHaveLength(0);
    expect(spans(doc, "#p").length).toBe(2);
    expect(doc.querySelector("#chip")!.textContent).toBe("Edited");
  });

  it("a short last sentence that ends like one still belongs to the page: it joins the sentence before it, as it always did", () => {
    const doc = page(`<article>${RECIPE}<p id="p">Cook on a hot griddle for two minutes a side, until the bubbles burst. Serve warm.</p></article>`);
    segmentPage(doc);
    expect(spans(doc, "#p").map((s) => s.textContent).join("")).toContain("Serve warm.");
  });
});
