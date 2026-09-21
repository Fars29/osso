# Privacy

Osso has no server, no account and no analytics. It is a browser extension that talks to one API, with a key that is yours.

## What leaves your browser

When Osso judges a page, it sends to `api.typesafe.ai`, over HTTPS, with your own TypeSafe key:

- the page's **title** and **language**;
- a one-line **hint of what kind of page** it is ("recipe page", "terms of service");
- the **main text** of the page, split into sentences. Navigation, forms, comments, reviews, code and tables are not part of it;
- the **rules** you typed, if any ("prices", "deadlines"), so the model can look for them.

It never sends the page's **address**, your cookies, anything you type into a page, or anything from a page Osso is switched off on. Nothing is sent anywhere else, to us or to anyone.

What TypeSafe does with a request is governed by [TypeSafe's own terms and privacy policy](https://typesafe.ai); the request is made under your account with them, not ours.

## What stays in your browser

Stored with `chrome.storage.local`, on this device only:

- your **API key**. Only the extension's background worker reads it; the script that runs inside web pages never sees it;
- your **settings** and rules;
- a **cache** of past judgments, keyed by a hash of the page's text (not its address), so a page you have already read costs nothing. Options → Usage → *Clear cache* empties it;
- **usage counters** (pages, sentences, tokens, estimated cost). *Reset usage* clears them.

Removing the extension removes all of it.

## Where Osso does not run

By default it stays off on mail, documents, chat, code hosting, search, video and social sites (the list is in Options → Sites), on pages that look like an app rather than something to read, and everywhere until you have saved a key. The switch in the popup turns it off for any site.

## Permissions

- `storage`, `unlimitedStorage`: the settings and the cache above.
- `activeTab`: the popup talks to the page you are on.
- Access to `https://api.typesafe.ai/*`: the one place requests go.
- A content script on `http` and `https` pages: it reads the page's text to split it into sentences, and changes the colour of what is judged filler. It changes nothing else, and it holds no key.

## Changes

This file changes with the code, in the open, in this repository's history.

Osso is an independent open-source project. It is not affiliated with or endorsed by TypeSafe.
