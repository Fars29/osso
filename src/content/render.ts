/**
 * The fade is the product. Everything here is a colour change on wrappers that segment already
 * placed: no node is moved, hidden or resized, and every state is reversible by removing a class.
 *
 * Contract with segment: each sentence is one or more `<osso-s class="osso-s" data-osso="ID">`,
 * each judged block carries `data-osso-block`. We add classes, custom properties and one chip; we
 * never unwrap.
 */
import type { PageJudgment, RevealKey, SentenceJudgment } from "../shared/types.ts";
import { SENTENCE_KINDS } from "../shared/constants.ts";

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

/** Settle: a wave down the page, 10 ms per faded sentence, capped so a long page still settles in ~1 s. */
const WAVE_STEP_MS = 10;
const WAVE_MAX_MS = 500;
const SETTLE_MS = 550;
/** Threshold re-render runs at 200 ms with no stagger (see osso.css `osso-instant`). */
const INSTANT_MS = 200;
const CHIP_DELAY_MS = 250;
/** Hover chip sits this far above the sentence's line box, and never closer than this to a viewport edge. */
const CHIP_GAP_PX = 8;

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
  /** Spans that carry an entrance delay; cleared once the wave has settled so later transitions are uniform. */
  waved: HTMLElement[];
  settleTimer: ReturnType<typeof setTimeout> | null;
  instantTimer: ReturnType<typeof setTimeout> | null;
  chip: HTMLElement | null;
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
      waved: [],
      settleTimer: null,
      instantTimer: null,
      chip: null,
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

/**
 * Toggles fade/pin classes from the stored judgment. With `wave`, sentences that become faded in this
 * pass get a delay by their rank in document order, so the page settles top to bottom. Sentences that
 * were already faded keep their state; kept sentences end with no class and no inline style.
 */
function render(doc: Document, state: DocState, wave: boolean): Counts {
  let total = 0;
  let faded = 0;
  let rank = 0;
  let maxDelay = 0;
  for (const [id, spans] of spansById(doc)) {
    const j = state.judgment.get(id);
    if (!j || state.failed.has(id)) continue;
    total++;
    const fade = j.keep < state.threshold;
    const pinned = state.pinned.has(id);
    const wasFaded = spans[0]!.classList.contains("osso-fade");
    for (const s of spans) {
      s.classList.toggle("osso-fade", fade);
      s.classList.toggle("osso-pin", pinned);
    }
    if (fade && !pinned) faded++;
    if (wave && fade && !wasFaded) {
      const delay = Math.min(rank * WAVE_STEP_MS, WAVE_MAX_MS);
      rank++;
      maxDelay = Math.max(maxDelay, delay);
      for (const s of spans) {
        s.style.setProperty("--osso-delay", `${delay}ms`);
        state.waved.push(s);
      }
    }
  }
  if (wave && rank > 0) scheduleSettle(doc, state, maxDelay);
  return { total, kept: total - faded, faded };
}

/**
 * Once the entrance wave has played, the delays have done their job: drop them so reveal, pin and
 * threshold changes move every sentence together, and mark the root settled (osso.css shortens the
 * transition from there on).
 */
function scheduleSettle(doc: Document, state: DocState, maxDelay: number) {
  const root = doc.documentElement;
  root.classList.remove("osso-settled");
  if (state.settleTimer) clearTimeout(state.settleTimer);
  state.settleTimer = setTimeout(() => {
    state.settleTimer = null;
    for (const s of state.waved) dropProperty(s, "--osso-delay");
    state.waved = [];
    root.classList.add("osso-settled");
  }, maxDelay + SETTLE_MS + 50);
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
  const blocks = Array.from(doc.querySelectorAll<HTMLElement>(BLOCK));
  const memo = new Map<Element, RGB>();
  const bgs = blocks.map((b) => (win ? effectiveBackground(b, win, memo) : WHITE));
  const inks = blocks.map((b) => (win ? inkOf(b, win) : null));
  blocks.forEach((b, i) => {
    const bg = bgs[i]!;
    const ink = inks[i];
    b.style.setProperty("--osso-grey", ink ? pickGrey(bg, ink) : pickGrey(bg));
    b.classList.toggle("osso-dark", luminance(bg) < LIGHT_LUMINANCE);
  });
}

export function applyJudgment(
  doc: Document,
  judgment: PageJudgment,
  opts: { threshold: number; animations: boolean },
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
  root.classList.toggle("osso-still", !opts.animations);
  const counts = render(doc, state, wave);
  if (!wave && !state.settleTimer) root.classList.add("osso-settled");
  return counts;
}

/** The popup slider: re-render from stored probabilities, no stagger, no inference. */
export function setThreshold(doc: Document, threshold: number): Counts {
  const state = stateOf(doc);
  state.threshold = threshold;
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

function showChip(doc: Document, state: DocState, span: HTMLElement, id: number, at?: Point) {
  const j = state.judgment.get(id);
  const win = doc.defaultView;
  if (!j || !win || !span.isConnected) return;
  const rect = visibleRect(span, win, at);
  if (!rect) return;
  const chip = chipOf(doc, state);
  const label = SENTENCE_KINDS[j.kind]?.label ?? j.kind;
  chip.textContent = `${label} · ${Math.round(j.keep * 100)}% worth keeping${state.pinned.has(id) ? " · pinned" : ""}`;
  chip.classList.toggle("osso-chip-light", span.closest(BLOCK)?.classList.contains("osso-dark") ?? false);

  // Reads, then writes. Measuring the chip here also flushes its style so the show transition plays.
  const cw = chip.offsetWidth;
  const ch = chip.offsetHeight;
  const vw = win.innerWidth || 0;
  const vh = win.innerHeight || 0;

  let left = rect.left + rect.width / 2 - cw / 2;
  if (vw > 0) left = Math.min(Math.max(left, CHIP_GAP_PX), Math.max(CHIP_GAP_PX, vw - cw - CHIP_GAP_PX));
  let top = rect.top - ch - CHIP_GAP_PX;
  if (top < CHIP_GAP_PX / 2) top = rect.bottom + CHIP_GAP_PX;
  if (vh > 0) top = Math.min(top, Math.max(0, vh - ch - CHIP_GAP_PX));
  top = Math.max(CHIP_GAP_PX / 2, top);
  chip.style.left = `${Math.round(left)}px`;
  chip.style.top = `${Math.round(top)}px`;
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
    if (!span || !span.classList.contains("osso-fade")) return;
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
    if (state.settleTimer) clearTimeout(state.settleTimer);
    if (state.instantTimer) clearTimeout(state.instantTimer);
    state.chip?.remove();
    states.delete(doc);
  }
  doc.documentElement.classList.remove("osso-on", "osso-reveal", "osso-instant", "osso-settled", "osso-still");
  for (const s of doc.querySelectorAll<HTMLElement>(SPAN)) {
    s.classList.remove("osso-fade", "osso-pin");
    dropProperty(s, "--osso-delay");
  }
  for (const b of doc.querySelectorAll<HTMLElement>(BLOCK)) {
    dropProperty(b, "--osso-grey");
    b.classList.remove("osso-dark");
  }
  for (const chip of doc.querySelectorAll(".osso-chip")) chip.remove();
}
