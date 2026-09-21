/**
 * The rules field and chip list the popup and the options page share: what Enter, Escape, × and
 * a full list do, how chips are reused between renders, and the placeholder that walks through
 * examples.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_RULES, MAX_RULE_LENGTH } from "../src/shared/constants.ts";
import { FULL_HINT, PLACEHOLDER_CYCLE_MS, RULE_EXAMPLES, cyclePlaceholder, findRule, ruleField, ruleList } from "../src/ui/rules.ts";

const keydown = (el: HTMLElement, key: string) => {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};
const shown = (ul: HTMLUListElement) => Array.from(ul.querySelectorAll<HTMLLIElement>(".rule")).map((li) => li.dataset.rule);
const countOf = (ul: HTMLUListElement, rule: string) => {
  const el = ul.querySelector<HTMLElement>(`.rule[data-rule="${rule}"] .rule-count`)!;
  return el.hidden ? null : el.textContent;
};

let ul: HTMLUListElement;
let input: HTMLInputElement;

beforeEach(() => {
  document.body.innerHTML = '<ul id="l"></ul><input id="i" />';
  ul = document.getElementById("l") as HTMLUListElement;
  input = document.getElementById("i") as HTMLInputElement;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("findRule", () => {
  it("matches ignoring case and surrounding whitespace", () => {
    expect(findRule(["Prices", "deadlines"], " prices ")).toBe("Prices");
    expect(findRule(["Prices"], "price")).toBeUndefined();
    expect(findRule([], "prices")).toBeUndefined();
  });
});

describe("ruleList", () => {
  it("renders chips in order, reuses them across renders, pops only new ones, and removes what is gone", () => {
    const onRemove = vi.fn();
    const list = ruleList(ul, { onRemove });
    expect(ul.hidden).toBe(false);
    list.render([]);
    expect(ul.hidden).toBe(true);
    list.render(["prices", "deadlines"]);
    expect(ul.hidden).toBe(false);
    expect(shown(ul)).toEqual(["prices", "deadlines"]);
    const prices = ul.querySelector<HTMLLIElement>('.rule[data-rule="prices"]')!;
    expect(prices.classList.contains("pop")).toBe(true);
    prices.dispatchEvent(new Event("animationend"));
    expect(prices.classList.contains("pop")).toBe(false);
    // Same chip element after a re-render: nothing pops again, the order is kept.
    list.render(["deadlines", "prices", "allergens"]);
    expect(shown(ul)).toEqual(["deadlines", "prices", "allergens"]);
    expect(ul.querySelector('.rule[data-rule="prices"]')).toBe(prices);
    expect(prices.classList.contains("pop")).toBe(false);
    expect(ul.querySelector('.rule[data-rule="allergens"]')?.classList.contains("pop")).toBe(true);
    list.render(["prices"]);
    expect(shown(ul)).toEqual(["prices"]);
    (prices.querySelector(".rule-x") as HTMLButtonElement).click();
    expect(onRemove).toHaveBeenCalledWith("prices");
    expect(prices.querySelector(".rule-x")?.getAttribute("aria-label")).toBe("Remove “prices”");
  });

  it("shows a count per rule: a number, … while judging, ? when unknown, nothing when there is none", () => {
    const list = ruleList(ul, { onRemove: () => undefined });
    const counts: Record<string, number | "judging" | "unknown" | null> = { a: 3, b: 0, c: "judging", d: "unknown", e: null };
    list.render(["a", "b", "c", "d", "e"], (r) => counts[r] ?? null);
    expect(countOf(ul, "a")).toBe("· 3");
    expect(countOf(ul, "b")).toBe("· 0");
    expect(countOf(ul, "c")).toBe("· …");
    expect(countOf(ul, "d")).toBe("· ?");
    expect(countOf(ul, "e")).toBeNull();
    const muted = (r: string) => ul.querySelector(`.rule[data-rule="${r}"] .rule-count`)?.classList.contains("muted");
    expect([muted("a"), muted("b"), muted("c"), muted("d")]).toEqual([false, true, true, true]);
    expect(ul.querySelector<HTMLElement>('.rule[data-rule="a"]')?.title).toBe("3 sentences kept on this page");
    expect(ul.querySelector<HTMLElement>('.rule[data-rule="c"]')?.title).toBe("");
    list.render(["a"], () => 1);
    expect(countOf(ul, "a")).toBe("· 1");
    expect(ul.querySelector<HTMLElement>('.rule[data-rule="a"]')?.title).toBe("1 sentence kept on this page");
  });

  it("flash marks a chip and restarts on a second flash", () => {
    const list = ruleList(ul, { onRemove: () => undefined });
    list.render(["prices"]);
    list.flash("prices");
    const li = ul.querySelector<HTMLLIElement>('.rule[data-rule="prices"]')!;
    expect(li.classList.contains("flash")).toBe(true);
    li.dispatchEvent(new Event("animationend"));
    expect(li.classList.contains("flash")).toBe(false);
    list.flash("nope");
  });
});

describe("ruleField", () => {
  it("Enter adds the normalised entry or points at its duplicate; Escape clears an entry only", () => {
    vi.useFakeTimers();
    const rules: string[] = ["prices"];
    const onAdd = vi.fn((r: string) => rules.push(r));
    const onDuplicate = vi.fn();
    const field = ruleField(input, { rules: () => rules, onAdd, onDuplicate });
    expect(input.maxLength).toBe(MAX_RULE_LENGTH);
    expect(input.autocomplete).toBe("off");
    input.value = "  what   I have to do ";
    expect(keydown(input, "Enter").defaultPrevented).toBe(true);
    expect(onAdd).toHaveBeenCalledWith("what I have to do");
    expect(input.value).toBe("");
    input.value = " PRICES";
    keydown(input, "Enter");
    expect(onDuplicate).toHaveBeenCalledWith("prices");
    expect(onAdd).toHaveBeenCalledTimes(1);
    input.value = "   ";
    keydown(input, "Enter");
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onDuplicate).toHaveBeenCalledTimes(1);
    input.value = "dead";
    expect(keydown(input, "Escape").defaultPrevented).toBe(true);
    expect(input.value).toBe("");
    expect(keydown(input, "Escape").defaultPrevented).toBe(false);
    keydown(input, "a");
    field.stop();
  });

  it("disables itself with the hint when the list is full, and comes back when it is not", () => {
    vi.useFakeTimers();
    let rules = Array.from({ length: MAX_RULES }, (_, i) => `r${i}`);
    const field = ruleField(input, { rules: () => rules, onAdd: () => undefined, onDuplicate: () => undefined });
    field.refresh();
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe(FULL_HINT);
    expect(FULL_HINT).toBe(`${MAX_RULES} is plenty`);
    vi.advanceTimersByTime(PLACEHOLDER_CYCLE_MS * 2);
    expect(input.placeholder).toBe(FULL_HINT);
    rules = rules.slice(1);
    field.refresh();
    expect(input.disabled).toBe(false);
    expect(input.placeholder).toBe(RULE_EXAMPLES[0]);
    field.stop();
  });
});

describe("cyclePlaceholder", () => {
  it("walks through the examples every 3 s, fading the old one out first, and stops cleanly", () => {
    vi.useFakeTimers();
    const stop = cyclePlaceholder(input, window);
    expect(input.placeholder).toBe("prices");
    vi.advanceTimersByTime(PLACEHOLDER_CYCLE_MS);
    expect(input.classList.contains("swap")).toBe(true);
    expect(input.placeholder).toBe("prices");
    vi.advanceTimersByTime(200);
    expect(input.classList.contains("swap")).toBe(false);
    expect(input.placeholder).toBe("deadlines");
    vi.advanceTimersByTime(PLACEHOLDER_CYCLE_MS + 200);
    expect(input.placeholder).toBe("allergens");
    vi.advanceTimersByTime(PLACEHOLDER_CYCLE_MS + 200);
    expect(input.placeholder).toBe("what I have to do");
    vi.advanceTimersByTime(PLACEHOLDER_CYCLE_MS + 200);
    expect(input.placeholder).toBe("names of people");
    vi.advanceTimersByTime(PLACEHOLDER_CYCLE_MS + 200);
    expect(input.placeholder).toBe("prices");
    expect(RULE_EXAMPLES).toEqual(["prices", "deadlines", "allergens", "what I have to do", "names of people"]);
    // Stopped mid-cycle: the swap in progress is dropped and the placeholder stays where it is.
    vi.advanceTimersByTime(PLACEHOLDER_CYCLE_MS);
    expect(input.placeholder).toBe("deadlines");
    stop();
    expect(input.classList.contains("swap")).toBe(false);
    vi.advanceTimersByTime(PLACEHOLDER_CYCLE_MS * 3);
    expect(input.placeholder).toBe("deadlines");
  });
});
