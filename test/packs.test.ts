import { describe, expect, it } from "vitest";
import type { PageKind, PageMeta } from "../src/shared/types.ts";
import { PACKS, ROUTE_THRESHOLD, WEIGHT, getPack, route, score } from "../src/packs/index.ts";
import { generic } from "../src/packs/generic.ts";

/** A meta with no signal at all; each test adds the one it is exercising. */
function meta(patch: Partial<PageMeta> = {}): PageMeta {
  return {
    url: "https://example.com/page",
    host: "example.com",
    title: "Untitled",
    lang: "en",
    jsonLdTypes: [],
    ogType: null,
    sample: "The weather was mild that day. She looked out of the window for a while. Things had been quiet recently.",
    sentenceCount: 12,
    ...patch,
  };
}

describe("route: one signal at a time", () => {
  const byJsonLd: Array<[string, PageKind]> = [
    ["recipe", "recipe"],
    ["newsarticle", "article"],
    ["blogposting", "article"],
    ["reportage", "article"],
    ["product", "product"],
    ["offer", "product"],
    ["techarticle", "docs"],
    ["howto", "docs"],
    ["faqpage", "docs"],
  ];
  it.each(byJsonLd)("JSON-LD %s alone → %s", (type, kind) => {
    expect(route(meta({ jsonLdTypes: [type] }))).toBe(kind);
  });

  const byPath: Array<[string, PageKind]> = [
    ["/terms", "legal"],
    ["/legal/privacy", "legal"],
    ["/it/condizioni-generali/termini", "legal"],
    ["/ricette/focaccia-della-nonna", "recipe"],
    ["/recipes/lemon-chicken-orzo/", "recipe"],
    ["/press/2026/09/new-office", "corporate"],
    ["/blog/company/pricing-update", "corporate"],
    ["/docs/getting-started", "docs"],
    ["/api/v2/reference", "docs"],
    ["/dp/B08XYZ", "product"],
    ["/p/12345", "product"],
    ["/news/2026/tram-line", "article"],
    ["/blog/why-we-rewrote", "article"],
  ];
  it.each(byPath)("URL path %s alone → %s", (path, kind) => {
    expect(route(meta({ url: `https://example.com${path}` }))).toBe(kind);
  });

  it("matches whole path segments only", () => {
    expect(route(meta({ url: "https://example.com/recipes-blog/about" }))).toBe("other");
    expect(route(meta({ url: "https://example.com/apiary/bees" }))).toBe("other");
  });

  const byHost: Array<[string, PageKind]> = [
    ["medium.com", "article"],
    ["someone.substack.com", "article"],
    ["blog.example.com", "article"],
    ["docs.python.org", "docs"],
    ["developer.mozilla.org", "docs"],
    ["requests.readthedocs.io", "docs"],
  ];
  it.each(byHost)("host %s alone → %s", (host, kind) => {
    expect(route(meta({ host, url: `https://${host}/x` }))).toBe(kind);
  });

  it("og:type alone is a hint, not a route", () => {
    expect(score(meta({ ogType: "article" }), { ogType: ["article"] })).toBe(WEIGHT.ogType);
    expect(route(meta({ ogType: "product" }))).toBe("product");
    expect(route(meta({ ogType: "Article" }))).toBe("article");
  });

  const byCues: Array<[string, string, PageKind]> = [
    ["recipe (en)", "Ingredients: 500 g chicken thighs. Preheat the oven to 200 °C. Serves 4.", "recipe"],
    ["recipe (it)", "Ingredienti per 4 porzioni. Preriscalda il forno a 230 °C.", "recipe"],
    ["legal (en)", "These Terms are governed by the laws of Delaware. See also our Privacy Policy.", "legal"],
    ["legal (it)", "Il presente contratto regola i termini e condizioni e il trattamento dei dati personali.", "legal"],
    ["corporate (en)", "We're excited to announce an update on pricing. We are pleased to share the details.", "corporate"],
    ["corporate (it)", "Gentile cliente, siamo lieti di inviarle questo comunicato.", "corporate"],
    ["docs", "Usage: osso [options]. Parameters are listed below; each endpoint returns JSON. npm install osso", "docs"],
    ["product (en)", "Add to cart. In stock. Specifications: 30 × 40 cm.", "product"],
    ["product (it)", "Aggiungi al carrello. Disponibilità immediata. Specifications below.", "product"],
    ["social", "Repost if this resonated with you. Agree? Link in the first comment.", "social"],
  ];
  it.each(byCues)("cues alone: %s → %s", (_label, sample, kind) => {
    expect(route(meta({ sample }))).toBe(kind);
  });

  it("cues are case-insensitive and read the title too", () => {
    expect(route(meta({ title: "INGREDIENTS and method", sample: "PREHEAT the oven. SERVES six." }))).toBe("recipe");
  });

  it("one or two cues are not enough on their own", () => {
    expect(route(meta({ sample: "Preheat the oven." }))).toBe("other");
    expect(score(meta({ sample: "Preheat the oven. Serves 4." }), { cues: ["preheat", "serves"] })).toBeCloseTo(WEIGHT.cue * 2);
  });
});

describe("route: combined signals", () => {
  it("adds signals and caps at 1", () => {
    const m = meta({
      url: "https://blog.example.com/recipes/orzo",
      host: "blog.example.com",
      jsonLdTypes: ["recipe"],
      sample: "Ingredients: orzo. Preheat the oven. Serves 4.",
    });
    expect(getPack("recipe").match(m)).toBe(1);
    expect(route(m)).toBe("recipe");
  });

  it("JSON-LD outweighs a misleading path", () => {
    const m = meta({ url: "https://example.com/blog/lemon-orzo", jsonLdTypes: ["recipe"] });
    expect(route(m)).toBe("recipe");
  });

  it("cue weight is capped so text alone never beats a declared type", () => {
    const m = meta({
      jsonLdTypes: ["newsarticle"],
      sample: "Ingredients, ingredienti, preheat, preriscalda, serves, porzioni: a food critic's report.",
    });
    expect(getPack("recipe").match(m)).toBe(WEIGHT.cueCap);
    expect(route(m)).toBe("article");
  });

  it("host and og:type together route a Medium story", () => {
    const m = meta({ host: "medium.com", url: "https://medium.com/@someone/story-abc", ogType: "article" });
    expect(route(m)).toBe("article");
  });

  it("an Italian ToS on a product host routes legal from path plus cues", () => {
    const m = meta({
      url: "https://shop.example.it/termini",
      host: "shop.example.it",
      title: "Termini e condizioni di vendita",
      sample: "Il presente contratto disciplina il trattamento dei dati.",
    });
    expect(route(m)).toBe("legal");
  });

  it("a tie goes to the earlier pack in PACKS", () => {
    // "/blog/company" scores the path weight for corporate and for article alike.
    const m = meta({ url: "https://example.com/blog/company/we-are-changing-prices" });
    expect(getPack("corporate").match(m)).toBe(getPack("article").match(m));
    expect(route(m)).toBe("corporate");
  });
});

describe("route: nothing to go on", () => {
  it("an ambiguous meta routes to other", () => {
    expect(route(meta())).toBe("other");
  });

  it("a malformed url falls back to path matching on the string", () => {
    expect(route(meta({ url: "/recipes/soup" }))).toBe("recipe");
    expect(route(meta({ url: "not a url" }))).toBe("other");
  });
});

describe("packs", () => {
  it("getPack returns the generic pack for other and itself for every id", () => {
    expect(getPack("other")).toBe(generic);
    for (const p of PACKS) expect(getPack(p.id)).toBe(p);
  });

  it("the generic pack is last, never matches and carries no hints", () => {
    expect(PACKS[PACKS.length - 1]).toBe(generic);
    expect(generic.match(meta({ jsonLdTypes: ["recipe"], url: "https://x.com/terms" }))).toBe(0);
    expect(generic.keepHints).toBeUndefined();
    expect(generic.stateHint).toBe("web page");
  });

  it("every pack has a unique id and a threshold-clearing match is possible", () => {
    const ids = PACKS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ROUTE_THRESHOLD).toBe(0.5);
  });

  it("match stays within 0..1 on every pack", () => {
    const loud = meta({
      url: "https://docs.example.com/docs/recipes/terms/press/dp/news/status",
      host: "docs.example.com",
      jsonLdTypes: ["recipe", "newsarticle", "product", "techarticle", "socialmediaposting"],
      ogType: "article",
      sample: "ingredients preheat serves these terms governed by privacy policy we are pleased npm install usage: add to cart in stock repost if agree? link in bio",
    });
    for (const p of PACKS) {
      const s = p.match(loud);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it("every hint is one sentence under 220 characters", () => {
    for (const p of PACKS) {
      for (const hint of [p.keepHints?.true, p.keepHints?.false]) {
        if (hint === undefined) continue;
        expect(hint.length, `${p.id}: ${hint}`).toBeLessThan(220);
        expect(hint.trim(), `${p.id}: ${hint}`).toMatch(/[.!?]$/);
        // A single sentence: no terminal punctuation followed by a capitalised word inside it.
        expect(hint.slice(0, -1), `${p.id}: ${hint}`).not.toMatch(/[.!?]\s+[A-Z"]/);
        expect(hint, `${p.id}: ${hint}`).not.toMatch(/\n/);
      }
      expect(p.stateHint.length).toBeGreaterThan(0);
      expect(p.stateHint.length).toBeLessThan(80);
    }
  });
});
