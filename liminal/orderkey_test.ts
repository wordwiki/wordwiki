// Order keys: canonical '0.xxx' decimal strings whose plain string sort
// matches their numeric sort, used to represent explicit ordering in a
// relational db (see orderkey.ts).  The load-bearing invariants tested here:
// between() always returns a canonical key strictly between its bounds,
// null/undefined bounds mean open-ended, and null/undefined keys compare
// as equal to each other so callers' secondary sort criteria still apply.
import { test } from "./testing/test.ts";
import { assert, assertEquals, assertThrows } from "./testing/assert.ts";
import * as orderkey from "./orderkey.ts";

test("between with open bounds: starts ranges at 0.5", () => {
    assertEquals(orderkey.between(undefined, undefined), "0.5");
    assertEquals(orderkey.between(null, null), "0.5");
    assertEquals(orderkey.between("0.1", "0.9"), "0.5");
});

test("between accepts nulls as open bounds (db columns yield null, not undefined)", () => {
    const afterLast = orderkey.between("0.7", null);
    assert("0.7" < afterLast && afterLast < "0.9");
    const beforeFirst = orderkey.between(null, "0.3");
    assert("0.1" < beforeFirst && beforeFirst < "0.3");
});

test("between rejects malformed and non-canonical keys", () => {
    // Non-canonical forms ('0.20' is numerically '0.2' but string-distinct)
    // would corrupt the string-sort == numeric-sort invariant.
    for (const bad of ["0.20", "0.10", "0.0", "0.05", "1.5", ".5", "0.5e-1", "0", "", "cat"]) {
        assertThrows(() => orderkey.between(bad, "0.9"), Error, "incorrect form");
        assert(!orderkey.isValidOrderKey(bad), `isValidOrderKey('${bad}') should be false`);
    }
});

test("between rejects misordered, equal, and out-of-range bounds", () => {
    assertThrows(() => orderkey.between("0.5", "0.5"), Error);
    assertThrows(() => orderkey.between("0.6", "0.5"), Error);
    assertThrows(() => orderkey.between("0.91", undefined), Error);  // > end_key 0.9
});

test("compareOrderKeys: null/undefined sort last; two missing keys are equal", () => {
    assert(orderkey.compareOrderKeys("0.5", "0.6") < 0);
    assert(orderkey.compareOrderKeys("0.6", "0.5") > 0);
    assertEquals(orderkey.compareOrderKeys("0.5", "0.5"), 0);
    assert(orderkey.compareOrderKeys(null, "0.5") > 0);
    assert(orderkey.compareOrderKeys("0.5", undefined) < 0);
    // Regression: this returned 1, which (being truthy) short-circuited the
    // `compareOrderKeys(..) || byId(..)` tiebreaker chains in callers like
    // compareAssertionsByOrderKey, making sorts of unkeyed rows unstable.
    assertEquals(orderkey.compareOrderKeys(null, null), 0);
    assertEquals(orderkey.compareOrderKeys(undefined, null), 0);
});

test("initial: canonical, unique, sorted keys within (0.1, 0.9)", () => {
    assertEquals(orderkey.initial(0), []);
    for (const n of [1, 2, 9, 10, 11, 99, 100, 1000]) {
        const keys = orderkey.initial(n);
        assertEquals(keys.length, n);
        assertEquals(new Set(keys).size, n, `initial(${n}) has duplicates`);
        for (const k of keys) {
            assert(orderkey.isValidOrderKey(k), `initial(${n}) non-canonical key: ${k}`);
            assert("0.1" < k && k < "0.9", `initial(${n}) key out of range: ${k}`);
        }
        assertEquals(keys, [...keys].toSorted(), `initial(${n}) not sorted`);
    }
});

// Deterministic LCG so failures reproduce (liminal/random.ts is
// Math.random-based, which we don't want in a regression test).
function makeRng(seed: number): (n: number) => number {
    let state = seed;
    return (n: number) => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state % n;
    };
}

test("random inserts: every key canonical, unique, and string-sorted in place", () => {
    for (const [seed, seedKeys] of [[1, orderkey.initial(10)], [2, []]] as const) {
        const rand = makeRng(seed * 12345);
        const keys: string[] = [...seedKeys];
        for (let i = 0; i < 3000; i++) {
            const pos = rand(keys.length + 1);  // insert before index pos
            const a = pos === 0 ? null : keys[pos - 1];
            const b = pos === keys.length ? null : keys[pos];
            const k = orderkey.between(a, b);
            assert(orderkey.isValidOrderKey(k), `non-canonical key generated: ${k}`);
            if (a != null) {
                assert(a < k, `plain string order violated: ${a} !< ${k}`);
                assert(orderkey.compareOrderKeys(a, k) < 0, `collator order violated: ${a} vs ${k}`);
            }
            if (b != null) {
                assert(k < b, `plain string order violated: ${k} !< ${b}`);
                assert(orderkey.compareOrderKeys(k, b) < 0, `collator order violated: ${k} vs ${b}`);
            }
            keys.splice(pos, 0, k);
        }
        assertEquals(new Set(keys).size, keys.length, "duplicate keys generated");
        // Random inserts should keep keys short (worst observed is ~14 chars).
        assert(Math.max(...keys.map(k => k.length)) < 20);
    }
});

test("worst-case repeated front-insert: keys grow ~1 char per 3 inserts", () => {
    let v: string = orderkey.initial(1)[0];
    for (let i = 0; i < 300; i++)
        v = orderkey.between(undefined, v);
    assert(orderkey.isValidOrderKey(v));
    assert(v.length <= 110, `front-insert keys growing too fast: ${v.length} chars`);
});
