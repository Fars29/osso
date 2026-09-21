/**
 * The options page. Every control saves itself the moment it settles (change, blur), with an
 * inline "Saved" that fades; there is no form and no Save button except for the key, which
 * deserves a deliberate act. If the background is not answering the page still renders with
 * the defaults and says so once, quietly.
 */
import { DEFAULT_DENIED_HOSTS, DEFAULT_SETTINGS, THRESHOLD_MAX, THRESHOLD_MIN, USD_PER_INPUT_TOKEN } from "../../shared/constants.ts";
import type { FromBackground, RevealKey, RunMode, Settings, Stats, ToBackground } from "../../shared/types.ts";
import { getSettings, getStats, patchSettings, sendToBackground } from "../messaging.ts";
import { SETTINGS_KEY } from "../../background/settings.ts";
import { ruleField, ruleList } from "../rules.ts";

/**
 * Local adapter: the shared contract has no message to reset usage counters. Sent as an
 * extension of ToBackground until `{ type: "resetStats" }` lands in shared/types.ts; a
 * background that does not know it answers nothing and the page says so.
 */
type UiToBackground = ToBackground | { type: "resetStats" };

const EMPTY_STATS: Stats = { pagesJudged: 0, sentencesJudged: 0, inputTokens: 0, ms: 0, cacheHits: 0 };
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`[osso] options: #${id} missing`);
  return node as T;
}

const ui = {
  notice: el<HTMLParagraphElement>("notice"),
  key: el<HTMLInputElement>("key"),
  keyEye: el<HTMLButtonElement>("key-eye"),
  keyTest: el<HTMLButtonElement>("key-test"),
  keySave: el<HTMLButtonElement>("key-save"),
  keyResult: el<HTMLParagraphElement>("key-result"),
  keySaved: el<HTMLSpanElement>("key-saved"),
  enabled: el<HTMLInputElement>("enabled"),
  threshold: el<HTMLInputElement>("threshold"),
  thresholdValue: el<HTMLOutputElement>("threshold-value"),
  revealKey: el<HTMLElement>("reveal-key"),
  mode: el<HTMLElement>("mode"),
  animations: el<HTMLInputElement>("animations"),
  strike: el<HTMLInputElement>("strike"),
  rule: el<HTMLInputElement>("rule"),
  ruleList: el<HTMLUListElement>("rule-list"),
  behaviourSaved: el<HTMLSpanElement>("behaviour-saved"),
  denied: el<HTMLTextAreaElement>("denied"),
  allowed: el<HTMLTextAreaElement>("allowed"),
  sitesSaved: el<HTMLSpanElement>("sites-saved"),
  defaults: el<HTMLUListElement>("defaults"),
  defaultsCount: el<HTMLSpanElement>("defaults-count"),
  stPages: el<HTMLElement>("st-pages"),
  stSentences: el<HTMLElement>("st-sentences"),
  stTokens: el<HTMLElement>("st-tokens"),
  stCost: el<HTMLElement>("st-cost"),
  stAvg: el<HTMLElement>("st-avg"),
  stCache: el<HTMLElement>("st-cache"),
  usageSaved: el<HTMLSpanElement>("usage-saved"),
  clearCache: el<HTMLButtonElement>("clear-cache"),
  resetUsage: el<HTMLButtonElement>("reset-usage"),
};

let settings: Settings = { ...DEFAULT_SETTINGS };
let connected = false;

const chips = ruleList(ui.ruleList, { onRemove: (rule) => void saveRules(settings.rules.filter((r) => r !== rule)) });
const field = ruleField(ui.rule, {
  rules: () => settings.rules,
  onAdd: (rule) => void saveRules([...settings.rules, rule]),
  onDuplicate: (existing) => chips.flash(existing),
});

// ---- feedback -------------------------------------------------------------

const savedTimers = new WeakMap<HTMLElement, number>();

/** "Saved", inline, gone again in a second and a half. Never an alert. */
function flash(target: HTMLElement, text = "Saved") {
  target.textContent = text;
  target.classList.add("on");
  clearTimeout(savedTimers.get(target));
  savedTimers.set(target, window.setTimeout(() => target.classList.remove("on"), 1500));
}

async function save(patch: Partial<Settings>, badge: HTMLElement): Promise<boolean> {
  settings = { ...settings, ...patch };
  const ok = await patchSettings(patch);
  flash(badge, ok ? "Saved" : "Not saved");
  if (!ok) offline();
  return ok;
}

async function saveRules(rules: string[]) {
  await save({ rules }, ui.behaviourSaved);
  renderRules();
}

function offline() {
  if (connected) return;
  ui.notice.textContent = "Osso's background worker isn't answering. Showing defaults; changes may not stick until the extension reloads.";
  ui.notice.hidden = false;
}

// ---- formatting -----------------------------------------------------------

const integer = new Intl.NumberFormat("en-US");

function formatCost(inputTokens: number): string {
  const usd = inputTokens * USD_PER_INPUT_TOKEN;
  if (usd === 0) return "$0";
  return usd < 0.001 ? "< $0.001" : `$${usd.toFixed(usd < 1 ? 4 : 2)}`;
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function setNumber(target: HTMLElement, text: string) {
  if (target.textContent === text) return;
  target.textContent = text;
  if (reducedMotion) return;
  target.classList.add("changed");
  setTimeout(() => target.classList.remove("changed"), 500);
}

// ---- hosts ----------------------------------------------------------------

/** One host per line, tolerant of pasted URLs: "https://Example.com/path" becomes "example.com". */
function parseHosts(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim().toLowerCase();
    if (!line) continue;
    line = line.replace(/^[a-z]+:\/\//, "").replace(/^\*\./, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/^www\./, "");
    if (line) out.add(line);
  }
  return [...out];
}

// ---- rendering ------------------------------------------------------------

function renderSettings() {
  ui.key.value = settings.apiKey;
  ui.enabled.checked = settings.enabled;
  ui.threshold.value = String(settings.threshold);
  renderThreshold();
  for (const radio of ui.revealKey.querySelectorAll<HTMLInputElement>("input[type=radio]")) radio.checked = radio.value === settings.revealKey;
  for (const radio of ui.mode.querySelectorAll<HTMLInputElement>("input[type=radio]")) radio.checked = radio.value === settings.mode;
  ui.animations.checked = settings.animations;
  ui.strike.checked = settings.strike;
  ui.denied.value = settings.deniedHosts.join("\n");
  ui.allowed.value = settings.allowedHosts.join("\n");
  renderRules();
  if (settings.apiKeyInvalid && settings.apiKey) {
    ui.keyResult.textContent = "TypeSafe rejected this key the last time it was used.";
    ui.keyResult.className = "key-result bad";
  }
}

function renderRules() {
  chips.render(settings.rules);
  field.refresh();
}

function renderThreshold() {
  const v = Number(ui.threshold.value);
  ui.thresholdValue.value = v.toFixed(2);
  ui.threshold.style.setProperty("--fill", `${((v - THRESHOLD_MIN) / (THRESHOLD_MAX - THRESHOLD_MIN)) * 100}%`);
}

function renderStats(stats: Stats) {
  setNumber(ui.stPages, integer.format(stats.pagesJudged));
  setNumber(ui.stSentences, integer.format(stats.sentencesJudged));
  setNumber(ui.stTokens, integer.format(stats.inputTokens));
  setNumber(ui.stCost, formatCost(stats.inputTokens));
  setNumber(ui.stAvg, stats.pagesJudged > 0 ? formatMs(stats.ms / stats.pagesJudged) : "—");
  setNumber(ui.stCache, integer.format(stats.cacheHits));
}

function renderDefaults() {
  ui.defaultsCount.textContent = `· ${DEFAULT_DENIED_HOSTS.length}`;
  const frag = document.createDocumentFragment();
  for (const host of DEFAULT_DENIED_HOSTS) {
    const li = document.createElement("li");
    li.textContent = host;
    frag.append(li);
  }
  ui.defaults.replaceChildren(frag);
}

// ---- key ------------------------------------------------------------------

function toggleEye() {
  const showing = ui.key.type === "text";
  ui.key.type = showing ? "password" : "text";
  ui.keyEye.textContent = showing ? "Show" : "Hide";
  ui.keyEye.setAttribute("aria-label", showing ? "Show key" : "Hide key");
}

async function testKey() {
  const apiKey = ui.key.value.trim();
  ui.keyResult.className = "key-result";
  if (!apiKey) {
    ui.keyResult.textContent = "Paste a key first.";
    return;
  }
  ui.keyTest.disabled = true;
  ui.keyResult.textContent = "Testing…";
  try {
    const r = await sendToBackground<FromBackground>({ type: "testKey", apiKey });
    if (r.type === "keyTest" && r.ok) {
      ui.keyResult.textContent = `Works${typeof r.ms === "number" ? ` · ${(r.ms / 1000).toFixed(1)} s` : ""}`;
      ui.keyResult.className = "key-result ok";
    } else {
      const error = r.type === "keyTest" ? r.error : r.type === "error" ? r.error : undefined;
      ui.keyResult.textContent = error || "TypeSafe did not accept this key.";
      ui.keyResult.className = "key-result bad";
    }
  } catch {
    ui.keyResult.textContent = "Couldn't reach the background worker.";
    ui.keyResult.className = "key-result bad";
    offline();
  } finally {
    ui.keyTest.disabled = false;
  }
}

async function saveKey() {
  const apiKey = ui.key.value.trim();
  const firstKey = !settings.apiKey && apiKey !== "";
  ui.key.value = apiKey;
  ui.keyResult.className = "key-result";
  if (settings.apiKeyInvalid) ui.keyResult.textContent = "";
  const ok = await save({ apiKey }, ui.keySaved);
  settings.apiKeyInvalid = false;
  if (firstKey && ok) {
    // The first key is the whole setup: say what happens next, since nothing else on this page will.
    ui.notice.hidden = true;
    ui.keyResult.textContent = "Saved. Open any article and it fades in a second or two; pages already open pick the key up too.";
    ui.keyResult.className = "key-result ok";
  }
}

// ---- usage ----------------------------------------------------------------

async function clearCache() {
  ui.clearCache.disabled = true;
  try {
    const r = await sendToBackground<FromBackground>({ type: "clearCache" });
    flash(ui.usageSaved, r.type === "error" ? "Not cleared" : "Cache cleared");
  } catch {
    flash(ui.usageSaved, "Not cleared");
    offline();
  } finally {
    ui.clearCache.disabled = false;
  }
}

async function resetUsage() {
  ui.resetUsage.disabled = true;
  try {
    const msg: UiToBackground = { type: "resetStats" };
    const r = await sendToBackground<FromBackground>(msg as unknown as ToBackground);
    const fresh = r.type === "error" ? null : await getStats();
    if (fresh && fresh.pagesJudged === 0 && fresh.inputTokens === 0) {
      renderStats(fresh);
      flash(ui.usageSaved, "Usage reset");
    } else {
      flash(ui.usageSaved, "Not reset");
    }
  } catch {
    flash(ui.usageSaved, "Not reset");
  } finally {
    ui.resetUsage.disabled = false;
  }
}

// ---- boot -----------------------------------------------------------------

function wire() {
  ui.keyEye.addEventListener("click", toggleEye);
  ui.keyTest.addEventListener("click", () => void testKey());
  ui.keySave.addEventListener("click", () => void saveKey());
  ui.key.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void saveKey();
  });

  ui.enabled.addEventListener("change", () => void save({ enabled: ui.enabled.checked }, ui.behaviourSaved));
  ui.threshold.addEventListener("input", renderThreshold);
  ui.threshold.addEventListener("change", () => void save({ threshold: Number(ui.threshold.value) }, ui.behaviourSaved));
  ui.mode.addEventListener("change", () => {
    const chosen = ui.mode.querySelector<HTMLInputElement>("input[type=radio]:checked");
    if (chosen) void save({ mode: chosen.value as RunMode }, ui.behaviourSaved);
  });
  ui.revealKey.addEventListener("change", () => {
    const chosen = ui.revealKey.querySelector<HTMLInputElement>("input[type=radio]:checked");
    if (chosen) void save({ revealKey: chosen.value as RevealKey }, ui.behaviourSaved);
  });
  ui.animations.addEventListener("change", () => void save({ animations: ui.animations.checked }, ui.behaviourSaved));
  ui.strike.addEventListener("change", () => void save({ strike: ui.strike.checked }, ui.behaviourSaved));

  ui.denied.addEventListener("blur", () => {
    const deniedHosts = parseHosts(ui.denied.value);
    ui.denied.value = deniedHosts.join("\n");
    if (deniedHosts.join("\n") !== settings.deniedHosts.join("\n")) void save({ deniedHosts }, ui.sitesSaved);
  });
  ui.allowed.addEventListener("blur", () => {
    const allowedHosts = parseHosts(ui.allowed.value);
    ui.allowed.value = allowedHosts.join("\n");
    if (allowedHosts.join("\n") !== settings.allowedHosts.join("\n")) void save({ allowedHosts }, ui.sitesSaved);
  });

  ui.clearCache.addEventListener("click", () => void clearCache());
  ui.resetUsage.addEventListener("click", () => void resetUsage());
  window.addEventListener("pagehide", () => field.stop());
}

async function main() {
  ui.threshold.min = String(THRESHOLD_MIN);
  ui.threshold.max = String(THRESHOLD_MAX);
  ui.threshold.step = "0.05";
  renderDefaults();
  renderSettings();
  renderStats(EMPTY_STATS);
  wire();

  const [loaded, stats] = await Promise.all([getSettings(), getStats()]);
  connected = loaded !== null;
  if (loaded) settings = loaded;
  renderSettings();
  renderStats(stats ?? EMPTY_STATS);
  if (!connected) offline();
  if (connected && !settings.apiKey) {
    // First run: the page opened itself, and the one thing to do should not have to be guessed.
    ui.notice.textContent = "One thing to do: paste a TypeSafe key below. Nothing is judged until you have.";
    ui.notice.hidden = false;
    ui.key.focus();
  }

  // Another window (the popup's slider, the background after a 401) may change settings underneath
  // us. Only the settings record counts: cache and stats writes land once per judged page, and each
  // would otherwise pull the key over the message channel again for nothing.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(SETTINGS_KEY in changes)) return;
    const active = document.activeElement;
    if (active === ui.key || active instanceof HTMLTextAreaElement) return;
    void getSettings().then((fresh) => {
      if (!fresh) return;
      settings = fresh;
      renderSettings();
    });
  });
}

void main();
