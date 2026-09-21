/**
 * Is this page between the reader and a site, rather than something published to be read? Osso sends
 * the text of a page to a model, so it has to know, and it has to know without guessing from what
 * the page talks about: an article on banking says "bank" forty times and is an article. Every sign
 * here is about how the page is made (what it asks the reader to type, where it lives, whether it is
 * meant to be found) or about the data in it (an account number that validates), never about its
 * subject.
 *
 * None of this is a guarantee, and nothing that says otherwise should be written about it. These are
 * the marks private pages usually carry, and a page can carry none of them and still be the reader's
 * own: a portal that renders its own login widget out of divs, a message shown as an article, a
 * statement whose numbers are in a format nothing here knows. What Osso can promise is structural
 * and lives elsewhere: the page's address is never sent (background/api.ts never puts it in a
 * request), and what the reader types into a page is never read (SKIP_TAGS in segment.ts covers
 * input, textarea, select, button and label, so form values are not text nodes we ever walk). The
 * rest is this file doing its best, and the reader choosing "only when I click" where that matters.
 *
 *   never  what it shows is a secret being typed: a password, a card number, a one-time code.
 *          Osso does not run there, asked or not.
 *   ask    it looks like a private area (an account path, a form for personal details, a page no
 *          search engine is allowed to keep, a host that only exists inside a network). Osso holds
 *          back and says why; the reader can run it on that page once. These signs can be wrong in
 *          both directions, so they are never a wall.
 *
 * And below the page, the sentence: one that carries an account number is never sent, on any page.
 */
import { isPrivatePage } from "./segment.ts";

export type Privacy = { level: "never" | "ask"; reason: string } | null;

/**
 * Whole segments of a path that name an area behind a sign-in. Whole segments only: "/account" is
 * one, "/news/bank-account-fees-rise" is not. Words that also name things people write about
 * (bank, profile, security, health, money), or a section of a site (console, mail, statements,
 * transactions), are left out on purpose.
 */
const PRIVATE_SEGMENTS = new Set([
  "account", "accounts", "my-account", "myaccount", "my_account", "mein-konto", "mon-compte", "area-riservata", "area-personale", "mi-cuenta",
  "login", "log-in", "signin", "sign-in", "signup", "sign-up", "register", "registration", "auth", "oauth", "oauth2", "sso", "saml", "password", "reset-password", "2fa", "mfa", "accedi", "registrati",
  "checkout", "cart", "basket", "carrello", "cassa", "panier", "warenkorb", "payment", "payments", "billing", "invoice", "invoices", "fatture", "orders", "order-history", "ordini", "wallet", "subscriptions",
  "dashboard", "admin", "wp-admin", "settings", "preferences", "impostazioni", "inbox", "messages", "webmail", "movimenti", "estratto-conto",
]);

/** `autocomplete` values that ask for something about the reader. One is a newsletter box; several are a form about them. */
const PERSONAL_AUTOCOMPLETE = /^(name|given-name|additional-name|family-name|honorific-prefix|nickname|email|tel|tel-national|street-address|address-line[123]|address-level[1234]|postal-code|country|country-name|bday|bday-day|bday-month|bday-year|sex|organization|username)$/;
const PERSONAL_FIELDS_FOR_A_FORM = 3;

const SIGN_OUT = /^(log ?out|sign ?out|esci|disconnetti|disconnettiti|abmelden|ausloggen|déconnexion|se déconnecter|cerrar sesión|salir|sair|uitloggen|afmelden)$/i;

/** How many sentences with an account number make the page a statement rather than a page that quotes one. */
export const ACCOUNT_NUMBERS_FOR_A_STATEMENT = 3;

function shown(el: Element, laidOut: boolean): boolean {
  return !laidOut || el.getClientRects().length > 0;
}

function personalForm(doc: Document, laidOut: boolean): boolean {
  let n = 0;
  for (const input of Array.from(doc.querySelectorAll("input[autocomplete], select[autocomplete], textarea[autocomplete]"))) {
    const tokens = (input.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/);
    if (!tokens.some((t) => PERSONAL_AUTOCOMPLETE.test(t))) continue;
    if (shown(input, laidOut) && ++n >= PERSONAL_FIELDS_FOR_A_FORM) return true;
  }
  return false;
}

/**
 * A page its own site tells search engines not to keep. Published writing does not do this: of twelve
 * live articles, recipes, papers and policy pages checked on 2026-09-21, none carried noindex (the
 * one that did was a 403 bot wall). Account areas, intranets, webmail and admin screens carry it
 * almost by habit, so on its own it is worth holding back for.
 */
function unlisted(doc: Document): boolean {
  return Array.from(doc.querySelectorAll('meta[name="robots" i], meta[name="googlebot" i]')).some((m) => /noindex/i.test(m.getAttribute("content") ?? ""));
}

/** A way to sign out, visible on the page: not enough on its own (a news site a subscriber is logged into has one), but it says the reader is inside something. */
function hasSignOut(doc: Document, laidOut: boolean): boolean {
  for (const el of Array.from(doc.querySelectorAll("a, button"))) {
    const label = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (label.length <= 24 && SIGN_OUT.test(label) && shown(el, laidOut)) return true;
    const href = el.getAttribute("href") ?? "";
    if (/(^|[/?&=_-])(logout|log-out|signout|sign-out)([/?&=_.-]|$)/i.test(href) && shown(el, laidOut)) return true;
  }
  return false;
}

/**
 * A host that only exists inside a network: an intranet, an appliance, a server on the desk. Nothing
 * there was published, and much of it is somebody's records. Loopback is left out: it is a
 * developer's own machine, Osso already skips it by default, and turning it on there is deliberate.
 */
const PRIVATE_SUFFIX = /\.(local|internal|lan|intranet|corp|private|home\.arpa)$/i;
function privateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h.startsWith("127.")) return false;
  if (!h.includes(".") && !h.includes(":")) return true;
  if (PRIVATE_SUFFIX.test(h)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  return /^(f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i.test(h);
}

function privatePath(pathname: string): string | null {
  for (const raw of pathname.split("/")) {
    const segment = raw.toLowerCase().replace(/\.(html?|php|aspx?|jsp)$/, "");
    if (PRIVATE_SEGMENTS.has(segment)) return segment;
  }
  return null;
}

export function assessPrivacy(doc: Document, url: { hostname: string; pathname: string }): Privacy {
  if (isPrivatePage(doc)) return { level: "never", reason: "sign-in or payment page" };
  const laidOut = (doc.body?.getClientRects().length ?? 0) > 0;
  if (privateHost(url.hostname)) return { level: "ask", reason: "private-host" };
  const segment = privatePath(url.pathname);
  if (segment) return { level: "ask", reason: `private-path:${segment}` };
  if (personalForm(doc, laidOut)) return { level: "ask", reason: "personal-form" };
  if (unlisted(doc)) return { level: "ask", reason: hasSignOut(doc, laidOut) ? "signed-in" : "unlisted" };
  return null;
}

// ---- the sentence -----------------------------------------------------------------------------

const IBAN = /\b([A-Z]{2}\d{2})((?:[ \u00a0]?[A-Z0-9]{4}){2,7}(?:[ \u00a0]?[A-Z0-9]{1,4})?)\b/g;
/** 13 to 19 digits in groups, starting the way card numbers do (2–6): an ISBN-13 starts 97 and a phone number rarely runs this long. */
const CARD = /(?<![\d-])([2-6]\d{3}(?:[ -]?\d{2,6}){2,4})(?![\d-])/g;
const ITALIAN_TAX_CODE = /\b[A-Z]{6}\d{2}[A-EHLMPRST]\d{2}[A-Z]\d{3}[A-Z]\b/;
const US_SSN = /(?<![\d-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/;

function ibanIsValid(candidate: string): boolean {
  const s = candidate.replace(/[ \u00a0]/g, "");
  if (s.length < 15 || s.length > 34) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of moved) {
    const value = ch >= "A" ? ch.charCodeAt(0) - 55 : Number(ch);
    remainder = (value > 9 ? remainder * 100 + value : remainder * 10 + value) % 97;
  }
  return remainder === 1;
}

function luhnIsValid(candidate: string): boolean {
  const digits = candidate.replace(/[ -]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1 && (d *= 2) > 9) d -= 9;
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * Whether the sentence carries a number that identifies an account or a person: an IBAN or a card
 * number that passes its checksum, a tax code, a social security number. Such a sentence is never
 * sent to the model, whatever the page. Checksums keep this honest: a long number in an article (a
 * population, a serial, an ISBN) does not validate, and "IT60" in a sentence about IBANs is not one.
 * It catches these four shapes and no others: a bare account number, a sort code, a patient number
 * or a policy number goes through like any other text.
 */
export function carriesAccountNumber(text: string): boolean {
  for (const m of text.matchAll(IBAN)) if (ibanIsValid(m[1]! + m[2]!)) return true;
  for (const m of text.matchAll(CARD)) if (luhnIsValid(m[1]!)) return true;
  return ITALIAN_TAX_CODE.test(text) || US_SSN.test(text);
}
