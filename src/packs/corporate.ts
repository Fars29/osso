import type { Pack } from "./index.ts";
import { score } from "./generic.ts";

/** Press releases and customer notices: the price change is one sentence in a page of gratitude. */
export const corporate: Pack = {
  id: "corporate",
  stateHint: "company statement, press release or customer notice",
  keepHints: {
    true: "What changes, when, by how much, what it costs, what the reader must do and by when, and what caused it count.",
    false: "Values, gratitude, reassurance, commitment language and apologies without content do not.",
  },
  match: (meta) =>
    score(meta, {
      paths: ["press", "newsroom", "announcements", "blog/company"],
      cues: ["we're excited to announce", "we are pleased", "an update on", "gentile cliente", "comunicato", "siamo lieti"],
    }),
};
