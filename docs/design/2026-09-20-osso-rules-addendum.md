# Osso — addendum: your own rules

*2026-09-20. Extends the design spec. Status: approved for build.*

## What it is

A sentence of yours, in plain words, that Osso must always keep: *prices*, *deadlines*, *allergens*, *what I have to do*, *anything about Turin*. It is the one place the user talks to the model, so it has to be the most ergonomic thing in the product: one field, at the top of the popup, Enter to add, a click to remove. Rules are global (they apply on every page) and persist.

Adding a rule costs one batched request over the current page (~0.5 s); removing one costs 0 ms, because every rule's probabilities are cached beside the page judgment.

## Judgment

For each rule R and each sentence S, one Noul `rule_<ri>_<sid>` over the same state as the keep question:

> Consider this sentence from the page: «S». Does it carry information that a reader who cares about «R» would want to keep?
> true: Yes: the sentence states something concrete about «R», or a fact, figure, condition or step that matters for it.
> false: No: it is unrelated to «R», or only mentions it in passing with nothing to keep.

Rule hits use a fixed threshold `RULE_THRESHOLD = 0.5`, independent of the strictness slider. A sentence with any rule hit is kept regardless of its keep score. Rules are judged in their own request(s), in parallel with the base judgment on first load, so they never delay the settle.

## Contracts (additions to `src/shared`)

```ts
// types.ts
Settings.rules: string[]                       // ≤ 8 rules, each trimmed, ≤ 80 chars, unique (case-insensitive)
PageJudgment.rules: Record<string, Record<number, number>>   // rule text → sentence id → p(hit); may be partial
ToBackground: { type: "judgeRules"; contentHash: string; rules: string[] }   // judge only these rules on the page last judged with this hash
FromBackground: { type: "ruleJudgment"; contentHash: string; rules: Record<string, Record<number, number>> }
ToContent: { type: "rulesChanged"; rules: string[] }
TabState.ruleHits: Record<string, number>      // rule text → number of sentences it keeps on this page
// constants.ts
RULE_THRESHOLD = 0.5; MAX_RULES = 8; MAX_RULE_LENGTH = 80; RULE_QUESTION = { instructions(sentence, rule), criteriaTrue(rule), criteriaFalse(rule) }
```

## Flow

- Background keeps an in-memory `recentRequests: Map<contentHash, JudgeRequest>` (last 50) so a rule can be judged later without the page resending its sentences. `judgeRules` looks the request up, calls `api.judgeRules(req, rules, opts)` (same chunking, concurrency and retry as `judgePage`), merges the result into the cached `PageJudgment.rules`, replies `ruleJudgment`.
- On page load the content script sends `judge` and, if `settings.rules` is non-empty, `judgeRules` for all rules at once. Cached pages carry their rule results; only rules missing from the cache are judged.
- `render.applyRules(doc, rules: Record<string, Record<number, number>>, activeRules: string[])`: sentences with a hit on an active rule lose `osso-fade`. On a *new* hit (a rule just added, or first paint), spans get a transient `osso-rule-hit` class: an accent underline that draws in over 240 ms and fades out over 1.2 s — the one place the accent colour touches the page, so the user sees what the rule caught. Removing a rule re-renders from cache with no animation beyond the normal fade.
- Popup: the rules field sits directly under the header, above the big number. Placeholder cycles every 3 s through *prices · deadlines · allergens · what I have to do · names of people*. Enter adds; Escape clears; the chip appears with a 160 ms pop, reads `prices · …` while judging and `prices · 3` when the count arrives; `×` removes it. Chips wrap; over 8 the field is disabled with the hint "8 is plenty". Rules are saved through `setSettings({ rules })`; the background broadcasts `rulesChanged` (rules only — never the whole settings) to all tabs.
- Options page: the same list, editable, under Behaviour, for people who prefer a page.

## Tests

- api: `judgeRules` body shape (keys `rule_<ri>_<sid>`, criteria contain the rule text), parse to `rules[rule][id]`, chunking and failures as for `judgePage`.
- settings: rules validation (trim, dedupe, cap, length).
- render: `applyRules` un-fades hits; transient class added only for new hits; removing a rule re-fades; counts include rule keeps.
- background: `judgeRules` for an unknown hash replies an error; results merge into the cache.
- e2e: add the rule "sponsor discount codes" on `recipe.html` and assert the sponsor sentence is no longer faded and the chip shows a count ≥ 1; remove it and assert it fades again with no network request (count fetches via the service worker's request log or a counter exposed on `globalThis.__ossoRequests` in dev builds).
