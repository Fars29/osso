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
| H | noise floor | en | 8 | · | · | 0.05 | · | 0.06 |
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

## Real pages (2026-09-21, `e2e/review.mjs`)

The synthetic pages have crisp labels. Two real ones, read sentence by sentence with
`node --env-file=.env e2e/review.mjs <url> --kept`, showed what the labels could not: where the
debatable sentences sit, and what a pack's hints can do to them.

**A markets article** (milanofinanza.it, a bank's forecasts on gas, power and oil; 23 sentences). The
figures all came back at 0.89–0.94. But the article pack's hints listed "speculation" among what does
not count, and the piece's opening claim ("the next energy shock may come from gas before oil") came
back at 0.41, the analyst's quotes and the sentence defining the negative scenario at 0.32–0.47: a
sourced forecast is the substance of an analysis piece, not its colour. With the hints rewritten
(main claim, forecasts and estimates with their source, causes and consequences count; teasers,
bridges between topics and calls to follow do not) the opening claim rose to 0.55 and the quotes to
0.61. What stayed low is what should: the "add us to your Google sources" line (0.05), a teaser that
promises detail without giving it (0.13), a bridge to another topic (0.12).

**A recipe page** (allrecipes.com; 72 sentences after the interface text was left out). Every
ingredient at 0.97–0.98, every step at 0.84–0.98, storage and freezing at 0.84–0.94. Grey, rightly:
the grandmother's recipe book (0.06), the quoted reviews (0.05–0.09), photo credits, "Gather all
ingredients" (0.21), "Serve and enjoy!" (0.07), the nutrition boilerplate (0.13–0.26), the app promo.

**The default threshold.** On both pages true filler sat at or under **0.27** and substance at or
over **0.52**. Between 0.35 and 0.48 there was only what is debatable and useful: "Yes, you can
freeze pancakes and pancake batter" (0.47), "Plus, it helps bind the batter together" (0.40), "In
Italy the pressure on gas is likely to weigh on the power bill" (0.38). The first default, 0.5, cut
through that band on the wrong side. Fading what the reader needed costs far more than leaving a
lukewarm sentence in ink, and on the synthetic set filler above 0.3 is rare (mean 0.12), so the
default is now **0.35**; an install still carrying an untouched 0.5 is moved once.

**Interface is not prose.** The first pass on the recipe page judged, and greyed, "16,640 Reviews",
"Keep Screen Awake", "Get the App" and an "Oops! Something went wrong." that was not even showing.
A div, section or cell with fewer than 8 words is now left alone (a paragraph element may be as
short as it likes), and a block the page is not showing is neither judged nor paid for until it is
shown: 85 sentences became 72, and the tokens fell by about 15%.

## A wider sample (2026-09-21)

Sixteen live pages, found rather than chosen (news articles taken from the front pages of the day),
each read sentence by sentence with `e2e/review.mjs --brief`: what went grey, and what stayed in
ink although the model itself called it opinion, story, filler or promo.

| page | kind | judged | grey | what went grey |
|---|---|---|---|---|
| ilpost.it, a German state election | article | 23 | 6 | date line, two photo captions, a related-story title, one line of praise |
| apnews.com, drone strikes | article | 31 | 9 | "Updated…", the newsletter pitch, "Follow the AP's coverage…", a quote with nothing in it ("The enemy failed in this regard"), vague background |
| theguardian.com, a policy explainer | article | 33 | 3 | how the investigation was put together |
| ansa.it, a food feature | article | 30 | 8 | the rhetorical opener, PR sentences about "a dialogue between two cultures", "add us as a preferred source" |
| milanofinanza.it, a bank's forecasts | article | 23 | 5 | the Google-sources pitch, a teaser, a bridge to another topic |
| bbcgoodfood.com, pancakes | recipe | 27 | 4 | "Showing items 1 to 3 of 6", the app and subscription pitches, the magazine credit |
| allrecipes.com, pancakes | recipe | 72 | 36 | grandma's recipe book, quoted reviews, photo credits, "Gather all ingredients", nutrition boilerplate |
| giallozafferano.it, carbonara | recipe | 57 | 11 | the intro, the 1944 origin story, the pasta sponsor's paragraph, nutrition disclaimers |
| ar5iv, "Attention Is All You Need" | paper | 231 | 75 | licence note, author contributions, affiliations, "in the following sections we…", "see Figure 2", future work, thanks |
| journals.plos.org, a new monkey species | paper | 490 | 92 | citation line, editor, dates, licence, data availability, five sentences of funding, competing interests, map credits |
| wikipedia.org, Focaccia | article | 21 | 1 | the pointer to Wikimedia Commons; the body is all substance and all stays |
| spotify.com, terms of use | legal | 245 | 31 | "read these Terms carefully", cross-references, "we aim to create great experiences", severability and no-waiver |
| apple.com, a press release | article | 150 | 20 | the executive's quote, "like never before", "designed with the environment in mind", footnote pointers |
| notion.com, a product page | product | 54 | 16 | slogans and testimonials; concrete capabilities stay |

(Two more could not be read: a recipe URL that no longer exists, and an essay behind a "checking
your browser" wall.) Nothing that carried a quantity, a step, a price, a date, a binding clause or
a result went grey on any page. The misses were all of one kind, and none of them was the model's:
**structure was being read as prose.** Each became a rule in `segment.ts`, never wrapped and so
never judged, never faded, never paid for:

- a heading written as a paragraph ("Multi-Head Attention", "Ricetta risotto alla milanese con kimchi"): a paragraph of at most 8 words that does not end like a sentence, or up to 14 if it is all bold;
- a caption ("Table 1. Comparative skeletal sample…", a short `figcaption`);
- a sentence that ends in a colon: it introduces a list, a formula or a quotation, and greying it orphans what it introduces;
- the question that heads its answer in an FAQ ("Quante uova servono per la carbonara?");
- a list of works cited: on the encyclopedia article it was 44 of the 77 sentences judged, every one at 0.08, and 72% of what the page cost;
- and the sentence splitter learned "et al.", "sp. nov.", "Fig.", "(lit. …)", which had been cutting citations and glosses in half.

Papers got a pack of their own (`src/packs/paper.ts`): read as news they were fine, but their genre
has its own filler (signposting, contributions, funding) and its own substance (a hyperparameter,
a sample size, a limitation). The kind question's eight descriptions were cut to a quarter of
their words: asked once per sentence, they had been more than half of every request. Together:
the encyclopedia article 44.8k → 12.7k tokens, the long paper 421k → 277k, the recipe 44.0k → 29.7k.


## What the model sees (2026-09-21)

Beside each sentence the model gets a state: the page's title, its language, the pack's one-line
hint of what kind of page this is, and as `text` the chunk's own sentences, at most thirty, in
page order. Not the whole page. Is that the right amount? Seven live pages of 56 to 245 sentences
(a paper, terms of use, an encyclopedia article, a press release, three recipes; 880 sentences)
were dumped with `e2e/dump.mjs` and replayed with `scripts/context.ts`, the same questions over
different states:

| state | tokens vs shipped | decisions that change at 0.35 | mean |Δp| |
|---|---|---|---|
| no text at all (title and hint only) | −4% to −8% | 2 to 12 a page | 0.035 to 0.065 |
| **the chunk (shipped)** | · | · | · |
| the chunk, its boundaries moved by 15 sentences | 0% | 0 to 6 a page | 0.011 to 0.037 |
| the chunk + the five sentences before it | +1% | 0 to 4 a page | 0.005 to 0.024 |
| the chunk + the page's headings and lead, the sentence's heading in the question | +3% to +5% | 0 to 9 a page | 0.009 to 0.035 |
| the whole page | +4% to +62% | 0 to 8 a page | 0.012 to 0.046 |
| the whole page with headings, heading in the question | +7% to +66% | 0 to 10 a page | 0.010 to 0.049 |

- **Local context does real work.** With no text the model loses the sentences that lean on their
  neighbours ("Any counsel representing the parties also may participate" 0.72 → 0.33, "For each of
  these we use…" 0.63 → 0.14, "The salt amount has been reduced based on review feedback" 0.43 →
  0.21) and warms to platitudes that the clauses around them expose ("You and Spotify agree that
  arbitration should be cost effective" 0.20 → 0.47).
- **The whole page adds nothing that can be told from noise.** Moving the chunk boundaries, which
  changes no information at all, moves p as much as handing over the entire page does. No clear
  case changed side under a bigger state: every sentence that flipped was one the shipped state
  already had between 0.17 and 0.52. Where the whole page
  leaned, it leaned the wrong way: on the encyclopedia article it greyed dated facts ("…replaced by
  barm, and after 1871 by purpose-cultured yeast" 0.52 → 0.32), since a sentence weighed against a
  whole page of facts looks less needed, the same trap as the redundancy clause above.
- **No edge effect.** The two sentences that open a chunk, cut off from what precedes them, differ
  from the same sentences judged mid-chunk by 0.021 on average; interior sentences differ by 0.021.
  The five-sentence lead-in fixes nothing because nothing is broken.
- **The state is billed once per request**, not once per question (a 2.9k-token state costs 2.9k
  with one question or with sixty), and does not slow the answer. So context is cheap; it is just
  not what these judgments are short of. The tokens are in the questions: about 290 a sentence for
  the keep question and as many again for the kind question, which only ever names the reason on
  the chip of a grey sentence.

The state stays as it is. What the numbers do say: p is good to about ±0.05. On a recipe almost nothing sits that
close to the threshold (1 sentence of 199); on an encyclopedia article, a paper or a contract about
one in thirty does (19 of 568), which is why the fade is a colour and never a cut.

## What readers wrote is not the page (2026-09-21)

A recipe's reviews went through the keep question and came out backwards: "it didn't disappoint"
and "the overall texture came out great" grey, the reviewer's aside about vanilla paste in ink. Not
a threshold to move: in a review the opinion is the content, and the question reads opinion as
filler, so it is wrong there by construction. Reviews, comments and replies are now structure
(`segment.ts`, `UGC_HINT` and schema.org's Review and Comment): never wrapped, never judged, never
paid for, and on that page they were 44% of the text. The rule is asked inside an `<article>` too,
which is where publishers put them, and gives way when the readers' words are most of the page (a
thread, a Q&A). Names that also mean an article are left out: "review" is a critic's page,
"discussion" a paper's section. And a tag at the end of a paragraph ("Edited", "Read more") is a
label, not a short sentence to join to the one before it: it had been greyed and struck with it.

One more of the same family, from a policy page: "The privacy policy must comprehensively disclose: (a) How your Product collects, uses and shares user data". The item is the second half of the sentence the colon left open; read alone it looks like a heading, and the model gave it 0.43 on one page and under 0.35 on another with different neighbours. An item that does not end like a sentence, in a list a colon introduces, is now structure, like the lead-in itself. On that page of 221 sentences the 17 that still go grey are mission statements, "see the FAQ" pointers and the licence footer.

Everything we say to the model is English, on a page in any language: only what is quoted inside
« » (the sentence, the user's rule) and the title are the page's own. `test/prompts.test.ts` holds
that line.
