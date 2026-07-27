/**
 * The ambiguity pattern form (transliterate-pattern.ts): parse/format
 * round-trip, RANKED enumeration, the lossy regex transform, candidate
 * folding, and loud rejection of stray reserved characters.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import { parsePattern, formatPattern, patternSize, enumeratePattern,
         patternToRegExp, patternMatches, candidatesToPattern,
       } from "./transliterate-pattern.ts";

test("pattern: parse/format round-trip", () => {
    for(const s of ["epa'q[oe]t", "ta(s|ts|)ipow", "plain'word", "[ae]start",
                    "two[ae]sites[ou]here", "g(ə|)j[ie]j"])
        assertEquals(formatPattern(parsePattern(s)), s);
    // A char-class group of 1-char alternatives formats back to brackets.
    assertEquals(formatPattern(parsePattern("x(a|e)y")), "x[ae]y");
});

test("pattern: parse errors are loud", () => {
    for(const bad of ["unclosed[ae", "unclosed(a|b", "stray]here", "stray|here",
                      "nested[a[e]]", "[a]", "(nopipe)", "[aa]", "(x|x)"]) {
        let threw = false;
        try { parsePattern(bad); } catch { threw = true; }
        assert(threw, `expected parse error: ${bad}`);
    }
});

test("pattern: ranked enumeration", () => {
    const p = parsePattern("epa'q[oe]t");
    assertEquals(patternSize(p), 2);
    assertEquals(enumeratePattern(p), ["epa'qot", "epa'qet"]);

    // Rank = sum of alternative indexes, all-preferred first; the empty
    // group branch enumerates too.
    const q = parsePattern("ta(s|ts|)i[pw]ow");
    assertEquals(patternSize(q), 6);
    assertEquals(enumeratePattern(q), [
        "tasipow",                       // cost 0
        "tasiwow", "tatsipow",           // cost 1
        "tatsiwow", "taipow",            // cost 2
        "taiwow",                        // cost 3
    ]);
    // The cap.
    assertEquals(enumeratePattern(q, 3), ["tasipow", "tasiwow", "tatsipow"]);
});

test("pattern: regex transform (the lossy direction)", () => {
    const p = parsePattern("ta(s|ts|)i[pw]ow");
    for(const w of enumeratePattern(p)) assert(patternMatches(p, w), w);
    assert(!patternMatches(p, "tazipow"));
    assert(!patternMatches(p, "xtasipow"), 'anchored both ends');
    // Orthographic characters that are regex metachars stay literal, and
    // the pattern's own surface syntax is NOT in the denoted set.
    const apo = parsePattern("epa'q[oe]t");
    assert(patternToRegExp(apo).test("epa'qot"));
    assert(!patternMatches(apo, "epa'q[oe]t"));
});

test("pattern: candidatesToPattern folds a ranked list", () => {
    const p = candidatesToPattern(["epa'qot", "epa'qet"])!;
    assertEquals(formatPattern(p), "epa'q[oe]t");
    // Rank is preserved: the first candidate is the preferred branch.
    assertEquals(enumeratePattern(p)[0], "epa'qot");
    // Insertion site: the shorter middle becomes the empty branch.
    assertEquals(formatPattern(candidatesToPattern(["gjijg", "gjijag"])!),
                 "gjij(|a)g");
    // Single candidate = a pure literal.
    assertEquals(formatPattern(candidatesToPattern(["mawita'jig"])!), "mawita'jig");
    // Not pattern-like (differences not isolable to one site) -> undefined.
    assertEquals(candidatesToPattern([]), undefined);
});
