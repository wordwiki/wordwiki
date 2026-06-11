// levenshtein-distance.ts is a heavily optimized DP (prefix/suffix trimming,
// short-circuit exits, 4-wide unrolled inner loop) - too clever to verify by
// reading.  So the audit strategy here is: a plain textbook Wagner-Fischer
// reference implementation, an exhaustive sweep of short strings, and seeded
// random pairs chosen to exercise every special path (trims, la===0 / lb<3
// exits, unroll boundaries at lb%4).  Plus the metric axioms, which catch
// whole classes of bugs without needing expected values.
import { test } from "./testing/test.ts";
import { assert, assertEquals } from "./testing/assert.ts";
import { levenshteinDistance } from "./levenshtein-distance.ts";

// Textbook two-row Wagner-Fischer: obviously correct, O(n*m).
function reference(a: string, b: string): number {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++)
            cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1,
                              prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
        prev = cur;
    }
    return prev[b.length];
}

test("classic known distances", () => {
    assertEquals(levenshteinDistance("kitten", "sitting"), 3);
    assertEquals(levenshteinDistance("saturday", "sunday"), 3);
    assertEquals(levenshteinDistance("flaw", "lawn"), 2);
    assertEquals(levenshteinDistance("cat", "cut"), 1);
    assertEquals(levenshteinDistance("dog", "doug"), 1);
    assertEquals(levenshteinDistance("levenshtein", "levenshtein"), 0);
});

test("edges and short-circuit paths", () => {
    assertEquals(levenshteinDistance("", ""), 0);
    assertEquals(levenshteinDistance("", "abc"), 3);          // la === 0 exit
    assertEquals(levenshteinDistance("abc", ""), 3);          // swap then la === 0
    assertEquals(levenshteinDistance("abc", "abcdef"), 3);    // pure prefix
    assertEquals(levenshteinDistance("def", "abcdef"), 3);    // pure suffix
    assertEquals(levenshteinDistance("aaaXbbb", "aaaYbbb"), 1);   // trim both ends, lb<3 exit
    assertEquals(levenshteinDistance("aaabbb", "aaaXbbb"), 1);    // insertion in the middle
    assertEquals(levenshteinDistance("ab", "ba"), 2);         // no transposition in Levenshtein
    assertEquals(levenshteinDistance("a", "b"), 1);
});

test("exhaustive: all string pairs up to length 4 over a 3-char alphabet match the reference", () => {
    // 121 strings -> 14,641 pairs; covers every combination of trims and
    // short-circuit exits for small sizes.
    const alphabet = "abc";
    const strings = [""];
    for (let len = 1; len <= 4; len++) {
        const count = alphabet.length ** len;
        for (let n = 0; n < count; n++) {
            let s = "", v = n;
            for (let i = 0; i < len; i++) { s += alphabet[v % alphabet.length]; v = Math.floor(v / alphabet.length); }
            strings.push(s);
        }
    }
    for (const a of strings)
        for (const b of strings)
            assertEquals(levenshteinDistance(a, b), reference(a, b), `lev('${a}', '${b}')`);
});

// Deterministic LCG so failures reproduce.
function makeRng(seed: number): (n: number) => number {
    let state = seed;
    return (n: number) => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state % n;
    };
}

test("random pairs match the reference (small alphabet forces shared structure)", () => {
    // A 4-char alphabet makes common prefixes/suffixes and repeated chars
    // likely, and lengths 0..40 sweep the unrolled loop's lb%4 boundaries.
    const rand = makeRng(20260611);
    const randString = (maxLen: number) => {
        const len = rand(maxLen + 1);
        let s = "";
        for (let i = 0; i < len; i++) s += "abcd"[rand(4)];
        return s;
    };
    for (let i = 0; i < 3000; i++) {
        const a = randString(40), b = randString(40);
        assertEquals(levenshteinDistance(a, b), reference(a, b), `lev('${a}', '${b}')`);
    }
});

test("metric axioms and length bounds on random triples", () => {
    const rand = makeRng(424242);
    const randString = (maxLen: number) => {
        const len = rand(maxLen + 1);
        let s = "";
        for (let i = 0; i < len; i++) s += "abc"[rand(3)];
        return s;
    };
    for (let i = 0; i < 1000; i++) {
        const a = randString(25), b = randString(25), c = randString(25);
        const ab = levenshteinDistance(a, b);
        assertEquals(levenshteinDistance(a, a), 0);                       // identity
        assertEquals(levenshteinDistance(b, a), ab);                      // symmetry
        assert(ab >= Math.abs(a.length - b.length), `lower bound: ${a} ${b}`);
        assert(ab <= Math.max(a.length, b.length), `upper bound: ${a} ${b}`);
        assert(levenshteinDistance(a, c) <= ab + levenshteinDistance(b, c),
               `triangle inequality: '${a}' '${b}' '${c}'`);
        if (a !== b) assert(ab > 0, "distinct strings must have distance > 0");
    }
});

test("distances are in UTF-16 code units (documented semantics for non-BMP text)", () => {
    assertEquals(levenshteinDistance("\u{1F600}", "\u{1F601}"), 1);  // same high surrogate
    assertEquals(levenshteinDistance("\u{1F600}", "x"), 2);          // 2 units vs 1
    assertEquals(levenshteinDistance("\u{1F600}", "\u{1F600}"), 0);
});
