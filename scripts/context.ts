/**
 * What should the model see beside the sentence it judges? Replays real pages (dumped by
 * `e2e/dump.mjs`) against the API with different states and prints where the decisions differ:
 *
 *   none     no text at all: the title, the language and the page-kind hint only
 *   chunk    what ships today: the state's text is the chunk's own ≤30 sentences
 *   shift    as chunk, with the chunks cut 15 sentences later: the sentences that open a chunk become interior ones
 *   window   the chunk, and in a field of its own the five sentences that come just before it
 *   page     the whole page as plain text (a window around the chunk if the page is very long)
 *   outline  the chunk, plus the page's headings and lead in the state and the sentence's heading in the question
 *   full     the whole page with its headings inline, and the sentence's heading in the question
 *
 * There is no ground truth on a live page, so the output is for reading: every sentence whose
 * decision flips between variants, with each variant's p(keep). The state is billed once per
 * request (measured), so the cost of a bigger state is its tokens × the number of chunks.
 *
 * Run: node --env-file=.env scripts/context.ts [host…] [--variants=chunk,page] [--reuse]
 * Results: e2e/.scratch/context/<host>.json, and docs/calibration.md for the conclusions
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { API_URL, DEFAULT_THRESHOLD, KEEP_QUESTION, MAX_SENTENCES_PER_REQUEST } from "../src/shared/constants.ts";
import { buildRequestBody, chunkSentences, parseAnswers, type RequestBody } from "../src/background/api.ts";
import { getPack } from "../src/packs/index.ts";
import type { PageKind, PageMeta, SentenceInput } from "../src/shared/types.ts";

const KEY = process.env.TYPESAFE_API_KEY;
if (!KEY) throw new Error("TYPESAFE_API_KEY missing");

type Dumped = { id: number; text: string; heading: string; block: string };
type Dump = { url: string; host: string; packId: PageKind; title: string; lang: string; sentences: Dumped[] };
type Variant = "none" | "shift" | "window" | "chunk" | "page" | "outline" | "full";
type Run = { tokens: number; ms: number; requests: number; keep: Record<number, number> };

const root = resolve(import.meta.dirname, "..");
const pagesDir = join(root, "e2e", ".scratch", "pages");
const outDir = join(root, "e2e", ".scratch", "context");
mkdirSync(outDir, { recursive: true });

const args = process.argv.slice(2);
const reuse = args.includes("--reuse");
const variants = (args.find((a) => a.startsWith("--variants="))?.slice(11).split(",") ?? ["chunk", "page", "outline", "full"]) as Variant[];
const hosts = args.filter((a) => !a.startsWith("--"));

/** ~4 characters a token; the state may be 32k tokens, and the questions need their share of the 64k. */
const STATE_CHAR_CAP = 80_000;

/** The page as text, optionally with each heading on its own line where it changes; cut to a window around the chunk when too long. */
function pageText(dump: Dump, chunk: SentenceInput[], withHeadings: boolean): string {
  const first = dump.sentences.findIndex((s) => s.id === chunk[0]!.id);
  const last = dump.sentences.findIndex((s) => s.id === chunk[chunk.length - 1]!.id);
  let lo = 0;
  let hi = dump.sentences.length - 1;
  const size = (a: number, b: number) => dump.sentences.slice(a, b + 1).reduce((n, s) => n + s.text.length + 1, 0);
  while (size(lo, hi) > STATE_CHAR_CAP && (lo < first || hi > last)) {
    if (first - lo >= hi - last && lo < first) lo++;
    else if (hi > last) hi--;
    else lo++;
  }
  const parts: string[] = [];
  let heading = "";
  for (const s of dump.sentences.slice(lo, hi + 1)) {
    if (withHeadings && s.heading !== heading) {
      heading = s.heading;
      if (heading) parts.push(`\n## ${heading}\n`);
    }
    parts.push(s.text);
  }
  return parts.join(" ").trim();
}

function outline(dump: Dump): string[] {
  const seen: string[] = [];
  for (const s of dump.sentences) if (s.heading && seen[seen.length - 1] !== s.heading) seen.push(s.heading);
  return seen;
}

const underHeading = (sentence: string, heading: string): string =>
  heading
    ? KEEP_QUESTION.instructions(sentence).replace("Consider this sentence from the page:", `Consider this sentence from the page, found under the heading «${heading}»:`)
    : KEEP_QUESTION.instructions(sentence);

function build(variant: Variant, dump: Dump, chunk: SentenceInput[], meta: PageMeta): RequestBody {
  const body = buildRequestBody(chunk, meta, getPack(dump.packId), false);
  const state = body.state as Record<string, unknown>;
  const headingOf = new Map(dump.sentences.map((s) => [s.id, s.heading]));
  if (variant === "none") delete state.text;
  if (variant === "window") {
    const first = dump.sentences.findIndex((x) => x.id === chunk[0]!.id);
    const before = dump.sentences.slice(Math.max(0, first - 5), first).map((x) => x.text).join(" ");
    if (before) body.state = { ...body.state, text_just_before: before } as RequestBody["state"];
  }
  if (variant === "page") state.text = pageText(dump, chunk, false);
  if (variant === "full") state.text = pageText(dump, chunk, true);
  if (variant === "outline") {
    state.headings = outline(dump);
    state.lead = dump.sentences.slice(0, 3).map((s) => s.text).join(" ").slice(0, 600);
    state.text = pageText({ ...dump, sentences: dump.sentences.filter((s) => chunk.some((c) => c.id === s.id)) }, chunk, true);
  }
  if (variant === "outline" || variant === "full") {
    for (const s of chunk) {
      const q = body.questions[`keep_${s.id}`] as { instructions: string };
      q.instructions = underHeading(s.text, headingOf.get(s.id) ?? "");
    }
  }
  return body;
}

async function post(body: RequestBody): Promise<{ answers: Record<string, unknown>; tokens: number; ms: number }> {
  for (let attempt = 0; ; attempt++) {
    const t0 = performance.now();
    try {
      const res = await fetch(API_URL, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as { answers: Record<string, unknown>; usage?: { input_tokens?: number } };
      return { answers: json.answers, tokens: json.usage?.input_tokens ?? 0, ms: performance.now() - t0 };
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

async function run(variant: Variant, dump: Dump): Promise<Run> {
  const meta: PageMeta = { url: dump.url, host: dump.host, title: dump.title, lang: dump.lang, jsonLdTypes: [], ogType: null, sample: "", sentenceCount: dump.sentences.length };
  const all = dump.sentences.map(({ id, text }) => ({ id, text }));
  const chunks = variant === "shift" ? [all.slice(0, 15), ...chunkSentences(all.slice(15), MAX_SENTENCES_PER_REQUEST)].filter((c) => c.length > 0) : chunkSentences(all, MAX_SENTENCES_PER_REQUEST);
  const out: Run = { tokens: 0, ms: 0, requests: chunks.length, keep: {} };
  const t0 = performance.now();
  let next = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (next < chunks.length) {
        const chunk = chunks[next++]!;
        const r = await post(build(variant, dump, chunk, meta));
        out.tokens += r.tokens;
        for (const s of parseAnswers(chunk, r.answers as Record<string, never>, false).sentences) out.keep[s.id] = s.keep;
      }
    }),
  );
  out.ms = Math.round(performance.now() - t0);
  return out;
}

const files = readdirSync(pagesDir).filter((f) => f.endsWith(".json") && (hosts.length === 0 || hosts.some((h) => f.includes(h))));
for (const file of files) {
  const dump = JSON.parse(readFileSync(join(pagesDir, file), "utf8")) as Dump;
  const saved = join(outDir, file);
  const runs: Partial<Record<Variant, Run>> = reuse && existsSync(saved) ? JSON.parse(readFileSync(saved, "utf8")) : {};
  for (const v of variants) if (!runs[v]) runs[v] = await run(v, dump);
  writeFileSync(saved, JSON.stringify(runs));

  const base = runs.chunk!;
  console.log(`\n${"=".repeat(110)}\n${dump.host}  (${dump.sentences.length} sentences, pack ${dump.packId}, ${outline(dump).length} headings)`);
  for (const v of variants) {
    const r = runs[v]!;
    const ids = Object.keys(r.keep).map(Number);
    const grey = ids.filter((id) => r.keep[id]! < DEFAULT_THRESHOLD).length;
    const toGrey = ids.filter((id) => r.keep[id]! < DEFAULT_THRESHOLD && (base.keep[id] ?? 1) >= DEFAULT_THRESHOLD).length;
    const toInk = ids.filter((id) => r.keep[id]! >= DEFAULT_THRESHOLD && (base.keep[id] ?? 0) < DEFAULT_THRESHOLD).length;
    const drift = ids.reduce((n, id) => n + Math.abs(r.keep[id]! - (base.keep[id] ?? r.keep[id]!)), 0) / Math.max(1, ids.length);
    const unsure = ids.filter((id) => r.keep[id]! > 0.2 && r.keep[id]! < 0.8).length;
    console.log(`  ${v.padEnd(8)} ${String(r.tokens).padStart(7)} tok  ${String(r.ms).padStart(6)} ms  grey ${String(grey).padStart(3)}  vs chunk: +${toGrey} grey, +${toInk} ink  mean|Δp| ${drift.toFixed(3)}  unsure(0.2–0.8) ${unsure}`);
  }
  // Every sentence some variant decides differently from another, in page order.
  const flips = dump.sentences.filter((s) => {
    const sides = variants.map((v) => (runs[v]!.keep[s.id] ?? 1) < DEFAULT_THRESHOLD);
    return sides.some((x) => x !== sides[0]);
  });
  console.log(`  --- decisions that differ (${flips.length}) ---   ${variants.join(" / ")}`);
  for (const s of flips) {
    const ps = variants.map((v) => (runs[v]!.keep[s.id] ?? NaN).toFixed(2)).join(" / ");
    console.log(`  ${ps}  [${s.heading.slice(0, 28)}]  ${s.text.slice(0, 190)}`);
  }
}
