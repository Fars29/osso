# How Osso decides

1. The main text of the page is split into sentences. Structure is never touched: headings (including the ones written as a bold paragraph), tables, code, navigation, forms, captions, bibliographies, the question that heads an FAQ answer, a sentence that introduces a list, the bold label that opens a list item ("**Milk:** …"), the items that finish a sentence a colon left open ("…must disclose: (a) how your product collects user data"), and a tag at the end of a paragraph ("Edited", "Read more"). Reviews, comments and replies under a page are left alone too: there the opinion is the content.
2. Sentences go to the model in batches of about 30, in parallel, with their own text as context. The neighbours are the context that counts: with no text the model loses the sentences that lean on the ones around them, and with the whole page it judges no better and costs up to two thirds more ([measured](calibration.md#what-the-model-sees-2026-09-21)).
3. Each sentence gets a probability that it carries what the reader came for, and a kind (fact, figure, step, condition, opinion, story, filler, promo). The kind only names the reason on the hover chip.
4. Each batch is painted the moment it comes back: a soft front of light comes down the page and the text is washed as it passes, and a hairline draws itself through each sentence that goes. Further down, nothing happens behind your back: a sentence waits in ink until you scroll to it, and is struck in front of you. It is a colour and a line, so nothing moves and links still work. The line can be switched off in Options.
5. Probabilities are cached per page, so the slider and rule removal re-render instantly with no request.
6. Pages that change under you (infinite scroll, client-side navigation) are watched; only new sentences are judged.

Everything Osso says to the model is in English, whatever the language of the page.

## When it reads, and when it holds back

The reader chooses at the welcome: every page as it loads, or only a page they open Osso on (`mode`, `auto` or `click`). Before anything is segmented, `content/privacy.ts` looks at how the page is made:

- a visible password, card or one-time-code field: **never** read, asked or not;
- a private area in the address (whole path segments: `/account`, `/checkout`, `/settings`…), a host that only exists inside a network (an intranet name, `.local`, a private IP range), a form with three or more personal-detail fields, or a `noindex` tag: **held back**; the popup says why and offers to read the page once. On twelve live articles, recipes, papers and policy pages checked on 2026-09-21, none carried `noindex`; account areas and intranets carry it almost by habit;
- after segmentation, a sentence carrying an IBAN or card number that passes its checksum (mod-97, Luhn), an Italian tax code or a US SSN is **never sent**; three or more make the page a statement, and it is held back.

None of these looks at what the page talks about. An article on banking says "bank", "password" and "checkout" and trips none of them (`test/privacy.test.ts` holds that line).

They are heuristics, and the code and the copy both say so: a page built unusually can get through them, and then its visible text is sent like any other page's. Two things do not depend on them, because they are structural. The URL is never put in a request (`background/api.ts`), and form values are never read: `input`, `textarea`, `select`, `button` and `label` are in `SKIP_TAGS`, so what the reader types is not a text node the segmenter ever walks.

## The question, verbatim

> Consider this sentence from the page: «S». Does this sentence itself carry practical content the reader came to this page for?
>
> **true:** Yes: the sentence states a fact, figure, date, quantity, ingredient, step, condition, cost, obligation, decision or warning that the reader needs, even if the page says it again elsewhere.
> **false:** No: the sentence is a story, memory, opinion, greeting, thanks, reassurance, navigation hint or promotion; a reader looking for the practical content would skip it.

Each page kind (recipe, article, paper, legal, corporate, product, docs, social) appends one sentence to each side. A rule the reader types becomes a question of its own, asked of every sentence.

On 99 hand-labelled sentences from ten pages in English and Italian, this question separates substance from filler with an AUC of 0.998 (mean p(keep) 0.94 for substance, 0.12 for filler), and a batch of 15–29 sentences answers in 610–1330 ms. Full numbers, the per-page table, the redundancy trap and what sixteen live pages taught us are in [calibration.md](calibration.md); the design is in [design/](design/).

## What leaves your machine

Only to `api.typesafe.ai`, with your own key: the page title, its language, a page-kind hint and the main text of the page. Never the URL. The key is stored in this browser only, and only the background worker holds it; the script that runs inside pages never sees it.
