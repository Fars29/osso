# Osso — design

*2026-09-20. Status: approved for build.*

## What it is

A browser extension. Every page you open arrives with its filler faded to a quiet grey and its substance left in the author's own ink. It never hides anything, never rewrites a word, never summarises. It is always on; you hold a key to see everything again. Judgments come from Jev (TypeSafe's System One model) through the user's own API key. Open source, GPL-3.0.

Tagline: **Solo l'osso.** ("Just the bones.")

## Evidence this works (probe, 2026-09-20, `scripts/calibrate.ts`)

78 hand-labelled sentences from seven synthetic-but-realistic pages (recipe blog, corporate statement, terms of service, LinkedIn post, news article; English and Italian) plus one page of bland narrative as a noise floor:

| measure | value |
|---|---|
| AUC substance vs filler, one generic question, all pages | **0.999** (1.000 on every page) |
| mean p(keep): substance / filler / noise floor | 0.94 / 0.16 / 0.11 |
| best single threshold | 0.5–0.8 (acc ≥ 0.987) |
| 24–42 questions per request | 350–500 ms |
| 258 questions, one request, all pages | 1.26 s, 49.7k tokens, $0.0021 |
| repeat of the same request | max Δp = 0.010 |

Conclusions that fix the design: (1) one generic "would the reader lose information?" question separates well on every page kind, so routing tunes wording but is not load-bearing; (2) embedding the sentence in the question with the page text as state works — per-element attention holds; (3) batching is the cost/latency model: ~60 sentences × 2 questions per request, chunks in parallel.

## Non-goals

No summaries or generated text of any kind. No `display: none`. No server of ours; the key and the cache live in the browser. No telemetry leaving the machine. No mobile. No per-site scraping adapters — Osso reads the DOM generically.

## Architecture

```
┌─ page ───────────────────────────────────────────────────────┐
│ content script                                                │
│   segment  → find main content, collect blocks, split         │
│              sentences, wrap each in <span class="osso-s">    │
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
2. `segment.findMainContainer` → `collectBlocks` → `splitSentences` → `wrapSentences`: each sentence becomes one or more `<span class="osso-s" data-osso="<id>">` around the original text nodes (split with `Text.splitText`, so inline markup survives). If fewer than `MIN_SENTENCES` (8) → `skipped`.
3. `packs.route(pageMeta)` picks a pack from JSON-LD `@type`, URL, `og:type`, title and a text sample. Unsure → `generic`.
4. Send `judge` with `{url, title, lang, packId, contentHash, sentences}`. Background: cache hit → return. Miss → chunk (≤ 60 sentences), one request per chunk in parallel (≤ 4 in flight), state `{title, language, page_kind_hint, text}` (the chunk's own text), questions `keep_<i>` (Noul) + `kind_<i>` (Choice) per sentence, and `page_kind` (Choice) on the first chunk. Parse → `PageJudgment`. Store.
5. `render.apply(judgment, threshold)`: sentences with `p(keep) < threshold` get `osso-fade`; settle animation staggered by document order. Kept sentences are untouched.
6. Report `TabState` to background (badge shows kept count). Popup reads it.
7. `MutationObserver` (debounced 800 ms, ignoring our own mutations) segments new blocks and judges only new sentences (memo by sentence hash).

### Question design (verbatim from the probe; packs may append hints to `criteria`)

State: `{ page_kind_hint, title, language, text }`.

`keep_i` — Noul. Instructions: *Consider this sentence from the page: «S». If this sentence were deleted, would a reader who came to this page for its practical content lose information that the rest of the page does not already give them?* Criteria true: *Yes: the sentence states a fact, figure, date, step, condition, cost, obligation, decision or warning that the reader needs and that is not stated elsewhere on the page.* false: *No: the sentence is a story, opinion, greeting, thanks, reassurance, navigation hint, promotion, or it restates something the page already says; deleting it loses nothing practical.*

`kind_i` — Choice over `fact, figure_or_date, instruction_or_step, condition_or_obligation, opinion, anecdote_or_story, filler_or_transition, promotion_or_appeal` with the descriptions in `shared/constants.ts`.

`page_kind` — Choice over `recipe, article, legal, corporate, social, product, docs, other` (first chunk only; shown in popup, stored).

### Rendering rules

- A fade is a **colour change only**: `color` transitions to a grey chosen per block for its effective background (walk ancestors to the first opaque background; pick the grey giving ≈1.6:1 contrast — about `#b9b9b9` on white, `#5c5c5c` on near-black). Links inside faded text inherit the grey and stay clickable. Nothing changes size, position or layout.
- Settle: delay `min(order × 10 ms, 500 ms)`, `550 ms ease-out`. `prefers-reduced-motion` → 120 ms, no stagger.
- Hover on a judged sentence (250 ms delay): a small chip above its first span — kind label and p(keep), e.g. `anecdote · 0.11`.
- Reveal: hold `settings.revealKey` (default **Shift**; Space is never used, it scrolls) ≥ 120 ms → root class `osso-reveal`, faded text returns to ink in 180 ms; release → fades back in 300 ms. Click on a faded sentence → pinned back for this page view.
- Threshold slider in the popup → `setThreshold` → re-render from cached probabilities, 0 ms, no inference.
- Never touched: headings, tables, `pre`/`code`, `nav`/`header`/`footer`/`aside`, forms and editable regions, `aria-hidden`, anything under 3 words, images/figures (captions are judged).

### Scope guard

Run only when all hold: `settings.enabled`; host not in `deniedHosts` (defaults in `constants.ts`: mail, docs, chat, code hosting, search, video, social feeds, localhost); API key present; ≥ 8 sentences in main content; the document is not an app (a large `contenteditable`, or inputs dominate). The reason for skipping is reported to the popup.

### Error handling

- No key → badge `!`, popup explains, page untouched.
- 401 → key marked invalid in settings; popup says so.
- 429 / 529 → exponential backoff, 3 retries; then untouched, popup shows "rate-limited".
- Timeout 20 s per request; network failure → untouched, popup shows the error.
- Chunks apply independently; a failed chunk leaves its sentences untouched. A page is never left half-broken: any exception in segment/render → `unwrapAll()`, `console.warn('[osso] …')`.

### Privacy and permissions

The key lives only in `chrome.storage.local` and is used only by the background worker; the content script never sees it. What leaves the machine: the page title, language, page-kind hint and the main text of the page, to `api.typesafe.ai` only. No URLs are sent. Permissions: `storage` and host permissions for `http(s)://*/*` (content script). No remote code.

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
