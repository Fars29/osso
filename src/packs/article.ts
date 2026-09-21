import type { Pack } from "./index.ts";
import { score } from "./generic.ts";

/**
 * News, analysis and blog posts: the vote count stays in ink, the tired mayor fades. The hints once
 * listed "speculation" among what does not count, and a markets piece built on a bank's forecasts
 * lost its opening claim and its analyst's quotes: a sourced forecast is the substance of such an
 * article, not its colour. What does not count is what promises or decorates without telling. A
 * later miss rewrote the hint around who is speaking: a page that was one central banker's quotes
 * end to end lost "Lo ha detto il governatore della Banca d'Italia, Fabio Panetta, alla 10ª
 * Conferenza…" at 0.20, the one sentence saying whose words the reader is reading, and the claim
 * the headline was built on at 0.32. Three wordings were measured against the page (0.20 -> 0.39,
 * 0.32 -> 0.54) and against a press release and a recipe blog, where this one moved no decision.
 */
export const article: Pack = {
  id: "article",
  stateHint: "news article or blog post",
  keepHints: {
    true: "The news is what was said or done and by whom: the main claim, the speaker's name and title, where and when, how much, decisions, forecasts with their source, causes, consequences and the quotes carrying them.",
    false: "Scene-setting, atmosphere, teasers that promise detail without giving it, bridges between topics, reactions of onlookers and calls to follow or subscribe do not.",
  },
  match: (meta) =>
    score(meta, {
      jsonLd: ["newsarticle", "article", "blogposting", "reportage"],
      ogType: ["article"],
      paths: ["news", "article", "blog", "post"],
      hosts: ["medium.com", "substack.com", "wordpress.com", "blog."],
    }),
};
