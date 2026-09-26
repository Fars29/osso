# Privacy

Osso has no server, no account and no analytics. Page text goes to one place, TypeSafe, under your own key, and nowhere else.

## What is sent

When Osso reads a page, it sends to `api.typesafe.ai`, over HTTPS:

- the page's title and language, and a short hint of what kind of page it is ("recipe", "terms of service");
- the page's main text, sentence by sentence;
- the rules and highlight terms you typed.

Two things are never sent, whatever the page, because Osso has no code that could send them: **the page's address**, and **anything you type into a page** (form fields and editors are skipped before any text is read).

What TypeSafe does with a request is set by its own [terms](https://typesafe.ai/legal/mca) and [privacy policy](https://typesafe.ai/legal/privacy-policy), under your account with them. As we read them on 2026-09-21: requests are processed in the United States, customer data is not used for training without consent, and no retention period is stated. Check them yourself.

Page text is used for one thing only: judging the page for you. It is not sold, not used for advertising or for credit or lending decisions, and nobody on our side reads it, since it never reaches us. This complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies), including the Limited Use requirements.

## What stays on your computer

In the browser's storage, on this device only: your key (the script that runs inside web pages never receives it), your settings, a cache of past answers (a score per sentence, filed under a fingerprint of the text, without the text or the address), and usage counters. Options clears the cache and the counters; removing the extension removes all of it.

## When Osso reads a page

Never before you agree. The welcome, and Options, say what is sent above the key field, and only the button that says *Agree* saves the key. Then you choose, at the welcome or any time in Options:

- **Every page, as it loads.** Pages arrive already stripped. This relies on the checks below to leave private pages alone.
- **Only when I click.** Nothing is sent until you open Osso on a page, except on sites you have marked *always*.

## What Osso tries to leave alone

It looks at how a page is built, never at what it talks about:

- a page showing a **password, card or one-time-code field** is not read, even if you ask;
- a page that looks like the **inside of an account or a company network** (an address like `/account` or `/checkout`, a form asking for your personal details, a page hidden from search engines, an intranet address) is held back until you press *Read this page once*;
- a sentence with an **IBAN, a card number, an Italian tax code or a US social security number** is left out, and a page with three or more is held back;
- a **list of well-known sites** (Gmail, Outlook, Google Docs, Slack, GitHub, the main search engines, video and social sites, and a few more) stays off until you turn it on. The list is in Options → Sites.

**These checks can miss.** They catch the shapes private pages usually have, not every one. A site is recognised by name only if it is on the list: any other webmail, bank or work tool is read like any page unless a check above catches it, and then its text is sent. If you open private things in this browser, choose **Only when I click**, or switch Osso off on those sites from the popup.

## Permissions

- `storage`: the settings and the cache above.
- `activeTab`: the shortcut (Alt+Shift+O) reads which site you are on, to switch Osso on or off there.
- `https://api.typesafe.ai/*`: the one place requests go.
- A content script on `http` and `https` pages: it reads the page's text and colours what it judges filler. It changes nothing else.

---

Osso is an independent open-source project, not affiliated with or endorsed by TypeSafe. This file changes with the code, in this repository's history.
