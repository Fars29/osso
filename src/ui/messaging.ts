/**
 * The UI's only door to the rest of the extension. Popup and options never touch storage or
 * the API; they ask the background worker and, for the live re-render, the tab's content script.
 * Every helper here degrades to `null`/`false` when nobody answers, so a page opened before
 * the worker woke up, or on a tab with no content script, still renders a neutral state.
 */
import type {
  FromBackground,
  FromContent,
  Settings,
  Stats,
  TabState,
  ToBackground,
  ToContent,
} from "../shared/types.ts";

/** Ask the background and expect a `FromBackground` reply; rejects when the worker gives none. */
export async function sendToBackground<T extends FromBackground>(msg: ToBackground): Promise<T> {
  const reply: unknown = await chrome.runtime.sendMessage(msg);
  if (!isMessage(reply)) throw new Error("Osso's background worker did not answer");
  return reply as T;
}

/**
 * Talk to the content script of a tab. Resolves `null` when the tab has none (chrome:// pages,
 * the Web Store, a tab loaded before the extension was installed): Chrome reports that as a
 * rejected promise, not as an empty reply.
 */
export async function sendToTab(tabId: number, msg: ToContent): Promise<FromContent | null> {
  try {
    const reply: unknown = await chrome.tabs.sendMessage(tabId, msg);
    return isMessage(reply) ? (reply as FromContent) : null;
  } catch (err) {
    if (isNoReceiver(err)) return null;
    throw err;
  }
}

export async function getSettings(): Promise<Settings | null> {
  const r = await quiet(sendToBackground<FromBackground>({ type: "getSettings" }));
  return r?.type === "settings" ? r.settings : null;
}

export async function patchSettings(patch: Partial<Settings>): Promise<boolean> {
  const r = await quiet(sendToBackground<FromBackground>({ type: "setSettings", patch }));
  return r !== null && r.type !== "error";
}

export async function getStats(): Promise<Stats | null> {
  const r = await quiet(sendToBackground<FromBackground>({ type: "getStats" }));
  return r?.type === "stats" ? r.stats : null;
}

/** The background's copy of a tab's state; `null` when it has none or is not answering. */
export async function getTabStateFromBackground(tabId: number): Promise<TabState | null> {
  const r = await quiet(sendToBackground<FromBackground>({ type: "getTabState", tabId }));
  return r?.type === "tabState" ? r.state : null;
}

/** The content script's own, fresher state; `null` when the tab has no content script. */
export async function getTabStateFromTab(tabId: number): Promise<TabState | null> {
  const r = await quiet(sendToTab(tabId, { type: "getTabState" }));
  return r?.type === "tabState" ? r.state : null;
}

function isMessage(x: unknown): x is { type: string } {
  return typeof x === "object" && x !== null && typeof (x as { type?: unknown }).type === "string";
}

function isNoReceiver(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /Could not establish connection|Receiving end does not exist|message port closed|No tab with id/i.test(m);
}

async function quiet<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}
