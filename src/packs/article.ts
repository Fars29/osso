import type { Pack } from "./index.ts";
import { score } from "./generic.ts";

/**
 * News, analysis and blog posts: the vote count stays in ink, the tired mayor fades. The hints once
 * listed "speculation" among what does not count, and a markets piece built on a bank's forecasts
 * lost its opening claim and its analyst's quotes: a sourced forecast is the substance of such an
 * article, not its colour. What does not count is what promises or decorates without telling.
 */
export const article: Pack = {
  id: "article",
  stateHint: "news article or blog post",
  keepHints: {
    true: "The main claim, who, what, when, where, how much, decisions, forecasts and estimates with their source, causes and consequences count, as do quotes that carry them.",
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
