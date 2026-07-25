/**
 * The injective identifier escaper (identifier.ts).  The PROPERTY test is
 * the load-bearing one: over an adversarial corpus (exhaustive short
 * strings on a nasty alphabet + seeded randoms with embedded escape-word
 * substrings), every output is identifier-shaped and NO TWO DISTINCT
 * INPUTS COLLIDE.  The known counterexamples to the ORIGINAL scheme
 * (source '__' encoded as '___') are pinned individually - this corpus is
 * exactly what would have caught that bug.
 */
import { test } from "./testing/test.ts";
import { assertEquals, assertNotEquals } from "./testing/assert.ts";
import { toJavascriptIdentifier, isJavascriptIdentifier } from "./identifier.ts";

test("pretty names pass through untouched", () => {
    for(const s of ['spelling', 'my_field', 'a_b_c', '_private', 'entryId2', 'uu', '_uu_'])
        assertEquals(toJavascriptIdentifier(s), s);
});

test("the whole-string special forms", () => {
    assertEquals(toJavascriptIdentifier(''), '__empty');
    assertEquals(toJavascriptIdentifier('_'), '__underscore');
    assertEquals(toJavascriptIdentifier('class'), '__class');
    assertEquals(toJavascriptIdentifier('let'), '__let');
    assertEquals(toJavascriptIdentifier('constructor'), '__constructor');
});

test("MDF's digit-initial markers become identifiers", () => {
    assertEquals(toJavascriptIdentifier('1d'), '__1d');
    assertEquals(toJavascriptIdentifier('2s'), '__2s');
    assertEquals(isJavascriptIdentifier(toJavascriptIdentifier('3d')), true);
});

test("specials become words; the ortho slug shape", () => {
    assertEquals(toJavascriptIdentifier('mm-li'), 'mm__dash_li');
    assertEquals(toJavascriptIdentifier('a.b c'), 'a__dot_b__space_c');
});

test("the ORIGINAL scheme's counterexamples no longer collide", () => {
    assertEquals(toJavascriptIdentifier('_-'), '___dash_');
    assertEquals(toJavascriptIdentifier('__dash_'), '__uu_dash_');
    assertNotEquals(toJavascriptIdentifier('_-'), toJavascriptIdentifier('__dash_'));
    assertNotEquals(toJavascriptIdentifier('a_-b'), toJavascriptIdentifier('a__dash_b'));
    assertNotEquals(toJavascriptIdentifier('x_!'), toJavascriptIdentifier('x__bang_'));
});

test("PROPERTY: injective + identifier-shaped over an adversarial corpus", () => {
    // Deterministic LCG so the corpus is reproducible.
    let seed = 42;
    const rand = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;

    const alphabet = ['_', '-', 'a', '9', '!', 'u', 'd', 's', 'h', 'x', '2', 'f', ' '];
    const chunks = [...alphabet, 'uu', 'dash', '__', 'x2f', 'é'];
    const corpus = new Set<string>();
    // Exhaustive length 0..3 over the nasty alphabet.
    const grow = (prefix: string, depth: number) => {
        corpus.add(prefix);
        if(depth === 0) return;
        for(const c of alphabet) grow(prefix + c, depth - 1);
    };
    grow('', 3);
    // Seeded randoms with embedded escape-word substrings.
    for(let i = 0; i < 20000; i++) {
        let s = '';
        const n = 1 + rand(8);
        for(let j = 0; j < n; j++) s += chunks[rand(chunks.length)];
        corpus.add(s);
    }
    for(const s of ['_-', '__dash_', 'a_-b', 'a__dash_b', 'x_!', 'x__bang_',
                    '___', '____', '_', '', 'if', 'uu', '_uu_', '9d', 'é'])
        corpus.add(s);

    const seen = new Map<string, string>();
    for(const s of corpus) {
        const e = toJavascriptIdentifier(s);
        assertEquals(/^[A-Za-z_][A-Za-z0-9_]*$/.test(e), true,
                     `non-identifier output for ${JSON.stringify(s)}: ${JSON.stringify(e)}`);
        const prior = seen.get(e);
        if(prior !== undefined && prior !== s)
            throw new Error(`COLLISION: ${JSON.stringify(prior)} and ${JSON.stringify(s)} ` +
                            `both encode to ${JSON.stringify(e)}`);
        seen.set(e, s);
    }
    assertEquals(seen.size, corpus.size);
});
