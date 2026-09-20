/**
 * Segment: find the main content of a page, collect its text blocks, split them into sentences and
 * wrap each sentence in `<osso-s class="osso-s" data-osso="ID">` around the original text nodes.
 *
 * This runs on every page on the web, so the rules are conservative by construction: it only ever
 * splits text nodes and wraps them in inline elements, it never reads layout, it never touches
 * headings, tables, code, chrome (nav/header/footer/aside), forms or editable regions, and anything
 * it is unsure about it leaves alone — untouched text stays in the author's ink, which is the safe
 * default.
 *
 * The wrapper is a custom element rather than a <span> so that no author stylesheet written against
 * structure (`article p > span`, `.entry span`) ever matches it. Everything this module inserts or
 * splits is remembered per document, so unwrapping puts the page's own text nodes back with their
 * identity intact: a framework that holds a reference to a text node it rendered still holds the
 * node that is in the document afterwards. `Node.normalize()` is never called, because it would also
 * merge the page's own adjacent text nodes and detach the ones the framework updates.
 */
import { MIN_WORDS } from "../shared/constants.ts";
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

/** Elements whose sentences are judged. */
const JUDGED_TAGS = new Set(["p", "li", "dd", "dt", "blockquote", "figcaption", "summary", "div", "section", "article"]);
/** One unit each (an ingredient, a definition term) unless long enough to be prose. */
const UNIT_TAGS = new Set(["li", "dd", "dt", "figcaption", "summary"]);
/** Only a block when they hold their own text and no block-level child; otherwise they are layout. */
const LAYOUT_TAGS = new Set(["div", "section", "article"]);

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
const PARAGRAPH_TAGS = new Set(["p", "li", "blockquote", "dd", "dt", "figcaption", "div", "section", "article"]);
const CHROME_TAGS = new Set(["nav", "header", "footer", "aside"]);
/** Class or id tokens that mark page chrome on sites that do not use the semantic elements. */
const CHROME_HINT =
  /(^|[\s_-])(comment|comments|sidebar|side-bar|footer|menu|nav|navbar|navigation|breadcrumb|breadcrumbs|advert|ad|ads|related|widget|cookie|newsletter|popup|modal|promo|banner|toolbar|topbar|header)([\s_-]|$)/i;
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

function isSkipped(el: Element): boolean {
  const tag = el.localName;
  if (SKIP_TAGS.has(tag)) return true;
  if (tag === "form" && formIsChrome(el)) return true;
  if (isHidden(el)) return true;
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

function isChrome(el: Element): boolean {
  const tag = el.localName;
  if (CHROME_TAGS.has(tag)) return true;
  if (tag === "form" && formIsChrome(el)) return true;
  const role = el.getAttribute("role");
  if (role !== null && SKIP_ROLES.has(role.toLowerCase())) return true;
  const editable = el.getAttribute("contenteditable");
  if (editable !== null && editable.toLowerCase() !== "false") return true;
  return hasChromeHint(el);
}

function isSemanticMain(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.localName;
  return tag === "article" || tag === "main" || el.getAttribute("role") === "main";
}

function isCandidate(el: Element): boolean {
  const tag = el.localName;
  return tag === "div" || tag === "section" || isSemanticMain(el);
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
  const chromeMemo = new Map<Element, boolean>();
  const seenParagraphs = new Set<Element>();

  const underChrome = (el: Element): boolean => {
    const memo = chromeMemo.get(el);
    if (memo !== undefined) return memo;
    const parent = el.parentElement;
    const value = isChrome(el) || (parent !== null && parent !== root && underChrome(parent));
    chromeMemo.set(el, value);
    return value;
  };

  const walker = doc.createTreeWalker(root, 1 | 4 /* SHOW_ELEMENT | SHOW_TEXT */, {
    acceptNode: (node) => {
      if (node.nodeType === ELEMENT_NODE) {
        const el = node as Element;
        const tag = el.localName;
        // Chrome stays in the walk so that its text can count against its ancestors.
        if (SKIP_TAGS.has(tag) && !CHROME_TAGS.has(tag)) return 2 /* REJECT */;
        return isHidden(el) ? 2 /* REJECT */ : 1 /* ACCEPT */;
      }
      return (node as Text).data.trim().length > 0 ? 1 : 3 /* SKIP */;
    },
  });

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
    const contribution = underChrome(block) ? -length / 2 : inLink ? -length : length;
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
];
const CASE_SENSITIVE_ABBREVIATIONS = new Set(["No", "Gen", "Col", "Rev", "Rep", "Sen", "Gov", "Pres", "Hon"]);
const ABBREVIATION_SET = new Set(
  ABBREVIATIONS.flatMap((a) => (CASE_SENSITIVE_ABBREVIATIONS.has(a) ? [a] : [a, a.toLowerCase()])),
);

/**
 * A terminator run, then any closing quotes or brackets that belong to the sentence. Beyond the
 * Latin set: the CJK full stop, exclamation and question marks, the Arabic question mark, the Urdu
 * full stop and the Devanagari danda, so a page in those scripts splits into sentences at all.
 */
const TERMINATOR = /[.!?…。！？؟۔।॥]+[)\]"'”’»›」』）】]*/gu;
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

export function countWords(text: string): number {
  const cjk = text.match(CJK_CHAR);
  const rest = (cjk ? text.replace(CJK_CHAR, " ") : text).match(WORD);
  return (cjk ? cjk.length : 0) + (rest ? rest.length : 0);
}

/**
 * Whether a sentence may start at `at`: the Latin rule (capital, digit, opening quote), or any
 * letter of a script that has no case at all — Arabic, Hebrew, Thai, Devanagari, CJK — where the
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

/** Whether a lone period at `index` (the period itself) closes a sentence, judging by the word before it. */
function periodEndsSentence(text: string, index: number): boolean {
  let start = index;
  while (start > 0 && TOKEN_CHAR.test(text[start - 1]!)) start--;
  const token = text.slice(start, index);
  if (token.length === 0) return true;
  if (SINGLE_LETTER.test(token)) return false;
  if (ENUMERATOR.test(token)) return false;
  if (isAbbreviation(token)) return false;
  // "U.S." / "Ph.D." / "e.g.": judge the part after the last inner period as well.
  const tail = token.slice(token.lastIndexOf(".") + 1);
  if (tail !== token && (SINGLE_LETTER.test(tail) || isAbbreviation(tail) || tail.length === 0)) return false;
  return true;
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
    if (run[0] === "." && (run.length === 1 || !/^[.!?…]/.test(run[1]!)) && !periodEndsSentence(line, m.index)) continue;
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
    const words = countWords(text.slice(piece.start, piece.end));
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
   * there is no article boundary keeping it out.
   */
  hintSkip: boolean;
}

/** A block already wrapped is not wrapped again, unless the page replaced its content and our wrappers went with it. */
function isWrapped(el: Element): boolean {
  return el.hasAttribute(BLOCK_ATTR) && el.querySelector(`.${SENTENCE_CLASS}`) !== null;
}

function visit(el: Element, block: Block | null, inLink: boolean, out: Block[], walk: Walk): void {
  const tag = el.localName;
  const blockLevel = BLOCK_LEVEL.has(tag);
  if (isSkipped(el) || (walk.hintSkip && el !== walk.root && hasChromeHint(el))) {
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

/** The sentence ranges to wrap in a block, or null when the block is not judged at all. */
function rangesFor(block: Block, text: string): SentenceRange[] | null {
  if (block.layout && block.hasBlockChild) return null;
  if (block.textChars === 0) return null;
  if (block.linkChars / block.textChars >= LINK_TEXT_RATIO) return null;
  if (countWords(text) < MIN_WORDS) return null;
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
  visit(container, null, false, blocks, { root: container, hintSkip: container === doc.body || container === doc.documentElement });

  const sentences: SentenceInput[] = [];
  let id = startId;
  for (const block of blocks) {
    if (block.segments.length === 0) continue;
    const text = block.parts.join("");
    const ranges = rangesFor(block, text);
    if (!ranges) continue;
    for (let i = 0; i < ranges.length; i++) {
      const range = ranges[i]!;
      sentences.push({ id: id + i, text: cleanText(text.slice(range.start, range.end)) });
    }
    wrapRanges(reg, block, ranges, id);
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

/** An editor or a data-entry form is an application, not a page to read; Osso stays out. */
export function isAppLikePage(doc: Document): boolean {
  if (doc.designMode === "on") return true;
  for (const region of Array.from(doc.querySelectorAll("[contenteditable]"))) {
    const value = region.getAttribute("contenteditable");
    if (value !== null && value.toLowerCase() === "false") continue;
    if ((region.textContent ?? "").length > APP_EDITABLE_CHARS) return true;
  }
  return doc.querySelectorAll("input:not([type=hidden]), textarea, select").length > APP_INPUT_COUNT;
}
