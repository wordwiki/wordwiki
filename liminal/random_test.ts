// Math.random utility functions (see random.ts).  Math.random is not
// seedable, so the statistical assertions here use bounds at least 10
// standard deviations wide: tight enough to catch the bugs this audit
// fixed (the naive shuffle's ~2% bias, rollRandomDie's off-by-one), loose
// enough to essentially never flake.
import { test } from "./testing/test.ts";
import { assert, assertEquals, assertThrows } from "./testing/assert.ts";
import * as random from "./random.ts";

test("randomInt: both endpoints inclusive, nothing outside, roughly uniform", () => {
    const counts = new Map<number, number>();
    const N = 20_000;
    for (let i = 0; i < N; i++) {
        const v = random.randomInt(3, 6);
        assert(v >= 3 && v <= 6 && Number.isInteger(v), `out of range: ${v}`);
        counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    assertEquals([...counts.keys()].toSorted(), [3, 4, 5, 6]);  // all 4 values reachable
    for (const [v, n] of counts)
        assert(Math.abs(n / N - 0.25) < 0.05, `value ${v}: ${n}/${N} vs expected ~25%`);
    assertEquals(random.randomInt(5, 5), 5);  // degenerate range
    assertEquals(random.randomInt(-3, -3), -3);
});

test("randomInt: rejects reversed and non-integer bounds (previously silent garbage)", () => {
    assertThrows(() => random.randomInt(5, 0), Error, "bounds");
    assertThrows(() => random.randomInt(0.5, 2), Error, "bounds");
    assertThrows(() => random.randomInt(0, 2.5), Error, "bounds");
    assertThrows(() => random.randomInt(NaN, 3), Error, "bounds");
});

test("randomBool: produces both values, roughly balanced", () => {
    let trues = 0;
    const N = 20_000;
    for (let i = 0; i < N; i++) if (random.randomBool()) trues++;
    assert(Math.abs(trues / N - 0.5) < 0.1, `${trues}/${N} true`);
});

test("rollRandomDie: a spec of N rolls 0..N-1 (off-by-one regression)", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 20_000; i++) seen.add(random.rollRandomDie([6]));
    assertEquals([...seen].toSorted((a, b) => a - b), [0, 1, 2, 3, 4, 5]);  // never 6
    assertEquals(random.rollRandomDie([1]), 0);   // 1-faced die
    assertThrows(() => random.rollRandomDie([])); // previously returned NaN
});

test("rollRandomDie: mixes the dies as documented", () => {
    // [10, 100]: P(roll >= 10) = (1/2)(90/100) = 45%.
    const N = 50_000;
    let big = 0;
    for (let i = 0; i < N; i++) if (random.rollRandomDie([10, 100]) >= 10) big++;
    assert(Math.abs(big / N - 0.45) < 0.05, `${big}/${N} rolls >= 10`);
});

test("shuffle: in-place, preserves elements, handles the edges", () => {
    const arr = [5, 3, 3, 9, 1];
    const out = random.shuffle(arr);
    assert(out === arr, "must shuffle in place");
    assertEquals([...out].toSorted((a, b) => a - b), [1, 3, 3, 5, 9]);
    assertEquals(random.shuffle([]), []);
    assertEquals(random.shuffle([7]), [7]);
});

test("shuffle: uniform over permutations (naive-shuffle bias regression)", () => {
    // The pre-Fisher-Yates version was off by ~2% absolute on 3-element
    // permutations (14.7%-18.6% vs 16.7%).  60k trials puts one std dev at
    // ~0.15%, so a 1.5% bound is ~10 sigma for the fix and would still
    // catch the old bias.
    const counts = new Map<string, number>();
    const N = 60_000;
    for (let i = 0; i < N; i++) {
        const k = random.shuffle([0, 1, 2]).join('');
        counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    assertEquals(counts.size, 6, "all 6 permutations must occur");
    for (const [k, n] of counts)
        assert(Math.abs(n / N - 1 / 6) < 0.015, `perm ${k}: ${(100 * n / N).toFixed(2)}% vs ~16.67%`);
});

test("randomSequenceGenerator: length and face range; faces=0 means a permutation", () => {
    const seq = random.randomSequenceGenerator(500, 4);
    assertEquals(seq.length, 500);
    for (const v of seq) assert(v >= 0 && v < 4 && Number.isInteger(v), `out of range: ${v}`);

    const perm = random.randomSequenceGenerator(50, 0);
    assertEquals([...perm].toSorted((a, b) => a - b), Array.from({ length: 50 }, (_, i) => i));

    const noDups = random.randomSequenceGeneratorNoDups(50);
    assertEquals(new Set(noDups).size, 50);
    assertEquals(random.randomSequenceGenerator(0, 5), []);
});
