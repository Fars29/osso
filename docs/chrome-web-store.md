# Chrome Web Store: the listing, and why Osso fits the policies

What to paste into the Developer Dashboard, and the reasoning behind each answer, checked against the [Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies) and the [Developer Agreement](https://developer.chrome.com/docs/webstore/program-policies/terms) on 2026-09-21. Policies change: read them again before submitting.

## Before submitting

- A developer account: one-time registration fee, **2-Step Verification** on the Google account, and a contact email that will be **public** on the listing (use an address made for it).
- A **TypeSafe key for the reviewers**, made for that purpose, with a spending limit. Osso does nothing without a key, and an extension the reviewer cannot make work is rejected as broken functionality. It goes in the dashboard's *Test instructions*, never in the package.
- The zip: `npm run build && npm run zip` → `release/osso-<version>.zip`. It is minified, not obfuscated (the policy allows minification), contains no remote code, and the source is public.
- Screenshots of **invented pages only** (the e2e fixtures), never of someone else's site or brand.

## Store listing

**Name** Osso

**Summary** (132 characters max)
Just the bone. Strikes the filler out of every page you read and leaves what you came for. Needs your own TypeSafe API key.

**Description**

> Most of what you read online is filler. Osso strikes it out, on every page, as you read, and leaves what you came for.
>
> • The life story fades; the recipe stays.
> • "We value your trust" fades; "prices go up 20% on Monday" stays.
> • Forty paragraphs of legalese fade; "renews automatically, no refunds" stays.
>
> Nothing is hidden, rewritten or summarised: the filler is still there, greyed and struck through, in the author's own words. Hold Shift and it all comes back.
>
> HOW IT WORKS
> Osso splits the main text of the page into sentences and asks Jev, a model by TypeSafe, one question about each: is this what the reader came for? Sentences that are not are faded.
>
> YOU NEED A TYPESAFE API KEY
> Osso is free and open source, and it runs on your own TypeSafe key (typesafe.ai). TypeSafe bills usage to your account: a typical page costs about $0.001, a page you have already read costs nothing. Osso does nothing until you have saved a key.
>
> WHAT IS SENT, AND WHERE
> To judge a page, Osso sends its title, its language and the words the page displays to api.typesafe.ai over HTTPS, with your key. Never the page's address, and never what you type into a page. It does not read pages showing a password or card field, and holds back to ask first on pages that look like an account area, an intranet, or a page hidden from search engines; these checks catch the usual shapes, not every one. At install you choose whether Osso reads every page as it loads or only when you click its icon. Nothing is sent to the developer or to anyone else; there is no account, no server and no analytics. Off by default on mail, documents, chat, code hosting, search, video and social sites, and one switch turns it off on any site.
>
> Source code and privacy statement: https://github.com/Fars29/osso
>
> Osso is an independent project, not affiliated with TypeSafe.

**Category** Productivity → Tools (or Accessibility). **Language** English.

## Privacy practices tab

**Single purpose**
Osso fades and strikes through the filler sentences of the web page the user is reading, so that the substantive sentences stand out.

**Permission justifications**

| permission | justification |
|---|---|
| `storage` | Stores the user's settings, their API key, and a cache of past judgments so a page already read is not judged (or billed) again. |
| `activeTab` | The keyboard shortcut (Alt+Shift+O) reads the host of the current tab to turn Osso on or off for that site. |
| host permission `https://api.typesafe.ai/*` | The one endpoint Osso calls: it sends the page's sentences there and receives a judgment for each. |
| content script on `http://*/*`, `https://*/*` | The single purpose applies to any page the user reads: the script splits the page's main text into sentences and changes the colour of the ones judged filler. It does not run on the sites in the default deny list, on pages showing a password or card field, or on app-like pages. |

**Remote code** No. All logic is in the package; the API returns JSON data (probabilities), never code.

**Data usage: what to tick**

- ☑ **Website content** (the text of the page being read is transmitted to TypeSafe to be judged).
- ☐ Personally identifiable information, health, financial, authentication, personal communications, location, web history, user activity: not collected. Osso never sends the URL, and keeps no history: the cache is keyed by a hash of the text.

**The three certifications** all hold:

- does not sell or transfer user data to third parties outside the approved use cases (the transfer to TypeSafe is *necessary to providing the single purpose*, under the user's own account with TypeSafe);
- does not use or transfer user data for purposes unrelated to the single purpose;
- does not use or transfer user data to determine creditworthiness or for lending.

**Privacy policy URL** https://github.com/Fars29/osso/blob/main/PRIVACY.md

## Test instructions (for the reviewer)

> 1. After install, a welcome page opens. Paste this key and press "Save key" (it is tested first): `<the reviewers' key>`. Leave "Every page, as it loads" selected.
> 2. Open any long article, recipe or terms-of-service page (for example a Wikipedia article). Within a second or two the filler sentences turn grey and are struck through.
> 3. Hold Shift to see everything in ink again; click the toolbar icon for the counts, the strictness slider and the per-site switch.
> The key is a limited one made for this review.

## How Osso meets each policy

| policy | how |
|---|---|
| Single purpose, minimum functionality | One narrow purpose; works on any page of prose. |
| Privacy policy | `PRIVACY.md`, linked in the dashboard and from Options → About. Names the one party data is shared with (TypeSafe). |
| Limited Use | Page text goes only to TypeSafe and only to provide the feature. No ads, no brokers, no analytics, no human reads it on our side: we never receive it. |
| Web browsing activity | Used only for the user-facing feature, which is described in the listing and in the UI: the welcome page says what is sent next to the Save button, and asks the user to choose between reading every page and reading only on a click. Nothing is sent before the user saves a key; in click mode nothing is sent before the user opens Osso on that page. |
| Sensitive pages | Does not run on a page showing a password, card or one-time-code field. Held back, with the reason shown and a one-time override, on pages that look like an account area (private path segment, personal-details form, a host only reachable inside a network, `noindex`, several validated account numbers). Sentences carrying a validated IBAN or card number, a tax code or an SSN are left out of what is sent. Form values are never read at all (`input`, `textarea`, `select` are skipped by the segmenter), and the URL is never transmitted. The listing and the extension both state that the page checks are heuristics rather than guarantees. |
| Secure handling | HTTPS only; the key lives in `chrome.storage.local` and only the background worker reads it; the script inside pages never sees it. |
| Narrowest permissions | `storage`, `activeTab`, one API host. No `tabs`, no `scripting`, no `<all_urls>` host permission, no `unlimitedStorage`. |
| Remotely hosted code, obfuscation | None. Minified by esbuild; source public. |
| Misleading behaviour | Nothing is hidden or rewritten; every change is a colour and a line, reversible with one key; the listing says a paid third-party key is required. |
| Payments | Osso takes no payment. The requirement of a paid third-party key is stated in the summary and the description. |
| Developer Agreement: third parties' terms | Osso calls TypeSafe's public API with the user's own key. TypeSafe's Master Customer Agreement (read 2026-09-21, last updated 2026-09-19) lets a customer include the API in software for its end users (2.2) and forbids offering the Services "as a standalone service" (2.3a): with a key of their own each user is TypeSafe's customer, and Osso resells nothing. It also forbids using the Output to distil or train an imitating model (2.3b): Osso must never be used to label data for a local replacement. Not settled: which agreement governs a self-serve account, and TypeSafe's own guidance says to keep credentials server-side in web apps; an extension's background worker holding the user's own key is a different case, but ask them if in doubt. |

## What can still get it bounced

- **Broad host access** puts every such extension through a longer, manual review (days, sometimes weeks). Expected, not a rejection.
- A reviewer who cannot make it work: hence the reviewers' key and the test instructions.
- A listing that does not say, up front, that a paid key is needed.
