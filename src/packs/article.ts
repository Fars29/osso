import type { Pack } from "./index.ts";
import { score } from "./generic.ts";

/** News and blog posts: the vote count stays in ink, the tired mayor fades. */
export const article: Pack = {
  id: "article",
  stateHint: "news article or blog post",
  keepHints: {
    true: "Who, what, when, where, how much, decisions and quotes that carry a fact count.",
    false: 'Scene-setting, atmosphere, speculation, "it remains to be seen" and reactions of onlookers do not.',
  },
  match: (meta) =>
    score(meta, {
      jsonLd: ["newsarticle", "article", "blogposting", "reportage"],
      ogType: ["article"],
      paths: ["news", "article", "blog", "post"],
      hosts: ["medium.com", "substack.com", "wordpress.com", "blog."],
    }),
};
