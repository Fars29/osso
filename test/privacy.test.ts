/**
 * What Osso must never send, and what it must not refuse to read for a stupid reason. Every sign is
 * about how the page is made or about the data in it, never about its subject: an article on
 * banking is an article.
 */
import { describe, expect, it } from "vitest";
import { assessPrivacy, carriesAccountNumber } from "../src/content/privacy.ts";

function page(body: string, head = ""): Document {
  return new DOMParser().parseFromString(`<!DOCTYPE html><html><head>${head}</head><body>${body}</body></html>`, "text/html");
}
const at = (pathname: string, hostname = "www.example.com") => ({ hostname, pathname });

const FINANCE_ARTICLE = `<main><article><h1>Why your bank account fees are rising</h1>
  <p>Banks across Europe raised current account fees by 8% this year, and the central bank expects another rise.</p>
  <p>To pay by card or to log in to online banking, customers of the largest bank now need a second password sent by SMS.</p>
  <p>Your IBAN starts with the country code, and a credit card number has sixteen digits; neither should be shared in a checkout you do not trust.</p>
  <form><input type="email" autocomplete="email" placeholder="Our newsletter"><input type="search"></form>
  </article></main>`;

describe("a page is never refused for what it talks about", () => {
  it("an article on banking, passwords, payments and accounts is an article", () => {
    expect(assessPrivacy(page(FINANCE_ARTICLE), at("/business/banking/2026/09/why-your-bank-account-fees-are-rising"))).toBeNull();
    expect(assessPrivacy(page(FINANCE_ARTICLE), at("/money/how-to-pay-less-at-checkout-with-a-new-account.html"))).toBeNull();
    expect(assessPrivacy(page(FINANCE_ARTICLE), at("/health/my-account-of-a-year-with-long-covid"))).toBeNull();
  });

  it("nor for a newsletter box, a search field, or a sign-out link on its own: a subscriber is logged in to a newspaper too", () => {
    expect(assessPrivacy(page(`${FINANCE_ARTICLE}<a href="/logout">Sign out</a>`), at("/article"))).toBeNull();
    expect(assessPrivacy(page(FINANCE_ARTICLE, `<meta name="robots" content="index, follow, max-image-preview:large">`), at("/article"))).toBeNull();
  });
});

describe("a page between the reader and a site", () => {
  it("is never read when it shows a password, a card or a one-time code field", () => {
    for (const field of [`<input type="password">`, `<input autocomplete="cc-number">`, `<input autocomplete="one-time-code">`]) {
      expect(assessPrivacy(page(`${FINANCE_ARTICLE}<form>${field}</form>`), at("/article"))?.level, field).toBe("never");
    }
  });

  it("is held back, to ask first, when its address is a private area: a whole path segment, in any of the usual languages", () => {
    for (const path of ["/account", "/my-account/orders", "/it/area-riservata/movimenti", "/checkout/step-2", "/wp-admin/index.php", "/user/settings", "/login.html", "/Billing/"]) {
      expect(assessPrivacy(page(FINANCE_ARTICLE), at(path))?.level, path).toBe("ask");
    }
  });

  it("is held back when it asks the reader for several things about themselves", () => {
    const form = `<form><input autocomplete="given-name"><input autocomplete="family-name"><input autocomplete="shipping street-address"><input autocomplete="postal-code"></form>`;
    expect(assessPrivacy(page(`${FINANCE_ARTICLE}${form}`), at("/article"))).toEqual({ level: "ask", reason: "personal-form" });
  });

  it("is held back when it is hidden from search engines and has a way to sign out: the inside of an account", () => {
    const head = `<meta name="robots" content="noindex, nofollow">`;
    expect(assessPrivacy(page(`<main><p>Your plan renews on 3 October.</p></main><a href="/session/end">Log out</a>`, head), at("/home"))).toEqual({ level: "ask", reason: "signed-in" });
    expect(assessPrivacy(page(`<main><p>Your plan renews on 3 October.</p></main><a href="/auth/logout?next=/">Marta</a>`, head), at("/home"))?.level).toBe("ask");
  });
});

describe("a sentence that carries an account number is never sent", () => {
  it("an IBAN, a card number, a tax code, a social security number: each checked, not guessed", () => {
    expect(carriesAccountNumber("Pay the deposit to IT60 X054 2811 1010 0000 0123 456 by Friday.")).toBe(true);
    expect(carriesAccountNumber("IBAN: DE89370400440532013000")).toBe(true);
    expect(carriesAccountNumber("Card ending 4111 1111 1111 1111 was charged €12.")).toBe(true);
    expect(carriesAccountNumber("Card 5500-0000-0000-0004, expires 09/28.")).toBe(true);
    expect(carriesAccountNumber("Codice fiscale RSSMRA85T10A562S, residente a Torino.")).toBe(true);
    expect(carriesAccountNumber("SSN 078-05-1120 on file.")).toBe(true);
  });

  it("a number that does not validate is a number: populations, serials, ISBNs, phone numbers, prices", () => {
    for (const s of [
      "An IBAN such as IT60 X054 2811 1010 0000 0123 457 has a check digit that catches typos.",
      "The card number 4111 1111 1111 1112 fails the Luhn check.",
      "ISBN 978-3-16-148410-0, first published in 2019.",
      "Call +39 02 1234 5678 or 1-800-555-0199 between 9 and 17.",
      "The fund manages 4,250,000,000,000 yen and lost 1.2% in 2026.",
      "Order 2026-09-21-000173 shipped in 3 boxes of 12 units.",
      "Use 500 g of chicken thighs, 300 g of orzo and 750 ml of stock.",
    ]) expect(carriesAccountNumber(s), s).toBe(false);
  });
});

describe("a page nobody published", () => {
  it("is held back when its own site tells search engines not to keep it", () => {
    const head = `<meta name="robots" content="noindex, nofollow">`;
    expect(assessPrivacy(page(FINANCE_ARTICLE, head), at("/anything"))).toEqual({ level: "ask", reason: "unlisted" });
    // With a way to sign out as well, the reason is the plainer one.
    expect(assessPrivacy(page(`${FINANCE_ARTICLE}<a href="/logout">Log out</a>`, head), at("/anything"))).toEqual({ level: "ask", reason: "signed-in" });
  });

  it("is held back on a host that only exists inside a network", () => {
    for (const host of ["intranet", "hr.corp.local", "wiki.internal", "10.4.1.9", "172.20.0.3", "192.168.1.1", "169.254.10.2", "fd00::1"]) {
      expect(assessPrivacy(page(FINANCE_ARTICLE), at("/article", host))?.reason, host).toBe("private-host");
    }
  });

  it("is not held back on the open web, or on the machine the reader is developing on", () => {
    for (const host of ["www.example.com", "corporate.com", "my.internal-affairs.org", "192.168.com", "10.com", "localhost", "127.0.0.1"]) {
      expect(assessPrivacy(page(FINANCE_ARTICLE), at("/article", host)), host).toBeNull();
    }
  });
});
