/**
 * The rule-list interpreter (I4): transliterate == the sequential rule
 * chain, explain records only the fired steps, and rule ids are
 * content-keyed (stable across reordering / label edits).  Self-contained.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import { reRule, fnRule, compileRules, renderTrace } from "./transliterate-rules.ts";

const RULES = [
    reRule("g → k", /g/g, 'k'),
    reRule("double vowel → long", /aa/g, "a'"),
    reRule("drop final z", /z$/, ''),           // note: no /g flag, anchored
];

test("compileRules: transliterate == sequential apply", () => {
    const c = compileRules(RULES);
    assertEquals(c.transliterate('gaataz'), "ka'taz".replace(/z$/, ''));  // -> ka'ta
    assertEquals(c.transliterate('gaataz'), "ka'ta");
    assertEquals(c.transliterate('xyz'), 'xy');                          // only last rule fires
});

test("explain: records only the rules that FIRED, in order", () => {
    const c = compileRules(RULES, {pairId: 'demo', version: 'v1'});
    const t = c.explain('gaataz');
    assertEquals([t.input, t.output], ['gaataz', "ka'ta"]);
    assertEquals(t.steps.map(s => s.label), ["g → k", "double vowel → long", "drop final z"]);
    assertEquals(t.steps[0].before + '/' + t.steps[0].after, "gaataz/kaataz");
    // A word that triggers no rule -> empty derivation.
    const none = c.explain('mn');
    assertEquals(none.steps.length, 0);
    assertEquals(none.output, 'mn');
});

test("reRule id: content-keyed — label-independent, semantics-sensitive", () => {
    // Same pattern+replacement, different label -> SAME id (id is semantic).
    assertEquals(reRule("A", /g/g, 'k').id, reRule("different label", /g/g, 'k').id);
    // Different replacement -> different id.
    assert(reRule("x", /g/g, 'k').id !== reRule("x", /g/g, 'q').id);
    // Different pattern -> different id.
    assert(reRule("x", /g/g, 'k').id !== reRule("x", /h/g, 'k').id);
});

test("fnRule: id from label; apply runs", () => {
    const r = fnRule("reverse", w => [...w].reverse().join(''));
    assertEquals(r.apply('abc'), 'cba');
    assertEquals(r.id, fnRule("reverse", w => w).id);       // id keyed on label
    assert(r.source === undefined);                          // not a publishable regex
});

test("rulesFingerprint: order-sensitive", () => {
    const a = compileRules([RULES[0], RULES[1]]).rulesFingerprint;
    const b = compileRules([RULES[1], RULES[0]]).rulesFingerprint;
    assert(a !== b, 'reordering changes the fingerprint');
});

test("renderTrace: fired steps + no-fire case", () => {
    const c = compileRules(RULES);
    const lines = renderTrace(c.explain('gg'));
    assert(lines.some(l => l.includes('gg  →  kk')), lines.join('\n'));
    assert(renderTrace(c.explain('mn')).some(l => l.includes('no rule fired')));
});
