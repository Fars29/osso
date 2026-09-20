import type { Pack } from "./index.ts";
import { score } from "./generic.ts";

/** Product, plan and service pages: the spec table in prose, minus the lifestyle. */
export const product: Pack = {
  id: "product",
  stateHint: "product, plan or service page",
  keepHints: {
    true: "Specifications, dimensions, compatibility, prices, limits, what is and is not included, and warranty and return terms count.",
    false: 'Marketing adjectives, lifestyle framing and "designed for you" do not.',
  },
  match: (meta) =>
    score(meta, {
      jsonLd: ["product", "offer"],
      ogType: ["product"],
      paths: ["product", "products", "p", "dp", "item"],
      cues: ["add to cart", "in stock", "specifications", "aggiungi al carrello", "disponibilità"],
    }),
};
