/**
 * Is this page between the reader and a site, rather than something published to be read? Osso sends
 * the text of a page to a model, so it has to know, and it has to know without guessing from what
 * the page talks about: an article on banking says "bank" forty times and is an article. Every sign
 * here is about how the page is made (what it asks the reader to type, where it lives, whether it is
 * meant to be found) or about the data in it (an account number that validates), never about its
 * subject.
 *
 *   never  what it shows is a secret being typed: a password, a card number, a one-time code.
 *          Osso does not run there, asked or not.
 *   ask    it looks like a private area (an account path, a form for personal details, a page hidden
 *          from search engines with a way to sign out). Osso holds back and says why; the reader
 *          can run it on that page once. These signs can be wrong, so they are never a wall.
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

/** Not meant to be found, and there is a way out of it: the inside of an account, an intranet, a webmail. Either alone is ordinary. */
function signedInAndUnlisted(doc: Document, laidOut: boolean): boolean {
  const robots = Array.from(doc.querySelectorAll('meta[name="robots" i], meta[name="googlebot" i]')).some((m) => /noindex/i.test(m.getAttribute("content") ?? ""));
  if (!robots) return false;
  for (const el of Array.from(doc.querySelectorAll("a, button"))) {
    const label = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (label.length <= 24 && SIGN_OUT.test(label) && shown(el, laidOut)) return true;
    const href = el.getAttribute("href") ?? "";
    if (/(^|[/?&=_-])(logout|log-out|signout|sign-out)([/?&=_.-]|$)/i.test(href) && shown(el, laidOut)) return true;
  }
  return false;
}

function privatePath(pathname: string): string | null {
  for (const raw of pathname.split("/")) {
    const segment = raw.toLowerCase().replace(/\.(html?|php|aspx?|jsp)$/, "");
    if (PRIVATE_SEGMENTS.has(segment)) return segment;
  }
  return null;
}

export function assessPrivacy(doc: Document, url: { pathname: string }): Privacy {
  if (isPrivatePage(doc)) return { level: "never", reason: "sign-in or payment page" };
  const laidOut = (doc.body?.getClientRects().length ?? 0) > 0;
  const segment = privatePath(url.pathname);
  if (segment) return { level: "ask", reason: `private-path:${segment}` };
  if (personalForm(doc, laidOut)) return { level: "ask", reason: "personal-form" };
  if (signedInAndUnlisted(doc, laidOut)) return { level: "ask", reason: "signed-in" };
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
 */
export function carriesAccountNumber(text: string): boolean {
  for (const m of text.matchAll(IBAN)) if (ibanIsValid(m[1]! + m[2]!)) return true;
  for (const m of text.matchAll(CARD)) if (luhnIsValid(m[1]!)) return true;
  return ITALIAN_TAX_CODE.test(text) || US_SSN.test(text);
}
