import type { Pack } from "./index.ts";
import { score } from "./generic.ts";

/**
 * Scientific papers and preprints: the result and how it was got stay in ink; the signposting, the
 * thanks and the funding fade. Read as a news article, a paper kept its background and lost nothing
 * worse, but its own genre has its own filler ("in this section we describe…", "see Figure 2",
 * author contributions) and its own substance (a hyperparameter, a sample size, a limitation).
 */
export const paper: Pack = {
  id: "paper",
  stateHint: "scientific paper or preprint",
  keepHints: {
    true: "Claims, results, numbers, methods, definitions, datasets, sample sizes, parameters, comparisons with prior work and limitations count.",
    false: 'Signposting ("in this section we", "see Figure 2", "results are in Table 3"), acknowledgements, funding, author contributions, affiliations and licence notes do not.',
  },
  match: (meta) =>
    score(meta, {
      jsonLd: ["scholarlyarticle", "medicalscholarlyarticle"],
      // Only segments no newsroom uses: "/articles/" is the BBC's word too.
      paths: ["plosone", "doi"],
      hosts: ["arxiv.org", "ar5iv.labs.arxiv.org", "ar5iv.org", "biorxiv.org", "medrxiv.org", "journals.plos.org", "ncbi.nlm.nih.gov", "nature.com", "sciencedirect.com", "springer.com", "acm.org", "ieee.org", "openreview.net", "ssrn.com", "frontiersin.org", "mdpi.com", "pnas.org", "science.org", "cell.com", "wiley.com", "tandfonline.com"],
      cues: ["abstract", "et al.", "doi:", "we propose", "we show that", "in this paper", "related work", "materials and methods"],
    }),
};
