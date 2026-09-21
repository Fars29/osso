/**
 * Page-kind routing. A pack is a page kind the extension knows a little about: how to recognise
 * it from what the content script sees before any request (JSON-LD, URL, og:type, title, a sample
 * of the text) and how to phrase the hint that goes to Jev. The probe showed the generic question
 * separates on every kind (AUC 1.000 per page), so routing tunes wording and is never load-bearing:
 * a wrong route costs a little precision, never a broken page. Adding a pack = adding a file here.
 */
import type { PageKind, PageMeta } from "../shared/types.ts";
import { generic } from "./generic.ts";
import { recipe } from "./recipe.ts";
import { legal } from "./legal.ts";
import { corporate } from "./corporate.ts";
import { product } from "./product.ts";
import { docs } from "./docs.ts";
import { paper } from "./paper.ts";
import { article } from "./article.ts";
import { social } from "./social.ts";

export interface Pack {
  id: PageKind;
  /** Sent as `page_kind_hint` in the request state, e.g. "recipe page". */
  stateHint: string;
  /**
   * Appended (with a leading space) to KEEP_QUESTION.criteriaTrue / criteriaFalse. One short,
   * concrete sentence each: the criteria are read per sentence, sixty times a request.
   */
  keepHints?: { true?: string; false?: string };
  /** How sure the heuristics are that the page is this kind, 0..1. Code, never the model. */
  match(meta: PageMeta): number;
}

/** Minimum match for a pack to win; below it the page is "other" and gets the plain question. */
export const ROUTE_THRESHOLD = 0.5;

/**
 * Order breaks ties. Corporate sits before article so "/blog/company" lands on the press pack
 * rather than the blog one, and paper before article so a journal that also declares itself an
 * Article is read as a paper; the generic pack is last and never matches, so it is only reached
 * when nothing else does.
 */
export const PACKS: Pack[] = [recipe, legal, corporate, product, docs, paper, article, social, generic];

export function getPack(id: PageKind): Pack {
  return PACKS.find((p) => p.id === id) ?? generic;
}

export function route(meta: PageMeta): PageKind {
  let best: Pack = generic;
  let bestScore = 0;
  for (const pack of PACKS) {
    const s = pack.match(meta);
    // Strictly greater: an earlier pack keeps a tie, which is what "ties broken by PACKS order" means.
    if (s > bestScore) {
      best = pack;
      bestScore = s;
    }
  }
  return bestScore >= ROUTE_THRESHOLD ? best.id : "other";
}

export { score, WEIGHT } from "./generic.ts";
export type { Signals } from "./generic.ts";
