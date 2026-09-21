# Development

Node 20 or newer. TypeScript strict, no frameworks, no runtime dependencies: vanilla DOM and `fetch`. The key for the live scripts goes in `.env` as `TYPESAFE_API_KEY` (see `.env.example`).

| command | what it does |
|---|---|
| `npm run build` | esbuild → `dist/` |
| `npm run dev` | build and watch |
| `npm test` | vitest, jsdom, mocked `chrome.*`; never calls the API |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run e2e` | Playwright loads `dist/` into Chromium against the live API; screenshots in `e2e/screenshots/` |
| `npm run calibrate` | the probe behind `docs/calibration.md`; live API, about a quarter of a cent |
| `node --env-file=.env e2e/screens.mjs --docs` | every screen as a picture; `--docs` refreshes `docs/screenshots/` |
| `node --env-file=.env e2e/review.mjs <url…> [--kept]` | what Osso did to a real page, sentence by sentence: p(keep), kind, grey or ink; the tool for judging the judgments |
| `node --env-file=.env e2e/sites.mjs [url…]` | Osso on real pages: what it did on each and why (the tool for "it does nothing on site X") |
| `node --env-file=.env e2e/dump.mjs <url…>` then `npm run context` | what should the model see beside the sentence? Replays real pages with different states and prints every decision that changes |
| `npm run icons` | `icons/icon.svg` → the PNG sizes |
| `npm run zip` | `dist/` → `release/osso-<version>.zip` |

## Layout

`src/shared/` (types and constants, the contracts), `src/content/` (segment, render, orchestrator: runs inside the page), `src/background/` (settings, cache, api: the only code that holds the key), `src/packs/` (page kinds), `src/ui/` (popup and options), `test/`, `e2e/`, `scripts/`.

## Page kinds

Page kinds live in `src/packs/`, one file each (recipe, article, paper, legal, corporate, product, docs, social). A pack is an id, a `stateHint` sent to the model, optional one-sentence hints appended to the keep criteria, and a `match(meta)` score computed from JSON-LD, URL, `og:type`, title and a text sample. To add one: copy `recipe.ts`, add the id to `PageKind` in `src/shared/types.ts` and its label in `PAGE_KINDS`, and add the pack to `PACKS` in `src/packs/index.ts`. Routing only tunes wording; a wrong pack still gets a good answer.

Whatever is sent to the model is written in English (`test/prompts.test.ts` holds that line).

## Releases and CI

The version lives in `package.json`; `scripts/sync-version.mjs` writes it to the manifest and the Options page.

```
npm version patch        # or minor / major: bumps, syncs, commits, tags vX.Y.Z
git push --follow-tags   # the tag starts the release
```

- `.github/workflows/ci.yml` runs on every push and pull request: version check, types, unit tests, build, and the zip as a downloadable artifact (kept 14 days), so any commit can be loaded unpacked and tried.
- `.github/workflows/release.yml` runs on a `v*` tag: the same checks, then a GitHub release with `osso-<version>.zip` attached and notes generated from the commits. A tag that disagrees with `package.json` publishes nothing.

Neither calls the API, so no secret is needed. The live end-to-end run stays local (`npm run e2e`), where the key is.

## Firefox

The manifest carries a `gecko` id for Firefox 128+, but it is untested there and the background worker may need to become an event page.
