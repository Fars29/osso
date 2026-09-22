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

## A highlight

A term the reader types under *highlight* ("candidate names", "ingredients", "consequences") is found in up to two rounds, and a question about the term decides whether there is a second:

1. **Which sentences mention it at all.** One Noul per sentence over the whole page, batched like the keep question. On a news page four sentences in twenty-five mention a person, and that is what keeps the rest affordable. The question is *does it tell the reader about any «term»?*, and the criteria say both halves out loud: yes *whether or not it uses that word*, no when *using the word alone* is all there is. Asked plainly, the round was as literal as a search: on a report about workplace safety funding, "consequences" passed only the one sentence with "conseguenze" in it, and the three that say what the money will change scored 0.23 to 0.37. With the criteria spelled out they score 0.71 to 0.82, and names and sums of money pass the same sentences as before.
2. **Which words say what it is.** One Noul per content word, and only for the sentences round one kept. The question is *does this word belong to the words that say what the «term» is?*, not *is this word a «term»?*: asked the second way, "conseguenze" marked the word "conseguenze" and left the consequence alone, which is what the browser's own find already does. Function words and punctuation are dropped before anything is sent, and the sentence rides in the state of its own request so each question is a few words long. Measured against repeating the sentence inside every question: half the tokens, the same answers. This round does not decide *whether* (round one did), only *where*, so a word that stands out from the rest of its sentence is marked even under 0.5: at least 0.35, and at least three quarters of the sentence's best word. "L'incremento dell'1,73%" came back at 0.40 and 0.45 against 0.14 to 0.28 for every other word; a sentence where nothing stands out is left alone.

**Words or the whole sentence.** A name, an amount or an ingredient is a few words, and marking its sentence would bury it. A consequence, a reason or a risk is said by a clause, and marking it word by word cuts it apart: on the report above, round two returned "consequences" as *disavanzo* … *3,1miliardi* … *all'incremento*. So each term gets one more question, once: *is a «term» something a whole sentence states, rather than something a few words name?* (`HIGHLIGHT_UNIT_QUESTION`). The answer is about the term, not the page, so it is asked with no page in the state, beside round one so it adds no wait, and kept for every page after (`background/units.ts`). At 0.5 or above the term is marked as the whole sentences round one found, in a lighter wash of the marker that keeps the page's own ink, and round two is skipped; below, it goes through round two as above. Ties go to words: a wrong "words" is the marker as it always was, a wrong "sentence" buries a name.

Measured on 70 terms in English and Italian, asked twice each: things (names, places, prices, dates, ingredients, brands, medicines) came back between 0.06 and 0.34, statements (reasons, risks, what I have to do, criticism, limitations, *cosa cambia*) between 0.51 and 0.90, and no term moved more than 0.11 between its two asks. Naming consequences and causes among the criteria's examples is what lifted the Italian *conseguenze* from 0.46 to 0.56, on average over its asks. The same question asked as a Choice flipped *conseguenze* from one ask to the next, which is why it is a Noul.

Marks are then stitched: two of them become one stretch when nothing lies between but spaces and words that were never asked about. The little words of a clause are not asked ("un aumento dei mutui e una spesa" is asked as *aumento, mutui, spesa*), so without this a consequence would be marked in three pieces. A word that **was** asked and refused ends the stretch, and so does punctuation, because the writer put it there: "sugar, salted butter" stays two things. What comes back are offsets into the sentence, which the page turns into ranges and hands to the browser's Custom Highlight API: nothing of ours is added to the page, and nothing moves. A sentence a highlight marks is never struck, since asking to see a thing and then greying it is two answers to one question.

A term marked in words costs about as much again as the page (measured on a 27-sentence news report: 17.4k tokens for the page, 14k to 29k for a term depending on how many sentences it finds, $0.0006 to $0.0012) and adds a second or two after the page is already stripped. A term marked as sentences costs round one alone: on that report "consequences" came back as five whole sentences for 6.4k tokens, where word by word it had been thirteen fragments for 20k. The unit question adds about 420 tokens, once per term. A term that matches everything is capped at 60 sentences. The marks are kept in the page's cached judgment, so a page read again is marked with no request, and they are kept with the version of the question that found them (`HIGHLIGHT_VERSION`): when the question changes, marks found by the old one are asked again rather than served.

## The question, verbatim

> Consider this sentence from the page: «S». Does this sentence itself carry practical content the reader came to this page for?
>
> **true:** Yes: the sentence states a fact, figure, date, quantity, ingredient, step, condition, cost, obligation, decision or warning that the reader needs, even if the page says it again elsewhere.
> **false:** No: the sentence is a story, memory, opinion, greeting, thanks, reassurance, navigation hint or promotion; a reader looking for the practical content would skip it.

Each page kind (recipe, article, paper, legal, corporate, product, docs, social) appends one sentence to each side. A rule the reader types becomes a question of its own, asked of every sentence.

On 99 hand-labelled sentences from ten pages in English and Italian, this question separates substance from filler with an AUC of 0.998 (mean p(keep) 0.94 for substance, 0.12 for filler), and a batch of 15–29 sentences answers in 610–1330 ms. Full numbers, the per-page table, the redundancy trap and what sixteen live pages taught us are in [calibration.md](calibration.md); the design is in [design/](design/).

## What leaves your machine

Only to `api.typesafe.ai`, with your own key: the page title, its language, a page-kind hint and the main text of the page. Never the URL. The key is stored in this browser only, and only the background worker holds it; the script that runs inside pages never sees it.
