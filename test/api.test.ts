import { describe, expect, it, vi } from "vitest";
import { API_URL, KEEP_QUESTION, MODEL, PAGE_KINDS, SENTENCE_KINDS } from "../src/shared/constants.ts";
import type { JudgeRequest, PageMeta, SentenceInput } from "../src/shared/types.ts";
import { ApiError, buildRequestBody, chunkSentences, judgePage, parseAnswers, testKey, type PackLike } from "../src/background/api.ts";

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
    answers[`kind_${id}`] = { choice: id % 2 === 0 ? "fact" : "anecdote_or_story", confidence: 0.8 };
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
});

describe("parseAnswers", () => {
  const chunk = sents(3);

  it("reads keep, kind and confidence per sentence plus the page kind", () => {
    const out = parseAnswers(
      chunk,
      {
        keep_0: { noul: 0.94 },
        kind_0: { choice: "figure_or_date", confidence: 0.7 },
        keep_1: { noul: 0.16 },
        kind_1: { choice: "anecdote_or_story", confidence: 0.6 },
        keep_2: { noul: 0.5 },
        kind_2: { choice: "fact", confidence: 0.9 },
        page_kind: { choice: "legal", confidence: 0.8 },
      },
      true,
    );
    expect(out.failedIds).toEqual([]);
    expect(out.sentences).toEqual([
      { id: 0, keep: 0.94, kind: "figure_or_date", kindConfidence: 0.7 },
      { id: 1, keep: 0.16, kind: "anecdote_or_story", kindConfidence: 0.6 },
      { id: 2, keep: 0.5, kind: "fact", kindConfidence: 0.9 },
    ]);
    expect(out.pageKind).toEqual({ kind: "legal", confidence: 0.8 });
  });

  it("sends sentences with missing or malformed answers to failedIds", () => {
    const out = parseAnswers(
      chunk,
      {
        keep_0: { noul: 0.9 },
        kind_0: { choice: "fact", confidence: 0.9 },
        kind_1: { choice: "fact", confidence: 0.9 },
        keep_2: { noul: "high" },
        kind_2: { choice: "fact", confidence: 0.9 },
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
        kind_0: { choice: "fact", confidence: 2 },
        keep_1: { noul: -0.2 },
        kind_1: { choice: "fact" },
        page_kind: { choice: "poem", confidence: 0.9 },
      },
      true,
    );
    expect(out.sentences).toEqual([
      { id: 0, keep: 1, kind: "fact", kindConfidence: 1 },
      { id: 1, keep: 0, kind: "fact", kindConfidence: 0 },
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
    expect(out.sentences[0]).toEqual({ id: 0, keep: 0.9, kind: "fact", kindConfidence: 0.8 });
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

  it("422 fails the chunk without retrying and warns with the body", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async () => reply(422, { error: "bad question" }));
    const sleep = vi.fn(async (_ms: number) => undefined);
    const out = await judgePage(request(sents(5)), recipePack, { apiKey: "sk", maxSentencesPerRequest: 60, fetchImpl, sleep });
    expect(out.failedIds).toEqual([0, 1, 2, 3, 4]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[osso]"), expect.stringContaining("bad question"));
    expect(out.chunkErrors[0]).toMatchObject({ code: "server", status: 422 });
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
