/**
 * The LLM transcription eval's pure parts: ambiguity-aware scoring
 * (transcribe.ts).  The LLM-calling paths are exercised by the CLI against
 * the real API (budgeted, cached) - not here.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import { ambiguityCandidates, similarity } from "./transcribe.ts";

test("ambiguityCandidates: expands [a|b] markers, cartesian", () => {
    assertEquals(ambiguityCandidates('abc'), ['abc']);
    assertEquals(ambiguityCandidates('p[l|i]ei'), ['plei', 'piei']);
    assertEquals(ambiguityCandidates('[a|b]x[c|d]').toSorted(),
                 ['axc', 'axd', 'bxc', 'bxd'].toSorted());
});

test("ambiguityCandidates: cap keeps the first alternative beyond the limit", () => {
    const many = Array.from({length: 10}, () => '[a|b]').join('');   // 2^10 combos
    const c = ambiguityCandidates(many, 64);
    assert(c.length <= 64);
    assert(c.includes('aaaaaaaaaa'));
});

test("similarity: exact match 1; ambiguity scores as its best alternative", () => {
    assertEquals(similarity('aposgigen, clef', 'aposgigen, clef'), 1);
    // The [l|i] marker matches the gold's 'i' - honest uncertainty scores
    // as well as a lucky pick.
    assertEquals(similarity('p[l|i]tu', 'pitu'), 1);
    // Whitespace/newlines normalize away.
    assertEquals(similarity('a  b\nc', 'a b c'), 1);
    // A miss scores below 1.
    assert(similarity('eoltevetsi', 'eoltjeoetji') < 1);
    assert(similarity('eoltevetsi', 'eoltjeoetji') > 0.5);
});
