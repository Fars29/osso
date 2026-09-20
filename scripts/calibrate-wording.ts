/**
 * The e2e screenshot showed a real flaw: step 8 of the recipe ("do not add the lemon while the pan
 * is on the heat") was faded because the same fact appears in the (faded) introduction. Our keep
 * question asks whether the reader would lose information "that the rest of the page does not
 * already give them", so two sentences that say the same thing can eliminate each other.
 *
 * This compares three wordings on pages built to trigger that trap, plus three of the original
 * calibration pages so we can see whether dropping the redundancy clause costs separation.
 *
 * Run: node --env-file=.env scripts/calibrate-wording.ts
 */
const KEY = process.env.TYPESAFE_API_KEY;
if (!KEY) throw new Error("TYPESAFE_API_KEY missing");
const API = "https://api.typesafe.ai/v1/systemone";
export {};

type Sent = { t: string; k: 0 | 1; tag?: string };
type Page = { id: string; kind: string; title: string; lang: string; s: Sent[] };

const PAGES: Page[] = [
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
  { id: "A", kind: "recipe blog", lang: "en", title: "The Best One-Pot Lemon Chicken Orzo", s: [
    { k: 0, t: "Every summer, my grandmother would open the windows of her kitchen in Liguria and the whole street would know what was for dinner." },
    { k: 0, t: "I still remember the smell of lemons on her hands." },
    { k: 0, t: "It has become a weeknight staple in our house, and my kids ask for it at least twice a week." },
    { k: 0, t: "If you make it, please tag me on Instagram, I love seeing your photos!" },
    { k: 0, t: "Be sure to scroll down for the printable recipe card and a few reader questions I've answered below." },
    { k: 0, t: "I've partnered with my favorite olive oil brand this month, and you can get 15% off with my code." },
    { k: 1, t: "You will need 500 g of boneless chicken thighs, 300 g of orzo, one lemon, and 750 ml of chicken stock." },
    { k: 1, t: "Sear the chicken skin-side down for 6 minutes without moving it, or it will not brown." },
    { k: 1, t: "Simmer uncovered for 12 to 14 minutes, stirring every few minutes so the orzo does not stick to the bottom." },
    { k: 1, t: "Do not add the lemon juice until the heat is off, or the sauce will turn bitter." },
  ]},
  { id: "C", kind: "terms of service", lang: "en", title: "Terms of Service", s: [
    { k: 0, t: "Please read these Terms carefully." },
    { k: 0, t: "By accessing or using the Service, you agree to be bound by these Terms." },
    { k: 0, t: "We may update these Terms from time to time." },
    { k: 0, t: "Headings are for convenience only and do not affect interpretation." },
    { k: 1, t: "Your subscription will automatically renew at the end of each billing period unless you cancel at least 24 hours before the renewal date." },
    { k: 1, t: "Any dispute will be resolved by binding individual arbitration, and you waive the right to participate in a class action." },
    { k: 1, t: "If you cancel an annual plan before the end of the term, a cancellation fee equal to two months of service applies." },
    { k: 1, t: "Refunds are not provided for partial billing periods." },
  ]},
  { id: "E", kind: "news article", lang: "en", title: "City council approves new tram line", s: [
    { k: 1, t: "The city council voted 24 to 9 on Tuesday to approve a 12-kilometre tram line connecting the airport to the central station." },
    { k: 1, t: "Construction is scheduled to begin in March 2027 and to take four years." },
    { k: 1, t: "Fares will be the same as the existing metro, €1.70 per ride." },
    { k: 0, t: "The vote came after a long and at times heated debate that stretched well past midnight." },
    { k: 0, t: "Supporters in the public gallery applauded as the result was announced." },
    { k: 0, t: "It remains to be seen whether the ambitious timeline will hold." },
    { k: 0, t: "The mayor, visibly tired, thanked everyone for their patience." },
  ]},
];

const VARIANTS = {
  A_current: (s: string) => ({
    instructions: `Consider this sentence from the page: «${s}». If this sentence were deleted, would a reader who came to this page for its practical content lose information that the rest of the page does not already give them?`,
    criteria: {
      true: "Yes: the sentence states a fact, figure, date, step, condition, cost, obligation, decision or warning that the reader needs and that is not stated elsewhere on the page.",
      false: "No: the sentence is a story, opinion, greeting, thanks, reassurance, navigation hint, promotion, or it restates something the page already says; deleting it loses nothing practical.",
    },
  }),
  B_no_redundancy: (s: string) => ({
    instructions: `Consider this sentence from the page: «${s}». Does this sentence itself carry practical content the reader came to this page for?`,
    criteria: {
      true: "Yes: the sentence states a fact, figure, date, quantity, step, condition, cost, obligation, decision or warning that the reader needs, even if the page says it again elsewhere.",
      false: "No: the sentence is a story, memory, opinion, greeting, thanks, reassurance, navigation hint or promotion; a reader looking for the practical content would skip it.",
    },
  }),
  C_role: (s: string) => ({
    instructions: `Consider this sentence from the page: «${s}». Is this sentence part of the page's practical content (what the reader came for), rather than its framing (story, feelings, thanks, promotion, navigation)?`,
    criteria: {
      true: "Yes: it is an ingredient, quantity, step, warning, fact, figure, date, price, condition, obligation or decision. Repeating something said elsewhere does not make it framing.",
      false: "No: it is framing: a memory or story, an opinion or praise, a greeting or thanks, reassurance, a request to share, comment or subscribe, a sponsor mention, or a hint about where to scroll.",
    },
  }),
};

async function ask(state: unknown, questions: Record<string, unknown>) {
  const t0 = performance.now();
  const r = await fetch(API, { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ state, model: "jev-latest", questions }) });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return { ms: performance.now() - t0, ...(await r.json()) };
}
function auc(pos: number[], neg: number[]) { let w = 0; for (const p of pos) for (const n of neg) w += p > n ? 1 : p === n ? 0.5 : 0; return w / (pos.length * neg.length); }
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

const names = Object.keys(VARIANTS) as Array<keyof typeof VARIANTS>;
const all: Record<string, { pos: number[]; neg: number[] }> = Object.fromEntries(names.map((n) => [n, { pos: [], neg: [] }]));

for (const page of PAGES) {
  const q: Record<string, unknown> = {};
  page.s.forEach((s, i) => { for (const n of names) q[`${n}_${i}`] = { type: "noul", ...VARIANTS[n](s.t) }; });
  const res = await ask({ page_kind_hint: page.kind, title: page.title, language: page.lang, text: page.s.map((x) => x.t).join(" ") }, q);
  console.log(`\n=== ${page.id} ${page.kind} — ${res.ms.toFixed(0)} ms — ${res.usage.input_tokens} tok`);
  console.log(`  ${"".padEnd(5)} ${names.map((n) => n.padEnd(16)).join("")} sentence`);
  page.s.forEach((s, i) => {
    const ps = names.map((n) => res.answers[`${n}_${i}`].noul as number);
    names.forEach((n, j) => (s.k ? all[n]!.pos : all[n]!.neg).push(ps[j]!));
    const flag = s.tag ? `<${s.tag}>` : "";
    console.log(`  ${s.k ? "KEEP " : "     "} ${ps.map((p) => p.toFixed(2).padEnd(16)).join("")} ${s.t.slice(0, 70)} ${flag}`);
  });
  for (const n of names) {
    const pos = page.s.map((s, i) => [s.k, res.answers[`${n}_${i}`].noul]).filter((x) => x[0]).map((x) => x[1] as number);
    const neg = page.s.map((s, i) => [s.k, res.answers[`${n}_${i}`].noul]).filter((x) => !x[0]).map((x) => x[1] as number);
    console.log(`  ${n}: AUC=${auc(pos, neg).toFixed(3)} keep=${mean(pos).toFixed(2)} filler=${mean(neg).toFixed(2)} min-keep=${Math.min(...pos).toFixed(2)} max-filler=${Math.max(...neg).toFixed(2)}`);
  }
}
console.log("\n=== OVERALL ===");
for (const n of names) console.log(`${n.padEnd(16)} AUC=${auc(all[n]!.pos, all[n]!.neg).toFixed(3)}  keep=${mean(all[n]!.pos).toFixed(2)} filler=${mean(all[n]!.neg).toFixed(2)}  min-keep=${Math.min(...all[n]!.pos).toFixed(2)} max-filler=${Math.max(...all[n]!.neg).toFixed(2)}`);
