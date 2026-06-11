// nanoid: crypto-random ids drawn uniformly from an alphabet (see nanoid.ts).
// The load-bearing invariants tested here: every alphabet character is
// reachable (a too-small mask silently drops the top of the alphabet),
// accepted characters are uniform (mask+1 is a power of two dividing 256,
// out-of-range bytes refused), and inputs that would make the generator
// loop forever or bias the ids are rejected up front.
import { test } from "./testing/test.ts";
import { assert, assertEquals, assertThrows } from "./testing/assert.ts";
import { newId, customAlphabet, customRandom } from "./nanoid.ts";

const NEWID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

test("newId: 20 chars from the 52-char alphabet, no collisions in 10k", () => {
    const ids = Array.from({ length: 10_000 }, newId);
    for (const id of ids) {
        assertEquals(id.length, 20);
        for (const c of id) assert(NEWID_ALPHABET.includes(c), `unexpected char ${c} in ${id}`);
    }
    assertEquals(new Set(ids).size, ids.length);
});

test("newId: every alphabet character is reachable (mask regression guard)", () => {
    // A too-small mask (the historical float-log bug this module's clz32
    // mask avoids) would make the LAST characters unreachable - invisible
    // in casual use, a 2-in-52 entropy loss in every id.  2000 ids = 40k
    // draws; P(some char missing) < 1e-300 for a uniform generator.
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) for (const c of newId()) seen.add(c);
    assertEquals([...seen].toSorted().join(''), NEWID_ALPHABET);
});

// Deterministic byte source (xorshift32) so failures reproduce; the
// customRandom seam exists exactly so tests can inject this.
function seededBytes(seed: number): (n: number) => Uint8Array {
    let s = seed;
    return (n: number) => new Uint8Array(n).map(() => {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        return s & 0xff;
    });
}

// A generator that cycles deterministically through every byte value, so a
// test can prove reachability rather than sample it.
function cyclingBytes(): (n: number) => Uint8Array {
    let c = 0;
    return (n: number) => new Uint8Array(n).map(() => c++ & 0xff);
}

test("customRandom: exact alphabet coverage for EVERY alphabet length 1..256", () => {
    // Latin Extended block: 256 distinct single-code-unit characters.
    const chars = Array.from({ length: 256 }, (_, i) => String.fromCharCode(0x100 + i));
    for (let len = 1; len <= 256; len++) {
        const alphabet = chars.slice(0, len).join('');
        // 4*256 draws over all byte values: every index 0..len-1 is offered.
        const id = customRandom(cyclingBytes(), alphabet, 1024)();
        const seen = new Set(id);
        assertEquals(seen.size, len, `alphabet len ${len}: ${seen.size} distinct chars produced`);
        for (const c of seen) assert(alphabet.includes(c), `len ${len}: produced ${c} outside alphabet`);
    }
});

test("customRandom: accepted characters are uniform (seeded, generous bounds)", () => {
    // 52 chars (rejection path: mask 63) and 64 chars (no-rejection path).
    for (const [len, seed] of [[52, 0xdecafbad], [64, 0xfeedface]] as const) {
        const alphabet = Array.from({ length: len }, (_, i) => String.fromCharCode(0x100 + i)).join('');
        const id = customRandom(seededBytes(seed), alphabet, 100_000)();
        const counts = new Map<string, number>();
        for (const c of id) counts.set(c, (counts.get(c) ?? 0) + 1);
        const expected = 100_000 / len;
        for (const c of alphabet) {
            const n = counts.get(c) ?? 0;
            assert(Math.abs(n - expected) < expected * 0.25,
                   `char ${c} of ${len}: ${n} draws vs expected ~${Math.round(expected)}`);
        }
    }
});

test("customRandom: deterministic given a deterministic byte source", () => {
    const a = customRandom(seededBytes(42), 'abcdef', 32)();
    const b = customRandom(seededBytes(42), 'abcdef', 32)();
    assertEquals(a, b);
    assertEquals(a.length, 32);
});

test("customAlphabet: requested sizes and charsets, including the edges", () => {
    assertEquals(customAlphabet('a', 5)(), 'aaaaa');     // 1-char alphabet
    assertEquals(customAlphabet('0123456789', 1)().length, 1);
    const big = Array.from({ length: 256 }, (_, i) => String.fromCharCode(0x100 + i)).join('');
    assertEquals(customAlphabet(big, 40)().length, 40);  // 256-char alphabet
    const pow2 = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_', 64);
    assertEquals(pow2().length, 64);                     // 64 chars: no-rejection path
});

test("inputs that would loop forever or bias ids are rejected up front", () => {
    // Pre-validation, all of these spun the generator loop forever ...
    assertThrows(() => customAlphabet('', 5), Error, "alphabet");
    assertThrows(() => customAlphabet('abcdef', 0), Error, "size");
    assertThrows(() => customAlphabet('abcdef', -1), Error, "size");
    assertThrows(() => customAlphabet('abcdef', 2.5), Error, "size");
    // ... and these silently produced biased ids.
    const over256 = Array.from({ length: 257 }, (_, i) => String.fromCharCode(0x100 + i)).join('');
    assertThrows(() => customAlphabet(over256, 5), Error, "256");
    assertThrows(() => customAlphabet('aab', 5), Error, "duplicate");
    assertThrows(() => customAlphabet('ab\u{1F600}', 5), Error, "single-code-unit");
});
