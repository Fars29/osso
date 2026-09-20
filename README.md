# Osso

**Solo l'osso.** — Just the bones.

A Chrome extension. Every page you open arrives with its filler faded to a quiet grey and
its substance left in the author's own ink. It never hides anything, never rewrites a word,
never summarises: the story about the grandmother's kitchen is still there, in grey, right
above the ingredients, in black. It is always on. Hold **Shift** and the whole page comes
back; let go and it fades again. Judgments come from [Jev](https://docs.typesafe.ai),
TypeSafe's System One model, through your own API key. Open source, GPL-3.0.

![The recipe page after Osso: the story in grey, the ingredients and the method in ink](docs/recipe-faded.png)

## Install

There is no store listing yet.

1. `npm install && npm run build`
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick `dist/`.
3. Osso opens its settings page on install; paste your key there and open any article. Later:
   click the icon → **Add key**.

Works in Chrome and Chromium-based browsers (Edge, Brave, Arc, Vivaldi). The manifest
carries a `gecko` id and Firefox 128+ reads Manifest V3, but Firefox is not tested yet and
the background worker may need to become an event page there.

## Why it works

The whole product rests on one question. Before writing any of it, `scripts/calibrate.ts`
asked that question about 78 hand-labelled sentences from seven synthetic-but-realistic pages
(recipe blog, corporate statement, terms of service, LinkedIn post, news article; English and
Italian) plus one page of bland narrative as a noise floor. Probe of 2026-09-20:

| measure | value |
|---|---|
| AUC substance vs filler, one generic question, all pages | **0.999** (1.000 on every page) |
| mean p(keep): substance / filler / noise floor | 0.94 / 0.16 / 0.11 |
| best single threshold | 0.5–0.8 (acc ≥ 0.987) |
| 24–42 questions per request | 350–500 ms |
| 258 questions, one request, all pages | 1.26 s, 49.7k tokens, $0.0021 |
| repeat of the same request | max Δp = 0.010 |

The question, verbatim, one per sentence, with the page's text as state:

> Consider this sentence from the page: «S». If this sentence were deleted, would a reader
> who came to this page for its practical content lose information that the rest of the page
> does not already give them?
>
> **true:** Yes: the sentence states a fact, figure, date, step, condition, cost, obligation,
> decision or warning that the reader needs and that is not stated elsewhere on the page.
> **false:** No: the sentence is a story, opinion, greeting, thanks, reassurance, navigation
> hint, promotion, or it restates something the page already says; deleting it loses nothing
> practical.

Three things the probe settled. The generic wording separates well on every page kind, so
routing by page kind tunes the wording but is not load-bearing. Embedding the sentence in the
question with the whole page as state works: the model attends to the one sentence and still
sees what the rest of the page already says. And batching is the cost model: sixty sentences
in one request cost about what one sentence would, and the answers do not drift when you ask
again.

## Your key

Get one at [typesafe.ai](https://typesafe.ai). Osso stores it in `chrome.storage.local` on
your machine; there is no server of ours, and the content script that runs inside pages never
sees it, only the background worker does.

What leaves your machine, and only to `api.typesafe.ai`: the page title, its language, a
page-kind hint and the main text of the page. No URL is sent. Nothing is sent for pages Osso
skips. Nothing is logged, not even when the API rejects a request.

Permissions: `storage` for the key and the cache, `unlimitedStorage` so a full cache is never
the reason a page fails, `activeTab` so the popup knows which site it is looking at, and host
access to `https://api.typesafe.ai/*` only. The content script is injected by the manifest's
`content_scripts` rule, which needs no host permission of its own, and the worker has no
cross-origin privileges anywhere else.

What it costs: Jev bills input tokens at $0.042 per million, output is free. A long page is
40–60 sentences, one or two requests, roughly 25–50k tokens: about **$0.001–0.002**. The
popup keeps a running total. Results are cached by content hash, so reading the same page
twice costs once.

## How it decides

1. **Segment.** Find the main content, collect the text blocks, split them into sentences, wrap
   each in an `<osso-s class="osso-s">` around the original text nodes so inline links and
   emphasis survive untouched (a custom element, so no site stylesheet written against
   `p span` ever matches it). Fewer than 8 sentences: stop, the page is not worth a request.
   Switching Osso off puts the page's own text nodes back exactly as they were, so a framework
   that holds a reference to a node still holds the node that is on the page.
2. **Route.** Heuristics on JSON-LD `@type`, URL, `og:type`, title and a text sample pick a
   pack: recipe, article, legal, corporate, social, product, docs. Unsure: generic.
3. **Pack.** The pack supplies the page-kind hint and may append hints to the question's
   criteria. The question itself does not change.
4. **Ask.** One batched request per ~60 sentences, up to four in flight, each carrying its
   own chunk of text as state and two questions per sentence: keep (a probability) and kind
   (fact, figure, step, condition, opinion, story, filler, promo). The first chunk also asks
   what kind of page this is.
5. **Fade.** Sentences with p(keep) below the threshold (default 0.5) get a colour change.
   Only a colour change: the grey is chosen per block for its background, about `#b9b9b9` on
   white, so nothing moves and nothing reflows. Kept sentences are not touched at all.
6. **Cache.** Probabilities are stored per page. Moving the threshold slider in the popup
   re-renders from the cache in 0 ms; no request is made. Hover a sentence to see its kind
   and its p(keep). Click a faded sentence to pin it back for this view.

Pages that change under you (infinite scroll, client-side navigation) are watched with a
debounced `MutationObserver`; only the new sentences are judged, in a small request of their
own that is never cached, and the result is merged into the page's judgment.

## What it never touches

Headings. Tables. `pre` and `code`. `nav`, `header`, `footer`, `aside`. Forms, inputs and
anything `contenteditable`. Anything `aria-hidden`. Anything under three words. Images and
figures (captions are judged). Pages that are really apps: a large editable region, or inputs
that dominate the document.

And a deny list, on by default, where the page is your workspace rather than someone's
writing: Gmail, Google Docs, Drive, Calendar, Meet, Outlook, Office, Notion, Slack, Discord,
WhatsApp, Telegram, Teams, GitHub, GitLab, Bitbucket, Stack Overflow, Google, Bing,
DuckDuckGo, YouTube, Netflix, X, Facebook, Instagram, TikTok, LinkedIn, Reddit, Figma, Canva,
ChatGPT, Claude, typesafe.ai, and localhost. Any of these can be re-enabled per site from the
popup, and any other site can be added to the list.

## Honest limitations

It is a judgment, not a guarantee. An AUC of 0.999 on 78 sentences is a promising probe, not
a proof; the model will sometimes grey a sentence you needed. That is why the grey text is
still there, still readable, and Shift brings it all back. Read the grey when it matters.

The noise floor is not zero. Bland sentences on a page with no practical content scored a
mean p(keep) of 0.11, not 0.00, so on a page that is entirely narrative a few sentences stay
in ink for no reason the reader can see.

On pages of pure substance (a spec, a good news article) little or nothing fades, and that is
correct behaviour, not a bug.

The default threshold of 0.5 is one choice inside a wide plateau (0.5–0.8 all scored above
0.987 on the probe). It is a slider because the right value depends on how much you trust the
author.

It is off by default on the sites listed above. Nothing is judged on a page until you have
saved a key.

## Development

```
npm install
npm run build        # esbuild → dist/
npm run dev          # watch
npm test             # vitest, jsdom, mocked chrome.*; never calls the API
npm run typecheck    # tsc --noEmit
npm run calibrate    # the probe, live API, needs TYPESAFE_API_KEY in .env
npm run e2e          # Playwright loads dist/ into Chromium, live API, needs the key
npm run icons        # icons/icon.svg → icons/{16,32,48,128}.png
npm run zip          # dist/ → release/osso-<version>.zip
```

Node 20 or newer. TypeScript strict, no frameworks, no runtime dependencies: the extension
is vanilla DOM and `fetch`.

The e2e serves three fixtures on `127.0.0.1` (a recipe blog, a terms page and a three-sentence
page that must be skipped), saves the key through the options page, and asserts that the
recipe has at least five faded and five kept sentences, that an ingredient stays in ink, that
nothing inside `nav` or `footer` was touched, that Shift reveals, that the auto-renewal clause
of the terms is kept, and that the blank page is left alone. It writes screenshots to
`e2e/screenshots/` and prints a table with the time to first fade.

```
src/shared/       types and constants: the contracts every module builds against
src/content/      segment, render, orchestrator, osso.css — runs inside the page
src/background/   settings, cache, api, orchestrator — the only code that holds the key
src/packs/        page-kind routing and question hints
src/ui/           popup and options
scripts/          calibrate, icons, zip
e2e/              Playwright smoke and fixtures
```

## Modules

Packs live in `src/packs/`, one file per page kind, exported through `src/packs/index.ts`:

- `recipe.ts` — JSON-LD `Recipe`, ingredient and step vocabulary; hints that quantities and timings are substance.
- `article.ts` — `og:type=article`, news and blog URLs; scene-setting and reaction are filler.
- `legal.ts` — terms, privacy, licence; every clause that binds is substance, boilerplate about headings is not.
- `corporate.ts` — announcements and customer notices; dates, prices and decisions over gratitude.
- `social.ts` — posts and threads; the one line with the job link is the bone.
- `product.ts` — features, specs, pricing.
- `docs.ts` — guides and manuals.
- `generic.ts` — the fallback; the probe's question, unchanged.

A pack is a `Pack`: an id, a `match(meta)` score over `PageMeta`, and optional hint strings
appended to the keep criteria. To add one, create the file, export it, and add it to the list
in `index.ts`; `route(meta)` picks the highest score above its floor and falls back to
`generic`. Routing tunes wording, it is not load-bearing: a wrong pack still gets a good
answer.

## License

GPL-3.0.
