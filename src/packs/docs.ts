import type { Pack } from "./index.ts";
import { score } from "./generic.ts";

/** Technical documentation: the command and its defaults, not the guide's warm-up. */
export const docs: Pack = {
  id: "docs",
  stateHint: "technical documentation or how-to guide",
  keepHints: {
    true: "Commands, parameters, defaults, constraints, return values, version differences and warnings count.",
    false: 'Motivation, history, praise of the tool and "in this guide you will learn" do not.',
  },
  match: (meta) =>
    score(meta, {
      jsonLd: ["techarticle", "howto", "faqpage"],
      paths: ["docs", "documentation", "guide", "manual", "reference", "api"],
      hosts: ["docs.", "developer.", "readthedocs.io"],
      cues: ["npm install", "usage:", "parameters", "returns", "endpoint"],
    }),
};
