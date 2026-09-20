/**
 * The popup. One number (sentences kept), one switch, one slider, one reveal. Everything it
 * shows comes from the background's copy of the tab state or, when the content script answers,
 * from the page itself. It must render something sensible when neither answers.
 */
import { DEFAULT_SETTINGS, MIN_SENTENCES, PAGE_KINDS, THRESHOLD_MAX, THRESHOLD_MIN, USD_PER_INPUT_TOKEN } from "../../shared/constants.ts";
import type { Settings, TabState } from "../../shared/types.ts";
import { getSettings, getTabStateFromBackground, getTabStateFromTab, patchSettings, sendToBackground, sendToTab } from "../messaging.ts";

type View = "loading" | "cannot" | "no-key" | "invalid-key" | "disabled" | "off" | "skipped" | "error" | "judging" | "idle" | "done";

const POLL_MS = 500;
/** An "idle" tab may never start judging (content script waiting on a page that never settles); stop asking after this. */
const IDLE_POLL_LIMIT = 40;
/** The content script's skip sentinels, said the way a person would; anything else is shown as it came. */
const SKIP_REASONS: Record<string, string> = {
  "too little text": `Fewer than ${MIN_SENTENCES} sentences of body text.`,
  "looks like an app": "This page is an app, not something to read.",
};
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`[osso] popup: #${id} missing`);
  return node as T;
}

const ui = {
  root: el<HTMLElement>("popup"),
  chip: el<HTMLSpanElement>("chip"),
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
};

// ---- formatting -----------------------------------------------------------

function formatCost(inputTokens: number): string {
  const usd = inputTokens * USD_PER_INPUT_TOKEN;
  return usd < 0.001 ? "< $0.001" : `$${usd.toFixed(4)}`;
}

function formatSeconds(ms: number): string {
  return `${(Math.max(ms, 50) / 1000).toFixed(1)} s`;
}

function statusLine(s: TabState): string {
  if (s.cached) return "from cache";
  return `judged in ${formatSeconds(s.ms)} · ≈ ${formatCost(s.inputTokens)}`;
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
}

function note(title: string, sub = "", action?: { label: string; primary?: boolean; onClick: () => void }, soft = false) {
  ui.noteTitle.textContent = title;
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

function renderNumbers(s: TabState) {
  ui.total.textContent = `/ ${s.total}`;
  ui.caption.textContent = s.kept === 1 ? "sentence kept" : "sentences kept";
  ui.bone.style.width = s.total > 0 ? `${(100 * s.kept) / s.total}%` : "0%";
  ui.status.textContent = statusLine(s);
  countTo(s.kept);
}

function render() {
  const s = model.state;
  const settings = model.settings;
  renderChip(s);
  ui.site.checked = !(s?.status === "disabled") && settings.enabled;
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
      if (settings.enabled) note("Off on this site", "", undefined, true);
      else note("Osso is off", "", { label: "Turn on", primary: true, onClick: () => void turnOn() }, true);
      return;
    case "skipped":
      show("skipped");
      note("Nothing to strip here", SKIP_REASONS[s.reason ?? ""] ?? s.reason ?? "", undefined, true);
      return;
    case "error":
      show("error");
      note("Couldn't judge this page", s.reason ?? "Something went wrong.", { label: "Retry", onClick: retry });
      return;
    case "judging":
    case "idle":
      show(s.status);
      // The number that will become the kept count is already there, pulsing; the caption carries
      // the verb. When the judgment lands it counts down from here to what stayed.
      ui.kept.textContent = s.total > 0 ? String(s.total) : "—";
      ui.total.textContent = "";
      ui.caption.textContent = s.status === "judging" ? "sentences, judging…" : "waiting for the page";
      ui.status.textContent = "";
      ui.bone.style.width = "0%";
      model.shown = s.total;
      return;
    case "done":
      show("done");
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

function wantsPolling(): boolean {
  const st = model.state?.status;
  if (st === "judging") return true;
  if (st === "idle") return model.idlePolls++ < IDLE_POLL_LIMIT;
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

function setSliderFill() {
  const v = Number(ui.threshold.value);
  const pct = ((v - THRESHOLD_MIN) / (THRESHOLD_MAX - THRESHOLD_MIN)) * 100;
  ui.threshold.style.setProperty("--fill", `${pct}%`);
}

async function onSiteToggle() {
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
  window.addEventListener("pagehide", stopPolling);

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
}

void main();
