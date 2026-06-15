// deno-lint-ignore-file no-explicit-any
/**
 * The value-diff family (diff.ts): the right strategy for the shape of the
 * difference, and the rendered from/to markup.
 */
import { test } from "../liminal/testing/test.ts";
import { assertEquals, assertStringIncludes } from "../liminal/testing/assert.ts";
import { diffValues } from "./diff.ts";
import { markupToString } from "../liminal/markup.ts";

const from = (d: any) => markupToString(d.from);
const to = (d: any) => markupToString(d.to);

test("a one-letter lexeme tweak is a char diff that highlights the letter", () => {
    const d = diffValues("samqwan", "samqwann");
    assertEquals(d.strategy, "char");
    // The shared stem is plain; the added letter is the only highlight.
    assertStringIncludes(to(d), "samqwan");
    assertStringIncludes(to(d), "lm-diff-ins'>n</span>");
    assertEquals(from(d).includes("lm-diff-del"), false);   // nothing deleted
});

test("a single mid-word replacement marks just that letter on each side", () => {
    const d = diffValues("kesalk", "kesatk");
    assertEquals(d.strategy, "char");
    assertStringIncludes(from(d), "lm-diff-del'>l</span>");
    assertStringIncludes(to(d), "lm-diff-ins'>t</span>");
});

test("a reworded sentence is a word diff that marks the changed words", () => {
    const d = diffValues("he goes to the store", "she goes to the market");
    assertEquals(d.strategy, "word");
    // 'goes to the' is shared (plain); only the changed words are marked.
    assertStringIncludes(to(d), "goes to the");
    assertStringIncludes(to(d), "lm-diff-ins");
    assertStringIncludes(to(d), "market");
    assertStringIncludes(from(d), "store");
});

test("a tiny edit in a long value elides the unchanged context to a window", () => {
    const a = "BEGINNING " + "filler ".repeat(20) + "fox " + "trailing ".repeat(20) + "END";
    const b = "BEGINNING " + "filler ".repeat(20) + "dog " + "trailing ".repeat(20) + "END";
    const d = diffValues(a, b);
    assertEquals(d.strategy, "word");
    assertEquals(d.elided, true);
    assertStringIncludes(to(d), "lm-diff-elide");   // the "…"
    assertStringIncludes(to(d), "dog");             // the change is shown
    assertStringIncludes(to(d), "filler");          // with nearby context
    // The far ends (away from the edit) are collapsed.
    assertEquals(to(d).includes("BEGINNING"), false);
    assertEquals(to(d).includes("END"), false);
});

test("a short value is never elided", () => {
    const d = diffValues("he goes to the store", "she goes to the market");
    assertEquals(d.elided, false);
});

test("two unrelated values fall back to a plain replace (no diff noise)", () => {
    const d = diffValues("water", "fire");
    assertEquals(d.strategy, "replace");
    assertEquals(from(d).includes("lm-diff-del"), false);
    assertEquals(to(d).includes("lm-diff-ins"), false);
    assertStringIncludes(from(d), "water");
    assertStringIncludes(to(d), "fire");
});

test("an empty 'from' shows (empty) -> value, no diff", () => {
    const d = diffValues("", "samqwan");
    assertEquals(d.strategy, "replace");
    assertStringIncludes(from(d), "(empty)");
    assertStringIncludes(to(d), "samqwan");
});
