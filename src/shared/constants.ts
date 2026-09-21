import type { PageKind, SentenceKind, Settings } from "./types.ts";

export const API_URL = "https://api.typesafe.ai/v1/systemone";
export const MODEL = "jev-latest";
/** Input price, USD per token, for the popup's running estimate. Output tokens are free. */
export const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

/** Below this many sentences in the main content, a page is not worth judging. */
export const MIN_SENTENCES = 8;
/** A sentence shorter than this (in words) is folded into its neighbour. */
export const MIN_WORDS = 3;
/**
 * Upper bound on sentences per API request. Smaller chunks land sooner and more often, and each
 * one is painted the moment it lands, so the page is seen being judged rather than judged; the
 * probe showed 258 questions in 1.3 s, so 30 is far from the limit either way.
 */
export const MAX_SENTENCES_PER_REQUEST = 30;
/** Requests in flight at once for one page. */
export const MAX_CONCURRENT_REQUESTS = 6;
export const REQUEST_TIMEOUT_MS = 20_000;
export const MAX_RETRIES = 3;
/** Pages kept in the judgment cache before the oldest is evicted. */
export const CACHE_MAX_PAGES = 400;
/** Debounce for re-segmenting after DOM mutations. */
export const MUTATION_DEBOUNCE_MS = 800;
/** How long the reveal key must be held before the page reveals; a tap for capitalisation does nothing. */
export const REVEAL_HOLD_MS = 120;

/**
 * The default strictness. On real pages (a markets article, a recipe site) true filler sat at or
 * under 0.27 and substance at or over 0.52; between 0.35 and 0.48 there was only what is debatable
 * and useful ("Yes, you can freeze pancakes"). The first default, 0.5, cut through that band on the
 * wrong side: fading what the reader needed costs far more than leaving a lukewarm sentence in ink.
 */
export const DEFAULT_THRESHOLD = 0.35;
/** The default before that. A stored 0.5 that the user never chose is moved to the new default once. */
export const LEGACY_DEFAULT_THRESHOLD = 0.5;
export const THRESHOLD_MIN = 0.2;
export const THRESHOLD_MAX = 0.9;

/** A sentence with p(hit) at or above this on any active rule is kept, whatever the slider says. */
export const RULE_THRESHOLD = 0.5;
export const MAX_RULES = 8;
export const MAX_RULE_LENGTH = 80;
/** Judge requests the background remembers by content hash, so a rule added later can be judged without the page resending its text. */
export const RECENT_REQUESTS = 50;

export const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  apiKeyInvalid: false,
  enabled: true,
  threshold: DEFAULT_THRESHOLD,
  revealKey: "Shift",
  animations: true,
  deniedHosts: [],
  allowedHosts: [],
  maxSentencesPerRequest: MAX_SENTENCES_PER_REQUEST,
  rules: [],
  thresholdRev: 2,
};

/**
 * Where Osso never runs unless the user re-enables the host: apps, editors, chat, code, search,
 * video and social feeds. Matched as host suffixes (`mail.google.com` matches `*.mail.google.com`).
 */
export const DEFAULT_DENIED_HOSTS: readonly string[] = [
  "localhost",
  "127.0.0.1",
  "mail.google.com",
  "docs.google.com",
  "drive.google.com",
  "calendar.google.com",
  "meet.google.com",
  "outlook.live.com",
  "outlook.office.com",
  "office.com",
  "notion.so",
  "slack.com",
  "discord.com",
  "web.whatsapp.com",
  "web.telegram.org",
  "teams.microsoft.com",
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "stackoverflow.com",
  "google.com",
  "bing.com",
  "duckduckgo.com",
  "youtube.com",
  "netflix.com",
  "twitter.com",
  "x.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "linkedin.com",
  "reddit.com",
  "figma.com",
  "canva.com",
  "chatgpt.com",
  "claude.ai",
  "typesafe.ai",
];

/**
 * Sentence kinds, with the descriptions the model sees and the label the chip shows. The
 * descriptions are short on purpose: the kind is asked once per sentence, and at their first length
 * these eight lines were more than half the tokens of every request (a 672-sentence paper cost
 * 421k). The kind only names the reason on the chip; the keep question carries the judgment.
 */
export const SENTENCE_KINDS: Record<SentenceKind, { label: string; description: string; substantive: boolean }> = {
  fact: {
    label: "fact",
    substantive: true,
    description: "A checkable statement of what is, was or will be.",
  },
  figure_or_date: {
    label: "figure",
    substantive: true,
    description: "A number, price, measure, date or time is the point.",
  },
  instruction_or_step: {
    label: "step",
    substantive: true,
    description: "What to do, how, or what not to do.",
  },
  condition_or_obligation: {
    label: "condition",
    substantive: true,
    description: "A rule, right, fee, penalty or condition that binds someone.",
  },
  opinion: {
    label: "opinion",
    substantive: false,
    description: "A judgment or feeling; not checkable.",
  },
  anecdote_or_story: {
    label: "story",
    substantive: false,
    description: "Memories, stories, scene-setting.",
  },
  filler_or_transition: {
    label: "filler",
    substantive: false,
    description: "Greetings, thanks, reassurance, signposting, credits.",
  },
  promotion_or_appeal: {
    label: "promo",
    substantive: false,
    description: "Asks to follow, share, subscribe or buy; promotes something.",
  },
};

/** Page kinds, with the description the model sees for `page_kind` and the label the popup shows. */
export const PAGE_KINDS: Record<PageKind, { label: string; description: string }> = {
  recipe: { label: "Recipe", description: "A recipe page: ingredients, quantities and cooking steps, usually preceded by a personal introduction." },
  article: { label: "Article", description: "A news report, blog post, essay or long-form article." },
  paper: { label: "Paper", description: "A scientific paper, preprint or journal article: abstract, methods, results, references." },
  legal: { label: "Legal", description: "Terms of service, privacy policy, contract, licence or other legal text." },
  corporate: { label: "Announcement", description: "A company statement, press release, customer notice or product update." },
  social: { label: "Social post", description: "A social-media post or thread." },
  product: { label: "Product", description: "A product, plan or service page: features, specifications, pricing." },
  docs: { label: "Documentation", description: "Technical documentation, a guide, a manual or a how-to." },
  other: { label: "Page", description: "None of the above." },
};

/**
 * The generic keep question. Packs may append kind-specific hints to the criteria. It asks about
 * the sentence itself, not about what the rest of the page already says: an earlier wording
 * ("would the reader lose information the page does not give elsewhere?") let two sentences that
 * state the same fact eliminate each other, so a recipe step repeated in the faded introduction
 * faded too. The wording is what `scripts/calibrate.ts` measures; see docs/calibration.md.
 */
export const KEEP_QUESTION = {
  instructions: (sentence: string) =>
    `Consider this sentence from the page: «${sentence}». Does this sentence itself carry practical content the reader came to this page for?`,
  criteriaTrue:
    "Yes: the sentence states a fact, figure, date, quantity, ingredient, step, condition, cost, obligation, decision or warning that the reader needs, even if the page says it again elsewhere.",
  criteriaFalse:
    "No: the sentence is a story, memory, opinion, greeting, thanks, reassurance, navigation hint or promotion; a reader looking for the practical content would skip it.",
} as const;

export const KIND_QUESTION = {
  instructions: (sentence: string) => `What kind of sentence is this one from the page: «${sentence}»?`,
} as const;

export const PAGE_KIND_QUESTION = {
  instructions: "What kind of page is this?",
} as const;

/** The user's rule, asked of one sentence. The rule is quoted in every part so the model has no room to generalise it. */
export const RULE_QUESTION = {
  instructions: (sentence: string, rule: string) =>
    `Consider this sentence from the page: «${sentence}». Does it carry information that a reader who cares about «${rule}» would want to keep?`,
  criteriaTrue: (rule: string) =>
    `Yes: the sentence states something concrete about «${rule}», or a fact, figure, condition or step that matters for it.`,
  criteriaFalse: (rule: string) => `No: it is unrelated to «${rule}», or only mentions it in passing with nothing to keep.`,
} as const;
