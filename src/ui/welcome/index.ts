/**
 * The welcome page, opened once on install. It asks for the key and, with it, for the one decision
 * that is the reader's alone: whether Osso reads every page as it loads, or only a page they ask
 * for. A step comes forward when the one before it is done; the key is tested before it is saved,
 * so nobody leaves this page with a key that does not work.
 *
 * Nothing is sent before the reader agrees to what is sent: the words sit above the key field, and
 * the one button that saves the key says "Agree". Enter in the field only takes the reader to that
 * button, so the agreement is always the button pressed, never a key pressed out of habit.
 */
import type { FromBackground, RunMode } from "../../shared/types.ts";
import { getSettings, patchSettings, sendToBackground } from "../messaging.ts";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`[osso] welcome: #${id} missing`);
  return node as T;
}

const ui = {
  key: el<HTMLInputElement>("apiKey"),
  save: el<HTMLButtonElement>("saveKey"),
  feedback: el<HTMLElement>("key-feedback"),
  mode: el<HTMLElement>("mode"),
  steps: [el<HTMLElement>("step-key"), el<HTMLElement>("step-mode"), el<HTMLElement>("step-go")] as const,
  editSites: el<HTMLAnchorElement>("edit-sites"),
  settings: el<HTMLAnchorElement>("settings"),
};

/** Until there is a key, only the first step is within reach; with one, the rest open together. `done` steps wear a tick. */
function reach(hasKey: boolean, chosen = false) {
  ui.steps.forEach((step, i) => {
    step.classList.toggle("done", (i === 0 && hasKey) || (i === 1 && chosen));
    step.classList.toggle("waiting", !hasKey && i > 0);
    step.toggleAttribute("inert", !hasKey && i > 0);
  });
}

function say(text: string, tone: "" | "ok" | "bad" = "") {
  ui.feedback.textContent = text;
  ui.feedback.className = `feedback ${tone}`.trim();
}

async function saveKey() {
  const apiKey = ui.key.value.trim();
  if (!apiKey) {
    say("Paste a key first.");
    ui.key.focus();
    return;
  }
  ui.save.disabled = true;
  say("Testing the key…");
  try {
    const r = await sendToBackground<FromBackground>({ type: "testKey", apiKey });
    if (r.type !== "keyTest" || !r.ok) {
      say((r.type === "keyTest" || r.type === "error" ? r.error : undefined) || "TypeSafe did not accept this key.", "bad");
      return;
    }
    if (!(await patchSettings({ apiKey }))) {
      say("Couldn't save the key. Try again.", "bad");
      return;
    }
    say(`Works${typeof r.ms === "number" ? ` · answered in ${(r.ms / 1000).toFixed(1)} s` : ""}. Saved in this browser.`, "ok");
    // The choice below was made by default until now; from here it is the reader's, and it is stored as they make it.
    reach(true);
  } catch {
    say("Couldn't reach Osso's background worker. Reload this page.", "bad");
  } finally {
    ui.save.disabled = false;
  }
}

function openOptions(e: Event) {
  e.preventDefault();
  void chrome.runtime.openOptionsPage();
}

async function init() {
  const settings = await getSettings();
  const mode: RunMode = settings?.mode ?? "auto";
  for (const radio of ui.mode.querySelectorAll<HTMLInputElement>("input[type=radio]")) radio.checked = radio.value === mode;
  // Reopened by someone who already has a key: everything is open, nothing is asked twice.
  reach(!!settings?.apiKey);
  if (settings?.apiKey) say("A key is already saved in this browser.", "ok");

  ui.save.addEventListener("click", () => void saveKey());
  ui.key.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    ui.save.focus();
  });
  ui.mode.addEventListener("change", () => {
    const chosen = ui.mode.querySelector<HTMLInputElement>("input[type=radio]:checked");
    if (!chosen) return;
    void patchSettings({ mode: chosen.value as RunMode });
    reach(true, true);
  });
  el<HTMLAnchorElement>("try").addEventListener("click", () => reach(true, true));
  ui.editSites.addEventListener("click", openOptions);
  ui.settings.addEventListener("click", openOptions);
}

void init();
