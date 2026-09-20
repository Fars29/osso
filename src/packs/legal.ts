import type { Pack } from "./index.ts";
import { score } from "./generic.ts";

/** Terms, privacy policies, licences: the clauses that bind or entitle are the bone, the rest is scaffolding. */
export const legal: Pack = {
  id: "legal",
  stateHint: "terms of service or other legal text",
  keepHints: {
    true: "Clauses that bind or entitle someone count: renewal, price changes, fees, penalties, waivers, data sharing, termination, liability.",
    false: 'Definitions of defined terms, headings, "read carefully", "we may update these terms", severability and interpretation boilerplate do not.',
  },
  match: (meta) =>
    score(meta, {
      paths: ["terms", "tos", "privacy", "legal", "policy", "eula", "condizioni", "termini"],
      cues: ["these terms", "governed by", "privacy policy", "il presente contratto", "termini e condizioni", "trattamento dei dati"],
    }),
};
