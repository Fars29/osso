import { describe, expect, it } from "vitest";
import {
  HIGHLIGHT_QUESTION,
  HIGHLIGHT_UNIT_QUESTION,
  KEEP_QUESTION,
  KIND_QUESTION,
  PAGE_KINDS,
  PAGE_KIND_QUESTION,
  RULE_QUESTION,
  SENTENCE_KINDS,
} from "../src/shared/constants.ts";
import { buildRequestBody } from "../src/background/api.ts";
import { PACKS } from "../src/packs/index.ts";
import type { PageMeta } from "../src/shared/types.ts";

/**
 * The model is always asked in English, whatever language the page is in: it judges better that
 * way. What is quoted inside « » is the page's or the user's and stays as written; every word of
 * ours around it is English. A prompt in another language gives itself away by its letters.
 */
const PLACEHOLDER = "PLACEHOLDER";
const ours: Array<[string, string]> = [
  ["keep instructions", KEEP_QUESTION.instructions(PLACEHOLDER)],
  ["keep true", KEEP_QUESTION.criteriaTrue],
  ["keep false", KEEP_QUESTION.criteriaFalse],
  ["kind instructions", KIND_QUESTION.instructions(PLACEHOLDER)],
  ["page kind instructions", PAGE_KIND_QUESTION.instructions],
  ["rule instructions", RULE_QUESTION.instructions(PLACEHOLDER, PLACEHOLDER)],
  ["rule true", RULE_QUESTION.criteriaTrue(PLACEHOLDER)],
  ["rule false", RULE_QUESTION.criteriaFalse(PLACEHOLDER)],
  ["highlight gate instructions", HIGHLIGHT_QUESTION.gateInstructions(PLACEHOLDER, PLACEHOLDER)],
  ["highlight gate true", HIGHLIGHT_QUESTION.gateTrue(PLACEHOLDER)],
  ["highlight gate false", HIGHLIGHT_QUESTION.gateFalse(PLACEHOLDER)],
  ["highlight word instructions", HIGHLIGHT_QUESTION.wordInstructions(PLACEHOLDER, PLACEHOLDER)],
  ["highlight word true", HIGHLIGHT_QUESTION.wordTrue(PLACEHOLDER, PLACEHOLDER)],
  ["highlight word false", HIGHLIGHT_QUESTION.wordFalse(PLACEHOLDER, PLACEHOLDER)],
  ["highlight clause instructions", HIGHLIGHT_QUESTION.clauseInstructions(PLACEHOLDER, PLACEHOLDER)],
  ["highlight clause true", HIGHLIGHT_QUESTION.clauseTrue(PLACEHOLDER)],
  ["highlight clause false", HIGHLIGHT_QUESTION.clauseFalse(PLACEHOLDER)],
  ["highlight stated instructions", HIGHLIGHT_QUESTION.statedInstructions(PLACEHOLDER)],
  ["highlight stated true", HIGHLIGHT_QUESTION.statedTrue(PLACEHOLDER)],
  ["highlight stated false", HIGHLIGHT_QUESTION.statedFalse(PLACEHOLDER)],
  ["highlight unit state", HIGHLIGHT_UNIT_QUESTION.state],
  ["highlight unit instructions", HIGHLIGHT_UNIT_QUESTION.instructions(PLACEHOLDER)],
  ["highlight unit true", HIGHLIGHT_UNIT_QUESTION.criteriaTrue],
  ["highlight unit false", HIGHLIGHT_UNIT_QUESTION.criteriaFalse],
  ...Object.entries(SENTENCE_KINDS).map(([k, v]): [string, string] => [`sentence kind ${k}`, v.description]),
  ...Object.entries(PAGE_KINDS).map(([k, v]): [string, string] => [`page kind ${k}`, v.description]),
  ...PACKS.flatMap((p): Array<[string, string]> => [
    [`${p.id} state hint`, p.stateHint],
    [`${p.id} keep hint true`, p.keepHints?.true ?? ""],
    [`${p.id} keep hint false`, p.keepHints?.false ?? ""],
  ]),
];

describe("what we say to the model is English", () => {
  it.each(ours)("%s has no letter outside the English alphabet", (_name, text) => {
    // Punctuation we use on purpose: guillemets around quoted text, curly quotes, dashes, ellipsis.
    expect(text.replace(/[«»“”‘’–…]/g, "")).toMatch(/^[\x20-\x7E]*$/);
  });

  it("an Italian page is asked about in English: only the title and the sentences are Italian", () => {
    const meta: PageMeta = { url: "https://example.it/ricetta", host: "example.it", title: "Spaghetti alla carbonara", lang: "it", jsonLdTypes: [], ogType: null, sample: "", sentenceCount: 1 };
    const sentence = "Cuocete il guanciale finché non è croccante, perché così rilascia il grasso.";
    const body = buildRequestBody([{ id: 1, text: sentence }], meta, PACKS[0]!, true);
    const strip = (s: string) => s.split(sentence).join("").split(meta.title).join("");
    expect(strip(JSON.stringify(body))).toMatch(/^[\x20-\x7E«»“”‘’–…]*$/);
  });
});
