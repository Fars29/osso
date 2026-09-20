# Calibration

*Probe of 2026-09-20, `npm run calibrate` (`scripts/calibrate.ts`), model `jev-latest`.*

The whole product rests on one question per sentence. This is what it scores on 107 hand-labelled
sentences from ten synthetic-but-realistic pages: recipe blog, corporate statement, terms of
service, LinkedIn post, news article, English and Italian; one page of bland narrative as a noise
floor; and two pages built as a redundancy trap (below). The script builds every request with the
extension's own `buildRequestBody` and reads the answers with its own `parseAnswers`, generic pack,
no page-kind hints, so the numbers are for exactly what ships. Rerun it after any change to
`KEEP_QUESTION` in `src/shared/constants.ts`; it costs about a quarter of a cent.

## Summary

| measure | value |
|---|---|
| AUC substance vs filler, one generic question, 99 labelled sentences | **0.998** |
| AUC per page (A B C D E F G J / I) | 1.000 on eight pages; 0.978 on the redundancy trap I (see below) |
| mean p(keep): substance / filler / noise floor | 0.94 / 0.12 / 0.05 (noise max 0.06) |
| best single threshold | 0.55–0.60 (acc 0.980); the default 0.5 scores 0.970 |
| kind proxy | 98% of substance judged a substantive kind; 77% of filler a non-substantive kind |
| 15–29 questions per request | 610–1330 ms after warm-up (the first two requests of the run: 3.5 s and 2.4 s) |
| 214 questions, one request, all pages | 2.73 s, 52.3k tokens, $0.0022, AUC 0.989, no failed answers |
| ten requests, one per page | 13.2 s sequential, 57.1k tokens, $0.0024 |
| repeat of the same request (page B) | max Δp = 0.020 |
| `page_kind` | right on every page, confidence 1.00 (0.83 for the noise floor's `other`) |

Per page:

| page | kind | lang | n | AUC | mean keep | mean filler | min keep | max filler |
|---|---|---|---|---|---|---|---|---|
| A | recipe blog | en | 14 | 1.000 | 0.97 | 0.07 | 0.95 | 0.09 |
| B | corporate statement | en | 13 | 1.000 | 0.91 | 0.07 | 0.82 | 0.11 |
| C | terms of service | en | 12 | 1.000 | 0.96 | 0.36 | 0.95 | 0.78 |
| D | social post | en | 10 | 1.000 | 0.82 | 0.07 | 0.82 | 0.13 |
| E | news article | en | 10 | 1.000 | 0.93 | 0.10 | 0.90 | 0.13 |
| F | recipe blog | it | 11 | 1.000 | 0.91 | 0.07 | 0.63 | 0.12 |
| G | corporate statement | it | 8 | 1.000 | 0.96 | 0.05 | 0.95 | 0.06 |
| H | noise floor | en | 8 | — | — | 0.05 | — | 0.06 |
| I | recipe, redundancy trap | en | 14 | 0.978 | 0.94 | 0.26 | 0.75 | 0.84 |
| J | corporate, redundancy trap | it | 7 | 1.000 | 0.96 | 0.12 | 0.95 | 0.29 |

The one soft spot outside the trap is page C: "By accessing or using the Service, you agree to be
bound by these Terms" scores 0.78 and "We may update these Terms from time to time" 0.54. Both are
labelled filler as boilerplate, but both are, strictly, conditions that bind the reader, and the
question now asks about the sentence itself. They stay in ink at the default threshold; nothing
that matters fades.

## The redundancy trap

The e2e screenshot of the recipe fixture showed step 8 ("do not add the lemon while the pan is on
the heat") faded, because the same fact appears in the faded introduction. The previous wording
asked whether the reader would lose information "that the rest of the page does not already give
them", so two sentences stating one fact could eliminate each other. Pages I and J are built to
trigger that: I states the lemon rule in the story and in the step and the leftovers tip in the tip
and in the closing story; J states the price change vaguely in the greeting and concretely in the
notice. The tagged sentences, with the current wording:

| page | tag | label | p(keep) | kind | sentence |
|---|---|---|---|---|---|
| I | step-dup | keep | **0.98** | step | Turn off the heat, then stir in the lemon zest, the lemon juice and the Parmigiano; do not add the lemon juice while the pan is still on the heat, or the sauce will turn bitter. |
| I | tip-dup | keep | **0.93** | step | Leftovers keep in the fridge for up to three days; add a splash of stock when reheating. |
| I | pepper | keep | 0.75 | fact | Freshly ground black pepper |
| I | story-dup | filler | 0.84 | story | The lemon goes in off the heat, which is the single detail my grandmother was strict about, and which I have since confirmed the hard way. |
| I | story-dup2 | filler | 0.27 | opinion | That is it, really; it is the thing I make when it is Tuesday and everyone is tired and hungry, and the leftovers are honestly even better the next day. |
| J | concrete | keep | **0.97** | fact | A partire dal 1° ottobre 2026 il canone mensile passerà da 9,99 € a 12,99 €. |
| J | concrete-dup | keep | **0.95** | condition | In assenza di disdetta, il nuovo prezzo verrà applicato automaticamente al primo rinnovo utile. |
| J | vague-dup | filler | 0.29 | fact | Come forse saprai, nei prossimi mesi il prezzo del tuo abbonamento cambierà, e vogliamo spiegarti perché. |

The step that was faded now scores 0.98 (0.52 under the previous wording, in the wording
comparison that chose this one), and the concrete price line 0.97 (from 0.75). The cost of asking
about the sentence itself is the story-dup line: a memory that happens to carry the lemon rule now
scores 0.84 and stays in ink. That is the right way round. A reader who skims for the practical
content sees the rule twice; under the old wording they risked not seeing it at all. The vague
announcement in J (0.29) and the closing story in I (0.27) still fade: carrying a fact is not the
same as gesturing at one.

## The question, verbatim

One Noul per sentence, with the chunk's own text as state
(`{ page_kind_hint, title, language, text }`). Packs may append one hint sentence to each
criterion; the probe uses the generic pack, which appends nothing.

> Consider this sentence from the page: «S». Does this sentence itself carry practical content the
> reader came to this page for?
>
> **true:** Yes: the sentence states a fact, figure, date, quantity, ingredient, step, condition,
> cost, obligation, decision or warning that the reader needs, even if the page says it again
> elsewhere.
>
> **false:** No: the sentence is a story, memory, opinion, greeting, thanks, reassurance,
> navigation hint or promotion; a reader looking for the practical content would skip it.

Beside it, one Choice per sentence, *What kind of sentence is this one from the page: «S»?* over
`fact, figure_or_date, instruction_or_step, condition_or_obligation, opinion, anecdote_or_story,
filler_or_transition, promotion_or_appeal`, and on the first chunk of a page one Choice, *What kind
of page is this?* over `recipe, article, legal, corporate, social, product, docs, other`. The
descriptions the model reads for each option are in `src/shared/constants.ts`.

## What this settles

1. One generic question separates substance from filler on every page kind, in two languages, so
   page-kind routing tunes the wording and is never load-bearing.
2. Asking about the sentence itself, with the page as state, keeps a fact wherever it is stated;
   the page as context still tells the model what "practical content" means here.
3. Batching is the cost model: ~60 sentences × 2 questions per request costs about what one
   sentence would, answers in about a second, and does not drift between runs.
