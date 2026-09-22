/**
 * How each highlight term is marked, words or whole sentences. The answer is about the term, not the
 * page, so it is asked once and kept here for every page after, under the version of the highlight
 * questions: when they change, it is asked again with them. Keys are the term in lower case, the way
 * the settings tell two terms apart.
 */
import { HIGHLIGHT_VERSION } from "../shared/constants.ts";
import type { HighlightUnit } from "../shared/types.ts";

export const UNITS_KEY = "osso:highlightUnits";
/** Far more terms than anyone keeps at once; past it the oldest answer goes. */
const MAX_UNITS = 200;

interface Stored {
  version: number;
  units: Record<string, HighlightUnit>;
}

const keyOf = (term: string) => term.toLowerCase();
const isUnit = (u: unknown): u is HighlightUnit => u === "words" || u === "sentence";

async function readAll(): Promise<Record<string, HighlightUnit>> {
  const got = await chrome.storage.local.get(UNITS_KEY);
  const stored = got[UNITS_KEY] as Stored | undefined;
  if (!stored || stored.version !== HIGHLIGHT_VERSION || typeof stored.units !== "object" || stored.units === null) return {};
  return stored.units;
}

/** The units known for these terms; a term never asked about is absent. */
export async function knownUnits(terms: string[]): Promise<Record<string, HighlightUnit>> {
  const all = await readAll();
  const out: Record<string, HighlightUnit> = {};
  for (const term of terms) {
    const unit = all[keyOf(term)];
    if (isUnit(unit)) out[term] = unit;
  }
  return out;
}

let writing: Promise<unknown> = Promise.resolve();

/** Keeps what was learned. Writes one after another, so two tabs learning at once do not lose one. */
export function rememberUnits(units: Record<string, HighlightUnit>): Promise<void> {
  const next = writing.then(async () => {
    if (Object.keys(units).length === 0) return;
    const all = { ...(await readAll()) };
    for (const [term, unit] of Object.entries(units)) {
      // Re-inserted at the end: the order is the order they were last learned in.
      delete all[keyOf(term)];
      all[keyOf(term)] = unit;
    }
    const keys = Object.keys(all);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_UNITS))) delete all[key];
    const stored: Stored = { version: HIGHLIGHT_VERSION, units: all };
    await chrome.storage.local.set({ [UNITS_KEY]: stored });
  });
  writing = next.catch(() => undefined);
  return next;
}
