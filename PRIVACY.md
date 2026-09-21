# Privacy

Osso has no server, no account and no analytics. It is a browser extension that talks to one API, with a key that is yours.

## What leaves your browser

When Osso judges a page, it sends to `api.typesafe.ai`, over HTTPS, with your own TypeSafe key:

- the page's **title** and **language**;
- a one-line **hint of what kind of page** it is ("recipe page", "terms of service");
- the **main text** of the page, split into sentences. Navigation, forms, comments, reviews, code and tables are not part of it;
- the **rules** you typed, if any ("prices", "deadlines"), so the model can look for them.

It never sends the page's **address**, your cookies, anything you type into a page, or anything from a page Osso is switched off on. Nothing is sent anywhere else, to us or to anyone.

What TypeSafe does with a request is governed by TypeSafe's own [terms](https://typesafe.ai/legal/mca) and [privacy policy](https://typesafe.ai/legal/privacy-policy); the request is made under your account with them, not ours. As we read them on 2026-09-21: requests are processed in the United States, customer data is not used to train models without consent, and no fixed retention period is given. Read them yourself before relying on that.

## What stays in your browser

Stored with `chrome.storage.local`, on this device only:

- your **API key**. Only the extension's background worker reads it; the script that runs inside web pages never sees it;
- your **settings** and rules;
- a **cache** of past judgments, keyed by a hash of the page's text (not its address), so a page you have already read costs nothing. Options → Usage → *Clear cache* empties it;
- **usage counters** (pages, sentences, tokens, estimated cost). *Reset usage* clears them.

Removing the extension removes all of it.

## When Osso reads a page

You choose, at the welcome and any time in Options: **every page as it loads**, or **only when you open Osso on a page**. In the second mode nothing is read and nothing is sent until you ask, except on the sites you put on the *always* list yourself.

## Where Osso does not run

- **Never**, asked or not, on a page that is showing a password, card-number or one-time-code field (a sign-in, a checkout).
- **Not without asking** on a page that looks like the inside of an account: a private area in its address (`/account`, `/checkout`, `/settings`…, whole path segments only), a form asking for several personal details, or a page hidden from search engines that has a way to sign out. Osso holds back, the popup says why, and the page is read once only if you press the button. These signs are about how the page is made, never about its subject: an article about banking is read like any article.
- **Never a sentence that carries an account number**: an IBAN or card number that passes its checksum, an Italian tax code, a US social security number. Such a sentence is left out of what is sent, on every page; a page with three or more is treated as a statement and held back.
- **Off by default** on mail, documents, chat, code hosting, search, video and social sites (the list is in Options → Sites), on pages that look like an app rather than something to read, and everywhere until you have saved a key. The switch in the popup turns it off for any site.

## What these checks can and cannot do

Two things do not depend on any check, because no code exists to do them: **the page's address is never sent**, and **what you type into a page is never read** — form fields, text boxes and editors are skipped before anything is split into sentences, so their values are never part of what is sent.

Everything else on this page is a heuristic. It reads how a page is built, and it catches the shapes private pages usually have. A site built differently — a portal that draws its own login box, a message displayed like an article, a record in a format these checks do not know — can get through, and then that page's visible text is sent to TypeSafe under your key, like any other page's.

So: where the text itself is private, choose **only when I click**, or switch Osso off for that site. Osso is a reading aid for published writing, and that is the job it is built for.

## Permissions

- `storage`: the settings and the cache above.
- `activeTab`: the keyboard shortcut reads which site you are on, to turn Osso on or off for it.
- Access to `https://api.typesafe.ai/*`: the one place requests go.
- A content script on `http` and `https` pages: it reads the page's text to split it into sentences, and changes the colour of what is judged filler. It changes nothing else, and it holds no key.

## Changes

This file changes with the code, in the open, in this repository's history.

Osso is an independent open-source project. It is not affiliated with or endorsed by TypeSafe.
