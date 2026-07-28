/**
 * orthoMatch/orthoMatches (transliterate-match.ts) + the xlit blocking
 * keys (similarity.transliteratedSkeletons): graded cross-orthography
 * matching over a SYNTHETIC registered pair - the Mi'gmaq pairs get their
 * own coverage in mikmaq/.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import { registerTransliterationPair } from "./transliterate-pair.ts";
import { parsePattern } from "./transliterate-pattern.ts";
import { orthoMatch, orthoMatches } from "./transliterate-match.ts";
import { transliteratedSkeletons } from "./similarity.ts";

// A toy pair: lane tst-a writes g where tst-b writes k, and word-final
// -ei branches to -ey (preferred) or stays.
registerTransliterationPair({
    id: 'tst', sourceLane: 'tst-a', targetLane: 'tst-b', version: 'tst/v1',
    transliterate: (w) => w.replaceAll('g', 'k').replace(/ei$/, 'ey'),
    candidatePattern: (w) => {
        const t = w.replaceAll('g', 'k');
        return /ei$/.test(t) ? parsePattern(`${t.slice(0, -2)}(ey|ei)`)
                             : [{alternatives: [t]}];
    },
});

test("orthoMatch: grades across a registered pair", () => {
    // exact: the rules alone explain it (either direction of the call).
    assertEquals(orthoMatch('gada', 'tst-a', 'kada', 'tst-b'),
                 {grade: 'exact', via: 'tst', rank: 0});
    assertEquals(orthoMatch('kada', 'tst-b', 'gada', 'tst-a').grade, 'exact');
    // candidate: the non-preferred branch, with its rank.
    assertEquals(orthoMatch('gadei', 'tst-a', 'kadey', 'tst-b'),
                 {grade: 'exact', via: 'tst', rank: 0});
    assertEquals(orthoMatch('gadei', 'tst-a', 'kadei', 'tst-b'),
                 {grade: 'candidate', via: 'tst', rank: 1});
    // skeleton: marks-only difference on the transliteration.
    assertEquals(orthoMatch('gada', 'tst-a', "ka'da", 'tst-b').grade, 'skeleton');
    // none.
    assertEquals(orthoMatch('gada', 'tst-a', 'zzz', 'tst-b').grade, 'none');
});

test("orthoMatch: same-lane and the cross-lane floor", () => {
    assertEquals(orthoMatch('gada', 'tst-a', 'gada', 'tst-a').grade, 'exact');
    assertEquals(orthoMatch("ga'da", 'tst-a', 'gada', 'tst-a').grade, 'skeleton');
    // Unregistered lane pair: raw cross-lane skeleton equality still floors.
    assertEquals(orthoMatch("wel'taq", 'xx-1', 'weltaq', 'xx-2').grade, 'skeleton');
    assertEquals(orthoMatch('abc', 'xx-1', 'xyz', 'xx-2').grade, 'none');
});

test("orthoMatches: the threshold wrapper", () => {
    assert(orthoMatches('gadei', 'tst-a', 'kadei', 'tst-b'));            // candidate >= candidate
    assert(!orthoMatches('gada', 'tst-a', "ka'da", 'tst-b'));            // skeleton < candidate
    assert(orthoMatches('gada', 'tst-a', "ka'da", 'tst-b', 'skeleton'));
});

test("transliteratedSkeletons: the xlit blocking keys", () => {
    // A tst-a spelling ALSO indexes the skeleton of its tst-b rendering.
    assertEquals(transliteratedSkeletons("ga'dei", 'tst-a'), ['kadey']);
    assertEquals(transliteratedSkeletons('gada', 'other-lane'), []);
    assertEquals(transliteratedSkeletons('gada', undefined), []);
});
