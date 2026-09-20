/**
 * The fallback pack and the scoring helper every other pack is built from. The helper lives here
 * rather than in index.ts so that packs never value-import the module that imports them.
 */
import type { PageMeta } from "../shared/types.ts";
import type { Pack } from "./index.ts";

/**
 * Weights, from the design: JSON-LD is the author declaring what the page is, so it routes on its
 * own; a URL segment, a host name or og:type is a strong convention but not a declaration; text
 * cues are cheap and noisy, so each is worth little and together they can only just clear the
 * routing threshold.
 */
export const WEIGHT = { jsonLd: 0.9, path: 0.6, host: 0.5, ogType: 0.5, cue: 0.2, cueCap: 0.6 } as const;

export interface Signals {
  /** schema.org @type values, lower-cased, compared exactly. */
  jsonLd?: readonly string[];
  ogType?: readonly string[];
  /**
   * Path fragments matched as whole segments: "recipes" hits "/recipes/pasta" but not
   * "/recipes-blog"; "blog/company" hits those two consecutive segments.
   */
  paths?: readonly string[];
  /** Host tests: "medium.com" matches the host and any subdomain; "docs." matches a leading label. */
  hosts?: readonly string[];
  /** Case-insensitive substrings looked for in the title and the text sample. */
  cues?: readonly string[];
}

export function score(meta: PageMeta, s: Signals): number {
  let total = 0;
  if (s.jsonLd?.some((t) => meta.jsonLdTypes.includes(t))) total += WEIGHT.jsonLd;
  if (meta.ogType && s.ogType?.includes(meta.ogType.toLowerCase())) total += WEIGHT.ogType;
  if (s.paths && matchesPath(meta.url, s.paths)) total += WEIGHT.path;
  if (s.hosts && matchesHost(meta.host, s.hosts)) total += WEIGHT.host;
  if (s.cues) {
    const hay = `${meta.title}\n${meta.sample}`.toLowerCase();
    const hits = s.cues.filter((c) => hay.includes(c.toLowerCase())).length;
    total += Math.min(WEIGHT.cueCap, hits * WEIGHT.cue);
  }
  return Math.min(1, total);
}

const trimSlashes = (p: string) => p.toLowerCase().replace(/^\/+|\/+$/g, "");

function matchesPath(url: string, fragments: readonly string[]): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    // A bare path or a malformed URL from a fixture: match on what we were given.
    path = url;
  }
  const padded = `/${trimSlashes(path)}/`;
  return fragments.some((f) => padded.includes(`/${trimSlashes(f)}/`));
}

function matchesHost(host: string, patterns: readonly string[]): boolean {
  const h = host.toLowerCase();
  return patterns.some((p) => {
    const pat = p.toLowerCase();
    if (pat.endsWith(".")) return h.startsWith(pat);
    return h === pat || h.endsWith(`.${pat}`);
  });
}

export const generic: Pack = {
  id: "other",
  stateHint: "web page",
  match: () => 0,
};
