/**
 * The pair-composition mechanism: chaining registered pairs, lazy
 * lane-abutment / endpoint validation, and the A->B->A round trip.  Uses
 * throwaway registered pairs so it needs no db and no language package.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertThrows } from "../liminal/testing/assert.ts";
import { registerTransliterationPair, composedTransliterator,
         roundTripTransliterator, validateCompositions,
         type TransliterationPairSpec } from "./transliterate-pair.ts";

// Minimal spec: only the fields the composition machinery reads.
const p = (id: string, sourceLane: string, targetLane: string,
           transliterate: (w: string) => string,
           extra: Partial<TransliterationPairSpec> = {}) =>
    registerTransliterationPair({id, sourceLane, targetLane, version: 't',
                                 transliterate, ...extra});

// A -> B uppercases, B -> C appends '!', plus the inverses for round trip.
p('tp-ab', 'A', 'B', w => w.toUpperCase());
p('tp-bc', 'B', 'C', w => w + '!');
p('tp-ba', 'B', 'A', w => w.toLowerCase());          // inverse of tp-ab
p('tp-ac', 'A', 'C', w => w.toUpperCase() + '!', {composition: ['tp-ab', 'tp-bc']});

test("composedTransliterator: chains left-to-right", () => {
    assertEquals(composedTransliterator(['tp-ab', 'tp-bc'])('hi'), 'HI!');
});

test("composedTransliterator: unknown id and lane gap throw", () => {
    assertThrows(() => composedTransliterator(['tp-ab', 'nope']), Error, 'unknown pair');
    // tp-bc ends in C; tp-ab starts in A -> gap.
    assertThrows(() => composedTransliterator(['tp-bc', 'tp-ab']), Error, 'lane gap');
    assertThrows(() => composedTransliterator([]), Error, 'empty');
});

test("validateCompositions: endpoints must match the pair's own lanes", () => {
    validateCompositions();   // tp-ac declares A->C via ab,bc — consistent, no throw
    p('tp-bad', 'A', 'C', w => w, {composition: ['tp-ab']});   // ab is A->B, not A->C
    assertThrows(() => validateCompositions(), Error, 'endpoints');
});

test("roundTripTransliterator: A->B->A when the inverse is registered", () => {
    const rt = roundTripTransliterator('tp-ab');
    assert(rt !== undefined, 'inverse tp-ba registered');
    assertEquals(rt!('Hello'), 'hello');       // upper then lower = lossy on case
    // tp-bc has no C->B inverse registered.
    assertEquals(roundTripTransliterator('tp-bc'), undefined);
});
