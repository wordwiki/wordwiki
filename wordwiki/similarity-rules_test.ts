/**
 * The algorithmic judge (similarity-rules.ts): each rule in isolation -
 * exact/near skeleton with and without meaning agreement, morphology
 * (finals, stems, diminutive), root families, the rare-token and
 * coincidence rules - plus the referral band's semantics.
 */
import '../mikmaq/register.ts';   // Mi'gmaq normalizers + rules
import { test } from "../liminal/testing/test.ts";
import { assertEquals } from "../liminal/testing/assert.ts";
import * as rules from "./similarity-rules.ts";

const ev = (kind: 'skel'|'def'|'cat', key: string, df: number) =>
    ({kind, key, df, weight: 1});
const keys = (skels: string[], defs: string[]) => ({skels, defs});

test("rules: exact skeleton - agreement, missing defs, homograph ambiguity", () => {
    // plamu/plamu with 'salmon' both sides -> same-word high.
    assertEquals(rules.ruleVerdict(
        keys(['plamu'], ['salmon']), keys(['plamu'], ['salmon', 'fish']),
        [ev('skel', 'plamu', 2), ev('def', 'salmon', 4)]),
        {verdict: 'same-word', confidence: 'high', rule: 'exact-skel+def-overlap'});
    // Exact form, one side undefined (the entoq case) -> same-word medium.
    assertEquals(rules.ruleVerdict(
        keys(['entoq'], []), keys(['entoq'], ['groan']),
        [ev('skel', 'entoq', 2)]).verdict, 'same-word');
    // Exact form, DISJOINT definitions (zephyr vs breezy) -> the judgment
    // call the rules refuse: ambiguous (the referral band).
    assertEquals(rules.ruleVerdict(
        keys(['newsg'], ['zephyr']), keys(['newsg'], ['breezy', 'draughty']),
        [ev('skel', 'newsg', 2)]).verdict, 'ambiguous');
});

test("rules: near skeleton, morphology, root families", () => {
    // One-letter orthographic drift + shared meaning -> same-word medium.
    assertEquals(rules.ruleVerdict(
        keys(['gitulit'], ['finish', 'canoe']), keys(['gistulit'], ['finish', 'canoe']),
        [ev('def', 'finish', 5)]).verdict, 'same-word');
    // Diminutive: mui'n / mui'nji'j.
    const dim = rules.ruleVerdict(
        keys(['muin'], ['bear']), keys(['muinjij'], ['bear', 'cub']),
        [ev('def', 'bear', 6)]);
    assertEquals([dim.verdict, dim.qualifier], ['related', 'diminutive']);
    // Same stem under different verb finals: mawoteget / mawotasit.
    const stem = rules.ruleVerdict(
        keys(['mawoteget'], ['gather']), keys(['mawotasit'], ['gather', 'collect']),
        [ev('def', 'gather', 8)]);
    assertEquals([stem.verdict, stem.rule], ['related', 'same-stem']);
    // Root family: shared initial + meaning overlap (the maw- family).
    const fam = rules.ruleVerdict(
        keys(['mawalaji'], ['collect']), keys(['mawteg'], ['collect', 'save']),
        [ev('def', 'collect', 21)]);
    assertEquals(fam.verdict, 'related');
});

test("rules: meaning-only and the coincidence default", () => {
    // A single common token, no formal relation (mawalaji vs gunte'j's
    // pebble-collecting example) -> unrelated high.
    assertEquals(rules.ruleVerdict(
        keys(['mawalaji'], ['collect']), keys(['guntej'], ['pebble', 'stone', 'collect']),
        [ev('def', 'collect', 21)]),
        {verdict: 'unrelated', confidence: 'high', rule: 'single-common-token'});
    // A VERY rare shared token with no formal link: possible synonym pair
    // -> ambiguous (referral).
    assertEquals(rules.ruleVerdict(
        keys(['etawet'], ['crave']), keys(['mesugtaqanat'], ['crave']),
        [ev('def', 'crave', 2)]).verdict, 'ambiguous');
    // Two shared (non-rare) tokens -> related low.
    assertEquals(rules.ruleVerdict(
        keys(['aaa'], ['gather', 'winter']), keys(['zzz'], ['gather', 'winter']),
        [ev('def', 'gather', 8), ev('def', 'winter', 9)]).verdict, 'related');
});

test("morphology helpers: finals and prefixes", () => {
    assertEquals(rules.stripFinal('mawoteget'), {stem: 'mawot', final: 'eget'});
    assertEquals(rules.stripFinal('mawotasit'), {stem: 'mawot', final: 'asit'});
    assertEquals(rules.stripFinal('abc'), undefined);            // stem too short
    assertEquals(rules.sharedPrefixLen('mawalaji', 'mawteg'), 3);
});
