# Osso

**Just the bone.**

![Osso striking the filler out of a recipe, a company statement and a terms page](docs/demo.gif)

Most of what you read online is filler. Osso is a browser extension that strikes it out, on every page, as you read, and leaves what you came for.

- The life story fades; **the recipe stays**.
- "We value your trust" fades; **"prices go up 20% on Monday" stays**.
- Forty paragraphs of legalese fade; **"renews automatically, no refunds" stays**.

Nothing is hidden, rewritten or summarised: the filler is still there, greyed and struck through, in the author's own words. Hold **Shift** and it all comes back.

## Why

[Jev](https://docs.typesafe.ai) is a model by TypeSafe that does not chat. You ask it a question and it answers with a yes or a no and a probability. It is fast and cheap enough to ask about *every single sentence* of a page: **"is this what the reader came for?"** A whole article answers in a second or two, for about a tenth of a cent.

So Osso asks, sentence by sentence, and strikes out the rest.

## Install

Chrome, Edge or Brave. Two minutes.

1. Download the [latest release](https://github.com/Fars29/osso/releases/latest) and unpack it.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick the folder.
3. Paste your [TypeSafe key](https://typesafe.ai) into the welcome page, and choose when Osso reads: **every page as it loads**, or **only when you click**.

Free and open source, and it runs on a key of your own: no account, no server, no tracking. A page costs about $0.001 and one you have read before is free. What is sent and what never is: [PRIVACY.md](PRIVACY.md).

## Using it

| | |
|---|---|
| **Hold Shift** | Everything comes back to ink. |
| **Hover** a struck sentence | One word says why: *story*, *promo*, *opinion*, *filler*, *aside*. |
| **Click** a struck sentence | Pins it back for this visit. |
| **The slider** | How strict, from gentle to bare. Instant, no new request. |
| **keep …** | What to always keep, in your own words: *prices*, *deadlines*, *allergens*. |
| **highlight …** | What to mark, in your own words: *candidate names*, *ingredients*, *dates*. Osso finds them and paints them, and never strikes a sentence it marked. |
| **On this site** | Turns Osso off for a site. **Alt+Shift+O** does the same. |

![The popup after a page is judged](docs/screenshots/popup-done.png)

The marker's colour and the colour of struck text are both yours, in Options.

Osso stays out of the way where a page is your workspace rather than someone's writing (mail, documents, chat, code, search, video, social feeds), and leaves reviews and comments alone: there the opinion is the point. It never reads a page showing a password or card field, and holds back to ask first on anything that looks like the inside of an account. Those checks read how a page is built, never what it is about: an article about banks is an article.

![A rule bringing the sponsor's discount code back to ink](docs/screenshots/page-rule.png)

## How it decides

The page's main text is split into sentences; headings, labels, tables, code and navigation are never touched. Each sentence goes to Jev with its neighbours as context and comes back with the probability that it carries what the reader came for. Below the slider, it fades. Each batch is painted as it arrives, and what is further down waits until you scroll to it, so you watch it go.

A highlight is the same question twice: which sentences mention the thing, and then, inside those, which words are it.

On 99 hand-labelled sentences in English and Italian the question separates substance from filler with an AUC of 0.998. The question itself, the numbers, and what real pages taught us: [how it works](docs/how-it-works.md) · [calibration](docs/calibration.md).

## Honest limits

- It is a judgment, not a guarantee. Sometimes it strikes a sentence you needed. It is still there and still readable: hold Shift.
- The privacy checks are heuristics. A page built unusually can get through them, and then its text is sent like any other page's. Two things do not depend on them, because no code exists to do otherwise: **the page's address is never sent, and neither is anything you type into a page.**
- Pages with very little text, or with unusual markup, may be skipped. The popup says why.
- The cost is yours, because the key is. Options keeps a running total.
- Firefox is untested.

## Development

```
npm install
npm run build     # → dist/
npm test          # unit tests, never call the API
```

TypeScript, no frameworks, no runtime dependencies. Everything else (the live end-to-end run, the tools for judging the judgments on real pages, how to add a page kind, how releases are cut) is in [docs/development.md](docs/development.md).

## License

GPL-3.0. Osso is an independent project, not affiliated with or endorsed by TypeSafe.
