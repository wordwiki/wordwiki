/**
 * The LLM transcription eval's pure parts: ambiguity-aware scoring
 * (transcribe.ts).  The LLM-calling paths are exercised by the CLI against
 * the real API (budgeted, cached) - not here.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import { ambiguityCandidates, similarity, cropClosure } from "./transcribe.ts";

// cropClosure is THE crop cache key (batch-derivation §12b: one shared
// computation for the DB-group path and the PDM derive-from-boxes path).
// This pins the HISTORICAL closure shape byte-for-byte - a change here
// orphans every paid group-crop-keyed extraction in the store.
test("cropClosure: the historical key shape, order-sensitive, geometry-sensitive", () => {
    const page = {image_ref: 'content/pdm/ab/abc.jpg', width: 2000, height: 3000};
    const boxes = [{x: 100, y: 200, w: 300, h: 40}, {x: 120, y: 260, w: 280, h: 38}];
    // The exact shape groupCropPath has always produced: margins 12 (union)
    // and 16 (per box), crop-relative clamped rects.
    assertEquals(cropClosure(page, boxes),
                 ['groupCropCmd', 'content/pdm/ab/abc.jpg', 88, 188, 324, 122,
                  [{x1: 0, y1: 0, x2: 324, y2: 68},
                   {x1: 16, y1: 56, x2: 324, y2: 122}]]);
    // Same rects, different order = a DIFFERENT key (rects ride the closure
    // as an array; both call sites must build them in the same order).
    assert(JSON.stringify(cropClosure(page, boxes)) !==
           JSON.stringify(cropClosure(page, [boxes[1], boxes[0]])));
    // Geometry moves the key (boxes move => re-extract).
    assert(JSON.stringify(cropClosure(page, boxes)) !==
           JSON.stringify(cropClosure(page, [{...boxes[0], x: 101}, boxes[1]])));
});

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

test("lenient similarity: punctuation/case forgiven; apostrophes count MID-WORD only", async () => {
    const { lenientSimilarity } = await import("./transcribe.ts");
    // Punctuation + case differences: strict dings, lenient forgives.
    assert(similarity("aqtatpa'q, middle of the night", "Aqtatpa'q middle of the night.") < 1);
    assertEquals(lenientSimilarity("aqtatpa'q, middle of the night",
                                   "Aqtatpa'q middle of the night."), 1);
    // A MID-WORD apostrophe is orthography - its absence still counts.
    assert(lenientSimilarity("aqtatpaq", "aqtatpa'q") < 1);
    // A boundary apostrophe is punctuation - forgiven.
    assertEquals(lenientSimilarity("'aqtatpa'q'", "aqtatpa'q"), 1);
    // Unicode right-single-quote unifies with the ASCII apostrophe.
    assertEquals(lenientSimilarity("aqtatpa\u2019q", "aqtatpa'q"), 1);
});
