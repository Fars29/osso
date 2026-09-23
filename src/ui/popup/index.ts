/**
 * The popup. One field (what to always keep), one number (sentences kept), one switch, one
 * slider, one reveal. Everything it shows comes from the background's copy of the tab state or,
 * when the content script answers, from the page itself. It must render something sensible when
 * neither answers.
 */
import {
  MAX_HIGHLIGHTS,
  MAX_HIGHLIGHT_LENGTH, DEFAULT_SETTINGS, MIN_SENTENCES, PAGE_KINDS, THRESHOLD_MAX, THRESHOLD_MIN, USD_PER_INPUT_TOKEN } from "../../shared/constants.ts";
import type { Settings, TabState } from "../../shared/types.ts";
import { getSettings, getTabStateFromBackground, getTabStateFromTab, patchSettings, sendToBackground, sendToTab } from "../messaging.ts";
import { MARK_EXAMPLES, MARK_FULL_HINT, MARK_TITLE, ruleField, ruleList, type RuleCount } from "../rules.ts";

type View = "loading" | "cannot" | "no-key" | "invalid-key" | "disabled" | "off" | "skipped" | "error" | "judging" | "idle" | "done" | "ready" | "held";

const POLL_MS = 500;
/** An "idle" tab may never start judging (content script waiting on a page that never settles); stop asking after this. */
const IDLE_POLL_LIMIT = 40;
/** A rule's count is one request away (~0.5 s); after this many polls without one the chip stops its wheel and says "?". */
const RULE_POLL_LIMIT = 60;
/** The content script's skip sentinels, said the way a person would; anything else is shown as it came. */
const SKIP_REASONS: Record<string, string> = {
  "too little text": `Fewer than ${MIN_SENTENCES} sentences of body text.`,
  "looks like an app": "This page is an app, not something to read.",
  "sign-in or payment page": "It shows a password or card field. Osso never reads these.",
};
/** Why Osso held back on a page that looks private (content/privacy.ts): how the page is made, never what it is about. */
function heldReason(reason: string | undefined): string {
  if (reason?.startsWith("private-path:")) return `Its address is a private area (/${reason.slice("private-path:".length)}). Nothing was sent.`;
  if (reason === "personal-form") return "It asks for your personal details. Nothing was sent.";
  if (reason === "signed-in") return "It looks like the inside of an account. Nothing was sent.";
  if (reason === "unlisted") return "Its site tells search engines not to keep this page. Nothing was sent.";
  if (reason === "private-host") return "This host only exists inside a network. Nothing was sent.";
  if (reason === "account-numbers") return "It lists account numbers, like a statement. Nothing was sent.";
  return "It looks private. Nothing was sent.";
}
/** Views with nothing for a rule to count: the field still works (rules are global), the chips show no number. */
const NO_RULES_VIEWS: readonly View[] = ["loading", "cannot", "no-key", "invalid-key"];
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`[osso] popup: #${id} missing`);
  return node as T;
}

const ui = {
  root: el<HTMLElement>("popup"),
  chip: el<HTMLSpanElement>("chip"),
  rules: el<HTMLElement>("rules"),
  rule: el<HTMLInputElement>("rule"),
  ruleList: el<HTMLUListElement>("rule-list"),
  mark: el<HTMLInputElement>("mark"),
  markList: el<HTMLUListElement>("mark-list"),
  marks: el<HTMLElement>("v-marks"),
  markCount: el<HTMLElement>("marks"),
  markOf: el<HTMLElement>("marks-of"),
  markBone: el<HTMLElement>("mark-bone"),
  markStatus: el<HTMLElement>("marks-status"),
  count: el<HTMLDivElement>("v-count"),
  kept: el<HTMLSpanElement>("kept"),
  total: el<HTMLSpanElement>("total"),
  caption: el<HTMLParagraphElement>("caption"),
  bone: el<HTMLElement>("bone"),
  status: el<HTMLParagraphElement>("status"),
  note: el<HTMLDivElement>("v-note"),
  noteTitle: el<HTMLParagraphElement>("note-title"),
  noteSub: el<HTMLParagraphElement>("note-sub"),
  noteAction: el<HTMLButtonElement>("note-action"),
  controls: el<HTMLElement>("controls"),
  site: el<HTMLInputElement>("site"),
  siteLabel: el<HTMLElement>("site-label"),
  threshold: el<HTMLInputElement>("threshold"),
  reveal: el<HTMLButtonElement>("reveal"),
  hint: el<HTMLSpanElement>("hint"),
  settings: el<HTMLAnchorElement>("settings"),
};

const model = {
  tabId: null as number | null,
  host: "",
  settings: DEFAULT_SETTINGS as Settings,
  /** False when the background never answered; then the key checks would only mislead. */
  settingsLoaded: false,
  state: null as TabState | null,
  revealed: false,
  /** What the big number currently shows, so a count-up starts from where the eye is. */
  shown: 0,
  raf: 0,
  poll: 0,
  idlePolls: 0,
  rulePolls: 0,
  /** The field takes focus once, when the page is judged; not again on every poll. */
  focused: false,
};

const chips = ruleList(ui.ruleList, { onRemove: (rule) => void removeRule(rule) });
const field = ruleField(ui.rule, {
  rules: () => model.settings.rules,
  onAdd: (rule) => void addRule(rule),
  onDuplicate: (existing) => chips.flash(existing),
});

// The same widget, a shorter list: each term costs a second look at the page.
const markChips = ruleList(ui.markList, { onRemove: (term) => void removeHighlight(term), title: MARK_TITLE });
const markField = ruleField(ui.mark, {
  rules: () => model.settings.highlights,
  onAdd: (term) => void addHighlight(term),
  onDuplicate: (existing) => markChips.flash(existing),
  max: MAX_HIGHLIGHTS,
  maxLength: MAX_HIGHLIGHT_LENGTH,
  examples: MARK_EXAMPLES,
  fullHint: MARK_FULL_HINT,
});

// ---- formatting -----------------------------------------------------------

/** Four places, because a highlight costs a few hundredths of a cent and should still read as a price. */
function formatCost(inputTokens: number): string {
  const usd = inputTokens * USD_PER_INPUT_TOKEN;
  return usd < 0.0001 ? "< $0.0001" : `≈ $${usd.toFixed(4)}`;
}

function formatSeconds(ms: number): string {
  return `${(Math.max(ms, 50) / 1000).toFixed(1)} s`;
}

/** `short` when the figure shares the row with the highlight one: the column is half as wide, the verb goes. */
function statusLine(s: TabState, short = false): string {
  // A very long page is judged from the top down to the cap and no further: the reader is told, since the rest is in ink for that reason and no other.
  const long = s.capped ? ` · long page, first ${s.total.toLocaleString("en-US")} sentences` : "";
  if (s.cached) return `from cache${long}`;
  return `${short ? "" : "judged in "}${formatSeconds(s.ms)} · ${formatCost(s.inputTokens)}${long}`;
}

// ---- the big number -------------------------------------------------------

function countTo(target: number) {
  cancelAnimationFrame(model.raf);
  const from = model.shown;
  if (from === target) {
    ui.kept.textContent = String(target);
    return;
  }
  // The number is the product; when it moves it gets a breath of marrow, then returns to ink.
  ui.kept.classList.add("changed");
  setTimeout(() => ui.kept.classList.remove("changed"), 500);
  if (reducedMotion) {
    model.shown = target;
    ui.kept.textContent = String(target);
    return;
  }
  const t0 = performance.now();
  const duration = 400;
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    model.shown = Math.round(from + (target - from) * eased);
    ui.kept.textContent = String(model.shown);
    if (p < 1) model.raf = requestAnimationFrame(step);
  };
  model.raf = requestAnimationFrame(step);
}

// ---- rendering ------------------------------------------------------------

function show(view: View) {
  ui.root.dataset.state = view;
  // The second figure belongs to a judged page; every other view starts without it.
  if (view !== "done") {
    ui.marks.hidden = true;
    ui.count.classList.remove("pair");
  }
  const numeric = view === "done" || view === "judging" || view === "idle" || view === "loading";
  ui.count.hidden = !numeric;
  ui.note.hidden = numeric;
  ui.controls.hidden = view === "cannot";
  ui.controls.classList.toggle("dim", view === "loading");
  ui.kept.classList.toggle("pulse", view === "judging" || view === "idle");
  ui.kept.classList.remove("quiet");
  // Only a judged page has probabilities to move and grey to reveal; elsewhere the slider and the
  // reveal would answer nothing, so they say so by being inert. The site switch stays live: a
  // denied host has to be turnable on from here.
  const live = view === "done";
  ui.threshold.disabled = !live;
  ui.reveal.disabled = !live;
  ui.hint.hidden = !live;
  renderRules(view);
}

/** What a chip shows for a rule on this page: a count once the page has answered, a turning wheel while it is answering, "?" when no answer came. */
function countFor(rule: string): RuleCount {
  const s = model.state;
  if (!s || (s.status !== "done" && s.status !== "judging")) return null;
  const n = s.ruleHits[rule];
  if (typeof n === "number") return n;
  if (s.ruleFailed?.includes(rule)) return "unknown";
  return model.rulePolls >= RULE_POLL_LIMIT ? "unknown" : "judging";
}

/** How many stretches a term marks on this page, or what the chip should say while it does not know yet. */
function markCountFor(term: string): RuleCount {
  const s = model.state;
  if (!s || (s.status !== "done" && s.status !== "judging")) return null;
  const n = s.markHits?.[term];
  if (typeof n === "number") return n;
  if (s.markFailed?.includes(term)) return "unknown";
  return model.rulePolls >= RULE_POLL_LIMIT ? "unknown" : "judging";
}

function renderRules(view: View) {
  const on = model.settingsLoaded && !NO_RULES_VIEWS.includes(view);
  ui.rules.hidden = !on;
  if (!on) {
    field.stop();
    markField.stop();
    return;
  }
  chips.render(model.settings.rules, countFor);
  field.refresh();
  markChips.render(model.settings.highlights, markCountFor);
  markField.refresh();
  // The one field the reader talks to is ready to type in the moment there is a page to talk about.
  if (view === "done" && !model.focused && !ui.rule.disabled && document.activeElement === document.body) {
    model.focused = true;
    ui.rule.focus();
  }
}

function note(title: string, sub = "", action?: { label: string; primary?: boolean; onClick: () => void }, soft = false, wrap = false) {
  ui.noteTitle.textContent = title;
  // A reason the reader has to be able to read whole (why Osso held back) runs onto a second line; the rest stay on one.
  ui.noteSub.classList.toggle("wrap", wrap);
  ui.noteTitle.classList.toggle("soft", soft);
  ui.noteSub.textContent = sub;
  ui.noteSub.hidden = sub === "";
  ui.noteSub.title = sub;
  ui.noteAction.hidden = !action;
  if (action) {
    ui.noteAction.textContent = action.label;
    ui.noteAction.classList.toggle("btn-primary", !!action.primary);
    ui.noteAction.onclick = action.onClick;
  }
}

function renderChip(s: TabState | null) {
  const kind = s?.pageKind ?? s?.packId ?? null;
  const known = kind !== null && (s?.status === "done" || s?.status === "judging");
  ui.chip.hidden = !known;
  if (known) ui.chip.textContent = PAGE_KINDS[kind].label;
}

/**
 * The second figure, in the shape of the first and beside it: how many of the page's sentences the
 * highlight terms marked, a bar in the marker's colour, and what finding them cost. The chips say
 * how many things each term marked. Shown only while there is a term; "…" until every term is answered, "?" when none got an answer.
 */
function renderMarks(s: TabState | null) {
  const terms = model.settings.highlights;
  const on = !!s && terms.length > 0 && (s.status === "done" || s.status === "judging");
  ui.marks.hidden = !on;
  ui.count.classList.toggle("pair", on);
  if (!on || !s) return;
  ui.markBone.style.setProperty("--mark", model.settings.markColor);
  const failed = new Set(s.markFailed ?? []);
  const answered = terms.every((t) => typeof s.markHits?.[t] === "number" || failed.has(t));
  ui.markCount.classList.toggle("pulse", !answered);
  if (!answered) {
    ui.markCount.textContent = "…";
    ui.markOf.textContent = "";
    ui.markStatus.textContent = "looking…";
    return;
  }
  if (terms.every((t) => failed.has(t))) {
    ui.markCount.textContent = "?";
    ui.markOf.textContent = "";
    ui.markBone.style.width = "0%";
    ui.markStatus.textContent = "no answer";
    return;
  }
  const sentences = s.markedSentences ?? 0;
  const things = terms.reduce((n, t) => n + (s.markHits?.[t] ?? 0), 0);
  ui.markCount.textContent = String(sentences);
  ui.markOf.textContent = `/ ${s.total}`;
  ui.markBone.style.width = s.total > 0 ? `${(100 * sentences) / s.total}%` : "0%";
  const tokens = s.markTokens ?? 0;
  ui.markStatus.textContent = tokens === 0 ? "from cache" : `${formatSeconds(s.markMs ?? 0)} · ${formatCost(tokens)}`;
  ui.marks.title = `${things} ${things === 1 ? "thing" : "things"} highlighted in ${sentences} of ${s.total} sentences`;
}

function renderNumbers(s: TabState) {
  ui.total.textContent = `/ ${s.total}`;
  ui.caption.textContent = s.kept === 1 ? "sentence kept" : "sentences kept";
  ui.bone.style.width = s.total > 0 ? `${(100 * s.kept) / s.total}%` : "0%";
  ui.status.textContent = statusLine(s, ui.count.classList.contains("pair"));
  countTo(s.kept);
}

/** The blocks under the fields: a row of chips coming or going moves them. */
const below = [ui.count.parentElement, ui.controls, document.querySelector<HTMLElement>(".foot")].filter((el): el is HTMLElement => !!el);
/** How many chips the last render left, so a render that adds or removes a row is known; -1 before the first. */
let chipsBefore = -1;

/**
 * Renders, and lets what a new row of chips pushes down move there instead of jumping: in the popup's
 * close-up the figures dropped 85 px in one frame when the first highlight term went in, and the second
 * figure appeared from nowhere. Only when the chips changed, never on the first render (the popup
 * settles in as a whole) and never under reduced motion.
 */
function render() {
  const chipCount = ui.ruleList.children.length + ui.markList.children.length;
  const shown = (el: HTMLElement) => el.getClientRects().length > 0;
  const watch = !reducedMotion && chipsBefore >= 0;
  const before = watch ? below.map((el) => (shown(el) ? el.getBoundingClientRect().top : null)) : [];
  const marksBefore = !ui.marks.hidden;
  draw();
  const chipsNow = ui.ruleList.children.length + ui.markList.children.length;
  const changed = chipsBefore >= 0 && chipsNow !== chipCount;
  chipsBefore = chipsNow;
  if (!watch || !changed) return;
  const ease = "cubic-bezier(0.2, 0.7, 0.2, 1)";
  below.forEach((el, i) => {
    const top = before[i];
    if (top == null || !shown(el) || typeof el.animate !== "function") return;
    const dy = top - el.getBoundingClientRect().top;
    if (Math.abs(dy) >= 1) el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 220, easing: ease });
  });
  if (!marksBefore && !ui.marks.hidden && typeof ui.marks.animate === "function") {
    ui.marks.animate([{ opacity: 0, transform: "translateY(3px)" }, { opacity: 1, transform: "none" }], { duration: 240, easing: ease });
  }
}

function draw() {
  const s = model.state;
  const settings = model.settings;
  renderChip(s);
  // In run mode "click" the switch says where Osso reads without being asked; otherwise, where it reads at all.
  const click = settings.mode === "click";
  ui.siteLabel.textContent = click ? "Always on this site" : "On this site";
  ui.site.checked = click ? s?.always === true && s.status !== "disabled" && settings.enabled : !(s?.status === "disabled") && settings.enabled;
  // With Osso off everywhere the site switch would only snap back; the note offers the switch that matters.
  ui.site.disabled = !settings.enabled;
  ui.reveal.textContent = model.revealed ? "Fade again" : "Reveal all";
  const kbd = document.createElement("kbd");
  kbd.textContent = settings.revealKey;
  ui.hint.replaceChildren("Hold ", kbd, " to peek");

  if (!model.settingsLoaded && !s) {
    show("cannot");
    note("Osso is waking up", "Reopen the popup in a moment.", undefined, true);
    return;
  }
  if (model.settingsLoaded && (!settings.apiKey || s?.status === "no-key")) {
    show("no-key");
    note("Osso needs your TypeSafe key.", "Your key stays in this browser.", { label: "Add key", primary: true, onClick: openOptions });
    return;
  }
  if (model.settingsLoaded && settings.apiKeyInvalid) {
    show("invalid-key");
    note("TypeSafe rejected your key.", "Paste a new one in Settings.", { label: "Fix key", primary: true, onClick: openOptions });
    return;
  }
  if (!s) {
    show("cannot");
    note("Osso can't run here", "Only ordinary http and https pages.", undefined, true);
    return;
  }
  switch (s.status) {
    case "disabled":
      show("disabled");
      if (settings.enabled) note("Off on this site", "Switch it on below to judge this page.", undefined, true);
      else note("Osso is off", "Every page is left as it is.", { label: "Turn on", primary: true, onClick: () => void turnOn() }, true);
      return;
    case "skipped":
      show("skipped");
      note("Nothing to strip here", SKIP_REASONS[s.reason ?? ""] ?? s.reason ?? "", undefined, true, true);
      return;
    case "ready":
      // The reader opened the popup on this page: that is the asking. It starts at once (see init).
      show("ready");
      note("Reading this page…", "", undefined, true);
      return;
    case "held":
      show("held");
      note("Osso held back here", heldReason(s.reason), { label: "Read this page once", onClick: () => void runHere() }, false, true);
      return;
    case "error":
      show("error");
      note("Couldn't judge this page", s.reason ?? "Something went wrong.", { label: "Retry", onClick: retry });
      return;
    case "judging":
    case "idle":
      show(s.status);
      if (s.status === "judging" && s.kept + s.faded > 0) {
        // Chunks are landing: the kept count climbs and the bar fills with what has been judged so far.
        ui.total.textContent = `/ ${s.total}`;
        ui.caption.textContent = "sentences kept · judging…";
        ui.status.textContent = "";
        ui.bone.style.width = s.total > 0 ? `${(100 * (s.kept + s.faded)) / s.total}%` : "0%";
        countTo(s.kept);
        return;
      }
      // Nothing back yet: the number that will become the kept count is already there, pulsing;
      // the caption carries the verb.
      ui.kept.textContent = s.total > 0 ? String(s.total) : "…";
      ui.total.textContent = "";
      ui.caption.textContent = s.status === "judging" ? "sentences, judging…" : "waiting for the page";
      ui.status.textContent = "";
      ui.bone.style.width = "0%";
      model.shown = s.total;
      return;
    case "done":
      show("done");
      // The highlight figure first: whether it is there decides how much room the first one has.
      renderMarks(s);
      renderNumbers(s);
      return;
  }
}

// ---- data -----------------------------------------------------------------

async function freshState(): Promise<TabState | null> {
  if (model.tabId === null) return null;
  // The page's own state is fresher (the popup may open mid-judgment); the background's copy
  // survives a content script that has gone quiet.
  const fromTab = await getTabStateFromTab(model.tabId);
  return fromTab ?? (await getTabStateFromBackground(model.tabId));
}

async function refresh() {
  const s = await freshState();
  if (s) {
    model.state = s;
    model.host = s.host || model.host;
    model.revealed = s.revealed;
  } else if (model.state) {
    model.state = null;
  }
  render();
  schedulePolling();
}

/** A rule with no count yet on a judged page: the page is asking the model about it. */
function rulesPending(): boolean {
  const s = model.state;
  if (!s || s.status !== "done") return false;
  if (model.settings.rules.some((r) => typeof s.ruleHits[r] !== "number" && !s.ruleFailed?.includes(r))) return true;
  return model.settings.highlights.some((t) => typeof s.markHits?.[t] !== "number" && !s.markFailed?.includes(t));
}

function wantsPolling(): boolean {
  const st = model.state?.status;
  if (st === "judging") return true;
  if (st === "ready") return model.idlePolls++ < IDLE_POLL_LIMIT;
  if (st === "idle") return model.idlePolls++ < IDLE_POLL_LIMIT;
  if (rulesPending()) return model.rulePolls++ < RULE_POLL_LIMIT;
  return false;
}

function schedulePolling() {
  if (!wantsPolling()) {
    stopPolling();
    return;
  }
  if (model.poll) return;
  model.poll = window.setInterval(async () => {
    const s = await freshState();
    if (s) {
      model.state = s;
      model.revealed = s.revealed;
    }
    render();
    if (!wantsPolling()) stopPolling();
  }, POLL_MS);
}

function stopPolling() {
  if (model.poll) clearInterval(model.poll);
  model.poll = 0;
}

// ---- actions --------------------------------------------------------------

function openOptions() {
  void chrome.runtime.openOptionsPage();
}

/** The reader asks for this page. Nothing else starts a page in run mode "click", or one Osso held back on. */
async function runHere() {
  if (model.tabId === null) return;
  await sendToTab(model.tabId, { type: "run" }).catch(() => null);
  model.idlePolls = 0;
  await refresh();
}

async function retry() {
  if (model.tabId === null) return;
  await chrome.tabs.reload(model.tabId);
  window.close();
}

/** The master switch, from the note that says it is off. The page is told directly so the count starts now, not on the next poll. */
async function turnOn() {
  if (!(await patchSettings({ enabled: true }))) return;
  model.settings = { ...model.settings, enabled: true };
  if (model.tabId !== null) await sendToTab(model.tabId, { type: "setEnabledHere", enabled: true }).catch(() => null);
  model.idlePolls = 0;
  await refresh();
}

/**
 * Saves the list and shows it at once: the chip is there before the background answers, with
 * its wheel turning until the page reports what the rule keeps. The background tells the page; the popup only
 * has to keep asking the page for its counts.
 */
async function addHighlight(term: string) {
  return saveHighlights([...model.settings.highlights, term]);
}

async function removeHighlight(term: string) {
  return saveHighlights(model.settings.highlights.filter((t) => t !== term));
}

/** Saving is the whole of it: the background tells the page, and the page asks for what it does not have. */
async function saveHighlights(highlights: string[]) {
  model.settings = { ...model.settings, highlights };
  model.rulePolls = 0;
  render();
  schedulePolling();
  if (!(await patchSettings({ highlights }))) {
    const fresh = await getSettings();
    if (fresh) model.settings = fresh;
    render();
  }
}

async function saveRules(rules: string[]) {
  model.settings = { ...model.settings, rules };
  model.rulePolls = 0;
  render();
  schedulePolling();
  if (!(await patchSettings({ rules }))) {
    // Nobody saved it: the chip would lie. Reload what is really there.
    const fresh = await getSettings();
    if (fresh) model.settings = fresh;
    render();
  }
}

function addRule(rule: string) {
  return saveRules([...model.settings.rules, rule]);
}

function removeRule(rule: string) {
  return saveRules(model.settings.rules.filter((r) => r !== rule));
}

function setSliderFill() {
  const v = Number(ui.threshold.value);
  const pct = ((v - THRESHOLD_MIN) / (THRESHOLD_MAX - THRESHOLD_MIN)) * 100;
  ui.threshold.style.setProperty("--fill", `${pct}%`);
}

async function onSiteToggle() {
  if (model.settings.mode === "click") {
    const always = ui.site.checked;
    if (model.host) await sendToBackground({ type: "setHostAlways", host: model.host, always }).catch(() => null);
    if (model.state) model.state = { ...model.state, always };
    if (always) await runHere();
    else render();
    return;
  }
  const enabled = ui.site.checked;
  if (model.state && !enabled) {
    // Optimistic: the switch answers before the page does.
    model.state = { ...model.state, status: "disabled" };
    render();
  }
  if (model.host) await sendToBackground({ type: "setHostEnabled", host: model.host, enabled }).catch(() => null);
  if (model.tabId !== null) await sendToTab(model.tabId, { type: "setEnabledHere", enabled }).catch(() => null);
  model.idlePolls = 0;
  await refresh();
}

async function onThresholdInput() {
  setSliderFill();
  const value = Number(ui.threshold.value);
  model.settings = { ...model.settings, threshold: value };
  if (model.tabId === null || model.state?.status !== "done") return;
  const reply = await sendToTab(model.tabId, { type: "setThreshold", value }).catch(() => null);
  const s = reply?.type === "tabState" ? reply.state : await getTabStateFromTab(model.tabId);
  if (s) {
    model.state = s;
    renderNumbers(s);
  }
}

function onThresholdChange() {
  void patchSettings({ threshold: Number(ui.threshold.value) });
}

async function onReveal() {
  if (model.tabId === null) return;
  model.revealed = !model.revealed;
  ui.reveal.textContent = model.revealed ? "Fade again" : "Reveal all";
  await sendToTab(model.tabId, { type: "reveal", on: model.revealed }).catch(() => null);
}

// ---- boot -----------------------------------------------------------------

async function main() {
  ui.threshold.min = String(THRESHOLD_MIN);
  ui.threshold.max = String(THRESHOLD_MAX);
  ui.threshold.step = "0.05";
  ui.threshold.value = String(DEFAULT_SETTINGS.threshold);
  setSliderFill();

  ui.site.addEventListener("change", () => void onSiteToggle());
  ui.threshold.addEventListener("input", () => void onThresholdInput());
  ui.threshold.addEventListener("change", onThresholdChange);
  ui.reveal.addEventListener("click", () => void onReveal());
  ui.settings.addEventListener("click", (e) => {
    e.preventDefault();
    openOptions();
  });
  window.addEventListener("pagehide", () => {
    stopPolling();
    field.stop();
  });

  let tab: chrome.tabs.Tab | undefined;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    tab = undefined;
  }
  const url = tab?.url ?? "";
  const runnable = /^https?:/i.test(url);
  model.tabId = runnable && typeof tab?.id === "number" ? tab.id : null;
  try {
    model.host = runnable ? new URL(url).hostname : "";
  } catch {
    model.host = "";
  }

  const settings = await getSettings();
  if (settings) {
    model.settings = settings;
    model.settingsLoaded = true;
  }
  ui.threshold.value = String(model.settings.threshold);
  setSliderFill();

  await refresh();
  if (model.state?.status === "ready") await runHere();
}

void main();
