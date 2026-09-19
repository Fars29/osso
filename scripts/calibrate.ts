/**
 * Field probe for Osso's core judgment: does Jev separate substance from filler,
 * sentence by sentence, with the whole page as context — and how fast, at what cost,
 * with N sentences per request?
 *
 * Run: node --env-file=../Draw/.env scripts/probe.ts
 */
const KEY = process.env.TYPESAFE_API_KEY;
if (!KEY) throw new Error("TYPESAFE_API_KEY missing");
const URL = "https://api.typesafe.ai/v1/systemone";

type Sent = { t: string; k: 0 | 1 };
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
];

const KINDS = {
  fact: "A verifiable statement about what happened, what is, or what will happen: who, what, when, where, how much.",
  figure_or_date: "A quantity, price, measurement, percentage, date, deadline or time is the point of the sentence.",
  instruction_or_step: "Something the reader must do or how to do it, including warnings about what not to do.",
  condition_or_obligation: "A rule, right, obligation, fee, penalty, or condition that binds the reader or the writer.",
  opinion: "The writer's judgment, feeling or evaluation; not checkable.",
  anecdote_or_story: "Personal memories, stories, scene-setting, emotional colour.",
  filler_or_transition: "Greetings, thanks, generic reassurance, navigation hints, 'scroll down', 'read carefully', throat-clearing.",
  promotion_or_appeal: "Asks the reader to follow, share, subscribe, buy or comment, or promotes a product, brand or person.",
};

function questionsFor(page: Page, prefix = "") {
  const q: Record<string, unknown> = {};
  page.s.forEach((s, i) => {
    q[`${prefix}keepq_${i}`] = {
      type: "noul",
      instructions: `Consider this sentence from the page: «${s.t}». If this sentence were deleted, would a reader who came to this page for its practical content lose information that the rest of the page does not already give them?`,
      criteria: {
        true: "Yes: the sentence states a fact, figure, date, step, condition, cost, obligation, decision or warning that the reader needs and that is not stated elsewhere on the page.",
        false: "No: the sentence is a story, opinion, greeting, thanks, reassurance, navigation hint, promotion, or it restates something the page already says; deleting it loses nothing practical.",
      },
    };
    q[`${prefix}keeps_${i}`] = {
      type: "noul",
      instructions: `Sentence from the page: «${s.t}». This sentence carries information the reader came for: a fact, number, date, step, condition, cost, obligation, decision or warning that the rest of the page does not already state.`,
    };
    q[`${prefix}kind_${i}`] = {
      type: "choice",
      instructions: `What kind of sentence is this one from the page: «${s.t}»?`,
      criteria: KINDS,
    };
  });
  return q;
}

function stateFor(page: Page) {
  return { page_kind_hint: page.kind, title: page.title, language: page.lang, text: page.s.map((x) => x.t).join(" ") };
}

async function ask(state: unknown, questions: Record<string, unknown>) {
  const t0 = performance.now();
  const r = await fetch(URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ state, model: "jev-latest", questions }),
  });
  const ms = performance.now() - t0;
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  const j = await r.json();
  return { ms, ...j };
}

function auc(pos: number[], neg: number[]) {
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return pos.length && neg.length ? wins / (pos.length * neg.length) : NaN;
}
function mean(xs: number[]) { return xs.reduce((a, b) => a + b, 0) / (xs.length || 1); }
function bestThreshold(pos: number[], neg: number[]) {
  let best = { t: 0.5, acc: 0 };
  for (let t = 0.05; t < 1; t += 0.05) {
    const acc = (pos.filter((p) => p >= t).length + neg.filter((n) => n < t).length) / (pos.length + neg.length);
    if (acc > best.acc) best = { t: Number(t.toFixed(2)), acc: Number(acc.toFixed(3)) };
  }
  return best;
}

const rows: Array<{ page: string; k: number; q: number; s: number; kind: string; kconf: number; t: string }> = [];
let totalMs = 0, totalTok = 0;

for (const page of PAGES) {
  const res = await ask(stateFor(page), questionsFor(page));
  totalMs += res.ms; totalTok += res.usage.input_tokens;
  console.log(`\n=== ${page.id} ${page.kind} (${page.lang}) — ${page.s.length} sentences × 3 q = ${page.s.length * 3} questions — ${res.ms.toFixed(0)} ms — ${res.usage.input_tokens} in-tokens`);
  page.s.forEach((s, i) => {
    const a = res.answers;
    rows.push({ page: page.id, k: s.k, q: a[`keepq_${i}`].noul, s: a[`keeps_${i}`].noul, kind: a[`kind_${i}`].choice, kconf: a[`kind_${i}`].confidence, t: s.t });
  });
  const pr = rows.filter((r) => r.page === page.id).sort((a, b) => b.q - a.q);
  for (const r of pr) console.log(`  ${r.k ? "KEEP" : "    "}  q=${r.q.toFixed(2)} s=${r.s.toFixed(2)}  ${r.kind.padEnd(24)} ${r.t.slice(0, 90)}`);
  const pos = pr.filter((r) => r.k).map((r) => r.q), neg = pr.filter((r) => !r.k).map((r) => r.q);
  if (pos.length && neg.length) console.log(`  AUC(q)=${auc(pos, neg).toFixed(3)}  AUC(s)=${auc(pr.filter((r) => r.k).map((r) => r.s), pr.filter((r) => !r.k).map((r) => r.s)).toFixed(3)}  mean keep=${mean(pos).toFixed(2)} mean filler=${mean(neg).toFixed(2)}`);
  else console.log(`  noise floor: mean q=${mean(pr.map((r) => r.q)).toFixed(2)} max=${Math.max(...pr.map((r) => r.q)).toFixed(2)}  mean s=${mean(pr.map((r) => r.s)).toFixed(2)}`);
}

const labelled = rows.filter((r) => r.page !== "H");
const pos = labelled.filter((r) => r.k), neg = labelled.filter((r) => !r.k);
console.log(`\n=== OVERALL (${labelled.length} labelled sentences, ${pos.length} keep / ${neg.length} filler) ===`);
console.log(`AUC question-form = ${auc(pos.map((r) => r.q), neg.map((r) => r.q)).toFixed(3)}   best threshold ${JSON.stringify(bestThreshold(pos.map((r) => r.q), neg.map((r) => r.q)))}`);
console.log(`AUC statement-form = ${auc(pos.map((r) => r.s), neg.map((r) => r.s)).toFixed(3)}   best threshold ${JSON.stringify(bestThreshold(pos.map((r) => r.s), neg.map((r) => r.s)))}`);
console.log(`mean keep q=${mean(pos.map((r) => r.q)).toFixed(2)} filler q=${mean(neg.map((r) => r.q)).toFixed(2)}   |   noise floor (page H) q=${mean(rows.filter((r) => r.page === "H").map((r) => r.q)).toFixed(2)}`);
const keepKinds = ["fact", "figure_or_date", "instruction_or_step", "condition_or_obligation"];
console.log(`kind proxy: keep→substantive kinds = ${(pos.filter((r) => keepKinds.includes(r.kind)).length / pos.length * 100).toFixed(0)}%   filler→non-substantive kinds = ${(neg.filter((r) => !keepKinds.includes(r.kind)).length / neg.length * 100).toFixed(0)}%`);
console.log(`total: ${totalMs.toFixed(0)} ms sequential over ${PAGES.length} requests, ${totalTok} input tokens ≈ $${(totalTok / 1e6 * 0.042).toFixed(5)}`);

// Scaling: everything in ONE request.
const bigState = { pages: PAGES.map((p) => stateFor(p)) };
let bigQ: Record<string, unknown> = {};
for (const p of PAGES) bigQ = { ...bigQ, ...questionsFor(p, `${p.id}_`) };
const nq = Object.keys(bigQ).length;
const big = await ask(bigState, bigQ);
const bpos: number[] = [], bneg: number[] = [];
for (const p of PAGES) if (p.id !== "H") p.s.forEach((s, i) => (s.k ? bpos : bneg).push(big.answers[`${p.id}_keepq_${i}`].noul));
console.log(`\n=== ONE REQUEST, ${nq} questions over all pages: ${big.ms.toFixed(0)} ms, ${big.usage.input_tokens} in-tokens ≈ $${(big.usage.input_tokens / 1e6 * 0.042).toFixed(5)}, AUC(q)=${auc(bpos, bneg).toFixed(3)}`);

// Determinism: repeat page B.
const rep = await ask(stateFor(PAGES[1]), questionsFor(PAGES[1]));
let maxDiff = 0;
PAGES[1].s.forEach((s, i) => { maxDiff = Math.max(maxDiff, Math.abs(rep.answers[`keepq_${i}`].noul - rows.find((r) => r.page === "B" && r.t === s.t)!.q)); });
console.log(`determinism on page B repeat: max |Δp| = ${maxDiff.toFixed(3)}  (${rep.ms.toFixed(0)} ms)`);
