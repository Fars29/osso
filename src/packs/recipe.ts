import type { Pack } from "./index.ts";
import { score } from "./generic.ts";

/** The founding case: a life story above the ingredients. Everything below the story is the bone. */
export const recipe: Pack = {
  id: "recipe",
  stateHint: "recipe page",
  keepHints: {
    true: "Ingredients with quantities, temperatures, timings, equipment sizes and technique warnings are exactly what the reader came for.",
    false: "The story behind the dish, memories, praise, requests to comment, share or subscribe, and affiliate or sponsor mentions are not.",
  },
  match: (meta) =>
    score(meta, {
      jsonLd: ["recipe"],
      paths: ["recipe", "recipes", "ricetta", "ricette", "rezept"],
      cues: ["ingredients", "ingredienti", "preheat", "preriscalda", "serves", "porzioni"],
    }),
};
