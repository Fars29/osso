/**
 * The TypeSafe client for the background worker, and the only code that ever sees the user's key.
 *
 * A page is judged in chunks of at most `maxSentencesPerRequest` sentences (the probe showed 258
 * questions in one 1.3 s request, so ~60 sentences × 2 questions is comfortably fast and cheap),
 * in parallel through a small pool. Each chunk is its own request with its own text as state, so a
 * chunk that fails after retries only leaves its own sentences untouched; the rest of the page
 * still paints. The exact question wording lives in `shared/constants.ts` and is what the probe
 * measured; packs may only append hints to the keep criteria.
 *
 * The user's rules go through the same pool in requests of their own (`judgeRules`): one Noul per
 * rule per sentence over the same state, so a rule added later never re-asks the keep question.
 */
import {
  API_URL,
  KEEP_QUESTION,
  KIND_QUESTION,
  MAX_CONCURRENT_REQUESTS,
  MAX_RETRIES,
  MODEL,
  PAGE_KIND_QUESTION,
  PAGE_KINDS,
  REQUEST_TIMEOUT_MS,
  RULE_QUESTION,
  SENTENCE_KINDS,
} from "../shared/constants.ts";
import type {
  JudgeRequest,
  PageJudgment,
  PageKind,
  PageMeta,
  RuleResults,
  SentenceInput,
  SentenceJudgment,
  SentenceKind,
} from "../shared/types.ts";

/** The slice of a pack the client needs; `src/packs` provides the real thing with routing on top. */
export type PackLike = { id: PageKind; stateHint: string; keepHints?: { true?: string; false?: string } };

export type ApiErrorCode = "no-key" | "invalid-key" | "rate-limited" | "network" | "server" | "timeout";

export class ApiError extends Error {
  override readonly name = "ApiError";
  code: ApiErrorCode;
  status?: number;

  constructor(code: ApiErrorCode, message?: string, status?: number) {
    super(message ?? code);
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/** A chunk's failure, kept plain so the judgment can be stored and messaged as-is. */
export interface ChunkError {
  code: ApiErrorCode;
  status?: number;
  message: string;
}

/** `PageJudgment` plus why chunks failed, so the popup can say "rate-limited" rather than nothing. */
export interface JudgeResult extends PageJudgment {
  chunkErrors: ChunkError[];
}

/** The outcome of `judgeRules`: p(hit) per rule per sentence, plus what `judgePage` reports about its chunks. */
export interface RuleResult {
  rules: RuleResults;
  /** Ids whose chunk failed for every rule asked. */
  failedIds: number[];
  inputTokens: number;
  ms: number;
  chunkErrors: ChunkError[];
}

export interface RequestBody {
  state: { page_kind_hint: string; title: string; language: string; text: string };
  model: string;
  questions: Record<string, unknown>;
}

export interface ParsedChunk {
  sentences: SentenceJudgment[];
  failedIds: number[];
  pageKind?: { kind: PageKind; confidence: number };
}

export interface JudgeOptions {
  apiKey: string;
  maxSentencesPerRequest: number;
  fetchImpl?: typeof fetch;
  concurrency?: number;
  timeoutMs?: number;
  retries?: number;
  /** Injectable so tests can assert the backoff without waiting for it. */
  sleep?: (ms: number) => Promise<void>;
  onChunk?: (partial: { sentences: SentenceJudgment[]; failedIds: number[] }) => void;
}

/**
 * Contiguous, balanced chunks: 130 sentences with max 60 become 44/43/43, never 60/60/10. Equal
 * chunks finish at about the same time, so the last paint is not held up by one tiny straggler
 * queued behind two full requests.
 */
export function chunkSentences(sentences: SentenceInput[], max: number): SentenceInput[][] {
  if (sentences.length === 0) return [];
  const per = Math.max(1, Math.floor(max) || 1);
  const count = Math.ceil(sentences.length / per);
  const base = Math.floor(sentences.length / count);
  let extra = sentences.length % count;
  const chunks: SentenceInput[][] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    const size = base + (extra > 0 ? 1 : 0);
    if (extra > 0) extra--;
    chunks.push(sentences.slice(at, at + size));
    at += size;
  }
  return chunks;
}

function describe<K extends string>(table: Record<K, { description: string }>): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const k of Object.keys(table) as K[]) out[k] = table[k].description;
  return out;
}

const SENTENCE_KIND_CRITERIA = describe(SENTENCE_KINDS);
const PAGE_KIND_CRITERIA = describe(PAGE_KINDS);

/**
 * One request for one chunk. The state is the chunk's own text, so every sentence the questions
 * mention is present in the context the model attends over; the probe showed per-element attention
 * holds at this size.
 */
export function buildRequestBody(chunk: SentenceInput[], meta: PageMeta, pack: PackLike, includePageKind: boolean): RequestBody {
  const criteriaTrue = KEEP_QUESTION.criteriaTrue + (pack.keepHints?.true ? " " + pack.keepHints.true : "");
  const criteriaFalse = KEEP_QUESTION.criteriaFalse + (pack.keepHints?.false ? " " + pack.keepHints.false : "");
  const questions: Record<string, unknown> = {};
  for (const s of chunk) {
    questions[`keep_${s.id}`] = {
      type: "noul",
      instructions: KEEP_QUESTION.instructions(s.text),
      criteria: { true: criteriaTrue, false: criteriaFalse },
    };
    questions[`kind_${s.id}`] = {
      type: "choice",
      instructions: KIND_QUESTION.instructions(s.text),
      criteria: SENTENCE_KIND_CRITERIA,
    };
  }
  if (includePageKind) {
    questions.page_kind = { type: "choice", instructions: PAGE_KIND_QUESTION.instructions, criteria: PAGE_KIND_CRITERIA };
  }
  return {
    state: { page_kind_hint: pack.stateHint, title: meta.title, language: meta.lang, text: chunk.map((s) => s.text).join(" ") },
    model: MODEL,
    questions,
  };
}

function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function isSentenceKind(v: unknown): v is SentenceKind {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(SENTENCE_KINDS, v);
}

function isPageKind(v: unknown): v is PageKind {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(PAGE_KINDS, v);
}

/**
 * A sentence is judged only when both its answers are usable; anything else joins `failedIds` and
 * stays untouched on the page. Defaulting a missing keep would fade text on no evidence.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseAnswers(chunk: SentenceInput[], answers: Record<string, any>, includePageKind: boolean): ParsedChunk {
  const sentences: SentenceJudgment[] = [];
  const failedIds: number[] = [];
  for (const s of chunk) {
    const keep = finite(answers?.[`keep_${s.id}`]?.noul);
    const kindAnswer = answers?.[`kind_${s.id}`];
    const choice: unknown = kindAnswer?.choice;
    if (keep === null || !isSentenceKind(choice)) {
      failedIds.push(s.id);
      continue;
    }
    sentences.push({ id: s.id, keep: clamp01(keep), kind: choice, kindConfidence: clamp01(finite(kindAnswer?.confidence) ?? 0) });
  }
  if (includePageKind) {
    const pk = answers?.page_kind;
    const choice: unknown = pk?.choice;
    if (isPageKind(choice)) return { sentences, failedIds, pageKind: { kind: choice, confidence: clamp01(finite(pk?.confidence) ?? 0) } };
  }
  return { sentences, failedIds };
}

/** Rule questions are keyed by the rule's index in the request, so the rule's text never has to survive a round trip as a key. */
function ruleKey(ri: number, id: number): string {
  return `rule_${ri}_${id}`;
}

/**
 * One request for one chunk, one rule question per rule per sentence. The state is the same as the
 * keep question's, so the model reads the sentence in the same context it was judged in.
 */
export function buildRuleRequestBody(chunk: SentenceInput[], meta: PageMeta, pack: PackLike, rules: string[]): RequestBody {
  const questions: Record<string, unknown> = {};
  rules.forEach((rule, ri) => {
    const criteria = { true: RULE_QUESTION.criteriaTrue(rule), false: RULE_QUESTION.criteriaFalse(rule) };
    for (const s of chunk) {
      questions[ruleKey(ri, s.id)] = { type: "noul", instructions: RULE_QUESTION.instructions(s.text, rule), criteria };
    }
  });
  return {
    state: { page_kind_hint: pack.stateHint, title: meta.title, language: meta.lang, text: chunk.map((s) => s.text).join(" ") },
    model: MODEL,
    questions,
  };
}

/**
 * Rule answers are read per rule and per sentence: a missing one leaves that pair out of the map,
 * so a rule with a partial answer still keeps what it caught. A sentence is failed only when no
 * rule answered for it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseRuleAnswers(chunk: SentenceInput[], answers: Record<string, any>, rules: string[]): { rules: RuleResults; failedIds: number[] } {
  const out: RuleResults = {};
  for (const rule of rules) out[rule] = {};
  const failedIds: number[] = [];
  for (const s of chunk) {
    let answered = false;
    rules.forEach((rule, ri) => {
      const p = finite(answers?.[ruleKey(ri, s.id)]?.noul);
      if (p === null) return;
      out[rule]![s.id] = clamp01(p);
      answered = true;
    });
    if (!answered) failedIds.push(s.id);
  }
  return { rules: out, failedIds };
}

const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 400 ms, 800 ms, 1.6 s, each with up to 200 ms of jitter so parallel chunks do not retry in lockstep. */
function backoffMs(attempt: number): number {
  return 400 * 2 ** attempt + Math.random() * 200;
}

interface RequestContext {
  apiKey: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  retries: number;
  sleep: (ms: number) => Promise<void>;
  /** Fired on a 401 so chunks still in flight stop spending a key we know is bad. */
  pageSignal: AbortSignal;
}

/**
 * One POST with a hard timeout. The timeout is raced rather than only passed as a signal because a
 * fetch that ignores its signal (a stalled proxy, or a test double) must still not hang the page.
 */
async function post(body: unknown, ctx: RequestContext): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ctx.timeoutMs);
  const onPageAbort = () => controller.abort();
  ctx.pageSignal.addEventListener("abort", onPageAbort, { once: true });
  const abortError = () =>
    timedOut ? new ApiError("timeout", `Timed out after ${ctx.timeoutMs} ms`) : new ApiError("network", "Request cancelled");
  const aborted = new Promise<never>((_, reject) => {
    if (controller.signal.aborted) reject(abortError());
    else controller.signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
  aborted.catch(() => undefined);
  try {
    if (ctx.pageSignal.aborted) controller.abort();
    const response = await Promise.race([
      ctx.fetchImpl(API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${ctx.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      }),
      aborted,
    ]);
    const text = await Promise.race([response.text(), aborted]);
    return { status: response.status, text };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (timedOut) throw new ApiError("timeout", `Timed out after ${ctx.timeoutMs} ms`);
    throw new ApiError("network", e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
    ctx.pageSignal.removeEventListener("abort", onPageAbort);
  }
}

interface ApiResponse {
  answers: Record<string, unknown>;
  inputTokens: number;
}

async function requestOnce(body: unknown, ctx: RequestContext): Promise<ApiResponse> {
  const { status, text } = await post(body, ctx);
  if (status === 401) throw new ApiError("invalid-key", "Invalid key", status);
  if (status === 429) throw new ApiError("rate-limited", "Rate limited", status);
  if (status === 422) {
    // A rejected request is a bug in how we built it, not a transient fault: fail the chunk and do
    // not retry what the server has already refused. The body stays out of the console: the API
    // quotes the offending field, which is the page's own text, and nothing of a page is logged.
    console.warn(`[osso] api rejected the request (422, ${text.length} bytes)`);
    throw new ApiError("server", "Request rejected by the API", status);
  }
  if (status >= 500) throw new ApiError("server", `Server error ${status}`, status);
  if (status < 200 || status >= 300) throw new ApiError("server", `Unexpected status ${status}`, status);
  let json: { answers?: unknown; usage?: { input_tokens?: unknown } };
  try {
    json = JSON.parse(text);
  } catch {
    // Usually a captive portal or proxy page in place of the API: no status, so it is retried.
    throw new ApiError("server", "Malformed response body");
  }
  const answers = json.answers && typeof json.answers === "object" ? (json.answers as Record<string, unknown>) : {};
  return { answers, inputTokens: finite(json.usage?.input_tokens) ?? 0 };
}

/** Transient faults retry; a bad key, a rejected request and other 4xx are final on first sight. */
function isRetryable(err: ApiError): boolean {
  if (err.code === "rate-limited" || err.code === "timeout" || err.code === "network") return true;
  return err.code === "server" && (err.status === undefined || err.status >= 500);
}

async function requestWithRetry(body: unknown, ctx: RequestContext): Promise<ApiResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestOnce(body, ctx);
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError("network", e instanceof Error ? e.message : String(e));
      if (ctx.pageSignal.aborted || !isRetryable(err) || attempt >= ctx.retries) throw err;
      await ctx.sleep(backoffMs(attempt));
    }
  }
}

function toChunkError(err: ApiError): ChunkError {
  return err.status === undefined ? { code: err.code, message: err.message } : { code: err.code, status: err.status, message: err.message };
}

function contextFor(opts: Omit<JudgeOptions, "onChunk">, pageSignal: AbortSignal): RequestContext {
  return {
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl ?? defaultFetch,
    timeoutMs: opts.timeoutMs ?? REQUEST_TIMEOUT_MS,
    retries: opts.retries ?? MAX_RETRIES,
    sleep: opts.sleep ?? defaultSleep,
    pageSignal,
  };
}

/** How one kind of request turns a chunk into a body and an answer into a result. */
interface ChunkPlan<T> {
  build(chunk: SentenceInput[], index: number): unknown;
  parse(chunk: SentenceInput[], answers: Record<string, unknown>, index: number): T;
  /** What a chunk yields when its request failed after every retry. */
  failed(chunk: SentenceInput[]): T;
  onChunk?: (result: T) => void;
}

interface PoolResult<T> {
  results: (T | undefined)[];
  chunkErrors: ChunkError[];
  inputTokens: number;
}

/**
 * Runs every chunk through a pool of `concurrency` workers. `onChunk` fires as each chunk
 * settles, success or failure, so a caller can paint progressively. Only a bad key throws: it is
 * fatal for the page, and chunks still in flight are aborted so no more of it is spent.
 * Everything else degrades to the plan's `failed` result, and the page stays readable.
 */
async function runPool<T>(chunks: SentenceInput[][], plan: ChunkPlan<T>, opts: Omit<JudgeOptions, "onChunk">): Promise<PoolResult<T>> {
  const pageAbort = new AbortController();
  const ctx = contextFor(opts, pageAbort.signal);
  const results: (T | undefined)[] = new Array(chunks.length);
  const chunkErrors: ChunkError[] = [];
  let inputTokens = 0;
  let fatal: ApiError | undefined;
  let next = 0;

  async function worker(): Promise<void> {
    while (next < chunks.length && !fatal) {
      const i = next++;
      const chunk = chunks[i]!;
      let result: T;
      try {
        const res = await requestWithRetry(plan.build(chunk, i), ctx);
        inputTokens += res.inputTokens;
        result = plan.parse(chunk, res.answers, i);
      } catch (e) {
        if (fatal) return;
        const err = e instanceof ApiError ? e : new ApiError("network", e instanceof Error ? e.message : String(e));
        if (err.code === "invalid-key") {
          fatal = err;
          pageAbort.abort();
          return;
        }
        chunkErrors.push(toChunkError(err));
        result = plan.failed(chunk);
      }
      results[i] = result;
      plan.onChunk?.(result);
    }
  }

  const workers = Math.max(1, Math.min(opts.concurrency ?? MAX_CONCURRENT_REQUESTS, chunks.length));
  await Promise.all(Array.from({ length: workers }, worker));
  if (fatal) throw fatal;
  return { results, chunkErrors, inputTokens };
}

/**
 * Judge a whole page: keep and kind per sentence, and `page_kind` on the first chunk. Chunks,
 * failures and a bad key are handled by `runPool`.
 */
export async function judgePage(req: JudgeRequest, pack: PackLike, opts: JudgeOptions): Promise<JudgeResult> {
  if (!opts.apiKey) throw new ApiError("no-key", "No API key");
  const t0 = performance.now();
  const chunks = chunkSentences(req.sentences, opts.maxSentencesPerRequest);
  const plan: ChunkPlan<ParsedChunk> = {
    build: (chunk, i) => buildRequestBody(chunk, req.meta, pack, i === 0),
    parse: (chunk, answers, i) => parseAnswers(chunk, answers, i === 0),
    failed: (chunk) => ({ sentences: [], failedIds: chunk.map((s) => s.id) }),
  };
  const onChunk = opts.onChunk;
  if (onChunk) plan.onChunk = (r) => onChunk({ sentences: r.sentences, failedIds: r.failedIds });
  const { results, chunkErrors, inputTokens } = await runPool(chunks, plan, opts);

  const sentences: SentenceJudgment[] = [];
  const failedIds: number[] = [];
  for (const p of results) {
    if (!p) continue;
    sentences.push(...p.sentences);
    failedIds.push(...p.failedIds);
  }
  const pageKind = results[0]?.pageKind ?? { kind: pack.id, confidence: 0 };
  return {
    packId: pack.id,
    pageKind: pageKind.kind,
    pageKindConfidence: pageKind.confidence,
    sentences,
    inputTokens,
    ms: Math.round(performance.now() - t0),
    cached: false,
    failedIds,
    chunkErrors,
  };
}

/**
 * The keep judgment asks two questions per sentence; a rule request asks one per rule. The chunk
 * shrinks with the number of rules so a request carries about as many questions as a keep
 * request does, and answers in about the same time.
 */
export function ruleChunkSize(maxSentencesPerRequest: number, ruleCount: number): number {
  const max = Math.max(1, Math.floor(maxSentencesPerRequest) || 1);
  return Math.max(1, Math.min(max, Math.floor((max * 2) / Math.max(1, ruleCount))));
}

/**
 * Judge the user's rules on a page already judged: p(hit) per rule per sentence, through the same
 * pool, retries and key handling as `judgePage`. A rule whose every chunk failed is still present
 * in the map, empty; `failedIds` says which sentences got no answer at all.
 */
export async function judgeRules(
  req: JudgeRequest,
  pack: PackLike,
  rules: string[],
  opts: Omit<JudgeOptions, "onChunk">,
): Promise<RuleResult> {
  if (!opts.apiKey) throw new ApiError("no-key", "No API key");
  const t0 = performance.now();
  const merged: RuleResults = {};
  for (const rule of rules) merged[rule] = {};
  if (rules.length === 0 || req.sentences.length === 0) return { rules: merged, failedIds: [], inputTokens: 0, ms: 0, chunkErrors: [] };
  const chunks = chunkSentences(req.sentences, ruleChunkSize(opts.maxSentencesPerRequest, rules.length));
  const plan: ChunkPlan<{ rules: RuleResults; failedIds: number[] }> = {
    build: (chunk) => buildRuleRequestBody(chunk, req.meta, pack, rules),
    parse: (chunk, answers) => parseRuleAnswers(chunk, answers, rules),
    failed: (chunk) => ({ rules: {}, failedIds: chunk.map((s) => s.id) }),
  };
  const { results, chunkErrors, inputTokens } = await runPool(chunks, plan, opts);
  const failedIds: number[] = [];
  for (const r of results) {
    if (!r) continue;
    failedIds.push(...r.failedIds);
    for (const [rule, byId] of Object.entries(r.rules)) Object.assign(merged[rule]!, byId);
  }
  return { rules: merged, failedIds, inputTokens, ms: Math.round(performance.now() - t0), chunkErrors };
}

/** The options page's "test key": the smallest possible request, no retries, a plain verdict. */
export async function testKey(apiKey: string, fetchImpl?: typeof fetch): Promise<{ ok: boolean; ms: number; error?: string }> {
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);
  if (!apiKey) return { ok: false, ms: 0, error: "No API key" };
  const ctx: RequestContext = {
    apiKey,
    fetchImpl: fetchImpl ?? defaultFetch,
    timeoutMs: REQUEST_TIMEOUT_MS,
    retries: 0,
    sleep: defaultSleep,
    pageSignal: new AbortController().signal,
  };
  const body = {
    state: "ok",
    model: MODEL,
    questions: { check: { type: "noul", instructions: "Is this text the word ok?" } },
  };
  try {
    await requestOnce(body, ctx);
    return { ok: true, ms: elapsed() };
  } catch (e) {
    const err = e instanceof ApiError ? e : new ApiError("network", e instanceof Error ? e.message : String(e));
    return { ok: false, ms: elapsed(), error: err.message };
  }
}
