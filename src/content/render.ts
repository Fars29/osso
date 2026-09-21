/**
 * The fade is the product. Everything here is a colour change, and a hairline through it, on
 * wrappers that segment already placed: no node is moved, hidden or resized, and every state is
 * reversible by removing a class.
 *
 * Contract with segment: each sentence is one or more `<osso-s class="osso-s" data-osso="ID">`,
 * each judged block carries `data-osso-block`. We add classes, custom properties and one chip; we
 * never unwrap.
 */
import type { PageJudgment, RevealKey, RuleResults, SentenceJudgment } from "../shared/types.ts";
import { RULE_THRESHOLD, SENTENCE_KINDS } from "../shared/constants.ts";

export interface Counts {
  total: number;
  kept: number;
  faded: number;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

const SPAN = ".osso-s";
const BLOCK = "[data-osso-block]";

/**
 * The front: one horizontal line of light that comes down the page, and the text is washed as it
 * passes. It is a single vertical gradient anchored to the window (`background-attachment: fixed`)
 * and painted through the glyphs, so it runs unbroken across lines, sentences and paragraphs: above
 * it, a sentence the grey falls on has lost its ink over a feathering FRONT_FEATHER_PX tall; on a
 * kept sentence a veil of light passes and it is ink again. Each chunk the model answers brings
 * its own front, starting just above the chunk's first line on screen and ending far enough past
 * its last that nothing of the pass is left on the text, at a constant speed whatever the distance.
 * What is off screen is not animated at all: it is simply grey when the reader gets there. Inside a
 * link, without the block's ink, or over an emoji (a colour glyph cannot be painted through a
 * gradient) the grey falls back to a SETTLE_MS colour transition that starts when the front
 * arrives at that line.
 */
export const FRONT_FEATHER_PX = 160;
/** The front starts this far above the first line and ends this far below the last, so the veil and the feathering both clear the text. */
export const FRONT_LEAD_PX = 40;
export const FRONT_TRAIL_PX = 280;
export const FRONT_SPEED_PX_PER_MS = 0.4;
export const FRONT_MIN_MS = 900;
export const FRONT_MAX_MS = 3200;
export const SETTLE_MS = 700;
/**
 * The strike: a hairline drawn through a sentence the grey falls on, from its first letter to its
 * last, starting a moment after the front reaches it. A pen moves at a pace, so a longer sentence
 * takes longer, within limits; a sentence in several wrappers (a link or an emphasis in the middle)
 * is one stroke handed from wrapper to wrapper.
 */
export const STRIKE_LAG_MS = 120;
export const STRIKE_MS_PER_CHAR = 7;
export const STRIKE_MIN_MS = 450;
export const STRIKE_MAX_MS = 1200;
/**
 * A sentence the reader scrolls to goes at once and briskly: they are looking at it, and a second
 * of black text before anything happens reads as lag. The pen is quicker here than in the entrance.
 */
export const ARRIVE_MS_PER_CHAR = 4;
export const ARRIVE_MIN_MS = 320;
export const ARRIVE_MAX_MS = 800;
export const ARRIVE_STAGGER_MS = 60;
export const ARRIVE_STAGGER_MAX_MS = 240;
/** Threshold re-render runs at 200 ms with no stagger (see osso.css `osso-instant`). */
const INSTANT_MS = 200;
/** The rule-hit underline draws in over 240 ms and fades over 1.2 s (osso.css); the class comes off once that has played. */
export const RULE_HIT_MS = 240 + 1200;
const CHIP_DELAY_MS = 250;
/** Hover chip keeps this far from the text it describes and from a viewport edge; one and a half of it from the block's edge. */
const CHIP_GAP_PX = 8;
/** Colour glyphs, which a text-clipped gradient cannot paint. */
const EMOJI = /\p{Extended_Pictographic}/u;

/**
 * Contrast targets for the fade grey. The spec names `#b9b9b9` on white and `#5c5c5c` on near-black;
 * those are ~1.96:1 and ~2.8:1 under WCAG. The +0.05 flare term compresses ratios near black, so one
 * ratio cannot give a comparable fade on both grounds: 1.6:1 would be `#cdcdcd` on white and an
 * unreadable `#383838` on `#111`. One target per side lands on the named colours.
 */
export const FADE_CONTRAST = { light: 1.96, dark: 2.81 } as const;
/**
 * Below this contrast between the author's ink and the grey, the fade would not read as a fade:
 * white text on a mid-grey card, or a caption already set in grey. The grey then moves to the
 * point on the ink–ground line that is equally far from both.
 */
export const INK_MIN_CONTRAST = 1.8;
/** WCAG relative luminance above which a background counts as light. */
const LIGHT_LUMINANCE = 0.5;

const WHITE: RGB = { r: 255, g: 255, b: 255 };

interface DocState {
  judgment: Map<number, SentenceJudgment>;
  failed: Set<number>;
  threshold: number;
  animations: boolean;
  pinned: Set<number>;
  /** Faded spans kept in ink until the reader reaches them, and what tells us when. */
  waiting: Set<HTMLElement>;
  watcher: IntersectionObserver | null;
  /** One timer for each front that has not cleaned up after itself yet; how many of them are entrance passes. */
  settling: Set<ReturnType<typeof setTimeout>>;
  entrances: number;
  /** Ids rendered at least once: only a sentence's first rendering gets the sweep. */
  painted: Set<number>;
  instantTimer: ReturnType<typeof setTimeout> | null;
  chip: HTMLElement | null;
  /** Every rule result this page has seen, active or not: removing a rule and adding it back costs nothing. */
  rules: RuleResults;
  /** The rules in force, in the user's order; the first that hits a sentence is the one the chip names. */
  activeRules: string[];
  /** Rule hits already shown, as `rule\u0000id`; only a hit not in here gets the underline. */
  seenHits: Set<string>;
  /** Spans wearing the transient underline, and the timer that takes it off them. */
  hitSpans: Set<HTMLElement>;
  hitTimer: ReturnType<typeof setTimeout> | null;
}

const states = new WeakMap<Document, DocState>();

function stateOf(doc: Document): DocState {
  let s = states.get(doc);
  if (!s) {
    s = {
      judgment: new Map(),
      failed: new Set(),
      threshold: 0.5,
      animations: true,
      pinned: new Set(),
      waiting: new Set(),
      watcher: null,
      settling: new Set(),
      entrances: 0,
      painted: new Set(),
      instantTimer: null,
      chip: null,
      rules: {},
      activeRules: [],
      seenHits: new Set(),
      hitSpans: new Set(),
      hitTimer: null,
    };
    states.set(doc, s);
  }
  return s;
}

function sentenceId(el: Element): number | null {
  const raw = el.getAttribute("data-osso");
  if (raw == null) return null;
  const id = Number(raw);
  return Number.isFinite(id) ? id : null;
}

/** Spans grouped by sentence, in document order of each sentence's first span. */
function spansById(doc: Document): Map<number, HTMLElement[]> {
  const groups = new Map<number, HTMLElement[]>();
  for (const el of doc.querySelectorAll<HTMLElement>(SPAN)) {
    const id = sentenceId(el);
    if (id == null) continue;
    const list = groups.get(id);
    if (list) list.push(el);
    else groups.set(id, [el]);
  }
  return groups;
}

/** Removes one inline property and, when nothing else is left, the attribute itself: the author's markup comes back as it was. */
function dropProperty(el: HTMLElement, name: string) {
  el.style.removeProperty(name);
  if (el.style.length === 0) el.removeAttribute("style");
}

function prefersReducedMotion(doc: Document): boolean {
  const win = doc.defaultView;
  if (!win || typeof win.matchMedia !== "function") return false;
  try {
    return win.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** The first active rule that keeps this sentence, or null. Rules are the reader's own words, so their order is the reader's priority. */
function ruleKeeping(state: DocState, id: number): string | null {
  for (const rule of state.activeRules) {
    const p = state.rules[rule]?.[id];
    if (p !== undefined && p >= RULE_THRESHOLD) return rule;
  }
  return null;
}

/**
 * Toggles fade/pin classes from the stored judgment. With `wave`, the sentences rendered for the
 * first time in this pass get the front (see `sweep`). Sentences already rendered keep their
 * state; kept sentences end with no class and no inline style. A sentence an active rule keeps is
 * never faded, whatever the slider says.
 */
function render(doc: Document, state: DocState, wave: boolean): Counts {
  let total = 0;
  let faded = 0;
  const fresh: Fresh[] = [];
  const decided: Array<{ spans: HTMLElement[]; fade: boolean; pinned: boolean }> = [];
  for (const [id, spans] of spansById(doc)) {
    const j = state.judgment.get(id);
    if (!j || state.failed.has(id)) continue;
    total++;
    const fade = j.keep < state.threshold && ruleKeeping(state, id) === null;
    const pinned = state.pinned.has(id);
    decided.push({ spans, fade, pinned });
    if (fade && !pinned) faded++;
    if (!state.painted.has(id)) {
      state.painted.add(id);
      if (wave) for (const span of spans) fresh.push({ id, span, fade: fade && !pinned });
    }
  }
  // Every read before any write. A rectangle read once the classes are on makes the browser resolve
  // the new styles there and then, and every transition starts at once, before its delay is written:
  // the links went grey and the strikes set off together while the front was still at the top.
  const paint = fresh.length > 0 ? sweep(doc, state, fresh) : null;
  for (const d of decided) {
    for (const s of d.spans) {
      s.classList.toggle("osso-fade", d.fade);
      s.classList.toggle("osso-pin", d.pinned);
    }
  }
  paint?.();
  return { total, kept: total - faded, faded };
}

interface Fresh {
  id: number;
  span: HTMLElement;
  fade: boolean;
}

/** When a front on a sine ease reaches the share `p` of its travel, as a share of its duration. */
function arrival(p: number): number {
  return Math.acos(1 - 2 * Math.min(1, Math.max(0, p))) / Math.PI;
}

/**
 * Reads now and returns the writes, for the caller to run after it has put the classes on.
 * One front for the spans of this pass that are on screen: from just above the first of them to
 * past the last, at a constant speed. Every judged sentence on screen, kept or not, is painted
 * through the front; where the grey falls the ink is washed out behind it and struck. A span
 * holding an emoji, or inside a link, or with no ink known, keeps the plain colour transition,
 * delayed to the moment the front gets to it.
 *
 * What the grey will fall on elsewhere on the page is not greyed behind the reader's back: it waits
 * in ink (`osso-wait`) and is struck the moment it comes into view, so the reader sees each
 * sentence go as they reach it (`arrive`). Where the browser cannot tell us when that is,
 * it is simply grey when the reader gets there, as it was before.
 */
function sweep(doc: Document, state: DocState, fresh: Fresh[]): (() => void) | null {
  const win = doc.defaultView;
  const vh = win?.innerHeight ?? 0;
  const measured = fresh.map((f) => ({ ...f, rect: f.span.getBoundingClientRect() }));
  // No layout (a test document, a detached view): everything counts as on screen, at the top.
  const laidOut = vh > 0 && measured.some((m) => m.rect.height > 0);
  const visible = (m: (typeof measured)[number]) => m.rect.bottom > 0 && m.rect.top < vh;
  const onScreen = laidOut ? measured.filter(visible) : measured;
  const away = laidOut && typeof win?.IntersectionObserver === "function" ? measured.filter((m) => m.fade && !visible(m)) : [];
  if (onScreen.length === 0 && away.length === 0) return null;

  let front: Front | null = null;
  if (onScreen.length > 0) {
    let top = Infinity;
    let bottom = -Infinity;
    for (const m of onScreen) {
      if (m.rect.top < top) top = m.rect.top;
      if (m.rect.bottom > bottom) bottom = m.rect.bottom;
    }
    const y0 = Math.max(-FRONT_FEATHER_PX, top - FRONT_LEAD_PX);
    const y1 = (laidOut ? Math.min(vh, bottom) : bottom) + FRONT_TRAIL_PX;
    const ms = Math.round(Math.min(FRONT_MAX_MS, Math.max(FRONT_MIN_MS, (y1 - y0) / FRONT_SPEED_PX_PER_MS)));
    front = { y0, y1, ms, reaches: (y: number) => Math.round(arrival((y - y0) / (y1 - y0)) * ms) };
  }
  return () => {
    hold(doc, state, away.map((m) => m.span));
    if (front) paintSweep(doc, state, onScreen, front);
  };
}

interface Front {
  y0: number;
  y1: number;
  ms: number;
  /** When the front reaches a line at this height. */
  reaches: (y: number) => number;
}

/** The writes of a sweep: nothing here asks the browser where anything is. */
function paintSweep(doc: Document, state: DocState, onScreen: Array<Fresh & { rect: DOMRect }>, front: Front) {
  const { y0, y1, ms, reaches } = front;
  const waved: HTMLElement[] = [];
  const swept: HTMLElement[] = [];

  // The strike, one stroke a sentence, handed from wrapper to wrapper in reading order.
  let lastStroke = 0;
  const strokes = new Map<number, Array<(typeof onScreen)[number]>>();
  for (const m of onScreen) {
    if (!m.fade) continue;
    const parts = strokes.get(m.id);
    if (parts) parts.push(m);
    else strokes.set(m.id, [m]);
  }
  for (const parts of strokes.values()) {
    const chars = parts.map((p) => (p.span.textContent ?? "").length);
    const total = Math.max(1, chars.reduce((a, b) => a + b, 0));
    const draw = Math.min(STRIKE_MAX_MS, Math.max(STRIKE_MIN_MS, total * STRIKE_MS_PER_CHAR));
    const start = reaches(parts[0]!.rect.top) + STRIKE_LAG_MS;
    let before = 0;
    parts.forEach((p, i) => {
      p.span.style.setProperty("--osso-strike-delay", `${Math.round(start + (draw * before) / total)}ms`);
      p.span.style.setProperty("--osso-strike-ms", `${Math.max(60, Math.round((draw * chars[i]!) / total))}ms`);
      // A stroke that changes hands cannot ease in each hand: it moves at one pace.
      if (parts.length > 1) p.span.style.setProperty("--osso-strike-ease", "linear");
      before += chars[i]!;
    });
    lastStroke = Math.max(lastStroke, start + draw);
  }

  for (const m of onScreen) {
    const s = m.span;
    // The plain transition, where it is what a span gets, starts as the front arrives at its line.
    s.style.setProperty("--osso-delay", `${reaches(m.rect.top)}ms`);
    waved.push(s);
    // Glyphs painted through a gradient lose their own colours: an emoji would vanish for the pass.
    if (EMOJI.test(s.textContent ?? "")) continue;
    s.classList.add("osso-sweep");
    s.style.setProperty("--osso-y0", `${Math.round(y0)}px`);
    s.style.setProperty("--osso-y1", `${Math.round(y1)}px`);
    s.style.setProperty("--osso-front-ms", `${ms}ms`);
    // Not inside a link (its ink is the link's, not the block's), and not without the block's ink
    // to paint what the front has not reached.
    if (m.fade && !s.closest("a") && hasInk(s)) s.classList.add("osso-wipe");
    swept.push(s);
  }
  scheduleSettle(doc, state, { waved, swept }, Math.max(ms + SETTLE_MS, lastStroke));
}

const FRONT_PROPERTIES = ["--osso-y0", "--osso-y1", "--osso-front-ms"] as const;
const WAVE_PROPERTIES = ["--osso-delay", "--osso-strike-delay", "--osso-strike-ms", "--osso-strike-ease"] as const;

/** The reason in one word: the kind when the kind is the reason, "aside" when the model called it a fact, a figure or a step and still not what the reader came for. */
function reasonWord(j: SentenceJudgment): string {
  const kind = SENTENCE_KINDS[j.kind];
  return kind && !kind.substantive ? kind.label : "aside";
}

/** Keeps these spans in ink until they come into view. They are faded in every other sense: counted, pinnable once seen, grey to the slider. */
function hold(doc: Document, state: DocState, spans: HTMLElement[]) {
  if (spans.length === 0) return;
  const watcher = watcherOf(doc, state);
  if (!watcher) return;
  for (const s of spans) {
    s.classList.add("osso-wait");
    state.waiting.add(s);
    watcher.observe(s);
  }
}

function watcherOf(doc: Document, state: DocState): IntersectionObserver | null {
  if (state.watcher) return state.watcher;
  const Watcher = doc.defaultView?.IntersectionObserver;
  if (typeof Watcher !== "function") return null;
  state.watcher = new Watcher((entries) => {
    const seen = entries.filter((e) => e.isIntersecting).map((e) => e.target as HTMLElement).filter((s) => state.waiting.has(s));
    if (seen.length > 0) arrive(doc, state, seen);
  });
  return state.watcher;
}

/**
 * The reader got there. Each sentence that came into view and is still to go (the slider, a rule or
 * a pin may have changed that while it waited) is crossed by the pen at once, and its ink drains
 * behind the pen: one property, `--osso-strike`, drives the line and the wash together (osso.css
 * `osso-arrive`), along the sentence itself. Nothing here is anchored to the window. The entrance's
 * front is, and while the page is moving under it (a scroll, an advert pushing the text down) a
 * window-anchored wash falls out of step with the text: the sentence sat struck and black until the
 * clean-up took the class off, and then snapped grey. Asking the browser nothing, this also costs
 * no layout. Only what goes is animated: a veil over every paragraph that scrolls in would be
 * motion under the reader's eyes for nothing.
 */
function arrive(doc: Document, state: DocState, spans: HTMLElement[]) {
  const bySentence = new Map<number, HTMLElement[]>();
  // The observer reports in no particular order; a stroke is handed on in reading order.
  const inOrder = [...spans].sort((a, b) => (a.compareDocumentPosition(b) & 4 /* FOLLOWING */ ? -1 : 1));
  for (const span of inOrder) {
    state.waiting.delete(span);
    state.watcher?.unobserve(span);
    const id = sentenceId(span);
    if (id == null || !span.classList.contains("osso-fade") || span.classList.contains("osso-pin")) continue;
    const parts = bySentence.get(id);
    if (parts) parts.push(span);
    else bySentence.set(id, [span]);
  }
  const moving = state.animations && !prefersReducedMotion(doc) && !doc.documentElement.classList.contains("osso-reveal");
  const touched: HTMLElement[] = [];
  let end = 0;
  if (moving) {
    let n = 0;
    for (const parts of bySentence.values()) {
      const chars = parts.map((p) => (p.textContent ?? "").length);
      const total = Math.max(1, chars.reduce((a, b) => a + b, 0));
      const draw = Math.min(ARRIVE_MAX_MS, Math.max(ARRIVE_MIN_MS, total * ARRIVE_MS_PER_CHAR));
      // Sentences that come in together go one just after the other, not as a block.
      const start = Math.min(ARRIVE_STAGGER_MAX_MS, n++ * ARRIVE_STAGGER_MS);
      let before = 0;
      parts.forEach((s, i) => {
        const delay = Math.round(start + (draw * before) / total);
        s.style.setProperty("--osso-strike-delay", `${delay}ms`);
        s.style.setProperty("--osso-strike-ms", `${Math.max(60, Math.round((draw * chars[i]!) / total))}ms`);
        if (parts.length > 1) s.style.setProperty("--osso-strike-ease", "linear");
        // Where the ink cannot be painted through (a link's own colour, an emoji, no ink known) the colour eases instead, in step.
        s.style.setProperty("--osso-delay", `${delay}ms`);
        if (!EMOJI.test(s.textContent ?? "") && !s.closest("a") && hasInk(s)) s.classList.add("osso-arrive");
        touched.push(s);
        before += chars[i]!;
      });
      end = Math.max(end, start + draw);
    }
  }
  for (const span of spans) span.classList.remove("osso-wait");
  if (touched.length === 0) return;
  // At the end the wash is all grey over a colour that is already grey: taking the class off changes nothing on screen.
  const timer = setTimeout(() => {
    state.settling.delete(timer);
    for (const s of touched) {
      s.classList.remove("osso-arrive");
      for (const name of WAVE_PROPERTIES) dropProperty(s, name);
    }
  }, end + SETTLE_MS + 50);
  state.settling.add(timer);
}

/** Nothing waits any more: with animations off, or on the way out. */
function releaseWaiting(state: DocState) {
  for (const s of state.waiting) s.classList.remove("osso-wait");
  state.waiting.clear();
  state.watcher?.disconnect();
  state.watcher = null;
}

/**
 * Once a front has passed, what it needed has done its job: drop it from the spans it touched, so
 * reveal, pin and threshold changes move every sentence together. Each pass cleans up after itself,
 * so a short front that starts late never cuts a long one short, and holds the root unsettled;
 * osso.css shortens the transitions once the last of them is done.
 */
function scheduleSettle(doc: Document, state: DocState, pass: { waved: HTMLElement[]; swept: HTMLElement[] }, after: number) {
  const root = doc.documentElement;
  root.classList.remove("osso-settled");
  state.entrances++;
  const timer = setTimeout(() => {
    state.settling.delete(timer);
    for (const s of pass.waved) for (const name of WAVE_PROPERTIES) dropProperty(s, name);
    for (const s of pass.swept) {
      s.classList.remove("osso-sweep", "osso-wipe");
      for (const name of FRONT_PROPERTIES) dropProperty(s, name);
    }
    if (--state.entrances === 0) root.classList.add("osso-settled");
  }, after + 50);
  state.settling.add(timer);
}

/** Whether the span's block knows the author's ink (paintBlocks wrote it): the wipe needs it for the part not yet swept. */
function hasInk(span: HTMLElement): boolean {
  const block = span.closest<HTMLElement>(BLOCK);
  return !!block && block.style.getPropertyValue("--osso-ink") !== "";
}

function luminance(c: RGB): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

function contrast(l1: number, l2: number): number {
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

function greyLuminance(g: number): number {
  return luminance({ r: g, g, b: g });
}

/** The integer grey whose contrast against the ground is closest to the target for that side. */
function greyForGround(bgL: number): number {
  const light = bgL >= LIGHT_LUMINANCE;
  const target = light ? FADE_CONTRAST.light : FADE_CONTRAST.dark;
  let best = light ? 0 : 255;
  let bestDiff = Infinity;
  for (let g = 0; g <= 255; g++) {
    const gL = greyLuminance(g);
    if (light ? gL > bgL : gL < bgL) continue;
    const diff = Math.abs(contrast(gL, bgL) - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = g;
    }
  }
  return best;
}

/** The grey whose contrast to the ink equals its contrast to the ground: as far from both as one colour can be. */
function greyBetween(inkL: number, bgL: number): number {
  let best = 128;
  let bestDiff = Infinity;
  for (let g = 0; g <= 255; g++) {
    const gL = greyLuminance(g);
    const diff = Math.abs(contrast(gL, inkL) - contrast(gL, bgL));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = g;
    }
  }
  return best;
}

const greyCache = new Map<string, string>();

/**
 * The fade colour for a background: the grey at the target contrast for that ground, on the darker
 * side of light grounds and the lighter side of dark grounds. White gives `#b9b9b9`, `#111` gives
 * `#5c5c5c`. Given the author's ink as well, a grey the ink would almost match (white on a mid-grey
 * card, a caption already in grey) is replaced by the grey halfway between ink and ground, so the
 * fade is visible on any pairing the author chose.
 */
export function pickGrey(bg: RGB, ink?: RGB): string {
  const key = ink ? `${bg.r},${bg.g},${bg.b}/${ink.r},${ink.g},${ink.b}` : `${bg.r},${bg.g},${bg.b}`;
  const cached = greyCache.get(key);
  if (cached) return cached;
  const bgL = luminance(bg);
  let best = greyForGround(bgL);
  if (ink) {
    const inkL = luminance(ink);
    if (contrast(inkL, greyLuminance(best)) < INK_MIN_CONTRAST) best = greyBetween(inkL, bgL);
  }
  const hex = best.toString(16).padStart(2, "0");
  const out = `#${hex}${hex}${hex}`;
  greyCache.set(key, out);
  return out;
}

/** Parses the forms Chrome reports for a computed colour: `rgb(r, g, b)`, `rgba(r, g, b, a)`, `rgb(r g b / a)`. */
function parseColor(value: string): { rgb: RGB; a: number } | null {
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(value.trim());
  if (!m) return null;
  let a = 1;
  if (m[4] != null) a = m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return { rgb: { r: Math.round(+m[1]!), g: Math.round(+m[2]!), b: Math.round(+m[3]!) }, a: Number.isFinite(a) ? a : 1 };
}

/**
 * The colour the text actually sits on: this element's background composited over its ancestors'
 * until one is opaque, white when none is. `memo` lets one apply pass resolve shared ancestors once.
 */
export function effectiveBackground(el: Element, win: Window, memo?: Map<Element, RGB>): RGB {
  const known = memo?.get(el);
  if (known) return known;
  let own: { rgb: RGB; a: number } | null = null;
  try {
    own = parseColor(win.getComputedStyle(el).backgroundColor ?? "");
  } catch {
    own = null;
  }
  let out: RGB;
  if (own && own.a >= 1) {
    out = own.rgb;
  } else {
    const parent = el.parentElement;
    const under = parent ? effectiveBackground(parent, win, memo) : WHITE;
    if (own && own.a > 0) {
      const a = own.a;
      out = {
        r: Math.round(own.rgb.r * a + under.r * (1 - a)),
        g: Math.round(own.rgb.g * a + under.g * (1 - a)),
        b: Math.round(own.rgb.b * a + under.b * (1 - a)),
      };
    } else {
      out = under;
    }
  }
  memo?.set(el, out);
  return out;
}

/** The author's ink on a block, when the browser reports one; null leaves the grey to the ground alone. */
function inkOf(el: Element, win: Window): RGB | null {
  try {
    const parsed = parseColor(win.getComputedStyle(el).color ?? "");
    return parsed && parsed.a > 0 ? parsed.rgb : null;
  } catch {
    return null;
  }
}

/** Reads every block's background and ink first, then writes each block's grey: no interleaved layout thrash. */
function paintBlocks(doc: Document) {
  const win = doc.defaultView;
  // Only blocks not painted yet: a chunk landing mid-wash must not re-read every paragraph on the page.
  const blocks = Array.from(doc.querySelectorAll<HTMLElement>(BLOCK)).filter((b) => b.style.getPropertyValue("--osso-grey") === "");
  const memo = new Map<Element, RGB>();
  const bgs = blocks.map((b) => (win ? effectiveBackground(b, win, memo) : WHITE));
  const inks = blocks.map((b) => (win ? inkOf(b, win) : null));
  blocks.forEach((b, i) => {
    const bg = bgs[i]!;
    const ink = inks[i];
    b.style.setProperty("--osso-grey", ink ? pickGrey(bg, ink) : pickGrey(bg));
    if (ink) b.style.setProperty("--osso-ink", `rgb(${ink.r}, ${ink.g}, ${ink.b})`);
    b.classList.toggle("osso-dark", luminance(bg) < LIGHT_LUMINANCE);
  });
}

export function applyJudgment(
  doc: Document,
  judgment: PageJudgment,
  opts: { threshold: number; animations: boolean; strike?: boolean },
): Counts {
  const state = stateOf(doc);
  // Merge rather than replace: a later apply may carry only the sentences a mutation added, and a
  // sentence whose chunk failed earlier may have been judged since.
  for (const s of judgment.sentences) {
    state.judgment.set(s.id, s);
    state.failed.delete(s.id);
  }
  const judgedNow = new Set(judgment.sentences.map((s) => s.id));
  for (const id of judgment.failedIds) if (!judgedNow.has(id)) state.failed.add(id);
  state.threshold = opts.threshold;
  state.animations = opts.animations;

  const root = doc.documentElement;
  const wave = opts.animations && !prefersReducedMotion(doc);

  // Reads. The forced layout also gives freshly wrapped spans a "before" style, without which the
  // browser would jump straight to grey instead of transitioning.
  paintBlocks(doc);
  void root.getBoundingClientRect();

  // Writes.
  root.classList.add("osso-on");
  root.classList.toggle("osso-strike", opts.strike !== false);
  root.classList.toggle("osso-still", !opts.animations);
  if (!wave) releaseWaiting(state);
  const counts = render(doc, state, wave);
  // Nothing of this pass is on screen to be waited for.
  if (state.entrances === 0) root.classList.add("osso-settled");
  return counts;
}

/** A re-render with no stagger and a short settle: the slider, and a rule coming or going. */
function renderInstant(doc: Document, state: DocState): Counts {
  const root = doc.documentElement;
  root.classList.add("osso-instant");
  const counts = render(doc, state, false);
  if (state.instantTimer) clearTimeout(state.instantTimer);
  state.instantTimer = setTimeout(() => {
    state.instantTimer = null;
    root.classList.remove("osso-instant");
  }, INSTANT_MS + 50);
  return counts;
}

/** The popup slider: re-render from stored probabilities, no stagger, no inference. */
export function setThreshold(doc: Document, threshold: number): Counts {
  const state = stateOf(doc);
  state.threshold = threshold;
  return renderInstant(doc, state);
}

/**
 * The user's rules on the page. `rules` are results to merge (rule → sentence id → p(hit)), and
 * may carry rules that are no longer active: they are kept, so a rule added back is free.
 * `activeRules` are the rules in force. Sentences with a hit on an active rule lose their fade;
 * a hit shown for the first time gets the transient `osso-rule-hit` underline, the one place the
 * accent colour touches a page, so the reader sees what the rule caught. A rule removed simply
 * re-fades, with no animation beyond the normal one.
 *
 * While the entrance wave is still playing this rides along with it (a sentence a cached rule
 * keeps never goes grey at all); afterwards it takes the instant path, like the slider.
 */
export function applyRules(doc: Document, rules: RuleResults, activeRules: string[]): Counts {
  const state = stateOf(doc);
  for (const [rule, byId] of Object.entries(rules)) state.rules[rule] = { ...state.rules[rule], ...byId };
  state.activeRules = [...activeRules];

  const fresh: HTMLElement[] = [];
  const hits = new Set<string>();
  for (const [id, spans] of spansById(doc)) {
    for (const rule of state.activeRules) {
      const p = state.rules[rule]?.[id];
      if (p === undefined || p < RULE_THRESHOLD) continue;
      const key = `${rule}\u0000${id}`;
      hits.add(key);
      if (!state.seenHits.has(key)) fresh.push(...spans);
    }
  }
  state.seenHits = hits;

  const counts = state.entrances > 0 ? render(doc, state, false) : renderInstant(doc, state);
  if (fresh.length > 0) underline(doc, state, fresh);
  return counts;
}

/**
 * Puts the underline on freshly caught spans and takes it off everything wearing it once the
 * animation has played. A span caught again while still underlined starts over: the class is
 * re-applied after a forced style flush so the animation restarts.
 */
function underline(doc: Document, state: DocState, spans: HTMLElement[]) {
  for (const s of spans) {
    if (s.classList.contains("osso-rule-hit")) {
      s.classList.remove("osso-rule-hit");
      void s.offsetWidth;
    }
    s.classList.add("osso-rule-hit");
    state.hitSpans.add(s);
  }
  if (state.hitTimer) clearTimeout(state.hitTimer);
  state.hitTimer = setTimeout(() => {
    state.hitTimer = null;
    for (const s of state.hitSpans) s.classList.remove("osso-rule-hit");
    state.hitSpans.clear();
  }, RULE_HIT_MS);
  void doc;
}

/** How many sentences on the page each active rule keeps: what the popup's chips count. */
export function ruleHits(doc: Document): Record<string, number> {
  const out: Record<string, number> = {};
  const state = states.get(doc);
  if (!state) return out;
  for (const rule of state.activeRules) {
    const byId = state.rules[rule];
    if (!byId) continue;
    let n = 0;
    for (const id of spansById(doc).keys()) {
      const p = byId[id];
      if (p !== undefined && p >= RULE_THRESHOLD) n++;
    }
    out[rule] = n;
  }
  return out;
}

export function setReveal(doc: Document, on: boolean): void {
  doc.documentElement.classList.toggle("osso-reveal", on);
}

export function counts(doc: Document): Counts {
  const state = states.get(doc);
  if (!state) return { total: 0, kept: 0, faded: 0 };
  let total = 0;
  let faded = 0;
  for (const [id, spans] of spansById(doc)) {
    if (!state.judgment.has(id) || state.failed.has(id)) continue;
    total++;
    const first = spans[0]!;
    if (first.classList.contains("osso-fade") && !first.classList.contains("osso-pin")) faded++;
  }
  return { total, kept: total - faded, faded };
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as (Element & { isContentEditable?: boolean }) | null;
  if (!el || typeof el.closest !== "function") return false;
  if (el.isContentEditable) return true;
  return el.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') != null;
}

function chipOf(doc: Document, state: DocState): HTMLElement {
  if (state.chip && state.chip.isConnected) return state.chip;
  const chip = doc.createElement("div");
  chip.className = "osso-chip";
  chip.setAttribute("aria-hidden", "true");
  (doc.body ?? doc.documentElement).appendChild(chip);
  state.chip = chip;
  return chip;
}

/**
 * What the chip says, in one word: the reason. For a grey sentence, the kind when the kind is the
 * reason (story, opinion, filler, promo) and "aside" when the model called it a fact, a figure or a
 * step and still not what the reader came for. For a sentence brought back, what brought it back.
 * An earlier chip put the kind beside p(keep) as a row of dots, and it read as a contradiction:
 * "fact", one dot lit. A fact can be true and beside the point; the reader asks why it is grey.
 */
function chipContent(doc: Document, j: SentenceJudgment, pinned: boolean, rule: string | null): Node[] {
  const label = doc.createElement("span");
  label.className = "osso-chip-label";
  label.textContent = rule !== null ? `kept by ${rule}` : pinned ? "pinned" : reasonWord(j);
  return [label];
}

/** Only a sentence with something to explain gets a chip: grey, pinned back, or kept by a rule. Ink needs no note, and neither does a sentence still waiting for its front. */
function explained(state: DocState, span: HTMLElement, id: number): boolean {
  if (span.classList.contains("osso-wait")) return false;
  return span.classList.contains("osso-fade") || span.classList.contains("osso-pin") || ruleKeeping(state, id) !== null;
}

interface Point {
  x: number;
  y: number;
}

/**
 * The line box to hang the chip on: the one under the pointer, else the first one inside the
 * viewport. A long sentence whose first line has scrolled away must not send the chip off screen.
 * With no line boxes at all (no layout yet) the bounding box stands in; with none on screen, null.
 */
function visibleRect(span: HTMLElement, win: Window, at?: Point): DOMRect | null {
  const rects = Array.from(span.getClientRects());
  if (rects.length === 0) return span.getBoundingClientRect();
  if (at) {
    const under = rects.find((r) => at.x >= r.left && at.x <= r.right && at.y >= r.top && at.y <= r.bottom);
    if (under) return under;
  }
  const vw = win.innerWidth || Infinity;
  const vh = win.innerHeight || Infinity;
  return rects.find((r) => r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw) ?? null;
}

/** Which side of the line the chip sits on; osso.css slides it in from the text's side. */
export type ChipSide = "left" | "right" | "above";

export interface ChipPlace {
  left: number;
  top: number;
  side: ChipSide;
}

/**
 * Where the chip goes: beside the line it describes, in the nearer margin, like a note in the
 * margin of a book, so it never covers a word of the sentence. With no margin to speak of it takes
 * the free run at the end of the line when `lineEndFree` says there is one, and only as a last
 * resort sits above the line. Margins are the block's, not the line's, so a short last line still
 * gets its note beside it.
 */
export function placeChip(
  line: DOMRect,
  block: DOMRect,
  at: Point | undefined,
  size: { width: number; height: number },
  view: { width: number; height: number },
  lineEndFree: () => boolean,
): ChipPlace {
  const gap = CHIP_GAP_PX;
  const edge = gap * 1.5;
  const vw = view.width || Infinity;
  const vh = view.height || Infinity;
  const clampY = (y: number) => Math.max(gap / 2, Math.min(y, vh - size.height - gap / 2));
  const beside = clampY(line.top + line.height / 2 - size.height / 2);
  const roomLeft = block.left - edge - size.width >= gap;
  const roomRight = vw - block.right - edge - size.width >= gap;
  const nearer: ChipSide = at && at.x > block.left + block.width / 2 ? "right" : "left";
  for (const side of nearer === "right" ? (["right", "left"] as const) : (["left", "right"] as const)) {
    if (side === "left" && roomLeft) return { left: block.left - edge - size.width, top: beside, side };
    if (side === "right" && roomRight) return { left: block.right + edge, top: beside, side };
  }
  if (line.right + gap + size.width <= Math.min(block.right, vw - gap) && lineEndFree()) {
    return { left: line.right + gap, top: beside, side: "right" };
  }
  let left = line.left + line.width / 2 - size.width / 2;
  left = Math.min(Math.max(left, gap), Math.max(gap, vw - size.width - gap));
  let top = line.top - size.height - gap;
  if (top < gap / 2) top = line.bottom + gap;
  return { left, top: clampY(top), side: "above" };
}

function showChip(doc: Document, state: DocState, span: HTMLElement, id: number, at?: Point) {
  const j = state.judgment.get(id);
  const win = doc.defaultView;
  if (!j || !win || !span.isConnected || !explained(state, span, id)) return;
  const rect = visibleRect(span, win, at);
  if (!rect) return;
  const block = span.closest<HTMLElement>(BLOCK);
  const chip = chipOf(doc, state);
  chip.replaceChildren(...chipContent(doc, j, state.pinned.has(id), ruleKeeping(state, id)));
  chip.classList.toggle("osso-chip-on-dark", block?.classList.contains("osso-dark") ?? false);

  // Reads, then writes. Measuring the chip here also flushes its style so the show transition plays.
  const size = { width: chip.offsetWidth, height: chip.offsetHeight };
  const view = { width: win.innerWidth || 0, height: win.innerHeight || 0 };
  const blockRect = block?.getBoundingClientRect() ?? rect;
  // Is the run after the line's end empty page, or another sentence on the same line?
  const lineEndFree = () => {
    if (typeof doc.elementFromPoint !== "function") return false;
    const hit = doc.elementFromPoint(rect.right + CHIP_GAP_PX + size.width / 2, rect.top + rect.height / 2);
    return !!hit && !hit.closest(SPAN) && (block?.contains(hit) ?? false);
  };
  const place = placeChip(rect, blockRect, at, size, view, lineEndFree);
  chip.classList.remove("osso-chip-left", "osso-chip-right", "osso-chip-above");
  chip.classList.add(`osso-chip-${place.side}`);
  chip.style.left = `${Math.round(place.left)}px`;
  chip.style.top = `${Math.round(place.top)}px`;
  chip.classList.add("osso-chip-show");
}

function hideChip(state: DocState) {
  state.chip?.classList.remove("osso-chip-show");
}

/**
 * Reveal key, pin click and hover chip. Listeners run in the capture phase so a page that stops
 * propagation cannot trap the reveal key; the returned function removes everything. The root class
 * is the one truth about whether the page is revealed, whoever switched it: the key gives back only
 * what it took, so a "Reveal all" from the popup survives a Shift tap.
 */
export function installInteractions(
  doc: Document,
  opts: {
    revealKey: RevealKey;
    holdMs: number;
    onPinChange?: (counts: Counts) => void;
    onRevealChange?: (on: boolean) => void;
  },
): () => void {
  const win = doc.defaultView;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let heldByKey = false;
  let mouseDown = false;
  let chipTimer: ReturnType<typeof setTimeout> | null = null;
  let hoveredId: number | null = null;

  const isRevealed = () => doc.documentElement.classList.contains("osso-reveal");
  const setRevealed = (on: boolean) => {
    if (on === isRevealed()) return;
    setReveal(doc, on);
    opts.onRevealChange?.(on);
  };
  const cancelHold = () => {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
  };
  const endHold = () => {
    cancelHold();
    if (heldByKey) {
      heldByKey = false;
      setRevealed(false);
    }
  };
  const selecting = () => {
    const sel = doc.getSelection?.();
    return !!sel && !sel.isCollapsed;
  };
  const clearChip = () => {
    if (chipTimer) clearTimeout(chipTimer);
    chipTimer = null;
    hoveredId = null;
    hideChip(stateOf(doc));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    clearChip();
    if (e.key !== opts.revealKey || e.repeat || holdTimer || heldByKey) return;
    // Shadow DOM retargets the event to the host; the composed path still names the input inside it.
    const target = (typeof e.composedPath === "function" ? e.composedPath()[0] : undefined) ?? e.target;
    if (isEditable(target)) return;
    // Shift also extends a selection (Shift+click, Shift+arrow): over one, or with a button down, it is not a reveal.
    if (mouseDown || selecting()) return;
    // A tap (capitalising a letter, a shortcut) must do nothing: the timer only fires on a real hold.
    holdTimer = setTimeout(() => {
      holdTimer = null;
      if (isRevealed()) return;
      heldByKey = true;
      setRevealed(true);
    }, opts.holdMs);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === opts.revealKey) endHold();
  };
  const onBlur = () => endHold();
  const onMouseDown = () => {
    mouseDown = true;
    cancelHold();
  };
  const onMouseUp = () => {
    mouseDown = false;
  };
  const onSelectionChange = () => {
    if (holdTimer && selecting()) cancelHold();
  };

  const onClick = (e: MouseEvent) => {
    const target = e.target as Element | null;
    if (!target || typeof target.closest !== "function") return;
    const span = target.closest<HTMLElement>(SPAN);
    if (!span || !span.classList.contains("osso-fade") || span.classList.contains("osso-wait")) return;
    // A link is a link; and a drag to select text is not a click.
    if (target.closest("a")) return;
    if (selecting()) return;
    const id = sentenceId(span);
    if (id == null) return;
    const state = stateOf(doc);
    const pinned = !state.pinned.has(id);
    if (pinned) state.pinned.add(id);
    else state.pinned.delete(id);
    for (const s of doc.querySelectorAll<HTMLElement>(`${SPAN}[data-osso="${id}"]`)) s.classList.toggle("osso-pin", pinned);
    if (hoveredId === id && state.chip?.classList.contains("osso-chip-show")) showChip(doc, state, span, id, { x: e.clientX, y: e.clientY });
    opts.onPinChange?.(counts(doc));
  };

  const onOver = (e: MouseEvent) => {
    const target = e.target as Element | null;
    if (!target || typeof target.closest !== "function") return;
    const span = target.closest<HTMLElement>(SPAN);
    const id = span ? sentenceId(span) : null;
    if (span && id != null && id === hoveredId) return;
    clearChip();
    if (!span || id == null) return;
    hoveredId = id;
    const at = { x: e.clientX, y: e.clientY };
    chipTimer = setTimeout(() => {
      chipTimer = null;
      if (hoveredId === id) showChip(doc, stateOf(doc), span, id, at);
    }, CHIP_DELAY_MS);
  };
  const onOut = (e: MouseEvent) => {
    const to = e.relatedTarget as Element | null;
    if (to && typeof to.closest === "function") {
      const next = to.closest<HTMLElement>(SPAN);
      if (next && sentenceId(next) === hoveredId) return;
    }
    clearChip();
  };
  const onScroll = () => clearChip();

  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("keyup", onKeyUp, true);
  doc.addEventListener("mousedown", onMouseDown, true);
  doc.addEventListener("mouseup", onMouseUp, true);
  doc.addEventListener("selectionchange", onSelectionChange);
  doc.addEventListener("click", onClick);
  doc.addEventListener("mouseover", onOver);
  doc.addEventListener("mouseout", onOut);
  doc.addEventListener("scroll", onScroll, { capture: true, passive: true });
  win?.addEventListener("blur", onBlur);

  return () => {
    doc.removeEventListener("keydown", onKeyDown, true);
    doc.removeEventListener("keyup", onKeyUp, true);
    doc.removeEventListener("mousedown", onMouseDown, true);
    doc.removeEventListener("mouseup", onMouseUp, true);
    doc.removeEventListener("selectionchange", onSelectionChange);
    doc.removeEventListener("click", onClick);
    doc.removeEventListener("mouseover", onOver);
    doc.removeEventListener("mouseout", onOut);
    doc.removeEventListener("scroll", onScroll, true);
    win?.removeEventListener("blur", onBlur);
    endHold();
    clearChip();
  };
}

/** Back to the author's page: every class and property we added goes, the spans stay for segment to unwrap. */
export function clearRender(doc: Document): void {
  const state = states.get(doc);
  if (state) {
    for (const t of state.settling) clearTimeout(t);
    releaseWaiting(state);
    if (state.instantTimer) clearTimeout(state.instantTimer);
    if (state.hitTimer) clearTimeout(state.hitTimer);
    state.chip?.remove();
    states.delete(doc);
  }
  doc.documentElement.classList.remove("osso-on", "osso-reveal", "osso-instant", "osso-settled", "osso-still", "osso-strike");
  for (const s of doc.querySelectorAll<HTMLElement>(SPAN)) {
    s.classList.remove("osso-fade", "osso-pin", "osso-rule-hit", "osso-sweep", "osso-wipe", "osso-wait", "osso-arrive");
    for (const name of WAVE_PROPERTIES) dropProperty(s, name);
    for (const name of FRONT_PROPERTIES) dropProperty(s, name);
  }
  for (const b of doc.querySelectorAll<HTMLElement>(BLOCK)) {
    dropProperty(b, "--osso-grey");
    dropProperty(b, "--osso-ink");
    b.classList.remove("osso-dark");
  }
  for (const chip of doc.querySelectorAll(".osso-chip")) chip.remove();
}
