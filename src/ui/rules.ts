/**
 * The rules field and chip list, shared by the popup and the options page. One text field: Enter
 * adds, Escape clears, a chip per rule with × to remove it. The popup also shows what each rule
 * keeps on the current page; the options page shows the list alone. Everything here is DOM and
 * callbacks; saving is the caller's.
 */
import { MAX_RULE_LENGTH, MAX_RULES } from "../shared/constants.ts";
import { normalizeRule } from "../background/settings.ts";

/** What the empty field suggests, in turn, so a first-time reader sees what a rule sounds like. */
export const RULE_EXAMPLES: readonly string[] = ["prices", "deadlines", "allergens", "what I have to do", "names of people"];
export const PLACEHOLDER_CYCLE_MS = 3000;
/** How long the placeholder takes to fade out before the next example fades in (popup.css / options.css). */
const PLACEHOLDER_SWAP_MS = 160;
/** The hint the field shows when the list is full. */
export const FULL_HINT = `${MAX_RULES} is plenty`;

/**
 * What a chip shows beside its rule: a number of sentences kept, "judging" while the page is
 * still answering, "unknown" when it never did, or null for no count at all (the options page,
 * or a page with nothing judged).
 */
export type RuleCount = number | "judging" | "unknown" | null;

/** The rule already in the list that `text` would duplicate, ignoring case; undefined when none. */
export function findRule(rules: readonly string[], text: string): string | undefined {
  const key = normalizeRule(text).toLowerCase();
  return rules.find((r) => r.toLowerCase() === key);
}

export interface RuleListHandle {
  /** Renders the list; `count` answers per rule and defaults to no count. Chips already there stay put; new ones pop. */
  render(rules: readonly string[], count?: (rule: string) => RuleCount): void;
  /** Draws the eye to a chip for a moment: the one a duplicate entry meant. */
  flash(rule: string): void;
}

/** Restarts a one-shot CSS animation on `el`: the class comes off, the style is flushed, and it goes back on. */
function replay(el: HTMLElement, cls: string) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  el.addEventListener("animationend", () => el.classList.remove(cls), { once: true });
}

function countText(c: RuleCount): string {
  if (c === null) return "";
  if (c === "judging") return "· …";
  if (c === "unknown") return "· ?";
  return `· ${c}`;
}

/**
 * A chip list over `ul`. Chips are keyed by rule text and reused across renders, so a re-render
 * after a count arrives changes one number, not the whole row, and only a chip that is new to
 * the list plays its entrance.
 */
export function ruleList(ul: HTMLUListElement, opts: { onRemove(rule: string): void }): RuleListHandle {
  const chips = new Map<string, HTMLLIElement>();
  const doc = ul.ownerDocument;

  function chip(rule: string): HTMLLIElement {
    const li = doc.createElement("li");
    li.className = "rule pop";
    li.dataset.rule = rule;
    const text = doc.createElement("span");
    text.className = "rule-text";
    text.textContent = rule;
    const count = doc.createElement("span");
    count.className = "rule-count";
    const x = doc.createElement("button");
    x.type = "button";
    x.className = "rule-x";
    x.textContent = "×";
    x.setAttribute("aria-label", `Remove “${rule}”`);
    x.addEventListener("click", () => opts.onRemove(rule));
    li.append(text, count, x);
    // The entrance plays once; without this a chip re-inserted by a later render would pop again.
    li.addEventListener("animationend", () => li.classList.remove("pop"), { once: true });
    return li;
  }

  return {
    render(rules, count = () => null) {
      for (const [rule, li] of chips) {
        if (!rules.includes(rule)) {
          li.remove();
          chips.delete(rule);
        }
      }
      rules.forEach((rule, i) => {
        let li = chips.get(rule);
        if (!li) {
          li = chip(rule);
          chips.set(rule, li);
        }
        // Keep the list in the user's order without re-inserting chips that are already in place.
        if (ul.children[i] !== li) ul.insertBefore(li, ul.children[i] ?? null);
        const c = count(rule);
        const el = li.querySelector<HTMLSpanElement>(".rule-count")!;
        const text = countText(c);
        if (el.textContent !== text) {
          el.textContent = text;
          // A number landing where the ellipsis was is the page answering: it settles into place.
          if (typeof c === "number") replay(el, "arrived");
        }
        el.hidden = text === "";
        el.classList.toggle("muted", c === 0 || c === "judging" || c === "unknown");
        li.title = typeof c === "number" ? `${c} ${c === 1 ? "sentence" : "sentences"} kept on this page` : "";
      });
      ul.hidden = rules.length === 0;
    },
    flash(rule) {
      const li = chips.get(rule);
      if (li) replay(li, "flash");
    },
  };
}

export interface RuleFieldOptions {
  rules(): readonly string[];
  onAdd(rule: string): void;
  /** The entry matched a rule already there; the caller usually flashes that chip. */
  onDuplicate(existing: string): void;
}

/**
 * Wires the field: Enter adds the normalised entry (or points at the duplicate), Escape clears
 * it, and the field disables itself with the hint when the list is full. `refresh` is called by
 * the owner after the list changes, and returns what the caller needs to stop the placeholder.
 */
export function ruleField(input: HTMLInputElement, opts: RuleFieldOptions): { refresh(): void; stop(): void } {
  input.maxLength = MAX_RULE_LENGTH;
  input.autocomplete = "off";
  input.spellcheck = false;
  let cycling: (() => void) | null = null;
  const win = input.ownerDocument.defaultView;

  function submit() {
    const rule = normalizeRule(input.value);
    if (!rule) return;
    const existing = findRule(opts.rules(), rule);
    input.value = "";
    if (existing !== undefined) opts.onDuplicate(existing);
    else opts.onAdd(rule);
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape" && input.value !== "") {
      // Only an entry to discard: an empty field lets Escape close the popup as it normally would.
      e.preventDefault();
      e.stopPropagation();
      input.value = "";
    }
  });

  // The examples the placeholder walks through, minus the ones already on the list: a field that
  // suggests "prices" under a "prices" chip reads as a bug. Restarted only when that set changes,
  // since refresh runs on every poll while a page is being judged.
  let shown = "";
  function refresh() {
    const rules = opts.rules();
    const full = rules.length >= MAX_RULES;
    input.disabled = full;
    if (full) {
      cycling?.();
      cycling = null;
      shown = "";
      input.placeholder = FULL_HINT;
      return;
    }
    if (!win) return;
    const examples = RULE_EXAMPLES.filter((e) => findRule(rules, e) === undefined);
    const key = examples.join("\n");
    if (cycling && key === shown) return;
    cycling?.();
    shown = key;
    cycling = cyclePlaceholder(input, win, examples.length ? examples : ["what to always keep"]);
  }

  return {
    refresh,
    stop() {
      cycling?.();
      cycling = null;
    },
  };
}

/**
 * Walks the placeholder through the examples every PLACEHOLDER_CYCLE_MS, fading the old one out
 * before the next comes in (the `swap` class drives that in CSS). Returns the stop function.
 */
export function cyclePlaceholder(input: HTMLInputElement, win: Window, examples = RULE_EXAMPLES): () => void {
  let i = 0;
  input.placeholder = examples[0] ?? "";
  let swap = 0;
  const tick = win.setInterval(() => {
    input.classList.add("swap");
    swap = win.setTimeout(() => {
      i = (i + 1) % examples.length;
      input.placeholder = examples[i] ?? "";
      input.classList.remove("swap");
    }, PLACEHOLDER_SWAP_MS);
  }, PLACEHOLDER_CYCLE_MS);
  return () => {
    win.clearInterval(tick);
    win.clearTimeout(swap);
    input.classList.remove("swap");
  };
}
