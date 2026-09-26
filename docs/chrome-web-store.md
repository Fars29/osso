# Chrome Web Store: the listing, and why Osso fits the policies

What to paste into the Developer Dashboard, and the reasoning behind each answer, checked against the [Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies) and the [Developer Agreement](https://developer.chrome.com/docs/webstore/program-policies/terms) on 2026-09-21, and again in full, with the update enforced since 2026-08-01, on 2026-09-27. Policies change: read them again before submitting.

## Before submitting

- A developer account: one-time registration fee, **2-Step Verification** on the Google account, a **verified** contact email that will be **public** on the listing (use an address made for it), a publisher name, and the **trader declaration** (free, non-commercial, from an individual: non-trader).
- **The repository public.** The privacy policy URL and the listing's source link must open for the reviewers.
- **No TypeSafe key for the reviewers.** TypeSafe's Master Customer Agreement makes API keys confidential credentials, not to be shared outside one's own staff (sections 2.4 and 14), and Google's Developer Agreement asks not to knowingly break a third party's terms. The test instructions below say why there is no key and show what Osso does; the extension itself says plainly that it needs one.
- The zip: the one attached to the version's GitHub release (`release.yml`), or `npm run build && npm run zip` → `release/osso-<version>.zip`. It is minified, not obfuscated (the policy allows minification), contains no remote code, and the source is public.
- Screenshots of **invented pages only** (the e2e fixtures), never of someone else's site or brand.

## Store listing

**Name** Osso

**Summary** comes from the manifest's `description` and cannot be edited in the dashboard; over 132 characters, the upload is refused:
Just the bone. Strikes the filler out of every page you read and leaves what you came for. Needs your own paid TypeSafe API key.

**Description**

> Most of what you read online is filler. Osso strikes it out, on every page, as you read, and leaves what you came for.
>
> • The life story fades; the recipe stays.
> • "We value your trust" fades; "prices go up 20% on Monday" stays.
> • Forty paragraphs of legalese fade; "renews automatically, no refunds" stays.
>
> Nothing is hidden, rewritten or summarised: the filler is still there, greyed and struck through, in the author's own words. Hold Shift and it all comes back.
>
> KEEP AND HIGHLIGHT
> Type what you always want kept (prices, deadlines, allergens) and it stays in ink on every page. Type what you want marked (candidate names, ingredients, consequences) and Osso highlights it, like a marker drawn as you read.
>
> HOW IT WORKS
> Osso splits the main text of the page into sentences and asks Jev, a model by TypeSafe, one question about each: is this what the reader came for? Sentences that are not are faded.
>
> YOU NEED A TYPESAFE API KEY
> Osso is free and open source, and it runs on your own TypeSafe key (typesafe.ai). TypeSafe bills usage to your account: a typical page costs about $0.001, a page you have read recently costs nothing. Osso does nothing until you have saved a key.
>
> WHAT IS SENT, AND WHERE
> To judge a page, Osso sends its title, its language and the words the page displays, with any words you ask it to keep or highlight, to api.typesafe.ai over HTTPS, with your key. Your key is kept in your browser and sent only to TypeSafe, with each request. Never the page's address, and never what you type into a page. Nothing is sent before you agree to it, with the button that saves your key. It does not read pages showing a password or card field, and holds back to ask first on pages that look like an account area, an intranet, or a page hidden from search engines; these checks catch the usual shapes, not every one. When you add your key, you choose whether Osso reads every page as it loads or only when you click its icon. Nothing is sent to the developer or to anyone else; there is no account with us, no server and no analytics. Off by default on a list of well-known mail, document, chat, code, search, video and social sites (editable; other sites are not recognised by name), and one switch turns it off on any site. Where the text itself is private, choose "only when I click".
>
> Source code and privacy statement: https://github.com/Fars29/osso
>
> Osso is an independent project, not affiliated with TypeSafe.

**Category** Productivity → Tools. **Language** English. **Homepage URL** https://github.com/Fars29/osso. **Support URL** https://github.com/Fars29/osso/issues.

**Images**, in [docs/store/](store/) (made from the film's invented pages, with the shipped renderer and popup):

- Screenshots, 1280 x 800: `1-recipe.png`, `2-statement.png`, `3-terms-popup.png`, `4-terms-red-flags.png`.
- Small promo tile, 440 x 280 (required): `promo-small-440x280.png`.
- Marquee, 1400 x 560 (optional): `promo-marquee-1400x560.png`.
- Icon, 128 x 128: `icons/128.png`, already in the package.

## Privacy practices tab

**Single purpose**
Osso fades and strikes through the filler sentences of the web page the user is reading, so that the substantive sentences stand out; the user can also name things to always keep in ink, or to highlight, on that page.

**Permission justifications**

| permission | justification |
|---|---|
| `storage` | Stores the user's settings, their API key, and a cache of past judgments so a page already read is not judged (or billed) again. |
| `activeTab` | When the user opens the popup or presses the shortcut (Alt+Shift+O), Osso reads which site the current tab is on, to show and switch its state for that site. The address is never sent. |
| host permission `https://api.typesafe.ai/*` | The one endpoint Osso calls: it sends the page's sentences there and receives a judgment for each. |
| content script on `http://*/*`, `https://*/*` | The single purpose applies to any page the user reads: the script splits the page's main text into sentences and changes the colour of the ones judged filler. On the sites in the default deny list, on pages showing a password or card field and on app-like pages it reads nothing and changes nothing; with no key saved, it reads nothing anywhere. |

**Remote code** No. All logic is in the package; the API returns JSON data (probabilities), never code.

**Data usage: what to tick**

- ☑ **Website content** (the text of the page being read is transmitted to TypeSafe to be judged).
- ☑ **Web history** (the title of each page read goes with its text, and the form counts a visited page's title as web history; the address is never sent, and Osso keeps no history: the cache is keyed by a hash of the text).
- ☑ **Authentication information** (the user's TypeSafe API key: kept in the browser, sent only to TypeSafe, with each request).
- ☑ **Personal communications** and ☑ **Financial and payment information**: Osso stays off well-known mail sites, leaves card numbers and IBANs out and holds back pages that look like the inside of an account, but PRIVACY.md says plainly that a page these checks miss is read like any other. The form should not say less than the privacy policy.
- ☐ Personally identifiable information, health, location, user activity: not collected (clicks, hovers and the reveal key are handled on the page, never stored or sent).

**The three certifications** all hold:

- does not sell or transfer user data to third parties outside the approved use cases (the transfer to TypeSafe is *necessary to providing the single purpose*, under the user's own account with TypeSafe);
- does not use or transfer user data for purposes unrelated to the single purpose;
- does not use or transfer user data to determine creditworthiness or for lending.

**Privacy policy URL** https://github.com/Fars29/osso/blob/main/PRIVACY.md

## Test instructions (for the reviewer)

In *Additional instructions* (500 characters at most; no username or password):

> Osso needs the user's own TypeSafe API key (typesafe.ai, a paid third-party service). TypeSafe's terms do not let us share ours, so no key is included. Without one, Osso reads nothing and says so: the popup shows "Osso needs your TypeSafe key" and the welcome page asks for one. What it does with a key is shown at the top of https://github.com/Fars29/osso, filmed with Osso's own renderer and popup. With a key: paste it on the welcome page, press "Agree and save key", open any article.

## How Osso meets each policy

| policy | how |
|---|---|
| Single purpose, minimum functionality | One narrow purpose; works on any page of prose. Without a key it reads nothing and says so, in the popup, on the welcome page and in Options: it never fails silently. |
| Privacy policy | `PRIVACY.md`, linked in the dashboard and from Options → About. Names the one party data is shared with (TypeSafe). |
| Limited Use | Page text goes only to TypeSafe and only to provide the feature. No ads, no brokers, no analytics, no human reads it on our side: we never receive it. PRIVACY.md says so, with the Limited Use statement, one click from the repository's page. |
| Web browsing activity | Used only for the user-facing feature, which is described in the listing and in the UI. Consent comes first: the welcome page (and Options) says what is sent above the key field, and the only button that saves the key reads "Agree and save key"; Enter in the field does not save. Nothing is sent before that button is pressed. The welcome then asks the user to choose between reading every page and reading only on a click; in click mode nothing is sent before the user opens Osso on that page. |
| Sensitive pages | Does not run on a page showing a password, card or one-time-code field. Held back, with the reason shown and a one-time override, on pages that look like an account area (private path segment, personal-details form, a host only reachable inside a network, `noindex`, several validated account numbers). Sentences carrying a validated IBAN or card number, a tax code or an SSN are left out of what is sent. Form values are never read at all (`input`, `textarea`, `select` are skipped by the segmenter), and the URL is never transmitted. The listing and the extension both state that the page checks are heuristics rather than guarantees. |
| Secure handling | HTTPS only; the key lives in `chrome.storage.local` and only the background worker reads it; the script inside pages never sees it. |
| Narrowest permissions | `storage`, `activeTab`, one API host. No `tabs`, no `scripting`, no `<all_urls>` host permission, no `unlimitedStorage`. |
| Remotely hosted code, obfuscation | None. Minified by esbuild; source public. |
| Misleading behaviour | Nothing is hidden or rewritten; every change is a colour and a line, reversible with one key; the listing says a paid third-party key is required. |
| Payments | Osso takes no payment. The requirement of a paid third-party key is stated in the summary and the description. |
| Developer Agreement: third parties' terms | Osso calls TypeSafe's public API with the user's own key. TypeSafe's Master Customer Agreement (read 2026-09-21, last updated 2026-09-19) lets a customer include the API in software for its end users (2.2) and forbids offering the Services "as a standalone service" (2.3a): with a key of their own each user is TypeSafe's customer, and Osso resells nothing. It also forbids using the Output to distil or train an imitating model (2.3b): Osso must never be used to label data for a local replacement. It makes API keys confidential credentials (2.4, 14), hence no key for the reviewers. TypeSafe's SDK warns against exposing a key in web pages; Osso keeps each user's own key in the background worker, where pages never see it. |
| Changes to what is sent | Any future change to what leaves the browser is announced inside the extension, and agreed to again, before it applies. |

## What can still get it bounced

- **Broad host access** puts every such extension through a longer, manual review (days, sometimes weeks). Expected, not a rejection.
- **A reviewer who cannot see it work** may reject it as "not providing promised functionality" (Yellow Magnesium). The test instructions and the explicit no-key state are the answer; if it happens anyway, reply through the appeal with the same explanation.
- **A manifest description over 132 characters**: the upload itself is refused, since it is the store summary.
- A listing that does not say, up front, that a paid key is needed.
