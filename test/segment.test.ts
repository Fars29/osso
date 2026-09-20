/**
 * Segment on the fixtures the design names: a recipe with a life story above the ingredients, a
 * terms page with a table and nested clauses, a mixed article with code, figure and blockquote,
 * and an app that must be left alone. Every fixture is parsed into its own Document so the head
 * (JSON-LD, og:type, http-equiv) is there for collectPageMeta.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MIN_SENTENCES } from "../src/shared/constants.ts";
import {
  BLOCK_ATTR,
  collectPageMeta,
  countWords,
  findMainContainer,
  isAppLikePage,
  segmentNewBlocks,
  segmentPage,
  splitSentences,
  unwrapAll,
} from "../src/content/segment.ts";

function fixture(name: string): Document {
  const html = readFileSync(resolve(__dirname, "fixtures", `${name}.html`), "utf8");
  return new DOMParser().parseFromString(html, "text/html");
}

function page(body: string, head = ""): Document {
  return new DOMParser().parseFromString(`<!DOCTYPE html><html><head>${head}</head><body>${body}</body></html>`, "text/html");
}

const spans = (doc: Document, within = "") => Array.from(doc.querySelectorAll<HTMLElement>(`${within} .osso-s`.trim()));
const idsOf = (els: Element[]) => Array.from(new Set(els.map((s) => Number(s.getAttribute("data-osso")))));
const textOf = (doc: Document, id: number) =>
  spans(doc)
    .filter((s) => s.getAttribute("data-osso") === String(id))
    .map((s) => s.textContent)
    .join("");

/** The sentences as splitSentences cuts them, for reading. */
const pieces = (text: string) => splitSentences(text).map((r) => text.slice(r.start, r.end));

describe("splitSentences", () => {
  it("cuts on a terminator followed by whitespace and a capital, digit or opening quote", () => {
    expect(pieces("The council voted on Tuesday. Construction begins in March 2027. Fares stay at €1.70.")).toEqual([
      "The council voted on Tuesday.",
      "Construction begins in March 2027.",
      "Fares stay at €1.70.",
    ]);
    expect(pieces('He said "Stop right there." Then he left the room.')).toEqual(['He said "Stop right there."', "Then he left the room."]);
    expect(pieces("Is it done? Yes it is done! 2 more to go.")).toEqual(["Is it done?", "Yes it is done!", "2 more to go."]);
  });

  it("does not cut on abbreviations, initials, decimals or enumerators", () => {
    expect(pieces("Dr. Rossi arrived at 9.30 a.m. in St. Louis, Mo. and met J. K. Rowling in the U.S. Army canteen.")).toHaveLength(1);
    expect(pieces("It costs 9.99 € in print, i.e. the one on e.g. examples from Prof. Bianchi's paper.")).toHaveLength(1);
    // "No. 5" is an enumerator; a lower-case "no." is the word, and the sentence ends there.
    expect(pieces("See item No. 5 in the list. Then read art. 12 of the terms.")).toEqual([
      "See item No. 5 in the list.",
      "Then read art. 12 of the terms.",
    ]);
    expect(pieces("I told him no. Then he left the room.")).toEqual(["I told him no.", "Then he left the room."]);
    // A lower-case continuation after a period is never a new sentence.
    expect(pieces("Version 4.2 ships next week. and it is the last of the series.")).toHaveLength(1);
  });

  it("splits on newlines and on an ellipsis only before a capital", () => {
    expect(pieces("First line of the block\nSecond line of the block")).toEqual(["First line of the block", "Second line of the block"]);
    expect(pieces("I was not so sure… I am still not sure about that. And then… nothing at all happened.")).toEqual([
      "I was not so sure…",
      "I am still not sure about that.",
      "And then… nothing at all happened.",
    ]);
  });

  it("folds fragments under MIN_WORDS into their neighbour so nothing is judged alone", () => {
    // Short first piece leans forward; short later pieces lean back.
    expect(pieces("Yes. This one is a longer sentence here. No.")).toEqual(["Yes. This one is a longer sentence here. No."]);
    expect(pieces("It rained all day long. Fine. Nothing else happened at all.")).toEqual([
      "It rained all day long. Fine.",
      "Nothing else happened at all.",
    ]);
    expect(pieces("  Only two.  ")).toEqual(["Only two."]);
    expect(splitSentences("")).toEqual([]);
  });

  it("splits scripts without case, and CJK with no space after the full stop", () => {
    // Arabic: a period, whitespace, then a letter that has no upper case.
    expect(pieces("هذه هي الجملة الأولى من النص. وهذه هي الجملة الثانية من النص؟ وهذه الجملة الثالثة هنا أيضا.")).toHaveLength(3);
    // Hebrew and Devanagari likewise; the danda is a terminator.
    expect(pieces("זה המשפט הראשון בטקסט הזה. זה המשפט השני בטקסט הזה.")).toHaveLength(2);
    expect(pieces("यह पहला वाक्य है और लंबा है। यह दूसरा वाक्य है और लंबा है।")).toHaveLength(2);
    // Chinese: full-width stops sit flush against the next sentence.
    expect(pieces("这是第一句话，里面有几个字。这是第二句话，也有几个字。这是第三句话！")).toEqual([
      "这是第一句话，里面有几个字。",
      "这是第二句话，也有几个字。",
      "这是第三句话！",
    ]);
    expect(countWords("这是第二句话")).toBe(6);
    expect(countWords("これは日本語の文です")).toBe(10);
    // A page in Chinese clears MIN_SENTENCES like any other.
    const doc = page(`<main>${"<p>这是第一句话，里面有几个字。这是第二句话，也有几个字。这是第三句话！</p>".repeat(4)}</main>`);
    expect(segmentPage(doc).sentences).toHaveLength(12);
  });

  it("counts words across scripts and contractions", () => {
    expect(countWords("It's a weeknight staple")).toBe(4);
    expect(countWords("500 g di farina")).toBe(4);
    expect(countWords("— · —")).toBe(0);
  });
});

describe("recipe fixture", () => {
  it("picks the article over its wrapper, the comments and the sidebar", () => {
    const doc = fixture("recipe");
    const main = findMainContainer(doc);
    expect(main?.matches("article.post")).toBe(true);
  });

  it("wraps only the prose of the article, one span set per sentence, chrome untouched", () => {
    const doc = fixture("recipe");
    const seg = segmentPage(doc);
    expect(seg.container.matches("article.post")).toBe(true);
    expect(seg.sentences.length).toBeGreaterThanOrEqual(MIN_SENTENCES);
    // 5 paragraphs of prose, the sponsored div, 7 ingredients of three words or more, 6 steps (one split in two).
    expect(seg.sentences).toHaveLength(29);
    expect(seg.sentences.map((s) => s.id)).toEqual(seg.sentences.map((_, i) => i));

    for (const sel of ["nav", "header", "footer", "aside", "#comments", "h1", "h2"]) {
      expect(spans(doc, sel), sel).toHaveLength(0);
    }
    // Every judged block is marked, and only blocks inside the container are.
    for (const block of Array.from(doc.querySelectorAll(`[${BLOCK_ATTR}]`))) expect(seg.container.contains(block)).toBe(true);
  });

  it("keeps inline markup where it was: one sentence, several spans, same id", () => {
    const doc = fixture("recipe");
    segmentPage(doc);
    const first = spans(doc).filter((s) => s.getAttribute("data-osso") === "0");
    expect(first.length).toBeGreaterThanOrEqual(3);
    expect(textOf(doc, 0)).toBe("Every summer my nonna would open the windows of her kitchen in Liguria and the whole street would know what was for dinner.");
    // The <em> and the <a> still exist, still hold their text, and sit between spans rather than inside one.
    const em = doc.querySelector("p em");
    const a = doc.querySelector('a[href="/liguria"]');
    expect(em?.textContent).toBe("nonna");
    expect(a?.getAttribute("href")).toBe("/liguria");
    expect(em?.querySelector(".osso-s")?.getAttribute("data-osso")).toBe("0");
    expect(a?.closest(".osso-s")).toBeNull();
  });

  it("treats list items as units, skips the ones under three words and splits the long ones", () => {
    const doc = fixture("recipe");
    const seg = segmentPage(doc);
    const items = Array.from(doc.querySelectorAll("ul.ingredients li"));
    expect(items).toHaveLength(8);
    const lemon = items.find((li) => li.textContent?.trim() === "1 lemon");
    expect(lemon?.querySelector(".osso-s")).toBeNull();
    const judged = items.filter((li) => li.querySelector(".osso-s"));
    expect(judged).toHaveLength(7);
    for (const li of judged) expect(idsOf(Array.from(li.querySelectorAll(".osso-s")))).toHaveLength(1);

    const longStep = Array.from(doc.querySelectorAll("ol.steps li")).find((li) => li.textContent?.includes("This step matters"));
    expect(idsOf(Array.from(longStep!.querySelectorAll(".osso-s")))).toHaveLength(2);
    expect(seg.sentences.some((s) => s.text.startsWith("Add the orzo and stir for one minute"))).toBe(true);
    expect(seg.sentences.some((s) => s.text.startsWith("This step matters more than it looks"))).toBe(true);
  });

  it("collects the page meta packs route on", () => {
    const doc = fixture("recipe");
    const seg = segmentPage(doc);
    expect(seg.meta.title).toBe("The Best One-Pot Lemon Chicken Orzo — Nonna's Kitchen");
    expect(seg.meta.lang).toBe("en");
    expect(seg.meta.ogType).toBe("article");
    expect(seg.meta.jsonLdTypes).toEqual(expect.arrayContaining(["recipe", "person", "webpage", "itempage"]));
    expect(seg.meta.sentenceCount).toBe(seg.sentences.length);
    expect(seg.meta.sample.length).toBeLessThanOrEqual(600);
    expect(seg.meta.sample.startsWith("Every summer my nonna")).toBe(true);
    expect(seg.contentHash).toMatch(/^[0-9a-f]{16}$/);
    expect(segmentPage(fixture("recipe")).contentHash).toBe(seg.contentHash);
  });

  it("unwrapAll puts the document back byte for byte", () => {
    const doc = fixture("recipe");
    const before = doc.body.innerHTML;
    const seg = segmentPage(doc);
    expect(seg.sentences.length).toBeGreaterThan(0);
    expect(doc.body.innerHTML).not.toBe(before);
    unwrapAll(doc);
    expect(doc.body.innerHTML).toBe(before);
    expect(doc.querySelectorAll(`[${BLOCK_ATTR}]`)).toHaveLength(0);
  });

  it("unwrapAll gives the page's own text nodes their characters back, and merges nothing of the page's", () => {
    const doc = fixture("recipe");
    const article = doc.querySelector("article")!;
    // A framework rendering `You have {n} messages` keeps three text nodes and a reference to each.
    const live = doc.createElement("p");
    const held = [doc.createTextNode("You have "), doc.createTextNode("3"), doc.createTextNode(" new messages waiting for you today.")];
    live.append(...held);
    article.appendChild(live);
    // A node holding several sentences is split; the page's node must be the one that survives.
    const long = doc.createElement("p");
    const original = doc.createTextNode("First sentence of the text is here. Second sentence of the text follows. Third sentence of the text ends it.");
    long.appendChild(original);
    article.appendChild(long);

    segmentPage(doc);
    expect(long.querySelectorAll(".osso-s")).toHaveLength(3);
    expect(original.parentElement?.classList.contains("osso-s")).toBe(true);
    expect(original.data).toBe("First sentence of the text is here.");

    unwrapAll(doc);
    // The same three nodes, in the same place: identity, not just equal text.
    expect(live.childNodes).toHaveLength(3);
    held.forEach((n, i) => expect(live.childNodes[i]).toBe(n));
    expect(held.map((n) => n.data)).toEqual(["You have ", "3", " new messages waiting for you today."]);
    expect(long.childNodes).toHaveLength(1);
    expect(long.firstChild).toBe(original);
    expect(original.data).toBe("First sentence of the text is here. Second sentence of the text follows. Third sentence of the text ends it.");
    // The framework writes to the node it holds, and the page shows it.
    held[1]!.data = "4";
    expect(live.textContent).toBe("You have 4 new messages waiting for you today.");
  });

  it("unwrapAll reaches wrappers in a subtree the page has detached, so a cached view comes back clean", () => {
    const doc = fixture("recipe");
    const before = doc.body.innerHTML;
    const seg = segmentPage(doc);
    const view = seg.container;
    const parent = view.parentNode!;
    const next = view.nextSibling;
    view.remove();
    expect(view.querySelectorAll(".osso-s").length).toBeGreaterThan(0);
    unwrapAll(doc);
    expect(view.querySelectorAll(".osso-s")).toHaveLength(0);
    expect(view.querySelectorAll(`[${BLOCK_ATTR}]`)).toHaveLength(0);
    parent.insertBefore(view, next);
    expect(doc.body.innerHTML).toBe(before);
  });

  it("is not an app", () => {
    expect(isAppLikePage(fixture("recipe"))).toBe(false);
  });
});

describe("terms fixture", () => {
  it("finds the content div on a page without semantic landmarks", () => {
    const doc = fixture("tos");
    expect(findMainContainer(doc)?.id).toBe("content");
  });

  it("reads the language from http-equiv when <html> has none", () => {
    const doc = fixture("tos");
    const meta = collectPageMeta(doc, "", 0);
    expect(meta.lang).toBe("en-GB");
    expect(meta.jsonLdTypes).toEqual([]);
    expect(meta.ogType).toBeNull();
  });

  it("judges clauses, definitions and nested list items, never the fee table", () => {
    const doc = fixture("tos");
    const seg = segmentPage(doc);
    expect(spans(doc, "table")).toHaveLength(0);
    expect(spans(doc, "nav")).toHaveLength(0);
    expect(spans(doc, "footer")).toHaveLength(0);

    const texts = seg.sentences.map((s) => s.text);
    expect(texts).toContain("Effective 1 October 2026.");
    expect(texts).toContain("Version 4.2 supersedes all previous versions.");
    expect(texts).toContain(
      "2.1 Your subscription will automatically renew at the end of each billing period unless you cancel at least 24 hours before the renewal date.",
    );
    // dt/dd are units; the nested <ol> breaks its parent item into its own unit plus two more.
    expect(texts).toContain('"Service" means the Example platform, including the website, the API and the mobile applications.');
    expect(texts).toContain("Payment is due in full at the start of each billing period. We accept the payment methods listed at checkout.");
    expect(texts).toContain("Failed payments are retried three times over ten days before the account is suspended.");
    for (const li of Array.from(doc.querySelectorAll("ol.clauses li"))) {
      const own = Array.from(li.children).filter((c) => c.matches(".osso-s"));
      expect(idsOf(own)).toHaveLength(1);
    }
  });
});

describe("mixed fixture", () => {
  it("routes around code, pre, tables and figures but judges captions, quotes and text-only divs", () => {
    const doc = fixture("mixed");
    const seg = segmentPage(doc);
    expect(seg.container.localName).toBe("article");
    expect(seg.meta.jsonLdTypes).toEqual(["techarticle"]);

    expect(spans(doc, "pre")).toHaveLength(0);
    expect(spans(doc, "code")).toHaveLength(0);
    expect(spans(doc, "table")).toHaveLength(0);
    expect(spans(doc, "header")).toHaveLength(0);
    expect(spans(doc, "footer")).toHaveLength(0);
    expect(spans(doc, "figcaption").length).toBeGreaterThan(0);
    expect(spans(doc, "blockquote").length).toBeGreaterThan(0);
    expect(spans(doc, "div.note").length).toBeGreaterThan(0);

    const texts = seg.sentences.map((s) => s.text);
    expect(texts).toContain("Queue depth during the migration window, sampled every 30 seconds.");
    expect(texts).toContain("Run first and read the plan it prints.");
    expect(doc.querySelector("#inline-code code")?.textContent).toBe("npm run migrate --dry");
  });

  it("keeps the abbreviation-heavy paragraph as two sentences", () => {
    const doc = fixture("mixed");
    segmentPage(doc);
    const ids = idsOf(spans(doc, "#abbr"));
    expect(ids).toHaveLength(2);
    expect(textOf(doc, ids[0]!)).toBe("Dr. Rossi arrived at 9.30 a.m. in St. Louis, Mo. and met J. K. Rowling.");
  });
});

describe("app fixture", () => {
  it("is an app: a large editable region and a form of inputs", () => {
    const doc = fixture("app");
    expect(isAppLikePage(doc)).toBe(true);
    const editable = page('<div contenteditable="true"><p>' + "word ".repeat(60) + "</p></div><p>Short page with one sentence here.</p>");
    expect(isAppLikePage(editable)).toBe(true);
    const inputs = page("<form>" + '<input type="text">'.repeat(31) + "</form>");
    expect(isAppLikePage(inputs)).toBe(true);
    const fewInputs = page("<form>" + '<input type="text">'.repeat(5) + '<input type="hidden">'.repeat(40) + "</form>");
    expect(isAppLikePage(fewInputs)).toBe(false);
  });
});

describe("what is never touched", () => {
  const prose = (n: number) => Array.from({ length: n }, (_, i) => `<p>Sentence number ${i} carries a plain statement of fact.</p>`).join("");

  it("hidden, aria-hidden and editable elements, and blocks that are mostly links", () => {
    const doc = page(`<main>${prose(4)}
      <p hidden>Hidden text that nobody can read right now.</p>
      <p aria-hidden="true">Decorative text hidden from assistive technology.</p>
      <p contenteditable="true">Text the user is editing at this very moment.</p>
      <p style="display:none">Text hidden with an inline style attribute.</p>
      <p id="menu"><a href="/a">Home page link</a> <a href="/b">About us page</a> <a href="/c">Contact page link</a></p>
      <p id="mixed">Read <a href="/d">the full report</a> for the numbers behind this.</p>
      <p>Hi there.</p>
    </main>`);
    const seg = segmentPage(doc);
    expect(spans(doc, "[hidden]")).toHaveLength(0);
    expect(spans(doc, "[aria-hidden]")).toHaveLength(0);
    expect(spans(doc, "[contenteditable]")).toHaveLength(0);
    expect(spans(doc, '[style="display:none"]')).toHaveLength(0);
    expect(spans(doc, "#menu")).toHaveLength(0);
    expect(spans(doc, "#mixed").length).toBeGreaterThan(0);
    expect(seg.sentences.map((s) => s.text)).not.toContain("Hi there.");
    expect(seg.sentences).toHaveLength(5);
  });

  it("headings, forms, nav, header, footer and aside, even when they sit inside the container", () => {
    const doc = page(`<main>
      <h2>A heading with enough words to be a sentence.</h2>
      ${prose(3)}
      <form><p>Fill in the form below to continue.</p></form>
      <nav><p>Jump to the section you need next.</p></nav>
      <aside><p>Related reading you might also enjoy today.</p></aside>
      <footer><p>Copyright notice and a few legal words.</p></footer>
    </main>`);
    const seg = segmentPage(doc);
    expect(seg.sentences).toHaveLength(3);
    for (const sel of ["h2", "form", "nav", "aside", "footer"]) expect(spans(doc, sel), sel).toHaveLength(0);
  });

  it("an article under a hidden ancestor is neither chosen as the container nor wrapped", () => {
    const doc = page(`
      <div id="print" aria-hidden="true"><article>${prose(6)}</article></div>
      <div id="amp" hidden><article>${prose(6)}</article></div>
      <div id="mobile" style="display:none"><article>${prose(6)}</article></div>
      <main>${prose(3)}</main>`);
    const seg = segmentPage(doc);
    expect(seg.container.localName).toBe("main");
    expect(seg.sentences).toHaveLength(3);
    for (const id of ["print", "amp", "mobile"]) {
      expect(spans(doc, `#${id}`), id).toHaveLength(0);
      // Asked directly, as the observer would for new blocks, a container under a hidden ancestor yields nothing.
      expect(segmentNewBlocks(doc, doc.querySelector(`#${id} article`)!, 100), id).toEqual([]);
      expect(spans(doc, `#${id}`), id).toHaveLength(0);
    }
  });

  it("a page whose whole body is one form is still judged; a form of controls is chrome", () => {
    const doc = page(`<form id="form1" action="./default.aspx">
      <input type="hidden" name="__VIEWSTATE" value="x">
      <div id="content">${prose(9)}</div>
      <div><input type="search" name="q"><button>Go</button></div>
    </form>`);
    const seg = segmentPage(doc);
    expect(seg.container.id).toBe("content");
    expect(seg.sentences).toHaveLength(9);

    const login = page(`<main>${prose(4)}
      <form id="login">
        <p>Sign in with the email address you registered.</p>
        <p>Forgot your password? Reset it from here.</p>
        <p>New here? Create an account in a minute.</p>
        <input type="email"><input type="password"><input type="checkbox"><button>Sign in</button>
      </form></main>`);
    expect(segmentPage(login).sentences).toHaveLength(4);
    expect(spans(login, "#login")).toHaveLength(0);
  });

  it("prose in plain divs is found; with no main content, chrome named by class or id is left alone", () => {
    const div = (n: number) => Array.from({ length: n }, (_, i) => `<div>Paragraph ${i} set in a div carries a plain statement of fact.</div>`).join("");
    // Divs count as paragraph carriers, so the wrapper of divs wins over the body.
    const forum = page(`<div class="topbar">Sign in to your account to keep reading.</div>
      <div id="posts">${div(4)}</div>
      <div class="cookie-banner">We use cookies to improve your experience on this site.</div>`);
    const seg = segmentPage(forum);
    expect(seg.container.id).toBe("posts");
    expect(seg.sentences).toHaveLength(4);
    expect(spans(forum, ".topbar")).toHaveLength(0);
    expect(spans(forum, ".cookie-banner")).toHaveLength(0);

    // Nothing scores: the body is the container, and the banners are recognised by name.
    const flat = page(`<div class="topbar">Sign in to your account to keep reading.</div>
      ${div(4)}
      <div id="cookie-notice">We use cookies to improve your experience on this site.</div>
      <div class="modal open">Subscribe to our newsletter for weekly updates.</div>`);
    const flatSeg = segmentPage(flat);
    expect(flatSeg.container).toBe(flat.body);
    expect(flatSeg.sentences).toHaveLength(4);
    expect(spans(flat, ".topbar")).toHaveLength(0);
    expect(spans(flat, "#cookie-notice")).toHaveLength(0);
    expect(spans(flat, ".modal")).toHaveLength(0);
  });

  it("layout divs with block children are not blocks themselves; a br starts a new line", () => {
    const doc = page(`<main><div id="wrap">Stray text in a wrapper that also holds paragraphs.${prose(3)}</div>
      <p id="br">First line before the break<br>Second line after the break</p></main>`);
    const seg = segmentPage(doc);
    const texts = seg.sentences.map((s) => s.text);
    expect(texts).not.toContain("Stray text in a wrapper that also holds paragraphs.");
    expect(texts).toContain("First line before the break");
    expect(texts).toContain("Second line after the break");
    expect(doc.querySelector("#br br")).not.toBeNull();
    expect(doc.querySelector("#wrap")?.hasAttribute(BLOCK_ATTR)).toBe(false);
  });
});

describe("segmentNewBlocks (SPA mutation)", () => {
  it("wraps only new blocks, numbering from the id it is given, and never re-wraps", () => {
    const doc = fixture("recipe");
    const seg = segmentPage(doc);
    const before = spans(doc).length;
    expect(segmentNewBlocks(doc, seg.container, seg.sentences.length)).toEqual([]);
    expect(spans(doc)).toHaveLength(before);

    const p = doc.createElement("p");
    p.innerHTML = "The page loaded one more paragraph after a scroll. It carries <em>two</em> more sentences to judge.";
    seg.container.appendChild(p);
    const added = segmentNewBlocks(doc, seg.container, seg.sentences.length);
    expect(added.map((s) => s.id)).toEqual([seg.sentences.length, seg.sentences.length + 1]);
    expect(added[1]?.text).toBe("It carries two more sentences to judge.");
    expect(idsOf(Array.from(p.querySelectorAll(".osso-s")))).toEqual(added.map((s) => s.id));
    expect(spans(doc)).toHaveLength(before + 4);
    expect(p.hasAttribute(BLOCK_ATTR)).toBe(true);
  });

  it("refuses a container from another document", () => {
    const a = fixture("recipe");
    const b = fixture("recipe");
    expect(() => segmentNewBlocks(a, b.body, 0)).toThrow(/another document/);
  });
});

describe("wrappers named like chrome on real sites", () => {
  it("does not take a Tailwind grid named after its sidebar for chrome (react.dev)", () => {
    const doc = fixture("tailwind");
    const { container, sentences } = segmentPage(doc);
    expect(container.closest("main")).not.toBeNull();
    expect(sentences.length).toBeGreaterThanOrEqual(12);
    expect(spans(doc, "nav")).toHaveLength(0);
    expect(spans(doc, "footer")).toHaveLength(0);
  });

  it("does not take a BEM layout__header that holds the article for chrome (MDN)", () => {
    const doc = fixture("bem");
    const { container, sentences } = segmentPage(doc);
    expect(container.closest("main")).not.toBeNull();
    expect(sentences.length).toBeGreaterThanOrEqual(10);
    expect(spans(doc, ".layout__header p").length).toBeGreaterThan(0);
    expect(spans(doc, "aside")).toHaveLength(0);
    expect(spans(doc, "header")).toHaveLength(0);
  });

  it("still leaves a small sidebar named as such alone when the body is the container", () => {
    const doc = page(`
      <p>First sentence of the actual text on this page. Second sentence with some more words in it. Third sentence to be sure.</p>
      <p>Fourth sentence of the actual text. Fifth sentence, still the text. Sixth sentence keeps going along.</p>
      <p>Seventh sentence here again. Eighth sentence here too. Ninth sentence to finish the page.</p>
      <div class="sidebar"><p>A short promo line that lives in the sidebar of the page.</p></div>`);
    const { container, sentences } = segmentPage(doc);
    expect(container).toBe(doc.body);
    expect(sentences.length).toBeGreaterThanOrEqual(9);
    expect(spans(doc, ".sidebar")).toHaveLength(0);
  });
});

describe("table-based layout", () => {
  it("reads an essay laid out in one table cell, and still never touches a data table", () => {
    const doc = fixture("table-layout");
    const { sentences } = segmentPage(doc);
    expect(sentences.length).toBeGreaterThanOrEqual(12);
    expect(sentences.some((s) => s.text.startsWith("If you collected lists"))).toBe(true);
    expect(spans(doc, "table[border='1']")).toHaveLength(0);
    // Every judged sentence lives in the layout cell.
    for (const s of spans(doc)) expect(s.closest("font")).not.toBeNull();
  });

  it("treats a table with header cells or many even cells as data", () => {
    const doc = page(`
      <table><tr><td>A cell with one sentence of text inside it here.</td><td>Another cell with one sentence of text inside.</td></tr>
      <tr><td>A third cell with one sentence of text inside it.</td><td>A fourth cell with one sentence of text inside.</td></tr>
      <tr><td>A fifth cell with one sentence of text inside it.</td><td>A sixth cell with one sentence of text inside.</td></tr></table>
      <p>Prose outside the table, first sentence of it. Second sentence of the prose. Third sentence of the prose here.</p>
      <p>Fourth sentence of the prose. Fifth one of the prose. Sixth one of the prose, and done.</p>
      <p>Seventh sentence of the prose. Eighth of the prose. Ninth of the prose, and done for good.</p>`);
    const { sentences } = segmentPage(doc);
    expect(spans(doc, "table")).toHaveLength(0);
    expect(sentences.length).toBe(9);
  });
});

describe("isAppLikePage on pages that only look busy", () => {
  const prose = Array.from({ length: 40 }, (_, i) => `<p>Paragraph ${i} of the article, with enough words in it to read as prose and not as a label on a form. It goes on for a second sentence as well.</p>`).join("");

  it("a recipe with a tick box per ingredient, rating stars and a comment form is a page to read", () => {
    const ticks = Array.from({ length: 30 }, (_, i) => `<li><input type="checkbox" id="i${i}"><label for="i${i}">Ingredient ${i}, 100 g</label></li>`).join("");
    const stars = Array.from({ length: 10 }, (_, i) => `<input type="radio" name="rating" value="${i}">`).join("");
    const doc = page(`<article>${prose}<ul>${ticks}</ul></article><form>${stars}<textarea></textarea><input type="text"><input type="email"><input type="submit"></form>`);
    expect(isAppLikePage(doc)).toBe(false);
  });

  it("many entry fields do not make an app when the text far outweighs them", () => {
    const fields = Array.from({ length: 35 }, () => `<input type="text">`).join("");
    expect(isAppLikePage(page(`<article>${prose}${prose}</article><form>${fields}</form>`))).toBe(false);
  });

  it("many entry fields with little text around them do", () => {
    const fields = Array.from({ length: 35 }, (_, i) => `<label>Field ${i}<input type="text"></label>`).join("");
    expect(isAppLikePage(page(`<h1>New invoice</h1><form>${fields}</form>`))).toBe(true);
  });
});

describe("run-in labels", () => {
  const filler = "No pancake recipe would be complete without a generous pour of milk.";
  const rest = "This ingredient provides the liquid base for the batter, and the fat content helps to keep the pancakes moist and tender. I always go for whole milk when I make pancakes, but you can use your favorite kind here. Dairy-free milk and nut milk works, too!";
  const items = `
    <li><strong>One Egg:</strong> Egg not only adds a boost of protein, but it also helps to bind the ingredients together, resulting in a fluffy and delicious stack of homemade pancakes! It is the one ingredient you cannot leave out of this batter at all.</li>
    <li id="milk"><strong>Milk:</strong> ${filler} ${rest}</li>
    <li id="dash"><b>Flour</b> – The backbone of any good pancake recipe, flour gives the pancakes their structure and texture. Make sure to measure your flour accurately to keep your pancakes from turning out dry and dense, which happens more often than you would think.</li>
    <li id="plain">Salt: a pinch is all you need, it helps to boost the flavors of the other ingredients.</li>`;

  it("never wraps the bold label that opens an item, so it can never fade; the model still reads it", () => {
    const doc = page(`<article><p>Intro one here for the page. Intro two here for the page. Intro three here.</p><ul>${items}</ul></article>`);
    const before = doc.body.textContent;
    const { sentences } = segmentPage(doc);
    expect(doc.body.textContent).toBe(before);
    expect(spans(doc, "strong")).toHaveLength(0);
    expect(spans(doc, "b")).toHaveLength(0);
    const milk = sentences.find((s) => s.text.includes("No pancake recipe"))!;
    // Context for the model: label and sentence together. On the page: the sentence alone.
    expect(milk.text).toBe(`Milk: ${filler}`);
    expect(textOf(doc, milk.id)).toBe(filler);
    const flour = sentences.find((s) => s.text.includes("backbone"))!;
    expect(flour.text.startsWith("Flour – The backbone")).toBe(true);
    expect(textOf(doc, flour.id).startsWith("The backbone")).toBe(true);
  });

  it("takes a plain 'Label:' off the front of a list item too", () => {
    const doc = page(`<article><p>Intro one here for the page. Intro two here for the page. Intro three here.</p><ul>${items}</ul></article>`);
    const { sentences } = segmentPage(doc);
    const salt = sentences.find((s) => s.text.startsWith("Salt:"))!;
    expect(textOf(doc, salt.id)).toBe("a pinch is all you need, it helps to boost the flavors of the other ingredients.");
  });

  it("does not take a bold paragraph, a long bold lead or a colon in a paragraph for a label", () => {
    const doc = page(`<article>
      <p id="allbold"><strong>This whole paragraph is set in bold by its author.</strong></p>
      <p id="longlead"><strong>A very long bold lead that runs on for many more words than any label would</strong> and then the sentence carries on for a while after it.</p>
      <p id="colon">The result: a disaster that nobody in the kitchen saw coming at all. Another sentence follows it here. And a third one to be sure.</p>
      <p>Filler paragraph one for the count. Filler paragraph two for the count. Filler three for the count.</p></article>`);
    segmentPage(doc);
    expect(spans(doc, "#allbold strong").length).toBeGreaterThan(0);
    expect(spans(doc, "#longlead strong").length).toBeGreaterThan(0);
    expect(spans(doc, "#colon")[0]!.textContent!.startsWith("The result:")).toBe(true);
  });
});
