/**
 * Segment: find the main content of a page, collect its text blocks, split them into sentences and
 * wrap each sentence in `<osso-s class="osso-s" data-osso="ID">` around the original text nodes.
 *
 * This runs on every page on the web, so the rules are conservative by construction: it only ever
 * splits text nodes and wraps them in inline elements, it never reads layout, it never touches
 * headings, tables, code, chrome (nav/header/footer/aside), forms or editable regions, and anything
 * it is unsure about it leaves alone, since untouched text stays in the author's ink, which is the safe
 * default.
 *
 * The wrapper is a custom element rather than a <span> so that no author stylesheet written against
 * structure (`article p > span`, `.entry span`) ever matches it. Everything this module inserts or
 * splits is remembered per document, so unwrapping puts the page's own text nodes back with their
 * identity intact: a framework that holds a reference to a text node it rendered still holds the
 * node that is in the document afterwards. `Node.normalize()` is never called, because it would also
 * merge the page's own adjacent text nodes and detach the ones the framework updates.
 */
import { MAX_SENTENCES_PER_PAGE, MIN_WORDS } from "../shared/constants.ts";
import { hashText } from "../shared/hash.ts";
import type { PageMeta, SentenceInput } from "../shared/types.ts";

export interface SegmentResult {
  container: Element;
  sentences: SentenceInput[];
  /** hashText of every sentence joined by "\n"; the judgment cache key. */
  contentHash: string;
  /** First 600 characters of the joined text, for pack routing. */
  sample: string;
  meta: PageMeta;
}

export interface SentenceRange {
  start: number;
  end: number;
}

export const SENTENCE_CLASS = "osso-s";
export const SENTENCE_ATTR = "data-osso";
export const BLOCK_ATTR = "data-osso-block";
/** The wrapper element: a name no stylesheet targets, inline by default like a span. */
export const SENTENCE_TAG = "osso-s";

/** A list item or caption longer than this is prose, not a label, and gets split like a paragraph. */
const UNIT_MAX_CHARS = 240;
/**
 * A div, section or cell holding fewer words than this is interface, not prose: "16,640 Reviews",
 * "Keep Screen Awake", "Get the App". A paragraph element may be as short as it likes; a layout
 * element has to read like a sentence before its text is taken for one.
 */
const LAYOUT_MIN_WORDS = 8;
const SAMPLE_CHARS = 600;
/** A block whose text is mostly link text is a menu or a tag cloud, whatever element it uses. */
const LINK_TEXT_RATIO = 0.8;

// ---------------------------------------------------------------------------------------------
// Element classes

/** Never entered: their text is not prose, or touching them can break the page. */
const SKIP_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "pre", "code", "kbd", "samp", "var",
  "nav", "header", "footer", "aside",
  "button", "select", "textarea", "input", "label", "option", "datalist", "output", "meter", "progress",
  "script", "style", "noscript", "template", "svg", "math", "iframe", "object", "embed",
  "video", "audio", "canvas", "map", "title",
]);

const SKIP_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "search", "menu", "menubar", "toolbar"]);

/** Elements whose sentences are judged. A td only ever gets here inside a layout table (see isLayoutTable). */
const JUDGED_TAGS = new Set(["p", "li", "dd", "dt", "blockquote", "figcaption", "summary", "div", "section", "article", "td"]);
/** One unit each (an ingredient, a definition term) unless long enough to be prose. */
const UNIT_TAGS = new Set(["li", "dd", "dt", "figcaption", "summary"]);
/** Only a block when they hold their own text and no block-level child; otherwise they are layout. */
const LAYOUT_TAGS = new Set(["div", "section", "article", "td"]);

/** Block-level elements: a boundary in the flow of text, whichever block they belong to. */
const BLOCK_LEVEL = new Set([
  "address", "article", "aside", "blockquote", "body", "caption", "center", "colgroup", "dd", "details", "dialog",
  "dir", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5",
  "h6", "header", "hgroup", "hr", "html", "legend", "li", "main", "menu", "nav", "ol", "p", "pre", "section",
  "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

/**
 * Text that lives directly in these is paragraph text for the purpose of scoring containers. Plain
 * divs count too: forums, older CMSs and feeds put their prose in divs, and without them every such
 * page fell through to the body.
 */
const PARAGRAPH_TAGS = new Set(["p", "li", "blockquote", "dd", "dt", "figcaption", "div", "section", "article", "td"]);
const CHROME_TAGS = new Set(["nav", "header", "footer", "aside"]);
/** Class or id tokens that mark page chrome on sites that do not use the semantic elements. */
const CHROME_HINT =
  /(^|[\s_-])(sidebar|side-bar|footer|menu|nav|navbar|navigation|breadcrumb|breadcrumbs|advert|ad|ads|related|widget|cookie|newsletter|popup|modal|promo|banner|toolbar|topbar|header)([\s_-]|$)/i;
/**
 * What readers wrote under the page: reviews, comments, replies. It is not the author's prose, and
 * the keep question is wrong there by construction: in a review the opinion is the content ("it
 * didn't disappoint", "the texture came out great"), and the question reads opinion as filler, so
 * it greyed the verdict and kept the aside. Left alone, like a table. Names that also mean an
 * article are not here on purpose: "review" is a critic's page, "discussion" a paper's section.
 */
const UGC_HINT = /(^|[\s_-])(ugc|comment|comments|reviews|feedback|disqus|replies)([\s_-]|$)/i;
const UGC_ITEMPROP = new Set(["review", "reviews", "comment"]);
const UGC_ITEMTYPE = /\/(Review|Comment|UserComments)$/;
/**
 * A recipe with two hundred reviews is mostly reviews (44% of the text on the page this was written
 * for), so the bound is looser than for chrome; above it the readers' words are the page (a forum
 * thread, a Q&A), and that page is read as it always was.
 */
const UGC_MAX_PROSE_SHARE = 0.7;

function hasUgcHint(el: Element): boolean {
  const id = el.getAttribute("id");
  if (id && UGC_HINT.test(id)) return true;
  const cls = el.getAttribute("class");
  if (cls && UGC_HINT.test(cls)) return true;
  const prop = el.getAttribute("itemprop");
  if (prop !== null && prop.split(/\s+/).some((p) => UGC_ITEMPROP.has(p.toLowerCase()))) return true;
  const type = el.getAttribute("itemtype");
  return type !== null && UGC_ITEMTYPE.test(type);
}

/**
 * The list of works a page cites. It is reference material, not prose and not filler: on an
 * encyclopedia article it was 44 of the 77 sentences judged, every one at 0.08, and more than half
 * of what the page cost. Left alone, like a table.
 */
const REFERENCE_HINT = /(^|[\s_-])(references|reference-list|reflist|ref-list|bibliography|bibliografia|citations|footnotes|endnotes|ltx_bibliography|mw-references-wrap)([\s_-]|$)/i;
const REFERENCE_ROLES = new Set(["doc-bibliography", "doc-endnotes", "doc-footnote", "doc-biblioentry"]);

function isReferenceList(el: Element): boolean {
  const tag = el.localName;
  if (tag === "cite") return true;
  const role = el.getAttribute("role");
  if (role !== null && REFERENCE_ROLES.has(role.toLowerCase())) return true;
  if (tag !== "ol" && tag !== "ul" && tag !== "div" && tag !== "section" && tag !== "dl") return false;
  const id = el.getAttribute("id");
  if (id && REFERENCE_HINT.test(id)) return true;
  const cls = el.getAttribute("class");
  return !!cls && REFERENCE_HINT.test(cls);
}

/** Elements a form counts as prose when deciding whether it is the page or a widget. */
const FORM_PROSE = "p, li, blockquote, dd, dt, figcaption";
const FORM_CONTROLS = "input:not([type=hidden]), select, textarea, button";

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/**
 * A form is chrome (search, login, newsletter, comment box) unless it is the page: ASP.NET WebForms
 * and many older portals wrap the whole document in one form, and those still deserve judging.
 */
function formIsChrome(form: Element): boolean {
  const prose = form.querySelectorAll(FORM_PROSE).length;
  if (prose < 3) return true;
  return form.querySelectorAll(FORM_CONTROLS).length >= prose;
}

/** Not on screen, or being edited: never judged, and never counted when choosing the container. */
function isHidden(el: Element): boolean {
  if (el.hasAttribute("hidden")) return true;
  if (el.getAttribute("aria-hidden") === "true") return true;
  const editable = el.getAttribute("contenteditable");
  if (editable !== null && editable.toLowerCase() !== "false") return true;
  // The inline style attribute is markup, not layout: reading it never forces a reflow.
  if (el.hasAttribute("style")) {
    const style = (el as HTMLElement).style;
    if (style && (style.display === "none" || style.visibility === "hidden")) return true;
  }
  return false;
}

/**
 * A table is data (never touched) unless it is plainly the page's layout: no header cells, no
 * caption, and either a handful of cells or one cell holding most of its text. Hand-written sites
 * of the older web (essays, manifestos, university pages) put the whole article in one td, and
 * "never touch a table" left every one of them untouched. Memoised: the walk asks many times.
 */
const LAYOUT_TABLE_MAX_CELLS = 4;
const LAYOUT_TABLE_MAIN_CELL_SHARE = 0.6;
const layoutTables = new WeakMap<Element, boolean>();

function isLayoutTable(table: Element): boolean {
  const memo = layoutTables.get(table);
  if (memo !== undefined) return memo;
  let value = false;
  const rows = (table as HTMLTableElement).rows;
  if (rows && !table.querySelector("th, caption")) {
    const cells: Element[] = [];
    for (const row of Array.from(rows)) cells.push(...Array.from(row.cells));
    if (cells.length <= LAYOUT_TABLE_MAX_CELLS) value = true;
    else {
      let total = 0;
      let largest = 0;
      for (const cell of cells) {
        const n = textLength(cell);
        total += n;
        if (n > largest) largest = n;
      }
      value = total > 0 && largest >= LAYOUT_TABLE_MAIN_CELL_SHARE * total;
    }
  }
  layoutTables.set(table, value);
  return value;
}

function isSkipped(el: Element): boolean {
  const tag = el.localName;
  if (tag === "table") return !isLayoutTable(el);
  if (SKIP_TAGS.has(tag)) return true;
  if (tag === "form" && formIsChrome(el)) return true;
  if (isHidden(el)) return true;
  if (isReferenceList(el)) return true;
  const role = el.getAttribute("role");
  if (role !== null && role.split(/\s+/).some((r) => SKIP_ROLES.has(r.toLowerCase()))) return true;
  return false;
}

function hasChromeHint(el: Element): boolean {
  const id = el.getAttribute("id");
  if (id && CHROME_HINT.test(id)) return true;
  const cls = el.getAttribute("class");
  return !!cls && CHROME_HINT.test(cls);
}

/** Chrome by structure: the semantic elements, roles, widget forms and editors. Names are judged separately. */
function isChrome(el: Element): boolean {
  const tag = el.localName;
  if (CHROME_TAGS.has(tag)) return true;
  if (tag === "form" && formIsChrome(el)) return true;
  const role = el.getAttribute("role");
  if (role !== null && SKIP_ROLES.has(role.toLowerCase())) return true;
  const editable = el.getAttribute("contenteditable");
  return editable !== null && editable.toLowerCase() !== "false";
}

/**
 * A name hint ("sidebar", "header", "ad") only counts against an element that holds a minority of
 * the page's prose. Real pages put the article inside `div.layout__header` (BEM) or under
 * `div.lg:grid-cols-sidebar-content` (Tailwind), and a hint honoured there swallowed the whole
 * page: react.dev and MDN came back with nothing at all. Chrome is, by definition, not where the
 * prose is.
 */
const HINT_MAX_PROSE_SHARE = 0.3;

export function textLength(el: Element): number {
  return (el.textContent ?? "").replace(/\s+/g, "").length;
}

function isSemanticMain(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.localName;
  return tag === "article" || tag === "main" || el.getAttribute("role") === "main";
}

function isCandidate(el: Element): boolean {
  const tag = el.localName;
  return tag === "div" || tag === "section" || tag === "td" || isSemanticMain(el);
}

// ---------------------------------------------------------------------------------------------
// Main container

/**
 * Score every article/main/[role=main]/div/section by the paragraph text under it: text inside
 * links counts against (menus, tag clouds, "related" grids), and text under page chrome counts
 * against at half weight, so a wrapper that adds only a nav and a comments section to an article
 * scores lower than the article alone, while a wrapper that adds a recipe card scores higher.
 * Hidden subtrees (a print or AMP duplicate of the article, an app root behind a modal) are
 * invisible to the scoring, so they can neither win nor pull the winner towards them. The
 * best-scoring element wins; ties go to the tighter one. Nothing positive → body.
 */
export function findMainContainer(doc: Document): Element | null {
  const root = doc.body ?? doc.documentElement;
  if (!root) return null;

  const candidates = new Map<Element, { score: number; paragraphs: number }>();
  const proseUnder = new Map<Element, number>();
  const texts: Array<{ block: Element; inLink: boolean; length: number }> = [];
  let total = 0;

  const walker = doc.createTreeWalker(root, 1 | 4 /* SHOW_ELEMENT | SHOW_TEXT */, {
    acceptNode: (node) => {
      if (node.nodeType === ELEMENT_NODE) {
        const el = node as Element;
        const tag = el.localName;
        // Chrome stays in the walk so that its text can count against its ancestors.
        if (tag === "table") return isLayoutTable(el) ? 1 /* ACCEPT */ : 2 /* REJECT */;
        if (SKIP_TAGS.has(tag) && !CHROME_TAGS.has(tag)) return 2 /* REJECT */;
        return isHidden(el) ? 2 /* REJECT */ : 1 /* ACCEPT */;
      }
      return (node as Text).data.trim().length > 0 ? 1 : 3 /* SKIP */;
    },
  });

  // Pass one: where the prose is. Every character is credited to each of its ancestors, so a
  // name hint can be weighed against how much of the page the element actually holds.
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.nodeType === ELEMENT_NODE) {
      const el = node as Element;
      if (isCandidate(el)) candidates.set(el, { score: 0, paragraphs: 0 });
      continue;
    }
    const text = node as Text;
    let inLink = false;
    let block = text.parentElement;
    while (block && block !== root && !BLOCK_LEVEL.has(block.localName)) {
      if (block.localName === "a") inLink = true;
      block = block.parentElement;
    }
    if (!block || block === root || !PARAGRAPH_TAGS.has(block.localName)) continue;

    const length = text.data.trim().length;
    let structuralChrome = false;
    for (let ancestor: Element | null = block; ancestor && ancestor !== root; ancestor = ancestor.parentElement) {
      proseUnder.set(ancestor, (proseUnder.get(ancestor) ?? 0) + length);
      if (isChrome(ancestor)) structuralChrome = true;
    }
    // The share a name hint is weighed against is the page's prose outside nav, header, footer and
    // aside: a documentation site's menu can hold more text than its article.
    if (!structuralChrome) total += length;
    texts.push({ block, inLink, length });
  }

  const hintIsChrome = (el: Element): boolean =>
    (hasChromeHint(el) && (proseUnder.get(el) ?? 0) < HINT_MAX_PROSE_SHARE * total) || (hasUgcHint(el) && (proseUnder.get(el) ?? 0) < UGC_MAX_PROSE_SHARE * total);
  const chromeMemo = new Map<Element, boolean>();
  const underChrome = (el: Element): boolean => {
    const memo = chromeMemo.get(el);
    if (memo !== undefined) return memo;
    let value: boolean;
    // <main> and <article> are content whatever wraps them; nothing above them can make them chrome.
    if (isSemanticMain(el)) value = false;
    else {
      const parent = el.parentElement;
      value = isChrome(el) || hintIsChrome(el) || (parent !== null && parent !== root && underChrome(parent));
    }
    chromeMemo.set(el, value);
    return value;
  };

  // Pass two: score the candidates. Text inside links counts for nothing rather than against: a
  // menu or a grid of link cards then scores zero and cannot win, while a reference page whose
  // prose is a third links (MDN) is not punished for being well cross-referenced.
  const seenParagraphs = new Set<Element>();
  for (const { block, inLink, length } of texts) {
    const contribution = underChrome(block) ? -length / 2 : inLink ? 0 : length;
    const isNew = !seenParagraphs.has(block);
    if (isNew) seenParagraphs.add(block);
    for (let ancestor = block.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const entry = candidates.get(ancestor);
      if (!entry) continue;
      entry.score += contribution;
      if (isNew) entry.paragraphs += 1;
    }
  }

  let best: Element | null = null;
  let bestScore = 0;
  for (const [el, entry] of candidates) {
    const semantic = isSemanticMain(el);
    if (!semantic && entry.paragraphs < 3) continue;
    if (entry.score <= 0) continue;
    // At equal score the later (inner) element wins over its wrapper, except that a plain div never
    // displaces the article it fills: new content appended to the article should still be seen.
    const wins = entry.score > bestScore || (entry.score === bestScore && (semantic || !isSemanticMain(best)));
    if (wins) {
      best = el;
      bestScore = entry.score;
    }
  }
  return best ?? root;
}

// ---------------------------------------------------------------------------------------------
// Sentence splitting

/**
 * Abbreviations that end in a period without ending the sentence. Matched case-insensitively,
 * except the ones that are also ordinary words when lower-cased ("no." ends a sentence, "No. 5"
 * does not). Single letters (initials) and one- or two-digit enumerators are handled separately.
 */
const ABBREVIATIONS = [
  "Mr", "Mrs", "Ms", "Dr", "Prof", "St", "vs", "etc", "No", "approx", "i.e", "e.g", "a.m", "p.m", "Inc", "Ltd",
  "Co", "Jr", "Sr", "Sig", "Sig.ra", "Dott", "Ing", "Avv", "art", "n", "pag", "cfr", "ca", "min", "max",
  "ecc", "Prof.ssa", "Dott.ssa", "fig", "vol", "pp", "Corp", "Univ", "Ave", "Blvd", "Mt", "Capt", "Lt", "Sgt",
  "Gen", "Col", "Rev", "Rep", "Sen", "Gov", "Pres", "Hon", "Messrs", "Mme", "Mlle", "tel",
  // Papers: "Hart et al. [45] and…" is one sentence, and so is "Colobus congoensis sp. nov. in…".
  "lit", "transl", "pron", "est", "esp", "incl", "viz", "al", "Fig", "Figs", "Eq", "Eqs", "Ref", "Refs", "Tab", "Sec", "cf", "sp", "spp", "nov", "ed", "eds", "resp", "ibid",
];
const CASE_SENSITIVE_ABBREVIATIONS = new Set(["No", "Gen", "Col", "Rev", "Rep", "Sen", "Gov", "Pres", "Hon"]);
const ABBREVIATION_SET = new Set(
  ABBREVIATIONS.flatMap((a) => (CASE_SENSITIVE_ABBREVIATIONS.has(a) ? [a] : [a, a.toLowerCase()])),
);

/**
 * The footnote markers a wiki glues to the full stop: ".[16]", ".[5][7]", ".[citation needed]".
 * Without them "…as a dietary fad.[10] The United States…" ran on as one sentence, and on
 * Wikipedia 43 to 68% of an article was judged in lumps of two to five sentences.
 */
const FOOTNOTES = String.raw`(?:\[[^\[\]\n]{1,30}\])*`;
/**
 * A terminator run, then any closing quotes or brackets and footnote markers that belong to the
 * sentence. Beyond the Latin set: the CJK full stop, exclamation and question marks, the Arabic
 * question mark, the Urdu full stop and the Devanagari danda, so a page in those scripts splits
 * into sentences at all.
 */
const TERMINATOR = new RegExp(String.raw`[.!?…。！？؟۔।॥]+[)\]"'”’»›」』）】]*` + FOOTNOTES, "gu");
/** Full-width punctuation sits flush against the next sentence: no whitespace is expected after it. */
const FLUSH_TERMINATOR = /[。！？]/u;
/** What may open the next sentence: capital, digit, opening quote or bracket. Caseless scripts are handled in isStarter. */
const STARTER = /^[\p{Lu}\p{N}"'“‘«‹(\[「『（]/u;
const LETTER = /^\p{L}$/u;
const TOKEN_CHAR = /[\p{L}\p{N}.]/u;
const SINGLE_LETTER = /^\p{L}$/u;
const ENUMERATOR = /^\d{1,2}$/;
const WORD = /[\p{L}\p{N}]+(?:['’]\p{L}+)?/gu;
/** Scripts written without spaces between words: each character counts as a word for the length rules. */
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;

/** A footnote marker glued to the word before it ("fad.[10]", "Mercury,[17]"): a reference, not a word. */
const GLUED_FOOTNOTE = /(?<=\S)\[[^\[\]\n]{1,30}\]/gu;

export function countWords(text: string): number {
  const bare = text.includes("[") ? text.replace(GLUED_FOOTNOTE, " ") : text;
  const cjk = bare.match(CJK_CHAR);
  const rest = (cjk ? bare.replace(CJK_CHAR, " ") : bare).match(WORD);
  return (cjk ? cjk.length : 0) + (rest ? rest.length : 0);
}

/**
 * Whether a sentence may start at `at`: the Latin rule (capital, digit, opening quote), or any
 * letter of a script that has no case at all (Arabic, Hebrew, Thai, Devanagari, CJK) where the
 * capital test would otherwise mean "never".
 */
function isStarter(text: string, at: number): boolean {
  if (STARTER.test(text.slice(at, at + 2))) return true;
  const cp = text.codePointAt(at);
  if (cp === undefined) return false;
  const ch = String.fromCodePoint(cp);
  return LETTER.test(ch) && ch.toLowerCase() === ch.toUpperCase();
}

function isAbbreviation(token: string): boolean {
  if (ABBREVIATION_SET.has(token) || ABBREVIATION_SET.has(token.toLowerCase())) return true;
  return CASE_SENSITIVE_ABBREVIATIONS.has(token);
}

/**
 * Whether a lone period at `index` (the period itself) closes a sentence, judging by the word before
 * it. `footnoted` when a footnote marker follows the period: that is the writer's full stop ("Saturn
 * V.[45]", "Apollo 8.[50]", "July 27.[209]"), so a letter or a short number before it is no initial
 * or enumerator, and only a true abbreviation ("e.g.[3]", "et al.[12]") keeps the sentence open.
 */
function periodEndsSentence(text: string, index: number, footnoted = false): boolean {
  let start = index;
  while (start > 0 && TOKEN_CHAR.test(text[start - 1]!)) start--;
  const token = text.slice(start, index);
  if (token.length === 0) return true;
  if (footnoted) return !isAbbreviation(token) && !isAbbreviation(token.slice(token.lastIndexOf(".") + 1));
  if (SINGLE_LETTER.test(token)) return false;
  // A list number opens its sentence ("2. Mix the flour"); a number that ends one ("…Giulia a 58.") is a full stop.
  if (ENUMERATOR.test(token) && opensSentence(text, start)) return false;
  if (isAbbreviation(token)) return false;
  // "U.S." / "Ph.D." / "e.g.": judge the part after the last inner period as well.
  const tail = token.slice(token.lastIndexOf(".") + 1);
  if (tail !== token && (SINGLE_LETTER.test(tail) || isAbbreviation(tail) || tail.length === 0)) return false;
  return true;
}

/** Whether the token at `start` opens its line or its sentence, as a list number does: nothing before it but a terminator, a bullet or a bracket. */
function opensSentence(text: string, start: number): boolean {
  let i = start - 1;
  while (i >= 0 && isWhitespace(text[i]!)) i--;
  return i < 0 || /[.!?…:;(\[•·–—-]/.test(text[i]!);
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === " " || ch === "\r" || ch === "\n" || /\s/.test(ch);
}

/**
 * Boundaries inside one line: offsets (absolute, within `text`) where a new sentence starts. The
 * regex runs over the line alone, so a block of thousands of terminator-less lines (lyrics, a chat
 * export) costs one scan of the text rather than one scan per line.
 */
function lineBoundaries(text: string, lineStart: number, lineEnd: number, out: number[]): void {
  const line = text.slice(lineStart, lineEnd);
  TERMINATOR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TERMINATOR.exec(line))) {
    const run = m[0];
    const after = m.index + run.length;
    if (after >= line.length) break;
    if (!FLUSH_TERMINATOR.test(run) && !isWhitespace(line[after]!)) continue;
    let next = after;
    while (next < line.length && isWhitespace(line[next]!)) next++;
    if (next >= line.length) break;
    if (!isStarter(line, next)) continue;
    if (run[0] === "." && (run.length === 1 || !/^[.!?…]/.test(run[1]!)) && !periodEndsSentence(line, m.index, run.includes("["))) continue;
    out.push(lineStart + next);
    TERMINATOR.lastIndex = next;
  }
}

/**
 * Sentence ranges in `text`, as [start, end) offsets that exclude surrounding whitespace.
 * A boundary is a terminator (with any closing quote or bracket) followed by whitespace and a
 * capital, digit or opening quote; "Dr.", "9.99", "J. K." and "e.g." do not split, "…" splits
 * only before a capital. Newlines always split. Pieces under MIN_WORDS words fold into the
 * previous piece, or the next when they come first, so no fragment is ever judged alone.
 */
export function splitSentences(text: string): SentenceRange[] {
  const boundaries: number[] = [];
  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    const ch = i < text.length ? text[i] : "\n";
    if (ch !== "\n" && ch !== "\r") continue;
    if (i > lineStart) lineBoundaries(text, lineStart, i, boundaries);
    if (i < text.length) boundaries.push(i + 1);
    lineStart = i + 1;
  }

  const pieces: SentenceRange[] = [];
  let start = 0;
  for (let b = 0; b <= boundaries.length; b++) {
    const end = b < boundaries.length ? boundaries[b]! : text.length;
    let s = start;
    let e = end;
    while (s < e && isWhitespace(text[s]!)) s++;
    while (e > s && isWhitespace(text[e - 1]!)) e--;
    if (s < e) pieces.push({ start: s, end: e });
    start = end;
  }

  const out: SentenceRange[] = [];
  let pendingStart = -1;
  for (const piece of pieces) {
    const pieceText = text.slice(piece.start, piece.end);
    const words = countWords(pieceText);
    // A tag at the end of a paragraph ("Edited", "Read more", "Sponsored") is a label: it does not
    // end like a sentence and it is not one. Joined to the sentence before it, as a short piece
    // otherwise is, it was greyed and struck with it and read as part of the page's words.
    if (piece === pieces[pieces.length - 1] && out.length > 0 && words <= TAIL_LABEL_MAX_WORDS && !ENDS_SENTENCE.test(pieceText)) continue;
    if (words >= MIN_WORDS) {
      out.push({ start: pendingStart >= 0 ? pendingStart : piece.start, end: piece.end });
      pendingStart = -1;
      continue;
    }
    const previous = out[out.length - 1];
    if (previous) previous.end = piece.end;
    else if (pendingStart < 0) pendingStart = piece.start;
  }
  if (pendingStart >= 0 && out.length === 0) {
    const last = pieces[pieces.length - 1]!;
    out.push({ start: pendingStart, end: last.end });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// What we did to the page, so it can be undone wherever the nodes are now

interface Registry {
  /** Every wrapper we inserted, connected or not: a view a router detached and cached still comes apart at teardown. */
  spans: Set<Element>;
  blocks: Set<Element>;
  /** A page text node → the nodes cut off it by splitText, so unwrap can give it its characters back. */
  splits: Map<Text, Text[]>;
}

const registries = new WeakMap<Document, Registry>();

function registryOf(doc: Document): Registry {
  let reg = registries.get(doc);
  if (!reg) {
    reg = { spans: new Set(), blocks: new Set(), splits: new Map() };
    registries.set(doc, reg);
  }
  return reg;
}

// ---------------------------------------------------------------------------------------------
// Block collection

interface TextSegment {
  node: Text;
  /** Offsets of this node's data within the block's text. */
  start: number;
  end: number;
}

interface Block {
  el: Element;
  unit: boolean;
  layout: boolean;
  parts: string[];
  segments: TextSegment[];
  length: number;
  hasBlockChild: boolean;
  /** Set by a <br> or a nested block: the next text starts on a new line. */
  pendingBreak: boolean;
  textChars: number;
  linkChars: number;
}

function newBlock(el: Element): Block {
  const tag = el.localName;
  return {
    el,
    unit: UNIT_TAGS.has(tag),
    layout: LAYOUT_TAGS.has(tag),
    parts: [],
    segments: [],
    length: 0,
    hasBlockChild: false,
    pendingBreak: false,
    textChars: 0,
    linkChars: 0,
  };
}

const SOURCE_WHITESPACE = /[\r\n\t\f\v]/g;
const NON_SPACE = /\S/g;

function addText(block: Block, node: Text, inLink: boolean): void {
  if (block.pendingBreak) {
    // A virtual newline: it belongs to no text node, so offsets stay aligned with the DOM.
    if (block.length > 0) {
      block.parts.push("\n");
      block.length += 1;
    }
    block.pendingBreak = false;
  }
  // Source newlines inside a paragraph render as spaces; only <br> and nested blocks break lines.
  const data = node.data.replace(SOURCE_WHITESPACE, " ");
  const start = block.length;
  block.parts.push(data);
  block.length += data.length;
  block.segments.push({ node, start, end: block.length });
  const visible = data.match(NON_SPACE);
  const chars = visible ? visible.length : 0;
  block.textChars += chars;
  if (inLink) block.linkChars += chars;
}

interface Walk {
  /** The container: never skipped by its own class name, whatever it is called. */
  root: Element;
  /**
   * True when the container is the body, i.e. no main content was found: then anything that looks
   * like chrome by its class or id (a cookie banner, a top bar, a modal) is left alone too, since
   * there is no article boundary keeping it out, unless it holds most of the page's text, in
   * which case the name is just a name.
   */
  hintSkip: boolean;
  /** Characters of text under the container, for the share rule above. */
  total: number;
}

/** A block already wrapped is not wrapped again, unless the page replaced its content and our wrappers went with it. */
function isWrapped(el: Element): boolean {
  return el.hasAttribute(BLOCK_ATTR) && el.querySelector(`.${SENTENCE_CLASS}`) !== null;
}

function visit(el: Element, block: Block | null, inLink: boolean, out: Block[], walk: Walk): void {
  const tag = el.localName;
  const blockLevel = BLOCK_LEVEL.has(tag);
  // Chrome by name is only asked of a page with no container of its own; what readers wrote is
  // asked everywhere, because publishers put the reviews inside the <article>.
  const byName =
    el !== walk.root &&
    ((walk.hintSkip && hasChromeHint(el) && textLength(el) < HINT_MAX_PROSE_SHARE * walk.total) || (hasUgcHint(el) && textLength(el) < UGC_MAX_PROSE_SHARE * walk.total));
  if (isSkipped(el) || byName) {
    if (blockLevel && block) {
      block.pendingBreak = true;
      block.hasBlockChild = true;
    }
    return;
  }
  if (tag === "br") {
    if (block) block.pendingBreak = true;
    return;
  }
  if (blockLevel) {
    if (block) {
      block.pendingBreak = true;
      block.hasBlockChild = true;
    }
    // Blocks nested inside a wrapped block may still be new.
    block = JUDGED_TAGS.has(tag) && !isWrapped(el) ? newBlock(el) : null;
    if (block) out.push(block);
  } else if (tag === "a") {
    inLink = true;
  }
  for (let child = el.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === TEXT_NODE) {
      if (block) addText(block, child as Text, inLink);
    } else if (child.nodeType === ELEMENT_NODE) {
      visit(child as Element, block, inLink, out, walk);
    }
  }
}

const BOLD_TAGS = new Set(["strong", "b"]);
const LABEL_MAX_WORDS = 8;
const LABEL_MIN_REST_WORDS = 3;
/** What may close a bold label from outside the bold: a colon, a dash. */
/** The punctuation a run-in label ends with, as the world's pages write it: the em dash belongs here because they use it, not because we do. */
const LABEL_PUNCT = /^\s*[:–—-]/;
/** A plain "Label: text" at the head of a list item, the label short and with no sentence in it. */
const PLAIN_LABEL = /^\s*([^\n.!?:]{1,48}):(?=\s)/;
const PLAIN_LABEL_MAX_WORDS = 5;

function isBold(node: Node, root: Element): boolean {
  for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
    if (BOLD_TAGS.has(el.localName)) return true;
  }
  return false;
}

/**
 * Where a block's run-in label ends, in the block's text, or 0 when it has none. "**Milk:** No
 * pancake recipe would be complete without…" opens with a label: it names what the item is about,
 * the way a heading names a section, and like a heading it is structure, not prose. It is never
 * wrapped, so it can never fade: a recipe once lost "Milk:" from its ingredient notes because the
 * sentence after it was, rightly, judged filler. The label still goes to the model with its
 * sentence, as context.
 */
function labelEnd(block: Block, text: string): number {
  let end = 0;
  let sawBold = false;
  for (const seg of block.segments) {
    if (isBold(seg.node, block.el)) {
      sawBold = true;
      end = seg.end;
      continue;
    }
    // Whitespace before the bold run is skipped; anything else ends it.
    if (!sawBold && text.slice(seg.start, seg.end).trim() === "") continue;
    break;
  }
  if (sawBold) {
    const closing = LABEL_PUNCT.exec(text.slice(end));
    if (closing) end += closing[0].length;
  } else if (block.unit) {
    const plain = PLAIN_LABEL.exec(text);
    if (plain && countWords(plain[1]!) <= PLAIN_LABEL_MAX_WORDS) end = plain[0].length;
  }
  if (end === 0) return 0;
  const words = countWords(text.slice(0, end));
  if (words < 1 || words > LABEL_MAX_WORDS) return 0;
  // A block that is all label (a bold paragraph, a bare term) has no run-in label: it is just bold.
  if (countWords(text.slice(end)) < LABEL_MIN_REST_WORDS) return 0;
  return end;
}

/** The ranges as they are wrapped: the same sentences, with the label cut off the front of whichever one holds it. */
function withoutLabel(ranges: SentenceRange[], label: number, text: string): SentenceRange[] {
  if (label <= 0) return ranges;
  return ranges.map((r) => {
    if (r.start >= label) return r;
    let start = Math.min(label, r.end);
    while (start < r.end && isWhitespace(text[start]!)) start++;
    return { start, end: r.end };
  });
}

/** A caption's opening: "Fig 1.", "Figure 2:", "Table 3.", "Tabella 1", "Scheme 4". */
const CAPTION = /^\s*(fig(ure|ura)?s?|tab(le|ella)?s?|scheme|box|chart|equation|eq)\.?\s*\d+/i;
const TAIL_LABEL_MAX_WORDS = 3;
const ENDS_SENTENCE = new RegExp(String.raw`[.!?…。！？]["'”’»)\]]*` + FOOTNOTES + String.raw`\s*$`, "u");
/** A sentence that opens a list ends on its colon, or on the footnotes a wiki puts after it ("…were:[61][62]"). */
const LEAD_IN = new RegExp(":" + FOOTNOTES + String.raw`\s*$`, "u");
/**
 * A block that is a short question and nothing else: the heading of the answer under it, in an FAQ.
 * "How much does it cost? (and what are credits)?" is still one heading, so what is ruled out is a
 * statement anywhere in the block, not a second question mark.
 */
const QUESTION_MAX_WORDS = 18;
const ONE_QUESTION = /^[^.!]*\?["'”’»)\]]*\s*$/u;
const HEADING_MAX_WORDS = 8;
const BOLD_HEADING_MAX_WORDS = 14;
const CAPTION_MAX_WORDS = 14;

/**
 * Text that is structure, not prose, whatever element it sits in: a heading written as a paragraph
 * ("Multi-Head Attention", "Ricetta risotto alla milanese con kimchi"), a caption ("Table 1.
 * Comparative skeletal sample…"), a short figcaption, the question that heads its answer in an FAQ
 * ("Quante uova servono per la carbonara?"). Like a real heading it names what follows,
 * so it is never wrapped and can never fade. List items are left out of the first rule: an
 * ingredient is four words with no full stop and is exactly what the reader came for.
 */
function isStructure(block: Block, text: string): boolean {
  const tag = block.el.localName;
  const words = countWords(text);
  if (CAPTION.test(text)) return true;
  if (tag === "figcaption" && words <= CAPTION_MAX_WORDS) return true;
  // "The policy must disclose: (a) how your product collects, uses and shares user data": the item
  // is the rest of the sentence the colon left open, not a sentence of its own. Read alone it looks
  // like a heading, and the model put it at 0.43 on one page and under the threshold on another.
  if (!ENDS_SENTENCE.test(text) && continuesLeadIn(block.el)) return true;
  if (block.unit) return false;
  // "How much does it cost?" over its answer is a heading that happens to end in a question mark.
  if (words <= QUESTION_MAX_WORDS && ONE_QUESTION.test(text)) return true;
  // A heading does not end like a sentence; a bold sentence with its full stop is emphasis, not a heading.
  if (ENDS_SENTENCE.test(text)) return false;
  if (words <= HEADING_MAX_WORDS) return true;
  return words <= BOLD_HEADING_MAX_WORDS && block.segments.every((s) => isBold(s.node, block.el) || text.slice(s.start, s.end).trim() === "");
}

const colonLists = new WeakMap<Element, boolean>();

/**
 * Whether this block is an item of a list that a colon introduces: the text just before the list,
 * in a paragraph before it or in the item the list is nested in, ends in a colon. The sentence that
 * ends in the colon is already structure (greying it orphans what it introduces); an item that does
 * not end like a sentence is its other half.
 */
function continuesLeadIn(el: Element): boolean {
  const list = el.closest("li, dd")?.parentElement;
  if (!list) return false;
  const known = colonLists.get(list);
  if (known !== undefined) return known;
  let value = false;
  for (let node: Node | null = list.previousSibling; node; node = node.previousSibling) {
    const before = (node.textContent ?? "").trim();
    if (before === "") continue;
    value = LEAD_IN.test(before);
    break;
  }
  colonLists.set(list, value);
  return value;
}

/** The sentence ranges to wrap in a block, or null when the block is not judged at all. */
function rangesFor(block: Block, text: string): SentenceRange[] | null {
  if (block.layout && block.hasBlockChild) return null;
  if (block.layout && countWords(text) < LAYOUT_MIN_WORDS) return null;
  if (block.textChars === 0) return null;
  if (block.linkChars / block.textChars >= LINK_TEXT_RATIO) return null;
  if (countWords(text) < MIN_WORDS) return null;
  if (isStructure(block, text)) return null;
  if (block.unit) {
    let s = 0;
    let e = text.length;
    while (s < e && isWhitespace(text[s]!)) s++;
    while (e > s && isWhitespace(text[e - 1]!)) e--;
    if (e - s <= UNIT_MAX_CHARS) return [{ start: s, end: e }];
  }
  const ranges = splitSentences(text);
  return ranges.length > 0 ? ranges : null;
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function wrapNode(reg: Registry, node: Text, id: number): void {
  const parent = node.parentNode;
  if (!parent) return;
  const span = node.ownerDocument.createElement(SENTENCE_TAG);
  span.className = SENTENCE_CLASS;
  span.setAttribute(SENTENCE_ATTR, String(id));
  parent.insertBefore(span, node);
  span.appendChild(node);
  reg.spans.add(span);
}

/**
 * Split the block's text nodes at the sentence boundaries and wrap every resulting node. A sentence
 * that crosses inline markup becomes several wrappers with the same id; the inline elements never
 * move. Each node is cut from its last range to its first: splitText copies only the tail it cuts
 * off, so a node holding a thousand sentences splits in linear time rather than quadratic. The page's
 * own node keeps the head of its text and stays where it was.
 */
function wrapRanges(reg: Registry, block: Block, ranges: SentenceRange[], firstId: number): void {
  let r = 0;
  for (const segment of block.segments) {
    while (r < ranges.length && ranges[r]!.end <= segment.start) r++;
    let last = r;
    while (last < ranges.length && ranges[last]!.start < segment.end) last++;
    if (last === r) continue;
    const node = segment.node;
    const pieces = reg.splits.get(node) ?? [];
    for (let i = last - 1; i >= r; i--) {
      const range = ranges[i]!;
      const a = Math.max(range.start, segment.start) - segment.start;
      const b = Math.min(range.end, segment.end) - segment.start;
      if (a >= b) continue;
      if (b < node.length) pieces.push(node.splitText(b));
      const piece = a > 0 ? node.splitText(a) : node;
      if (piece !== node) pieces.push(piece);
      wrapNode(reg, piece, firstId + i);
    }
    if (pieces.length > 0) reg.splits.set(node, pieces);
    // The last range may run on into the next segment; every earlier one is done.
    r = ranges[last - 1]!.end > segment.end ? last - 1 : last;
  }
}

/**
 * Wrap every judged block under `container` that is not yet marked, numbering sentences from
 * `startId`. This is the whole of segmentation for a MutationObserver pass; segmentPage adds the
 * page-level hash, sample and meta on top. Reading happens before any writing, so a block whose
 * text nodes are being split is never being walked at the same time. A container under a hidden
 * or editable ancestor yields nothing: the spec's "never touched" holds for ancestors as well.
 */
export function segmentNewBlocks(doc: Document, container: Element, startId: number): SentenceInput[] {
  if (container.ownerDocument !== doc) throw new Error("[osso] container belongs to another document");
  for (let ancestor = container.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (isSkipped(ancestor)) return [];
  }
  const reg = registryOf(doc);
  const blocks: Block[] = [];
  const fallback = container === doc.body || container === doc.documentElement;
  visit(container, null, false, blocks, { root: container, hintSkip: fallback, total: textLength(container) });

  // Blocks the page is not showing (a collapsed panel, an error message waiting for its error, a
  // print copy of the nutrition notes) are neither judged nor paid for; when the page shows one,
  // the observer brings it in. Every rectangle is read before the first write, so asking costs no
  // reflow. A document with no layout at all (a test, a detached view) skips the question.
  const laidOut = (doc.body?.getClientRects().length ?? 0) > 0;
  const shown = laidOut ? blocks.map((b) => b.el.getClientRects().length > 0) : null;

  const sentences: SentenceInput[] = [];
  let id = startId;
  for (let n = 0; n < blocks.length; n++) {
    // Ids count the page's sentences across every pass, so this is the page's cap and not the pass's.
    // It falls between blocks, never inside one.
    if (id >= MAX_SENTENCES_PER_PAGE) break;
    const block = blocks[n]!;
    if (shown && !shown[n]) continue;
    if (block.segments.length === 0) continue;
    const text = block.parts.join("");
    const all = rangesFor(block, text);
    if (!all) continue;
    // A sentence that ends in a colon introduces what follows it (a list, a formula, a quotation):
    // greying it would orphan the thing it introduces, so it is structure and is left out.
    const ranges = all.filter((r) => !LEAD_IN.test(text.slice(r.start, r.end)));
    if (ranges.length === 0) continue;
    for (let i = 0; i < ranges.length; i++) {
      const range = ranges[i]!;
      sentences.push({ id: id + i, text: cleanText(text.slice(range.start, range.end)) });
    }
    // The model reads the label with its sentence; the page never has it wrapped.
    wrapRanges(reg, block, withoutLabel(ranges, labelEnd(block, text), text), id);
    block.el.setAttribute(BLOCK_ATTR, "");
    reg.blocks.add(block.el);
    id += ranges.length;
  }
  return sentences;
}

export function segmentPage(doc: Document): SegmentResult {
  const container = findMainContainer(doc);
  if (!container) throw new Error("[osso] document has no body to segment");
  const sentences = segmentNewBlocks(doc, container, 0);
  const joined = sentences.map((s) => s.text).join("\n");
  const sample = joined.slice(0, SAMPLE_CHARS);
  return {
    container,
    sentences,
    contentHash: hashText(joined),
    sample,
    meta: collectPageMeta(doc, sample, sentences.length),
  };
}

/**
 * Undo segmentation under `scope` (the whole document when null): wrappers come out, block marks
 * go, and every text node we split gets the pieces' characters appended back and the pieces
 * removed. The page's node is the one that survives, so a framework holding it keeps a node that
 * is still in the document. Wrappers the registry remembers are unwrapped wherever they are now,
 * even in a subtree the page has detached.
 */
function unwrap(doc: Document, scope: Element | null): void {
  const reg = registries.get(doc);
  const within = (n: Node) => scope === null || scope === n || scope.contains(n);
  const from = scope ?? doc;

  const spans = new Set<Element>();
  if (reg) for (const s of reg.spans) if (within(s)) spans.add(s);
  for (const s of Array.from(from.querySelectorAll(`.${SENTENCE_CLASS}`))) spans.add(s);
  for (const span of spans) {
    const parent = span.parentNode;
    if (parent) {
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
    }
    reg?.spans.delete(span);
  }

  const blocks = new Set<Element>();
  if (reg) for (const b of reg.blocks) if (within(b)) blocks.add(b);
  for (const b of Array.from(from.querySelectorAll(`[${BLOCK_ATTR}]`))) blocks.add(b);
  for (const block of blocks) {
    block.removeAttribute(BLOCK_ATTR);
    reg?.blocks.delete(block);
  }

  if (!reg) return;
  for (const [original, pieces] of reg.splits) {
    if (!within(original)) continue;
    const set = new Set<Node>(pieces);
    // Only pieces still adjacent are merged; anything the page put between them stays where it is.
    let next = original.nextSibling;
    while (next && set.has(next)) {
      const after = next.nextSibling;
      original.appendData((next as Text).data);
      (next as Text).remove();
      next = after;
    }
    reg.splits.delete(original);
  }
}

/** Back to the author's page, everywhere. It is the escape hatch for any failure downstream. */
export function unwrapAll(doc: Document): void {
  unwrap(doc, null);
}

/** Undo one block, so the next segmentation pass sees it as new: for a block whose text the page changed under us. */
export function unwrapBlock(block: Element): void {
  unwrap(block.ownerDocument, block);
}

// ---------------------------------------------------------------------------------------------
// Page meta and scope guard

const MAX_JSON_LD_DEPTH = 8;

function collectTypes(value: unknown, depth: number, out: Set<string>): void {
  if (depth > MAX_JSON_LD_DEPTH || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectTypes(item, depth + 1, out);
    return;
  }
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (key === "@type") {
      const types = Array.isArray(inner) ? inner : [inner];
      for (const t of types) if (typeof t === "string" && t.trim()) out.add(t.trim().toLowerCase());
    } else {
      collectTypes(inner, depth + 1, out);
    }
  }
}

export function collectPageMeta(doc: Document, sample: string, sentenceCount: number): PageMeta {
  const location = doc.location;
  let url = "";
  let host = "";
  if (location) {
    url = location.href;
    host = location.hostname;
  } else {
    url = doc.URL ?? "";
    try {
      host = new URL(url).hostname;
    } catch {
      host = "";
    }
  }

  let lang = doc.documentElement?.getAttribute("lang")?.trim() ?? "";
  if (!lang) {
    const meta = doc.querySelector('meta[http-equiv="content-language" i]');
    lang = meta?.getAttribute("content")?.trim() ?? "";
  }

  const types = new Set<string>();
  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json" i]'))) {
    // Malformed JSON-LD is common; it must never take the page down with it.
    try {
      collectTypes(JSON.parse(script.textContent ?? ""), 0, types);
    } catch {
      /* ignore */
    }
  }

  const og = doc.querySelector('meta[property="og:type" i]')?.getAttribute("content")?.trim() ?? null;

  return {
    url,
    host,
    title: (doc.title ?? "").trim(),
    lang,
    jsonLdTypes: Array.from(types),
    ogType: og ? og : null,
    sample,
    sentenceCount,
  };
}

const APP_EDITABLE_CHARS = 200;
const APP_INPUT_COUNT = 30;
/** Below this many characters of page text per entry control, the controls are the page. */
const APP_CHARS_PER_CONTROL = 150;
/**
 * Controls a person types or picks a value into. Checkboxes and radios are left out: a recipe card
 * puts a tick box beside every ingredient and five radio stars under the title, and a page with
 * forty of those is still a page to read (therecipecritic.com was skipped as "an app" for them).
 */
const APP_ENTRY_CONTROLS =
  "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]), textarea, select";

/** A field for a password or for a card: what is on a page that shows one is between the reader and that site. */
const PRIVATE_FIELDS = 'input[type="password"], input[autocomplete^="cc-"], input[autocomplete="one-time-code"]';

/**
 * A sign-in, an account page, a checkout: Osso reads nothing there and sends nothing. Only a field
 * the page is showing counts: many sites carry a sign-in form folded away in their header on every
 * article, and that is not what the page is. A document with no layout (a test) counts every field.
 */
export function isPrivatePage(doc: Document): boolean {
  const fields = Array.from(doc.querySelectorAll(PRIVATE_FIELDS));
  if (fields.length === 0) return false;
  const laidOut = (doc.body?.getClientRects().length ?? 0) > 0;
  return !laidOut || fields.some((f) => f.getClientRects().length > 0);
}

/**
 * An editor or a data-entry form is an application, not a page to read; Osso stays out. Many entry
 * controls alone do not make one: they must also outweigh the text, so an article with a long
 * comment form, a newsletter box and a search field is still an article.
 */
export function isAppLikePage(doc: Document): boolean {
  if (doc.designMode === "on") return true;
  for (const region of Array.from(doc.querySelectorAll("[contenteditable]"))) {
    const value = region.getAttribute("contenteditable");
    if (value !== null && value.toLowerCase() === "false") continue;
    if ((region.textContent ?? "").length > APP_EDITABLE_CHARS) return true;
  }
  const controls = doc.querySelectorAll(APP_ENTRY_CONTROLS).length;
  if (controls <= APP_INPUT_COUNT) return false;
  const chars = doc.body ? textLength(doc.body) : 0;
  return chars / controls < APP_CHARS_PER_CONTROL;
}
