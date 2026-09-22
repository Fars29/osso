/**
 * The contracts every module is built against. Content script, background worker, packs and UI
 * only ever talk through these shapes. Change here first, then everywhere.
 */

/** What a sentence is, as judged by Jev. Order and names are sent to the model; keep them stable. */
export type SentenceKind =
  | "fact"
  | "figure_or_date"
  | "instruction_or_step"
  | "condition_or_obligation"
  | "opinion"
  | "anecdote_or_story"
  | "filler_or_transition"
  | "promotion_or_appeal";

/** What a page is. Chosen by packs' heuristics before the request; Jev's own answer is stored beside it. */
export type PageKind = "recipe" | "article" | "paper" | "legal" | "corporate" | "social" | "product" | "docs" | "other";

/** One judged unit of text. `id` is the document-order index assigned by segment. */
export interface SentenceInput {
  id: number;
  text: string;
}

export interface SentenceJudgment {
  id: number;
  /** Probability that deleting the sentence would lose information the reader came for. */
  keep: number;
  kind: SentenceKind;
  kindConfidence: number;
}

export interface PageJudgment {
  /** The pack the request was built with. */
  packId: PageKind;
  /** Jev's own answer to "what kind of page is this?", from the first chunk. */
  pageKind: PageKind;
  pageKindConfidence: number;
  sentences: SentenceJudgment[];
  inputTokens: number;
  /** Wall-clock for the whole page (all chunks), 0 when served from cache. */
  ms: number;
  cached: boolean;
  /** Ids of sentences whose chunk failed; they stay untouched on the page. */
  failedIds: number[];
  /**
   * The user's rules judged on this page: rule text → sentence id → p(hit). May be partial (a
   * rule added later joins the record when it is judged) and absent on records stored before
   * rules existed.
   */
  rules?: RuleResults;
  /** Where each highlight term was found on this page. Absent on records stored before highlights existed. */
  spans?: HighlightSpans;
  /** HIGHLIGHT_VERSION the spans were found with; spans of any other version are not served. */
  spansVersion?: number;
}

/** Rule text → sentence id → probability that the sentence carries what the rule asks for. */
export type RuleResults = Record<string, Record<number, number>>;

/**
 * Highlight term → sentence id → the stretches of that sentence to mark, as [start, end) offsets
 * into the sentence's own text. Offsets rather than words, so the page is marked where the thing
 * actually is and a word that occurs twice is not marked twice over.
 */
export type HighlightSpans = Record<string, Record<number, [number, number][]>>;

/** Everything the content script knows about a page before judging it; packs route on this. */
export interface PageMeta {
  url: string;
  host: string;
  title: string;
  lang: string;
  /** schema.org @type values found in JSON-LD, lower-cased. */
  jsonLdTypes: string[];
  ogType: string | null;
  /** First ~600 characters of the main text. */
  sample: string;
  sentenceCount: number;
}

export interface JudgeRequest {
  meta: PageMeta;
  packId: PageKind;
  /** Hash of the main text; the cache key. */
  contentHash: string;
  sentences: SentenceInput[];
}

export type RevealKey = "Shift" | "Alt" | "Control";

/**
 * When Osso reads a page: `auto` on every page it is allowed on, as it loads; `click` only when the
 * reader opens the popup on that page, or on the sites they marked "always". Chosen at the welcome.
 */
export type RunMode = "auto" | "click";

export interface Settings {
  apiKey: string;
  /** Set by the background after a 401; cleared when the key changes. */
  apiKeyInvalid: boolean;
  enabled: boolean;
  /** Sentences with p(keep) below this are faded. 0.2–0.9. */
  threshold: number;
  revealKey: RevealKey;
  mode: RunMode;
  animations: boolean;
  /** A hairline through what is faded, as well as the grey. */
  strike: boolean;
  /** Hosts where Osso never runs (user list; merged with DEFAULT_DENIED_HOSTS at runtime). */
  deniedHosts: string[];
  /** Hosts the user explicitly re-enabled, overriding the default deny list. */
  allowedHosts: string[];
  maxSentencesPerRequest: number;
  /** Which default strictness this install has seen; lets a changed default reach a threshold the user never touched. */
  thresholdRev: number;
  /** What the reader must always keep, in their own words: ≤ MAX_RULES, each trimmed, ≤ MAX_RULE_LENGTH, unique ignoring case. Global. */
  rules: string[];
  /** What to mark on the page, in their own words ("candidate names", "ingredients"): ≤ MAX_HIGHLIGHTS. Global. */
  highlights: string[];
  /** The marker's colour, as #rrggbb. The ink over it is chosen for contrast, so any colour stays readable. */
  markColor: string;
  /** The colour of struck text, as #rrggbb, or "" for the grey Osso picks per block from its background. */
  fadeColor: string;
}

export interface Stats {
  pagesJudged: number;
  sentencesJudged: number;
  inputTokens: number;
  /** Sum of wall-clock ms for uncached page judgments. */
  ms: number;
  cacheHits: number;
}

/**
 * `ready`: nothing read and nothing sent, waiting for the reader to ask (run mode `click`).
 * `held`: the page looks private (see content/privacy.ts); nothing sent unless the reader says so.
 */
export type TabStatus = "idle" | "judging" | "done" | "skipped" | "error" | "no-key" | "disabled" | "ready" | "held";

/** What the popup shows. Produced by the content script, held by the background per tab id. */
export interface TabState {
  host: string;
  status: TabStatus;
  /** Why the page was skipped or what went wrong, for the popup. */
  reason?: string;
  packId: PageKind | null;
  pageKind: PageKind | null;
  total: number;
  kept: number;
  faded: number;
  ms: number;
  inputTokens: number;
  cached: boolean;
  revealed: boolean;
  /** Rule text → number of sentences it keeps on this page. A rule missing here has not been judged yet. */
  ruleHits: Record<string, number>;
  /** Highlight term → number of stretches marked on this page. A term missing here has not been looked for yet. */
  markHits?: Record<string, number>;
  /** Sentences on this page that carry at least one mark, whatever the term. */
  markedSentences?: number;
  /** The reader marked this site "always": in run mode `click` it is read as it loads. */
  always?: boolean;
  /** The page is longer than MAX_SENTENCES_PER_PAGE: only its beginning was judged, the rest is left in ink. */
  capped?: boolean;
}

/** Messages the content script (or UI pages) send to the background. */
export type ToBackground =
  | { type: "getSettings" }
  | { type: "setSettings"; patch: Partial<Settings> }
  | { type: "getStats" }
  | { type: "isHostEnabled"; host: string }
  | { type: "setHostEnabled"; host: string; enabled: boolean }
  | { type: "setHostAlways"; host: string; always: boolean }
  | { type: "judge"; req: JudgeRequest }
  /** Judge only these rules on the page last judged with this hash; the background still has its sentences. */
  | { type: "judgeRules"; contentHash: string; rules: string[] }
  /** Look for these terms on the page last judged with this hash, and say where they are. */
  | { type: "judgeHighlights"; contentHash: string; terms: string[] }
  | { type: "tabState"; state: TabState }
  | { type: "getTabState"; tabId: number }
  | { type: "testKey"; apiKey: string }
  | { type: "clearCache" };

export type FromBackground =
  | { type: "settings"; settings: Settings }
  | { type: "stats"; stats: Stats }
  | { type: "hostEnabled"; enabled: boolean; always: boolean }
  | { type: "judgment"; judgment: PageJudgment }
  | { type: "ruleJudgment"; contentHash: string; rules: RuleResults }
  | { type: "highlightJudgment"; contentHash: string; spans: HighlightSpans }
  | { type: "tabState"; state: TabState | null }
  | { type: "keyTest"; ok: boolean; error?: string; ms?: number }
  | { type: "ok" }
  | { type: "error"; error: string; code?: "no-key" | "invalid-key" | "rate-limited" | "network" | "server" | "unknown-page" };

/** Messages the background or popup send to a page's content script. */
export type ToContent =
  | { type: "settingsChanged"; settings: Settings }
  | { type: "setThreshold"; value: number }
  | { type: "reveal"; on: boolean }
  | { type: "setEnabledHere"; enabled: boolean }
  /** The rules changed (added, removed, or both); the page judges the new ones and drops the rest at once. */
  | { type: "rulesChanged"; rules: string[] }
  /** The highlight terms changed; the page looks for the new ones and drops the marks of the rest. */
  | { type: "highlightsChanged"; highlights: string[] }
  /** One chunk of a judge request the page is waiting on, as soon as the model answers it: the page paints it at once. */
  | { type: "judgmentChunk"; contentHash: string; sentences: SentenceJudgment[]; failedIds: number[] }
  /** The reader asked for this page: read it now, whatever the run mode, unless it is a page Osso never reads. */
  | { type: "run" }
  | { type: "getTabState" };

export type FromContent = { type: "tabState"; state: TabState } | { type: "ok" };
