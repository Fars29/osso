# Osso — design

*2026-09-20. Status: approved for build.*

## What it is

A browser extension. Every page you open arrives with its filler faded to a quiet grey and its substance left in the author's own ink. It never hides anything, never rewrites a word, never summarises. It is always on; you hold a key to see everything again. Judgments come from Jev (TypeSafe's System One model) through the user's own API key. Open source, GPL-3.0.

Tagline: **Solo l'osso.** ("Just the bones.")

## Evidence this works (probe, 2026-09-20, `scripts/calibrate.ts`; full results in `docs/calibration.md`)

99 hand-labelled sentences from nine synthetic-but-realistic pages (recipe blog, corporate statement, terms of service, LinkedIn post, news article; English and Italian; two of them a redundancy trap where a fact is stated twice) plus one page of bland narrative as a noise floor. The script builds every request with `buildRequestBody` and the generic pack, so it measures exactly what ships:

| measure | value |
|---|---|
| AUC substance vs filler, one generic question, all pages | **0.998** (1.000 on eight pages, 0.978 on the redundancy trap) |
| mean p(keep): substance / filler / noise floor | 0.94 / 0.12 / 0.05 |
| best single threshold | 0.55–0.6 (acc 0.980; 0.970 at the default 0.5) |
| 15–29 questions per request | 610–1330 ms once warm |
| 214 questions, one request, all pages | 2.73 s, 52.3k tokens, $0.0022, AUC 0.989 |
| repeat of the same request | max Δp = 0.020 |
| redundancy trap: the recipe step also stated in the faded story | p(keep) 0.98 (0.52 under the earlier "not already given elsewhere" wording) |

Conclusions that fix the design: (1) one generic "does this sentence itself carry practical content?" question separates well on every page kind, so routing tunes wording but is not load-bearing; (2) embedding the sentence in the question with the page text as state works — per-element attention holds; (3) the question must be about the sentence, not about what the rest of the page says: a redundancy clause let two sentences stating one fact eliminate each other; (4) batching is the cost/latency model: ~60 sentences × 2 questions per request, chunks in parallel.

## Non-goals

No summaries or generated text of any kind. No `display: none`. No server of ours; the key and the cache live in the browser. No telemetry leaving the machine. No mobile. No per-site scraping adapters — Osso reads the DOM generically.

## Architecture

```
┌─ page ───────────────────────────────────────────────────────┐
│ content script                                                │
│   segment  → find main content, collect blocks, split         │
│              sentences, wrap each in <osso-s class="osso-s">  │
│   index    → orchestrate, messaging, MutationObserver, state  │
│   render   → fade / reveal / chip / threshold / unwrap        │
└──────────────┬────────────────────────────────────────────────┘
               │ runtime messages (never the API key)
┌──────────────▼────────────────────────────────────────────────┐
│ background service worker                                     │
│   settings → chrome.storage.local, defaults, migrations       │
│   cache    → LRU by content hash, per-sentence memo           │
│   api      → chunk, build questions from pack, fetch with     │
│              retry, parse answers                             │
│   index    → message router, badge, stats                     │
└──────────────┬────────────────────────────────────────────────┘
               │ HTTPS, Authorization: Bearer <user key>
        api.typesafe.ai/v1/systemone
```

`packs/` (page-kind routing heuristics + question wording) is shared by content (routing) and background (question building). `ui/` holds popup and options.

### Data flow for one page

1. `content/index` at `document_idle`: ask background for settings + site state. Stop (and report `skipped`/`no-key`) if disabled, host denied, no key.
2. `segment.findMainContainer` → `collectBlocks` → `splitSentences` → `wrapSentences`: each sentence becomes one or more `<osso-s class="osso-s" data-osso="<id>">` around the original text nodes (split with `Text.splitText`, so inline markup survives; a custom element, so no site stylesheet matches it). Unwrapping gives every split node its characters back, so the page's own text nodes keep their identity. If fewer than `MIN_SENTENCES` (8) → `skipped`.
3. `packs.route(pageMeta)` picks a pack from JSON-LD `@type`, URL, `og:type`, title and a text sample. Unsure → `generic`.
4. Send `judge` with `{url, title, lang, packId, contentHash, sentences}`. Background: cache hit → return. Miss → chunk (≤ 60 sentences), one request per chunk in parallel (≤ 4 in flight), state `{title, language, page_kind_hint, text}` (the chunk's own text), questions `keep_<i>` (Noul) + `kind_<i>` (Choice) per sentence, and `page_kind` (Choice) on the first chunk. Parse → `PageJudgment`. Store.
5. `render.apply(judgment, threshold)`: sentences with `p(keep) < threshold` get `osso-fade`; settle animation staggered by document order. Kept sentences are untouched.
6. Report `TabState` to background (badge shows kept count). Popup reads it.
7. `MutationObserver` (debounced 800 ms, ignoring our own mutations) segments new blocks and judges only new sentences (memo by sentence hash).

### Question design (verbatim from the probe; packs may append hints to `criteria`)

State: `{ page_kind_hint, title, language, text }`.

`keep_i` — Noul. Instructions: *Consider this sentence from the page: «S». Does this sentence itself carry practical content the reader came to this page for?* Criteria true: *Yes: the sentence states a fact, figure, date, quantity, ingredient, step, condition, cost, obligation, decision or warning that the reader needs, even if the page says it again elsewhere.* false: *No: the sentence is a story, memory, opinion, greeting, thanks, reassurance, navigation hint or promotion; a reader looking for the practical content would skip it.*

`kind_i` — Choice over `fact, figure_or_date, instruction_or_step, condition_or_obligation, opinion, anecdote_or_story, filler_or_transition, promotion_or_appeal` with the descriptions in `shared/constants.ts`.

`page_kind` — Choice over `recipe, article, legal, corporate, social, product, docs, other` (first chunk only; shown in popup, stored).

### Rendering rules

- A fade is a **colour change only**: `color` transitions to a grey chosen per block for its effective background (walk ancestors to the first opaque background; pick the grey giving ≈1.6:1 contrast — about `#b9b9b9` on white, `#5c5c5c` on near-black). Links inside faded text go grey with their sentence, underline included (`a:has(.osso-fade)` takes `text-decoration-color`), stay clickable and come back in the author's colour under the pointer. Nothing changes size, position or layout.
- Progressive paint: the background streams every chunk (≤ 30 sentences, up to 6 in flight) to the page the moment the model answers it (`judgmentChunk`); the page paints each chunk on arrival with its own wave, so the grey is seen running down the page at the speed of the answers, and the popup's count climbs meanwhile. The whole judgment follows as the reply, for the cache, and animates nothing twice.
- Settle and sweep: delay `min(order × 16 ms, 500 ms)` over every sentence judged in the pass, kept or not. A **comet** of the accent colour crosses each sentence in 480 ms on its delay — a 2 px bright head with a tail thinning out over 120 px behind it, sized in pixels so it is the same on a three-word item and a paragraph-long sentence (`--osso-x`, a registered `<length-percentage>`, animated from `-4px` to `calc(100% + 130px)` so nothing of it is left on the text). Where the grey falls it is **drawn in behind the comet's head** (the wipe): a text-clipped gradient, grey behind `--osso-x` and the block's own ink (`--osso-ink`, read by the renderer) ahead of it, painted through `-webkit-text-fill-color: transparent` so `color` is already the grey underneath and nothing jumps when the class comes off. Inside a link, or with no ink known, the grey falls back to the `650 ms` colour transition. A **read-out** sits bottom right while the page is judged: the count of sentences answered for, climbing as chunks land, then the total and the model's time, gone 2.2 s later; never on a cached page. Classes and delays come off once the pass has settled. `prefers-reduced-motion` and animations-off → none of it, 120 ms, no stagger. (Revised 2026-09-20/21: 10 ms / 550 ms ease-out read as a loading effect; a flat band read as a highlight, not as motion; the comet and the wipe make the speed something seen.)
- Osso ignores its own mutations: records on `.osso-s` attributes and anything inside the chip or the read-out never reach the observer's logic, or they re-arm the debounce on every frame and a pending restart never comes.
- Hover on a grey sentence (250 ms delay): a small chip beside the line box under the pointer, in the nearer margin like a note in the margin of a book, so it never covers a word (with no margin: the free end of the line, else above the line) — one word, the reason: the kind when the kind is the reason (`story`, `opinion`, `filler`, `promo`), `aside` when the model called it a fact, figure or step and still not what the reader came for; `kept by <rule>` and `pinned` for a sentence brought back. Ink gets no chip. (Revised 2026-09-20: a kind beside a p(keep) meter read as a contradiction — "fact", one dot lit — because a fact can be true and beside the point.)
- Reveal: hold `settings.revealKey` (default **Shift**; Space is never used, it scrolls) ≥ 120 ms → root class `osso-reveal`, faded text returns to ink in 180 ms; release → fades back in 300 ms. Click on a faded sentence → pinned back for this page view.
- Threshold slider in the popup → `setThreshold` → re-render from cached probabilities, 0 ms, no inference.
- Never touched: headings, data tables, `pre`/`code`, `nav`/`header`/`footer`/`aside`, forms and editable regions, `aria-hidden`, anything under 3 words, images/figures (captions are judged) — and **run-in labels**: the bold run (≤ 8 words, with its colon or dash) that opens a block, or a plain `Label:` (≤ 5 words) at the head of a list item. A label names what the item is about, the way a heading names a section; it goes to the model with its sentence as context and is never wrapped, so it can never fade. (A recipe lost "Milk:" from its ingredient notes because the sentence after it was, rightly, filler.)

### Scope guard

Run only when all hold: `settings.enabled`; host not in `deniedHosts` (defaults in `constants.ts`: mail, docs, chat, code hosting, search, video, social feeds, localhost); API key present; ≥ 8 sentences in main content; the document is not an app (a large `contenteditable`, or inputs dominate). The reason for skipping is reported to the popup.

### Error handling

- No key → badge `!`, popup explains, page untouched.
- 401 → key marked invalid in settings; popup says so.
- 429 / 529 → exponential backoff, 3 retries; then untouched, popup shows "rate-limited".
- Timeout 20 s per request; network failure → untouched, popup shows the error.
- Chunks apply independently; a failed chunk leaves its sentences untouched. A page is never left half-broken: any exception in segment/render → `unwrapAll()`, `console.warn('[osso] …')`.

### Privacy and permissions

The key lives only in `chrome.storage.local` and is used only by the background worker; the content script never sees it, and the popup sees only a presence marker. What leaves the machine: the page title, language, page-kind hint and the main text of the page, to `api.typesafe.ai` only. No URLs are sent. Nothing is logged, not even a rejected request's body. Permissions: `storage`, `unlimitedStorage` (the cache), `activeTab` (the popup's tab URL) and a host permission for `https://api.typesafe.ai/*` only; the content script is injected by `content_scripts.matches`, which needs no host permission. No remote code.

### Modules and owners

| module | files | responsibility | tests |
|---|---|---|---|
| segment | `src/content/segment.ts` | main-content detection, block collection, sentence splitting, wrap/unwrap | jsdom fixtures: recipe with life story, ToS, page with nav/table/code, SPA mutation |
| render | `src/content/render.ts`, `src/content/osso.css` | fade/reveal/chip/threshold/unwrap, adaptive grey, stagger, reduced motion | jsdom: classes, threshold re-render, grey selection, pin |
| content orchestrator | `src/content/index.ts` | flow above, messaging, observer, tab state | jsdom with mocked runtime |
| packs | `src/packs/*.ts`, `src/packs/index.ts` | `Pack` definitions, `route(meta)` | routing on fixture metas |
| api | `src/background/api.ts` | chunking, question building, fetch/retry/timeout/concurrency, parsing | mocked fetch: chunk sizes, retry on 429, parse, 401 |
| cache | `src/background/cache.ts` | LRU over storage, content hash, sentence memo | mocked storage |
| settings | `src/background/settings.ts` | defaults, get/set, validation, broadcast | mocked storage |
| background orchestrator | `src/background/index.ts` | router, badge, stats, commands | mocked runtime |
| ui | `src/ui/popup/*`, `src/ui/options/*`, `src/ui/tokens.css` | popup, options, design tokens | smoke in e2e |
| tooling | `build.mjs`, `scripts/*` | esbuild bundle, icons, calibrate, zip | — |
| e2e | `e2e/*` | Playwright loads `dist/`, serves fixtures on localhost, real key from `.env` | recipe fixture: ≥ 5 faded and ≥ 5 kept; reveal; slider |

### Build and scripts

`npm run build` (esbuild → `dist/`), `npm run dev` (watch), `npm test` (vitest + jsdom), `npm run typecheck`, `npm run calibrate` (live API), `npm run icons`, `npm run e2e`, `npm run zip`. TypeScript strict, ES2022, Node ≥ 20. Content script bundled as IIFE; background and pages as ESM.

## Milestones

1. Spec + skeleton + shared types (inline).
2. Modules in parallel with unit tests.
3. Integration: orchestrators, build green, e2e smoke against the live API.
4. Review (DOM safety, key handling, UX polish) and fixes.
5. README with the calibration table and privacy section; release zip.
