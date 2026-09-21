/**
 * Field probe for Osso's core judgment: does Jev separate substance from filler, sentence by
 * sentence, with the page as context; how fast, at what cost, with N sentences per request; and
 * does a fact stated twice on a page survive in both places?
 *
 * The requests are built by the shipped code path (`buildRequestBody` and `parseAnswers` from
 * `src/background/api.ts`, with the generic pack and the wording in `src/shared/constants.ts`),
 * so what this measures is exactly what the extension sends. Pages I and J are the redundancy
 * trap: a step and a tip that the faded introduction also states, a vague announcement beside
 * the concrete one; their tagged sentences are printed on their own at the end.
 *
 * Run: npm run calibrate   (node --env-file=.env scripts/calibrate.ts; needs TYPESAFE_API_KEY)
 * Results: docs/calibration.md
 */
import { API_URL, KEEP_QUESTION, KIND_QUESTION, PAGE_KIND_QUESTION, PAGE_KINDS, SENTENCE_KINDS, USD_PER_INPUT_TOKEN } from "../src/shared/constants.ts";
import { buildRequestBody, parseAnswers, type RequestBody } from "../src/background/api.ts";
import { generic } from "../src/packs/generic.ts";
import type { PageMeta, SentenceInput, SentenceJudgment, SentenceKind } from "../src/shared/types.ts";

const KEY = process.env.TYPESAFE_API_KEY;
if (!KEY) throw new Error("TYPESAFE_API_KEY missing");

type Sent = { t: string; k: 0 | 1; tag?: string };
type Page = { id: string; kind: string; title: string; lang: string; s: Sent[] };

const PAGES: Page[] = [
  { id: "A", kind: "recipe blog", lang: "en", title: "The Best One-Pot Lemon Chicken Orzo", s: [
    { k: 0, t: "Every summer, my grandmother would open the windows of her kitchen in Liguria and the whole street would know what was for dinner." },
    { k: 0, t: "I still remember the smell of lemons on her hands." },
    { k: 0, t: "This recipe has been on my list for years, and honestly I don't know why it took me so long to share it with you." },
    { k: 0, t: "It has become a weeknight staple in our house, and my kids ask for it at least twice a week." },
    { k: 0, t: "If you make it, please tag me on Instagram, I love seeing your photos!" },
    { k: 0, t: "Be sure to scroll down for the printable recipe card and a few reader questions I've answered below." },
    { k: 0, t: "There is something magical about a dish that comes together in one pot." },
    { k: 0, t: "I've partnered with my favorite olive oil brand this month, and you can get 15% off with my code." },
    { k: 1, t: "You will need 500 g of boneless chicken thighs, 300 g of orzo, one lemon, and 750 ml of chicken stock." },
    { k: 1, t: "Sear the chicken skin-side down for 6 minutes without moving it, or it will not brown." },
    { k: 1, t: "Add the orzo and stir for one minute so it toasts slightly before the stock goes in." },
    { k: 1, t: "Simmer uncovered for 12 to 14 minutes, stirring every few minutes so the orzo does not stick to the bottom." },
    { k: 1, t: "Do not add the lemon juice until the heat is off, or the sauce will turn bitter." },
    { k: 1, t: "Leftovers keep in the fridge for up to three days; add a splash of stock when reheating." },
  ]},
  { id: "B", kind: "corporate statement", lang: "en", title: "An update on last week's service disruption", s: [
    { k: 0, t: "We know how much you rely on our service every day, and we take that responsibility seriously." },
    { k: 0, t: "Over the past week, our teams have been working around the clock to understand what happened." },
    { k: 0, t: "We want to be transparent with you, because transparency is one of our core values." },
    { k: 0, t: "Your trust means everything to us, and we are grateful for your patience." },
    { k: 0, t: "We are committed to learning from this and to becoming stronger as a company." },
    { k: 0, t: "We have always believed that the best products are built together with the people who use them." },
    { k: 0, t: "Thank you for being part of this journey." },
    { k: 0, t: "As always, our support team is here for you." },
    { k: 1, t: "Starting Monday, October 6, the price of the Standard plan will increase from $8 to $9.60 per month, a 20% increase." },
    { k: 1, t: "Customers affected by the outage on September 12 will not receive a refund or account credit." },
    { k: 1, t: "The disruption was caused by a failed database migration that deleted approximately 0.3% of user uploads between 14:02 and 16:40 UTC." },
    { k: 1, t: "Files uploaded during that window cannot be recovered." },
    { k: 1, t: "We have since added a mandatory second review step to every database migration." },
  ]},
  { id: "C", kind: "terms of service", lang: "en", title: "Terms of Service", s: [
    { k: 0, t: "These Terms of Service (\"Terms\") govern your access to and use of the services provided by Example Inc. (\"we\", \"us\", or \"our\")." },
    { k: 0, t: "Please read these Terms carefully." },
    { k: 0, t: "By accessing or using the Service, you agree to be bound by these Terms." },
    { k: 0, t: "Capitalized terms used but not defined in this section have the meanings given elsewhere in these Terms." },
    { k: 0, t: "We may update these Terms from time to time." },
    { k: 0, t: "Headings are for convenience only and do not affect interpretation." },
    { k: 1, t: "Your subscription will automatically renew at the end of each billing period unless you cancel at least 24 hours before the renewal date." },
    { k: 1, t: "We may change subscription prices at any time; changes take effect at your next billing period after 30 days' notice by email." },
    { k: 1, t: "Any dispute will be resolved by binding individual arbitration, and you waive the right to participate in a class action." },
    { k: 1, t: "If you cancel an annual plan before the end of the term, a cancellation fee equal to two months of service applies." },
    { k: 1, t: "We may share your personal data, including email address and usage history, with our advertising partners." },
    { k: 1, t: "Refunds are not provided for partial billing periods." },
  ]},
  { id: "D", kind: "social media post", lang: "en", title: "LinkedIn post", s: [
    { k: 0, t: "I don't usually post personal things here, but today I need to." },
    { k: 0, t: "Three years ago I was told I'd never make it in this industry." },
    { k: 0, t: "I cried in my car after that meeting." },
    { k: 0, t: "But I kept showing up, every single day." },
    { k: 0, t: "Because that's what leaders do." },
    { k: 0, t: "Today I'm humbled and grateful to share that our little team has been recognized as one of the fastest growing startups in the region." },
    { k: 0, t: "None of this would be possible without the incredible people around me." },
    { k: 0, t: "Agree?" },
    { k: 0, t: "Repost if this resonated with you." },
    { k: 1, t: "We're hiring three backend engineers in Turin, fully remote, salary range €55k-€75k; the link is in the first comment." },
  ]},
  { id: "E", kind: "news article", lang: "en", title: "City council approves new tram line", s: [
    { k: 1, t: "The city council voted 24 to 9 on Tuesday to approve a 12-kilometre tram line connecting the airport to the central station." },
    { k: 1, t: "Construction is scheduled to begin in March 2027 and to take four years." },
    { k: 1, t: "The project is budgeted at €480 million, of which €310 million comes from EU regional funds." },
    { k: 1, t: "Fares will be the same as the existing metro, €1.70 per ride." },
    { k: 1, t: "Via Roma will be closed to cars for the duration of the works." },
    { k: 0, t: "The vote came after a long and at times heated debate that stretched well past midnight." },
    { k: 0, t: "Supporters in the public gallery applauded as the result was announced." },
    { k: 0, t: "The tram has been a topic of conversation in the city for as long as most residents can remember." },
    { k: 0, t: "It remains to be seen whether the ambitious timeline will hold." },
    { k: 0, t: "The mayor, visibly tired, thanked everyone for their patience." },
  ]},
  { id: "F", kind: "recipe blog", lang: "it", title: "La focaccia della nonna", s: [
    { k: 0, t: "Ogni volta che impasto questa focaccia torno bambina, nella cucina di mia nonna a Recco." },
    { k: 0, t: "Lei non usava la bilancia, andava a occhio, e veniva sempre perfetta." },
    { k: 0, t: "Ci ho messo anni a ricostruire le dosi, e oggi finalmente ve la regalo." },
    { k: 0, t: "Fatemi sapere nei commenti se la provate, mi fa sempre tanto piacere!" },
    { k: 0, t: "È il profumo dell'estate, del mare, delle domeniche in famiglia." },
    { k: 0, t: "Se vi piace questa ricetta, iscrivetevi alla newsletter per riceverne una ogni settimana." },
    { k: 1, t: "Servono 500 g di farina 0, 300 ml di acqua tiepida, 10 g di sale, 4 g di lievito di birra secco e 40 ml di olio extravergine." },
    { k: 1, t: "Lasciate lievitare l'impasto coperto per 2 ore, finché non raddoppia." },
    { k: 1, t: "Stendete in una teglia da 30×40 cm unta abbondantemente e fate i buchi con le dita." },
    { k: 1, t: "Cuocete a 230 °C per 15-18 minuti, finché la superficie non è dorata." },
    { k: 1, t: "L'acqua della salamoia deve essere fredda, altrimenti l'impasto si sgonfia." },
  ]},
  { id: "G", kind: "corporate statement", lang: "it", title: "Novità sul tuo abbonamento", s: [
    { k: 0, t: "Gentile cliente, grazie per aver scelto di far parte della nostra community." },
    { k: 0, t: "In questi anni siamo cresciuti insieme, e questo grazie a persone come te." },
    { k: 0, t: "Continuiamo a investire ogni giorno per offrirti un servizio sempre migliore." },
    { k: 0, t: "Il tuo feedback è per noi fonte di ispirazione continua." },
    { k: 0, t: "Ti ringraziamo per la fiducia e non vediamo l'ora di continuare questo percorso con te." },
    { k: 1, t: "A partire dal 1° ottobre 2026 il canone mensile passerà da 9,99 € a 12,99 €." },
    { k: 1, t: "Se non desideri accettare le nuove condizioni, puoi disdire senza penali entro il 30 settembre dalla sezione Abbonamento." },
    { k: 1, t: "In assenza di disdetta, il nuovo prezzo verrà applicato automaticamente al primo rinnovo utile." },
  ]},
  { id: "H", kind: "unknown", lang: "en", title: "Untitled", s: [
    { k: 0, t: "The weather was mild that day." },
    { k: 0, t: "She looked out of the window for a while." },
    { k: 0, t: "Things had been quiet recently." },
    { k: 0, t: "He nodded and said nothing." },
    { k: 0, t: "The afternoon passed slowly." },
    { k: 0, t: "It was, in the end, an ordinary week." },
    { k: 0, t: "Somewhere a door closed." },
    { k: 0, t: "They walked back the way they had come." },
  ]},
  // The redundancy trap: the lemon-off-the-heat fact is in the story and in the step; the
  // leftovers tip is in the tip and in the closing story; page J states the price change vaguely
  // in the greeting and concretely in the notice.
  { id: "I", kind: "recipe blog", lang: "en", title: "One-Pot Lemon Chicken Orzo", s: [
    { k: 0, t: "Every summer my grandmother would open the windows of her kitchen and the whole street would know what was for dinner." },
    { k: 0, t: "The lemon goes in off the heat, which is the single detail my grandmother was strict about, and which I have since confirmed the hard way.", tag: "story-dup" },
    { k: 0, t: "This recipe has been on my list for years, and honestly I don't know why it took me so long to share it with you." },
    { k: 0, t: "If you make it, please tag me on Instagram, I love seeing your photos!" },
    { k: 1, t: "500 g boneless, skin-on chicken thighs, patted dry" },
    { k: 1, t: "300 g dried orzo" },
    { k: 1, t: "1 large unwaxed lemon, zested and juiced" },
    { k: 1, t: "Freshly ground black pepper", tag: "pepper" },
    { k: 1, t: "Sear the chicken skin-side down for 6 minutes without moving it, or it will not brown." },
    { k: 1, t: "Return the chicken to the pan and simmer uncovered for 12 to 14 minutes, stirring every few minutes so the orzo does not stick." },
    { k: 1, t: "Turn off the heat, then stir in the lemon zest, the lemon juice and the Parmigiano; do not add the lemon juice while the pan is still on the heat, or the sauce will turn bitter.", tag: "step-dup" },
    { k: 1, t: "Rest for 3 minutes, scatter with parsley and black pepper, and serve straight from the pan." },
    { k: 1, t: "Leftovers keep in the fridge for up to three days; add a splash of stock when reheating.", tag: "tip-dup" },
    { k: 0, t: "That is it, really; it is the thing I make when it is Tuesday and everyone is tired and hungry, and the leftovers are honestly even better the next day.", tag: "story-dup2" },
  ]},
  { id: "J", kind: "corporate statement", lang: "it", title: "Novità sul tuo abbonamento", s: [
    { k: 0, t: "Gentile cliente, grazie per aver scelto di far parte della nostra community." },
    { k: 0, t: "Come forse saprai, nei prossimi mesi il prezzo del tuo abbonamento cambierà, e vogliamo spiegarti perché.", tag: "vague-dup" },
    { k: 0, t: "Continuiamo a investire ogni giorno per offrirti un servizio sempre migliore." },
    { k: 1, t: "A partire dal 1° ottobre 2026 il canone mensile passerà da 9,99 € a 12,99 €.", tag: "concrete" },
    { k: 1, t: "Se non desideri accettare le nuove condizioni, puoi disdire senza penali entro il 30 settembre dalla sezione Abbonamento." },
    { k: 1, t: "In assenza di disdetta, il nuovo prezzo verrà applicato automaticamente al primo rinnovo utile.", tag: "concrete-dup" },
    { k: 0, t: "Ti ringraziamo per la fiducia e non vediamo l'ora di continuare questo percorso con te." },
  ]},
];

/** The noise floor page has no labels; it is reported on its own and left out of the AUC. */
const NOISE_PAGE = "H";

function metaFor(page: Page): PageMeta {
  return { url: `https://example.test/${page.id}`, host: "example.test", title: page.title, lang: page.lang, jsonLdTypes: [], ogType: null, sample: "", sentenceCount: page.s.length };
}

function inputsFor(page: Page, offset = 0): SentenceInput[] {
  return page.s.map((s, i) => ({ id: offset + i, text: s.t }));
}

/** Exactly the request the background worker sends for an unrouted page's first chunk. */
function bodyFor(page: Page): RequestBody {
  return buildRequestBody(inputsFor(page), metaFor(page), generic, true);
}

async function ask(body: RequestBody) {
  const t0 = performance.now();
  const r = await fetch(API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const ms = performance.now() - t0;
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  const j = (await r.json()) as { answers: Record<string, unknown>; usage: { input_tokens: number } };
  return { ms, answers: j.answers, tokens: j.usage.input_tokens };
}

function auc(pos: number[], neg: number[]) {
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return pos.length && neg.length ? wins / (pos.length * neg.length) : NaN;
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const usd = (tokens: number) => `$${(tokens * USD_PER_INPUT_TOKEN).toFixed(4)}`;

/** Every threshold (step 0.05) that reaches the best accuracy, so the slider's safe range is visible. */
function bestThresholds(pos: number[], neg: number[]) {
  const acc = (t: number) => (pos.filter((p) => p >= t).length + neg.filter((n) => n < t).length) / (pos.length + neg.length);
  const ts = Array.from({ length: 19 }, (_, i) => Number(((i + 1) * 0.05).toFixed(2)));
  const best = Math.max(...ts.map(acc));
  const range = ts.filter((t) => acc(t) === best);
  return { from: range[0]!, to: range[range.length - 1]!, acc: Number(best.toFixed(3)) };
}

type Row = { page: string; k: 0 | 1; tag?: string; t: string } & SentenceJudgment;

const rows: Row[] = [];
const requests: Array<{ page: string; questions: number; ms: number; tokens: number }> = [];

for (const page of PAGES) {
  const body = bodyFor(page);
  const res = await ask(body);
  const questions = Object.keys(body.questions).length;
  requests.push({ page: page.id, questions, ms: res.ms, tokens: res.tokens });
  const parsed = parseAnswers(inputsFor(page), res.answers, true);
  if (parsed.failedIds.length) throw new Error(`page ${page.id}: unparseable answers for ids ${parsed.failedIds.join(", ")}`);
  const pk = parsed.pageKind ? `${parsed.pageKind.kind} (${parsed.pageKind.confidence.toFixed(2)})` : "?";
  console.log(`\n=== ${page.id} ${page.kind} (${page.lang}) · ${page.s.length} sentences, ${questions} questions · ${res.ms.toFixed(0)} ms · ${res.tokens} in-tokens · page_kind: ${pk}`);
  for (const j of parsed.sentences) {
    const s = page.s[j.id]!;
    const row: Row = { page: page.id, k: s.k, t: s.t, ...j };
    if (s.tag) row.tag = s.tag;
    rows.push(row);
  }
  const pr = rows.filter((r) => r.page === page.id).sort((a, b) => b.keep - a.keep);
  for (const r of pr) console.log(`  ${r.k ? "KEEP" : "    "}  p=${r.keep.toFixed(2)}  ${r.kind.padEnd(24)} ${r.t.slice(0, 84)}${r.tag ? `  <${r.tag}>` : ""}`);
  const pos = pr.filter((r) => r.k).map((r) => r.keep), neg = pr.filter((r) => !r.k).map((r) => r.keep);
  if (pos.length && neg.length) console.log(`  AUC=${auc(pos, neg).toFixed(3)}  mean keep=${mean(pos).toFixed(2)} filler=${mean(neg).toFixed(2)}  min keep=${Math.min(...pos).toFixed(2)} max filler=${Math.max(...neg).toFixed(2)}`);
  else console.log(`  noise floor: mean p=${mean(pr.map((r) => r.keep)).toFixed(2)} max=${Math.max(...pr.map((r) => r.keep)).toFixed(2)}`);
}

const labelled = rows.filter((r) => r.page !== NOISE_PAGE);
const pos = labelled.filter((r) => r.k), neg = labelled.filter((r) => !r.k);
const noise = rows.filter((r) => r.page === NOISE_PAGE).map((r) => r.keep);
console.log(`\n=== OVERALL (${labelled.length} labelled sentences, ${pos.length} keep / ${neg.length} filler) ===`);
console.log(`AUC = ${auc(pos.map((r) => r.keep), neg.map((r) => r.keep)).toFixed(3)}   best threshold ${JSON.stringify(bestThresholds(pos.map((r) => r.keep), neg.map((r) => r.keep)))}`);
console.log(`mean keep=${mean(pos.map((r) => r.keep)).toFixed(2)} filler=${mean(neg.map((r) => r.keep)).toFixed(2)}   |   noise floor (page ${NOISE_PAGE}) mean=${mean(noise).toFixed(2)} max=${Math.max(...noise).toFixed(2)}`);
const substantive = (k: SentenceKind) => SENTENCE_KINDS[k].substantive;
console.log(`kind proxy: keep→substantive kinds = ${((pos.filter((r) => substantive(r.kind)).length / pos.length) * 100).toFixed(0)}%   filler→non-substantive kinds = ${((neg.filter((r) => !substantive(r.kind)).length / neg.length) * 100).toFixed(0)}%`);
const totalMs = requests.reduce((a, r) => a + r.ms, 0), totalTok = requests.reduce((a, r) => a + r.tokens, 0);
console.log(`latency: ${requests.map((r) => `${r.page}:${r.questions}q/${r.ms.toFixed(0)}ms`).join("  ")}`);
console.log(`total: ${totalMs.toFixed(0)} ms sequential over ${PAGES.length} requests, ${totalTok} input tokens ≈ ${usd(totalTok)}`);

console.log(`\n=== REDUNDANCY TRAP (tagged sentences) ===`);
for (const r of rows.filter((r) => r.tag)) console.log(`  ${r.page} <${r.tag}>${"".padEnd(14 - r.tag!.length)} ${r.k ? "KEEP" : "    "}  p=${r.keep.toFixed(2)}  ${r.kind.padEnd(24)} ${r.t.slice(0, 84)}`);

// Scaling: every page in ONE request, ids offset so the keys stay unique; the state is the whole text.
const all: SentenceInput[] = [];
const labels: Array<{ page: string; k: 0 | 1 }> = [];
for (const p of PAGES) {
  all.push(...inputsFor(p, all.length));
  labels.push(...p.s.map((s) => ({ page: p.id, k: s.k })));
}
const bigMeta: PageMeta = { ...metaFor(PAGES[0]!), title: "Calibration pages", lang: "en", sentenceCount: all.length };
const bigBody = buildRequestBody(all, bigMeta, generic, false);
const nq = Object.keys(bigBody.questions).length;
const big = await ask(bigBody);
const bigParsed = parseAnswers(all, big.answers, false);
const bpos: number[] = [], bneg: number[] = [];
for (const j of bigParsed.sentences) {
  const l = labels[j.id]!;
  if (l.page !== NOISE_PAGE) (l.k ? bpos : bneg).push(j.keep);
}
console.log(`\n=== ONE REQUEST, ${nq} questions over all ${PAGES.length} pages: ${big.ms.toFixed(0)} ms, ${big.tokens} in-tokens ≈ ${usd(big.tokens)}, AUC=${auc(bpos, bneg).toFixed(3)}, failed=${bigParsed.failedIds.length}`);

// Determinism: repeat page B.
const pageB = PAGES.find((p) => p.id === "B")!;
const rep = await ask(bodyFor(pageB));
const repParsed = parseAnswers(inputsFor(pageB), rep.answers, true);
let maxDiff = 0;
for (const j of repParsed.sentences) maxDiff = Math.max(maxDiff, Math.abs(j.keep - rows.find((r) => r.page === "B" && r.id === j.id)!.keep));
console.log(`determinism on page B repeat: max |Δp| = ${maxDiff.toFixed(3)}  (${rep.ms.toFixed(0)} ms)`);

console.log(`\n=== QUESTION (verbatim, generic pack) ===`);
console.log(`keep: ${KEEP_QUESTION.instructions("S")}`);
console.log(`  true:  ${KEEP_QUESTION.criteriaTrue}`);
console.log(`  false: ${KEEP_QUESTION.criteriaFalse}`);
console.log(`kind: ${KIND_QUESTION.instructions("S")}  [${Object.keys(SENTENCE_KINDS).join(", ")}]`);
console.log(`page_kind: ${PAGE_KIND_QUESTION.instructions}  [${Object.keys(PAGE_KINDS).join(", ")}]`);

// Top-level await needs a module; the probe exports nothing.
export {};
