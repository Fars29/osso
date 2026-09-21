# Osso

**Just the bone.**

![Osso striking the filler out of a recipe, a company statement and a terms page](docs/demo.gif)

Most of what you read online is filler. Osso is a browser extension that strikes it out, on every page, as you read, and leaves what you came for.

- The life story fades; **the recipe stays**.
- "We value your trust" fades; **"prices go up 20% on Monday" stays**.
- Forty paragraphs of legalese fade; **"renews automatically, no refunds" stays**.

Nothing is hidden, rewritten or summarised. The filler is still there, greyed and struck through, in the author's own words. Hold **Shift** and it all comes back.

## Why

Everything we read every day is padded: the story before the recipe, the apology before the price rise, the thanks, the teasers, the "as always, we're here for you". I only ever wanted the part that matters.

[Jev](https://docs.typesafe.ai) made that possible. Jev is a model by TypeSafe that does not chat: you ask it a question and it answers with a judgment, a yes or a no with a probability. It is fast and cheap enough to ask about *every single sentence* of a page: **"is this what the reader came for?"** Thirty sentences come back in about half a second, a whole article in a second or two, for about a tenth of a cent.

So Osso asks, sentence by sentence, and strikes out the rest. Read what matters. Skip the rest.

## Install

Chrome, Edge or Brave. Two minutes, no store listing yet.

1. Download the [latest release](https://github.com/Fars29/osso/releases/latest) zip and unpack it.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the folder.
3. Osso opens a welcome page: paste your [TypeSafe key](https://typesafe.ai), then choose when it should read a page: **every page as it loads**, or **only when you click its icon**.

That's it. Open any article.

**Your key, your data.** Osso is free and open source, and runs on your own key, so there is no account, no server and no tracking. The page's title and main text go to `api.typesafe.ai` and nowhere else; never the URL. The key stays in your browser. A typical page costs about $0.001, a page you have already read is free, and a page too long to be worth it (over 1,200 sentences) is only judged from the top down to that mark. The whole of it, in plain words: [PRIVACY.md](PRIVACY.md).

## Using it

If you chose *every page*, there is nothing to press: pages arrive already stripped. If you chose *only when I click*, open Osso on a page and it starts; its switch then reads *Always on this site*, for the sites you trust.

| | |
|---|---|
| **Hold Shift** | Everything comes back to ink. Let go and it fades again. |
| **Hover** a struck sentence | One word says why: *story*, *promo*, *opinion*, *filler*, *aside*. |
| **Click** a struck sentence | Pins it back for this visit. |
| **The slider** in the popup | How strict, from gentle to bare. Instant, no new request. |
| **Rules** in the popup | Type what you always want to keep, in your own words (*prices*, *deadlines*, *allergens*) and those sentences stay in ink on every page. |
| **On this site** | Turns Osso off for a site. **Alt+Shift+O** does the same. |

![The popup after a page is judged](docs/screenshots/popup-done.png)

Osso stays out of the way where the page is your workspace rather than someone's writing (mail, docs, chat, code, search, video, social feeds), and it leaves reviews and comments alone: there, the opinion is the point.

**Private pages.** Osso does not read a page that shows a password or card field. On a page that looks like the inside of an account (its address, a form asking for your details, an intranet host, a page its site hides from search engines) it holds back, tells you why, and reads it only if you say so. It decides by how a page is built, never by what it talks about: an article about banks is an article. A sentence carrying an IBAN, a card number or a tax code is left out of what is sent.

These checks catch the shapes private pages usually have, not every one: a site built differently can slip through, and then its text is sent like any other page's. What does not depend on them: **the page's address is never sent, and neither is anything you type into a page**. Osso reads the words a page displays, not the values in its fields. Where the text itself is private, use *only when I click*, or switch Osso off for that site.

![A rule bringing the sponsor's discount code back to ink](docs/screenshots/page-rule.png)

## How it decides

The page's main text is split into sentences; headings, lists' labels, tables, code and navigation are never touched. Each sentence goes to Jev with its neighbours as context, and comes back with the probability that it carries what the reader came for. Below the slider, it fades. Each batch is painted the moment it arrives, and what is further down waits until you scroll to it, so you see it go.

On 99 hand-labelled sentences in English and Italian the question separates substance from filler with an AUC of 0.998. The question itself, the numbers and what we learned on real pages: [how it works](docs/how-it-works.md) · [calibration](docs/calibration.md).

## Honest limits

- It is a judgment, not a guarantee. Sometimes it will strike a sentence you needed. It is still there and still readable: hold Shift when it matters.
- The privacy checks are heuristics. They read how a page is built, and a page built unusually can get through them; on a page whose text is itself private, that text would be sent to TypeSafe under your key. Run in *click* mode, or switch Osso off, where that matters.
- Pages with very little text, or built from unusual markup, may be skipped. The popup says why.
- The requests are made with your key, so the cost is yours. Options keeps a running total.
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
