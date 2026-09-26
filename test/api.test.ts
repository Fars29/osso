import { describe, expect, it, vi } from "vitest";
import { API_URL, HIGHLIGHT_UNIT_QUESTION, KEEP_QUESTION, MODEL, PAGE_KINDS, RULE_QUESTION, SENTENCE_KINDS } from "../src/shared/constants.ts";
import type { JudgeRequest, PageMeta, SentenceInput } from "../src/shared/types.ts";
import {
  ApiError,
  buildRequestBody,
  buildRuleRequestBody,
  chunkSentences,
  highlightClauses,
  judgeHighlights,
  pickClauses,
  judgePage,
  judgeRules,
  parseAnswers,
  parseRuleAnswers,
  ruleChunkSize,
  testKey,
  type PackLike,
} from "../src/background/api.ts";

const meta: PageMeta = {
  url: "https://example.com/orzo",
  host: "example.com",
  title: "The Best One-Pot Lemon Chicken Orzo",
  lang: "en",
  jsonLdTypes: ["recipe"],
  ogType: "article",
  sample: "Every summer, my grandmother…",
  sentenceCount: 14,
};

const recipePack: PackLike = {
  id: "recipe",
  stateHint: "recipe blog",
  keepHints: { true: "Ingredients, quantities and cooking steps count.", false: "The story before the recipe does not." },
};

const barePack: PackLike = { id: "other", stateHint: "web page" };

function sents(n: number, from = 0): SentenceInput[] {
  return Array.from({ length: n }, (_, i) => ({ id: from + i, text: `Sentence number ${from + i} says something.` }));
}

function request(sentences: SentenceInput[]): JudgeRequest {
  return { meta, packId: "recipe", contentHash: "abc", sentences };
}

/** A minimal Response stand-in; the client only reads `status` and `text()`. */
function reply(status: number, body: unknown): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text } as unknown as Response;
}

type RequestBodyShape = { state: { text: string }; questions: Record<string, unknown> };

function bodyOf(init: RequestInit | undefined): RequestBodyShape {
  return JSON.parse(String(init?.body)) as RequestBodyShape;
}

function idsOf(body: RequestBodyShape): number[] {
  return Object.keys(body.questions)
    .filter((k) => k.startsWith("keep_"))
    .map((k) => Number(k.slice(5)));
}

/** Answers every question the request asked, the way the real API does. */
function okReply(init: RequestInit | undefined, inputTokens = 100, keep = (id: number) => (id % 2 === 0 ? 0.9 : 0.1)): Response {
  const body = bodyOf(init);
  const answers: Record<string, unknown> = {};
  for (const id of idsOf(body)) {
    answers[`keep_${id}`] = { noul: keep(id) };
    answers[`kind_${id}`] = { choice: id % 2 === 0 ? "aside" : "story", confidence: 0.8 };
  }
  if ("page_kind" in body.questions) answers.page_kind = { choice: "recipe", confidence: 0.93 };
  return reply(200, { answers, usage: { input_tokens: inputTokens } });
}

const noSleep = vi.fn(async (_ms: number) => undefined);

describe("chunkSentences", () => {
  it.each([
    [0, []],
    [1, [1]],
    [59, [59]],
    [60, [60]],
    [61, [31, 30]],
    [130, [44, 43, 43]],
    [500, [56, 56, 56, 56, 56, 55, 55, 55, 55]],
  ])("%i sentences with max 60 → %j", (n, sizes) => {
    const chunks = chunkSentences(sents(n), 60);
    expect(chunks.map((c) => c.length)).toEqual(sizes);
    expect(chunks.flat()).toEqual(sents(n));
  });

  it("never exceeds max and keeps document order contiguous", () => {
    for (const n of [7, 8, 9, 119, 121, 181, 239, 241]) {
      const chunks = chunkSentences(sents(n), 60);
      for (const c of chunks) expect(c.length).toBeLessThanOrEqual(60);
      const sizes = chunks.map((c) => c.length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
      expect(chunks.flat().map((s) => s.id)).toEqual(sents(n).map((s) => s.id));
    }
  });

  it("survives a nonsensical max", () => {
    expect(chunkSentences(sents(3), 0).map((c) => c.length)).toEqual([1, 1, 1]);
  });
});

describe("buildRequestBody", () => {
  it("asks keep_<id> and kind_<id> per sentence and page_kind on request", () => {
    const chunk = sents(3, 10);
    const body = buildRequestBody(chunk, meta, recipePack, true);
    expect(Object.keys(body.questions).sort()).toEqual(
      ["keep_10", "keep_11", "keep_12", "kind_10", "kind_11", "kind_12", "page_kind"].sort(),
    );
    expect(body.model).toBe(MODEL);
    expect(body.state).toEqual({
      page_kind_hint: "recipe blog",
      title: meta.title,
      language: "en",
      text: chunk.map((s) => s.text).join(" "),
    });

    const keep = body.questions.keep_11 as { type: string; instructions: string; criteria: { true: string; false: string } };
    expect(keep.type).toBe("noul");
    expect(keep.instructions).toBe(KEEP_QUESTION.instructions(chunk[1]!.text));
    expect(keep.criteria.true).toBe(`${KEEP_QUESTION.criteriaTrue} ${recipePack.keepHints!.true}`);
    expect(keep.criteria.false).toBe(`${KEEP_QUESTION.criteriaFalse} ${recipePack.keepHints!.false}`);

    const kind = body.questions.kind_11 as { type: string; instructions: string; criteria: Record<string, string> };
    expect(kind.type).toBe("choice");
    expect(kind.instructions).toContain(chunk[1]!.text);
    expect(kind.criteria).toEqual(Object.fromEntries(Object.entries(SENTENCE_KINDS).map(([k, v]) => [k, v.description])));

    const page = body.questions.page_kind as { type: string; instructions: string; criteria: Record<string, string> };
    expect(page.type).toBe("choice");
    expect(page.criteria).toEqual(Object.fromEntries(Object.entries(PAGE_KINDS).map(([k, v]) => [k, v.description])));
  });

  it("omits page_kind for later chunks and uses the bare criteria without pack hints", () => {
    const body = buildRequestBody(sents(2), meta, barePack, false);
    expect(body.questions.page_kind).toBeUndefined();
    const keep = body.questions.keep_0 as { criteria: { true: string; false: string } };
    expect(keep.criteria.true).toBe(KEEP_QUESTION.criteriaTrue);
    expect(keep.criteria.false).toBe(KEEP_QUESTION.criteriaFalse);
    expect(body.state.page_kind_hint).toBe("web page");
  });

  // A fact stated twice on a page must survive in both places: the wording that asked about
  // "information the rest of the page does not already give" let a recipe step fade because the
  // faded introduction said the same thing (docs/calibration.md, the redundancy trap).
  it("asks about the sentence itself, never about what the rest of the page already says", () => {
    const body = buildRequestBody(sents(1), meta, barePack, false);
    const keep = body.questions.keep_0 as { instructions: string; criteria: { true: string; false: string } };
    expect(keep.instructions).toMatch(/this sentence itself/);
    expect(keep.criteria.true).toMatch(/even if the page says it again elsewhere/);
    for (const text of [keep.instructions, keep.criteria.true, keep.criteria.false]) {
      expect(text).not.toMatch(/rest of the page|elsewhere on the page|restates/);
    }
  });
});

describe("parseAnswers", () => {
  const chunk = sents(3);

  it("reads keep, kind and confidence per sentence plus the page kind", () => {
    const out = parseAnswers(
      chunk,
      {
        keep_0: { noul: 0.94 },
        kind_0: { choice: "aside", confidence: 0.7 },
        keep_1: { noul: 0.16 },
        kind_1: { choice: "story", confidence: 0.6 },
        keep_2: { noul: 0.5 },
        kind_2: { choice: "aside", confidence: 0.9 },
        page_kind: { choice: "legal", confidence: 0.8 },
      },
      true,
    );
    expect(out.failedIds).toEqual([]);
    expect(out.sentences).toEqual([
      { id: 0, keep: 0.94, kind: "aside", kindConfidence: 0.7 },
      { id: 1, keep: 0.16, kind: "story", kindConfidence: 0.6 },
      { id: 2, keep: 0.5, kind: "aside", kindConfidence: 0.9 },
    ]);
    expect(out.pageKind).toEqual({ kind: "legal", confidence: 0.8 });
  });

  it("sends sentences with missing or malformed answers to failedIds", () => {
    const out = parseAnswers(
      chunk,
      {
        keep_0: { noul: 0.9 },
        kind_0: { choice: "aside", confidence: 0.9 },
        kind_1: { choice: "aside", confidence: 0.9 },
        keep_2: { noul: "high" },
        kind_2: { choice: "aside", confidence: 0.9 },
      },
      false,
    );
    expect(out.sentences.map((s) => s.id)).toEqual([0]);
    expect(out.failedIds).toEqual([1, 2]);
    expect(out.pageKind).toBeUndefined();
  });

  it("treats an unknown kind name as a failure", () => {
    const out = parseAnswers(
      chunk,
      {
        keep_0: { noul: 0.9 },
        kind_0: { choice: "poetry", confidence: 0.9 },
        keep_1: { noul: 0.9 },
        kind_1: { confidence: 0.9 },
        keep_2: { noul: 0.9 },
        kind_2: { choice: "opinion", confidence: 0.9 },
      },
      false,
    );
    expect(out.failedIds).toEqual([0, 1]);
    expect(out.sentences.map((s) => s.id)).toEqual([2]);
  });

  it("clamps keep and confidence into [0, 1] and ignores an unknown page kind", () => {
    const out = parseAnswers(
      sents(2),
      {
        keep_0: { noul: 1.7 },
        kind_0: { choice: "aside", confidence: 2 },
        keep_1: { noul: -0.2 },
        kind_1: { choice: "aside" },
        page_kind: { choice: "poem", confidence: 0.9 },
      },
      true,
    );
    expect(out.sentences).toEqual([
      { id: 0, keep: 1, kind: "aside", kindConfidence: 1 },
      { id: 1, keep: 0, kind: "aside", kindConfidence: 0 },
    ]);
    expect(out.pageKind).toBeUndefined();
  });

  it("copes with an empty or missing answers object", () => {
    expect(parseAnswers(chunk, {}, true)).toEqual({ sentences: [], failedIds: [0, 1, 2] });
    expect(parseAnswers(chunk, undefined as unknown as Record<string, unknown>, false).failedIds).toEqual([0, 1, 2]);
  });
});

describe("judgePage", () => {
  it("throws no-key without touching the network", async () => {
    const fetchImpl = vi.fn();
    await expect(judgePage(request(sents(10)), recipePack, { apiKey: "", maxSentencesPerRequest: 60, fetchImpl })).rejects.toMatchObject({
      name: "ApiError",
      code: "no-key",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never puts the page's address in a request, for the page, a rule or a highlight", async () => {
    // PRIVACY.md states it as true by construction; this is the construction.
    const secret: PageMeta = { ...meta, url: "https://intranet.secret-host.example/private/path?token=abc123", host: "intranet.secret-host.example" };
    const req: JudgeRequest = { meta: secret, packId: "recipe", contentHash: "abc", sentences: sents(6) };
    const sent: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      sent.push(`${String(url)} ${JSON.stringify(init?.headers)} ${String(init?.body)}`);
      return reply(401, { error: "bad key" });
    });
    const opts = { apiKey: "sk-test", maxSentencesPerRequest: 60, fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep };
    await judgePage(req, recipePack, opts).catch(() => undefined);
    await judgeRules(req, recipePack, ["prices"], opts).catch(() => undefined);
    await judgeHighlights(req, recipePack, ["ingredients"], opts).catch(() => undefined);
    expect(sent.length).toBeGreaterThanOrEqual(3);
    for (const s of sent) {
      expect(s).not.toContain("secret-host");
      expect(s).not.toContain("/private/path");
      expect(s).not.toContain("token=abc123");
    }
  });

  it("judges one chunk: right URL, headers, page kind, tokens, timing", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => okReply(init, 1234));
    const onChunk = vi.fn();
    const out = await judgePage(request(sents(10)), recipePack, {
      apiKey: "sk-test",
      maxSentencesPerRequest: 60,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
      onChunk,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(API_URL);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ Authorization: "Bearer sk-test", "Content-Type": "application/json" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(bodyOf(init).questions.page_kind).toBeDefined();

    expect(out.packId).toBe("recipe");
    expect(out.pageKind).toBe("recipe");
    expect(out.pageKindConfidence).toBe(0.93);
    expect(out.sentences).toHaveLength(10);
    expect(out.sentences.map((s) => s.id)).toEqual(sents(10).map((s) => s.id));
    expect(out.sentences[0]).toEqual({ id: 0, keep: 0.9, kind: "aside", kindConfidence: 0.8 });
    expect(out.failedIds).toEqual([]);
    expect(out.inputTokens).toBe(1234);
    expect(out.cached).toBe(false);
    expect(out.ms).toBeGreaterThanOrEqual(0);
    expect(out.chunkErrors).toEqual([]);
    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith({ sentences: out.sentences, failedIds: [] });
  });

  it("returns an empty judgment for a page with no sentences", async () => {
    const fetchImpl = vi.fn();
    const out = await judgePage(request([]), barePack, { apiKey: "sk", maxSentencesPerRequest: 60, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out).toMatchObject({ packId: "other", pageKind: "other", pageKindConfidence: 0, sentences: [], failedIds: [], inputTokens: 0 });
  });

  it("401 → ApiError invalid-key at once, no retry, no backoff", async () => {
    const fetchImpl = vi.fn(async () => reply(401, { error: "unauthorized" }));
    const sleep = vi.fn(async (_ms: number) => undefined);
    const p = judgePage(request(sents(10)), recipePack, { apiKey: "bad", maxSentencesPerRequest: 60, fetchImpl, sleep });
    await expect(p).rejects.toBeInstanceOf(ApiError);
    await expect(p).rejects.toMatchObject({ code: "invalid-key", status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("401 on one chunk stops the rest of the page", async () => {
    const fetchImpl = vi.fn(async () => reply(401, "nope"));
    await expect(
      judgePage(request(sents(300)), recipePack, { apiKey: "bad", maxSentencesPerRequest: 60, fetchImpl, sleep: noSleep, concurrency: 1 }),
    ).rejects.toMatchObject({ code: "invalid-key" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("429 then 200 → success after one retry with backoff in [400, 600] ms", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => (++calls === 1 ? reply(429, { error: "slow down" }) : okReply(init, 50)));
    const sleep = vi.fn(async (_ms: number) => undefined);
    const out = await judgePage(request(sents(10)), recipePack, {
      apiKey: "sk",
      maxSentencesPerRequest: 60,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    const waited = sleep.mock.calls[0]![0];
    expect(waited).toBeGreaterThanOrEqual(400);
    expect(waited).toBeLessThanOrEqual(600);
    expect(out.failedIds).toEqual([]);
    expect(out.sentences).toHaveLength(10);
    expect(out.chunkErrors).toEqual([]);
  });

  it("backoff doubles on each retry", async () => {
    const fetchImpl = vi.fn(async () => reply(503, "down"));
    const sleep = vi.fn(async (_ms: number) => undefined);
    await judgePage(request(sents(5)), recipePack, { apiKey: "sk", maxSentencesPerRequest: 60, fetchImpl, sleep, retries: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    const waits = sleep.mock.calls.map((c) => c[0]);
    expect(waits).toHaveLength(3);
    expect(waits[0]).toBeGreaterThanOrEqual(400);
    expect(waits[0]).toBeLessThanOrEqual(600);
    expect(waits[1]).toBeGreaterThanOrEqual(800);
    expect(waits[1]).toBeLessThanOrEqual(1000);
    expect(waits[2]).toBeGreaterThanOrEqual(1600);
    expect(waits[2]).toBeLessThanOrEqual(1800);
  });

  it("permanent 529 on one chunk → its ids fail, the other chunks succeed", async () => {
    const all = sents(130);
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const ids = idsOf(bodyOf(init));
      return ids[0] === 44 ? reply(529, { error: "overloaded" }) : okReply(init, 10);
    });
    const sleep = vi.fn(async (_ms: number) => undefined);
    const onChunk = vi.fn();
    const out = await judgePage(request(all), recipePack, {
      apiKey: "sk",
      maxSentencesPerRequest: 60,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      onChunk,
    });
    const middle = all.slice(44, 87).map((s) => s.id);
    expect(out.failedIds).toEqual(middle);
    expect(out.sentences.map((s) => s.id)).toEqual([...all.slice(0, 44), ...all.slice(87)].map((s) => s.id));
    expect(out.pageKind).toBe("recipe");
    expect(out.inputTokens).toBe(20);
    expect(out.chunkErrors).toEqual([{ code: "server", status: 529, message: "Server error 529" }]);
    // 3 chunks: two succeed first time, the third exhausts 1 + MAX_RETRIES attempts.
    expect(fetchImpl).toHaveBeenCalledTimes(2 + 4);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(onChunk).toHaveBeenCalledTimes(3);
    expect(onChunk).toHaveBeenCalledWith({ sentences: [], failedIds: middle });
  });

  it("422 fails the chunk without retrying and warns with the status and size, never the body", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // The API quotes the offending field, i.e. the page's own text: none of it may reach the console.
    const body = { error: "bad question: «Sentence 2 of the page.»" };
    const fetchImpl = vi.fn(async () => reply(422, body));
    const sleep = vi.fn(async (_ms: number) => undefined);
    const out = await judgePage(request(sents(5)), recipePack, { apiKey: "sk", maxSentencesPerRequest: 60, fetchImpl, sleep });
    expect(out.failedIds).toEqual([0, 1, 2, 3, 4]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = warn.mock.calls[0]!.map(String).join(" ");
    expect(logged).toContain("[osso]");
    expect(logged).toContain("422");
    expect(logged).toContain(`${JSON.stringify(body).length} bytes`);
    expect(logged).not.toContain("Sentence 2");
    expect(logged).not.toContain("bad question");
    expect(out.chunkErrors[0]).toMatchObject({ code: "server", status: 422, message: "Request rejected by the API" });
    warn.mockRestore();
  });

  it("a fetch that never resolves times out and fails the chunk", async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => undefined));
    const sleep = vi.fn(async (_ms: number) => undefined);
    const out = await judgePage(request(sents(6)), recipePack, {
      apiKey: "sk",
      maxSentencesPerRequest: 60,
      fetchImpl,
      sleep,
      timeoutMs: 10,
      retries: 1,
    });
    expect(out.failedIds).toEqual([0, 1, 2, 3, 4, 5]);
    expect(out.sentences).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(out.chunkErrors[0]).toMatchObject({ code: "timeout" });
    const signal = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].signal;
    expect(signal?.aborted).toBe(true);
  });

  it("a network error retries and then fails the chunk", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const sleep = vi.fn(async (_ms: number) => undefined);
    const out = await judgePage(request(sents(4)), recipePack, { apiKey: "sk", maxSentencesPerRequest: 60, fetchImpl, sleep, retries: 2 });
    expect(out.failedIds).toEqual([0, 1, 2, 3]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(out.chunkErrors[0]).toEqual({ code: "network", message: "Failed to fetch" });
  });

  it("keeps at most `concurrency` requests in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return okReply(init, 7);
    });
    const onChunk = vi.fn();
    const out = await judgePage(request(sents(360)), recipePack, {
      apiKey: "sk",
      maxSentencesPerRequest: 60,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
      concurrency: 2,
      onChunk,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(maxInFlight).toBe(2);
    expect(onChunk).toHaveBeenCalledTimes(6);
    expect(out.inputTokens).toBe(6 * 7);
    expect(out.sentences).toHaveLength(360);
    expect(out.failedIds).toEqual([]);
    // Only the first chunk asks for the page kind.
    const withPageKind = fetchImpl.mock.calls.filter(([, init]) => "page_kind" in bodyOf(init).questions);
    expect(withPageKind).toHaveLength(1);
    expect(idsOf(bodyOf(withPageKind[0]![1]))[0]).toBe(0);
  });

  it("falls back to the pack id when the page kind answer is missing", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const r = okReply(init, 1);
      const body = JSON.parse(await r.text()) as { answers: Record<string, unknown> };
      delete body.answers.page_kind;
      return reply(200, body);
    });
    const out = await judgePage(request(sents(3)), barePack, { apiKey: "sk", maxSentencesPerRequest: 60, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.pageKind).toBe("other");
    expect(out.pageKindConfidence).toBe(0);
    expect(out.sentences).toHaveLength(3);
  });

  it("a malformed 200 body is retried and then fails the chunk", async () => {
    const fetchImpl = vi.fn(async () => reply(200, "<html>not json</html>"));
    const sleep = vi.fn(async (_ms: number) => undefined);
    const out = await judgePage(request(sents(2)), barePack, { apiKey: "sk", maxSentencesPerRequest: 60, fetchImpl, sleep, retries: 1 });
    expect(out.failedIds).toEqual([0, 1]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(out.chunkErrors[0]).toEqual({ code: "server", message: "Malformed response body" });
  });
});

describe("testKey", () => {
  it("sends one tiny request and reports ok on 200", async () => {
    const fetchImpl = vi.fn(async () => reply(200, { answers: { check: { noul: 0.99 } }, usage: { input_tokens: 5 } }));
    const out = await testKey("sk-test", fetchImpl);
    expect(out.ok).toBe(true);
    expect(out.error).toBeUndefined();
    expect(out.ms).toBeGreaterThanOrEqual(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(API_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(String(init.body)) as { state: unknown; model: string; questions: Record<string, { type: string; instructions: string }> };
    expect(body.state).toBe("ok");
    expect(body.model).toBe(MODEL);
    expect(Object.keys(body.questions)).toHaveLength(1);
    const q = Object.values(body.questions)[0]!;
    expect(q.type).toBe("noul");
    expect(q.instructions).toBe("Is this text the word ok?");
  });

  it("says Invalid key on 401 and does not retry", async () => {
    const fetchImpl = vi.fn(async () => reply(401, "unauthorized"));
    const out = await testKey("bad", fetchImpl);
    expect(out).toMatchObject({ ok: false, error: "Invalid key" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports other statuses and network failures as errors", async () => {
    expect(await testKey("sk", vi.fn(async () => reply(500, "boom")))).toMatchObject({ ok: false, error: "Server error 500" });
    expect(await testKey("sk", vi.fn(async () => reply(429, "slow")))).toMatchObject({ ok: false, error: "Rate limited" });
    const dead = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await testKey("sk", dead)).toMatchObject({ ok: false, error: "Failed to fetch" });
    expect(dead).toHaveBeenCalledTimes(1);
  });

  it("refuses an empty key without a request", async () => {
    const fetchImpl = vi.fn();
    expect(await testKey("", fetchImpl)).toEqual({ ok: false, ms: 0, error: "No API key" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

/** Rule question keys in a body: [ruleIndex, sentenceId]. */
function ruleIdsOf(body: RequestBodyShape): [number, number][] {
  return Object.keys(body.questions)
    .filter((k) => k.startsWith("rule_"))
    .map((k) => k.split("_").slice(1).map(Number) as [number, number]);
}

/** Answers every rule question: rule 0 hits even ids, rule 1 hits ids divisible by 3, later rules hit nothing. */
function okRuleReply(init: RequestInit | undefined, inputTokens = 40): Response {
  const answers: Record<string, unknown> = {};
  for (const [ri, id] of ruleIdsOf(bodyOf(init))) {
    const hit = ri === 0 ? id % 2 === 0 : ri === 1 ? id % 3 === 0 : false;
    answers[`rule_${ri}_${id}`] = { noul: hit ? 0.9 : 0.1 };
  }
  return reply(200, { answers, usage: { input_tokens: inputTokens } });
}

describe("buildRuleRequestBody / parseRuleAnswers", () => {
  const rules = ["prices", "deadlines"];

  it("asks rule_<ri>_<sid> per rule per sentence, the rule quoted in every part, over the keep question's state", () => {
    const chunk = sents(3, 10);
    const body = buildRuleRequestBody(chunk, meta, recipePack, rules);
    expect(Object.keys(body.questions).sort()).toEqual(
      ["rule_0_10", "rule_0_11", "rule_0_12", "rule_1_10", "rule_1_11", "rule_1_12"].sort(),
    );
    expect(body.model).toBe(MODEL);
    expect(body.state).toEqual(buildRequestBody(chunk, meta, recipePack, false).state);
    const q = body.questions.rule_1_11 as { type: string; instructions: string; criteria: { true: string; false: string } };
    expect(q.type).toBe("noul");
    expect(q.instructions).toBe(RULE_QUESTION.instructions(chunk[1]!.text, "deadlines"));
    expect(q.instructions).toContain(`«${chunk[1]!.text}»`);
    expect(q.instructions).toContain("«deadlines»");
    expect(q.criteria.true).toBe(RULE_QUESTION.criteriaTrue("deadlines"));
    expect(q.criteria.false).toBe(RULE_QUESTION.criteriaFalse("deadlines"));
    expect(q.criteria.true).toContain("«deadlines»");
    expect(q.criteria.false).toContain("«deadlines»");
    // A rule request never re-asks the keep question or the page kind.
    expect(Object.keys(body.questions).some((k) => !k.startsWith("rule_"))).toBe(false);
  });

  it("parses to rules[rule][id], clamps, and fails only a sentence no rule answered for", () => {
    const out = parseRuleAnswers(
      sents(3),
      {
        rule_0_0: { noul: 0.92 },
        rule_1_0: { noul: 1.4 },
        rule_0_1: { noul: "yes" },
        rule_1_1: { noul: -0.3 },
        rule_0_2: { confidence: 0.5 },
      },
      rules,
    );
    expect(out.rules).toEqual({ prices: { 0: 0.92 }, deadlines: { 0: 1, 1: 0 } });
    expect(out.failedIds).toEqual([2]);
    expect(parseRuleAnswers(sents(2), {}, rules)).toEqual({ rules: { prices: {}, deadlines: {} }, failedIds: [0, 1] });
  });

  it("ruleChunkSize keeps a request at about the keep judgment's question count", () => {
    expect(ruleChunkSize(60, 1)).toBe(60);
    expect(ruleChunkSize(60, 2)).toBe(60);
    expect(ruleChunkSize(60, 3)).toBe(40);
    expect(ruleChunkSize(60, 8)).toBe(15);
    expect(ruleChunkSize(60, 500)).toBe(1);
    expect(ruleChunkSize(0, 1)).toBe(1);
  });
});

describe("judgeRules", () => {
  const rules = ["prices", "deadlines", "allergens", "names of people"];
  const opts = { apiKey: "sk", maxSentencesPerRequest: 60, sleep: noSleep };

  it("throws no-key without touching the network; no rules or no sentences answer empty without one", async () => {
    const fetchImpl = vi.fn();
    await expect(judgeRules(request(sents(10)), recipePack, rules, { ...opts, apiKey: "", fetchImpl })).rejects.toMatchObject({ code: "no-key" });
    expect(await judgeRules(request(sents(10)), recipePack, [], { ...opts, fetchImpl })).toEqual({ rules: {}, failedIds: [], inputTokens: 0, ms: 0, chunkErrors: [] });
    expect(await judgeRules(request([]), recipePack, rules, { ...opts, fetchImpl })).toMatchObject({ rules: { prices: {}, deadlines: {}, allergens: {}, "names of people": {} }, failedIds: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("chunks by rule count, runs the pool, merges every chunk's answers and counts the tokens", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => okRuleReply(init, 7));
    const all = sents(130);
    const out = await judgeRules(request(all), recipePack, rules, { ...opts, fetchImpl: fetchImpl as unknown as typeof fetch, concurrency: 2 });
    // 4 rules → 30 sentences per chunk → 130 sentences in 5 balanced chunks of 26.
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    for (const [, init] of fetchImpl.mock.calls) {
      const ids = ruleIdsOf(bodyOf(init));
      expect(ids).toHaveLength(26 * 4);
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk");
    }
    expect(Object.keys(out.rules)).toEqual(rules);
    for (const rule of rules) expect(Object.keys(out.rules[rule]!)).toHaveLength(130);
    expect(out.rules.prices![4]).toBe(0.9);
    expect(out.rules.prices![5]).toBe(0.1);
    expect(out.rules.deadlines![9]).toBe(0.9);
    expect(out.rules.allergens![0]).toBe(0.1);
    expect(out.failedIds).toEqual([]);
    expect(out.inputTokens).toBe(35);
    expect(out.chunkErrors).toEqual([]);
    expect(out.ms).toBeGreaterThanOrEqual(0);
  });

  it("a chunk that fails for good leaves its ids out of every rule and in failedIds; the others answer", async () => {
    const all = sents(90);
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const first = ruleIdsOf(bodyOf(init))[0]![1];
      return first === 45 ? reply(529, "overloaded") : okRuleReply(init);
    });
    const out = await judgeRules(request(all), recipePack, ["prices"], { ...opts, fetchImpl: fetchImpl as unknown as typeof fetch, retries: 1 });
    expect(out.failedIds).toEqual(all.slice(45).map((s) => s.id));
    expect(Object.keys(out.rules.prices!).map(Number)).toEqual(all.slice(0, 45).map((s) => s.id));
    expect(out.chunkErrors).toEqual([{ code: "server", status: 529, message: "Server error 529" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1 + 2);
  });

  it("401 throws invalid-key at once and stops the other chunks", async () => {
    const fetchImpl = vi.fn(async () => reply(401, "no"));
    await expect(judgeRules(request(sents(200)), recipePack, ["prices"], { ...opts, fetchImpl, concurrency: 1 })).rejects.toMatchObject({
      name: "ApiError",
      code: "invalid-key",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("429 then 200 retries with backoff, like a keep request", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => (++calls === 1 ? reply(429, "slow") : okRuleReply(init)));
    const sleep = vi.fn(async (_ms: number) => undefined);
    const out = await judgeRules(request(sents(5)), recipePack, ["prices"], { ...opts, fetchImpl: fetchImpl as unknown as typeof fetch, sleep });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(out.failedIds).toEqual([]);
    expect(Object.keys(out.rules.prices!)).toHaveLength(5);
  });
});

describe("judgeHighlights: words or whole sentences", () => {
  const opts = { apiKey: "sk", maxSentencesPerRequest: 60, sleep: noSleep };
  /** Round one finds every term in sentences 2 and 5, round two in each one's first word; the unit question says «consequences» is a sentence. */
  function highlightReply(init: RequestInit | undefined, answerUnits = true): Response {
    const body = bodyOf(init);
    const answers: Record<string, unknown> = {};
    for (const [k, q] of Object.entries(body.questions)) {
      const instructions = (q as { instructions: string }).instructions;
      if (k.startsWith("unit_")) {
        if (answerUnits) answers[k] = { noul: instructions.includes("«consequences»") ? 0.8 : 0.2 };
      } else if (/^g\d+_\d+$/.test(k)) {
        answers[k] = { noul: [2, 5].includes(Number(k.split("_")[1])) ? 0.9 : 0.1 };
      } else if (/^w\d+$/.test(k)) {
        answers[k] = { noul: k === "w0" ? 0.9 : 0.1 };
      } else if (/^c\d+$/.test(k)) {
        answers[k] = { noul: /lost a week of catch|rose by 11\.4/.test(instructions) ? 0.8 : 0.1 };
      } else if (k === "stated") {
        // Only the sentence about the price index states its prices; everywhere else they are named.
        answers[k] = { noul: (body.state as { text: string }).text.includes("rose by 11.4") ? 0.78 : 0.2 };
      }
    }
    return reply(200, { answers, usage: { input_tokens: 10 } });
  }
  const kindOf = (init: RequestInit | undefined) => {
    const keys = Object.keys(bodyOf(init).questions);
    return keys.some((k) => k.startsWith("unit_")) ? "unit" : keys.some((k) => /^w\d+$/.test(k)) ? "words" : keys.some((k) => /^c\d+$/.test(k)) ? "clauses" : "gate";
  };

  it("asks once, beside round one, how each term is marked; a term a sentence states is marked as its whole sentences, with no word round", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => highlightReply(init));
    const all = sents(10);
    const out = await judgeHighlights(request(all), recipePack, ["consequences", "ingredients"], { ...opts, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.units).toEqual({ consequences: "sentence", ingredients: "words" });
    expect(out.spans.consequences).toEqual({ 2: [[0, all[2]!.text.length]], 5: [[0, all[5]!.text.length]] });
    expect(out.spans.ingredients).toEqual({ 2: [[0, "Sentence".length]], 5: [[0, "Sentence".length]] });
    const kinds = fetchImpl.mock.calls.map(([, init]) => kindOf(init));
    expect(kinds.filter((k) => k === "unit")).toHaveLength(1);
    expect(kinds.filter((k) => k === "gate")).toHaveLength(1);
    // Words are asked only for the term named by words, in the two sentences round one found.
    const wordStates = fetchImpl.mock.calls.filter(([, init]) => kindOf(init) === "words").map(([, init]) => (bodyOf(init).state as { looking_for?: string }).looking_for);
    expect(wordStates).toEqual(["ingredients", "ingredients"]);
    // The unit question is about the term alone: no page in it.
    const unitBody = bodyOf(fetchImpl.mock.calls.find(([, init]) => kindOf(init) === "unit")![1]);
    expect(unitBody.state).toEqual({ task: HIGHLIGHT_UNIT_QUESTION.state });
    expect(JSON.stringify(unitBody)).not.toContain("Sentence number");
    expect(out.chunkErrors).toEqual([]);
    expect(out.inputTokens).toBe(10 * fetchImpl.mock.calls.length);
  });

  it("asks nothing about a term whose unit it was given", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => highlightReply(init));
    const out = await judgeHighlights(request(sents(10)), recipePack, ["consequences"], { ...opts, fetchImpl: fetchImpl as unknown as typeof fetch, units: { consequences: "sentence" } });
    expect(fetchImpl.mock.calls.map(([, init]) => kindOf(init))).toEqual(["gate"]);
    expect(out.units).toEqual({});
    expect(Object.keys(out.spans.consequences!)).toEqual(["2", "5"]);
  });

  it("a reply that leaves a unit out fails that request: the term is marked in words this once, and the failure is said so nothing is kept", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => highlightReply(init, false));
    const out = await judgeHighlights(request(sents(10)), recipePack, ["consequences"], { ...opts, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.units).toEqual({});
    expect(out.spans.consequences).toEqual({ 2: [[0, "Sentence".length]], 5: [[0, "Sentence".length]] });
    expect(out.chunkErrors).toMatchObject([{ code: "server" }]);
  });

  const LONG = "The storm closed the harbour for three days, the fishing fleet stayed in port and lost a week of catch, while the town council met twice to plan repairs for the damaged pier.";

  it("marks a long sentence of a term a sentence states in the clauses that say it, and a short one whole", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => highlightReply(init));
    const all = sents(10);
    all[2] = { id: 2, text: LONG };
    const out = await judgeHighlights(request(all), recipePack, ["consequences"], { ...opts, fetchImpl: fetchImpl as unknown as typeof fetch });
    const clause = "the fishing fleet stayed in port and lost a week of catch";
    expect(out.spans.consequences![2]).toEqual([[LONG.indexOf(clause), LONG.indexOf(clause) + clause.length]]);
    expect(out.spans.consequences![5]).toEqual([[0, all[5]!.text.length]]);
    expect(fetchImpl.mock.calls.filter(([, init]) => kindOf(init) === "clauses")).toHaveLength(1);
  });

  const PRICES = "Between February and August, in six months of conflict, the consumer price index for electricity and gas rose by 11.4 per cent, adding 1.8 billion euros to the bills of nearly twenty-seven million households.";

  it("marks a term named in words as a statement where a sentence states it, and word by word everywhere else", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => highlightReply(init));
    const all = sents(10);
    all[2] = { id: 2, text: PRICES };
    const out = await judgeHighlights(request(all), recipePack, ["prices"], { ...opts, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.units).toEqual({ prices: "words" });
    const clause = "the consumer price index for electricity and gas rose by 11.4 per cent";
    expect(out.spans.prices![2]).toEqual([[PRICES.indexOf(clause), PRICES.indexOf(clause) + clause.length]]);
    // Sentence 5 names its prices: its first word, as before.
    expect(out.spans.prices![5]).toEqual([[0, "Sentence".length]]);
    // The question rides in the words' own request: no request of its own.
    expect(fetchImpl.mock.calls.map(([, init]) => kindOf(init)).sort()).toEqual(["gate", "unit", "words", "words"]);
  });

  it("marks the sentence whole when its clauses could not be asked about, and says so", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      kindOf(init) === "clauses" ? reply(500, "down") : highlightReply(init),
    );
    const all = sents(10);
    all[2] = { id: 2, text: LONG };
    const out = await judgeHighlights(request(all), recipePack, ["consequences"], { ...opts, fetchImpl: fetchImpl as unknown as typeof fetch, retries: 0 });
    expect(out.spans.consequences![2]).toEqual([[0, LONG.length]]);
    expect(out.chunkErrors).toMatchObject([{ code: "server" }]);
  });
});

describe("clauses", () => {
  const LONG = "The storm closed the harbour for three days, the fishing fleet stayed in port and lost a week of catch, while the town council met twice to plan repairs for the damaged pier.";
  const texts = (text: string) => highlightClauses(text).map(([a, b]) => text.slice(a, b));

  it("leaves a sentence of twenty words or fewer whole, and cuts a longer one where the writer paused", () => {
    expect(texts("The storm closed the harbour for three days, and the fleet stayed in port.")).toEqual(["The storm closed the harbour for three days, and the fleet stayed in port."]);
    expect(texts(LONG)).toEqual([
      "The storm closed the harbour for three days",
      "the fishing fleet stayed in port and lost a week of catch",
      "while the town council met twice to plan repairs for the damaged pier.",
    ]);
  });

  it("folds a short piece into its neighbour, and never cuts inside a number", () => {
    const text = "In 2025, according to the institute, the fund reached 1,74 miliardi di euro in total, which is the highest figure since the fund was first set up.";
    const out = texts(text);
    // "In 2025" and "according to the institute" are each too short to say anything; together they are a clause.
    expect(out).toEqual([
      "In 2025, according to the institute",
      "the fund reached 1,74 miliardi di euro in total",
      "which is the highest figure since the fund was first set up.",
    ]);
  });

  it("keeps the best clause even under the threshold, and any other that stands out; neighbours are one mark", () => {
    const c = highlightClauses(LONG);
    const at = (i: number) => c[i]!;
    expect(pickClauses(LONG, c, [0.2, 0.8, 0.1])).toEqual([at(1)]);
    // Round one already found the thing in this sentence: the best of three weak clauses is still where it is.
    expect(pickClauses(LONG, c, [0.3, 0.2, 0.1])).toEqual([at(0)]);
    expect(pickClauses(LONG, c, [0.6, 0.55, 0.1])).toEqual([[at(0)[0], at(1)[1]]]);
  });
});
