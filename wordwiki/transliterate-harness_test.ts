/**
 * The harness CORE (runHarness): pair normalization (legacy {li,sf}
 * accepted), scoring, error clusters, and the baseline diff - proving the
 * callable-on-JSON surface the SAAS path relies on.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import { runHarness, splitPairs } from "./transliterate-harness.ts";
import { normalizeCorpusPair } from "./transliterate-pair.ts";

const ORACLE = [
    {source: 'abc', target: 'apc', tag: 't1'},
    {source: 'def', target: 'def', tag: 't1'},
    {li: 'ghi', sf: 'ghix', tag: 't2'},          // legacy field names
];

test("runHarness: scores, clusters, legacy fields", () => {
    const [run] = runHarness(ORACLE,
        [{name: 'identity', fn: (w) => w}], {split: 'all'});
    assertEquals([run.n, run.exact], [3, 1]);
    assertEquals(run.near, 2);                    // both misses are 1 edit away
    assertEquals(run.perTag.toSorted((a, b) => a.tag < b.tag ? -1 : 1),
                 [{tag: 't1', n: 2, ok: 1}, {tag: 't2', n: 1, ok: 0}]);
    const sigs = run.clusters.map(c => c.sig);
    assert(sigs.includes(`replace 'b' -> 'p'`), sigs.join('; '));
    assert(sigs.includes(`insert '' -> 'x'`), sigs.join('; '));
    assert(run.lines.some(l => l.includes('1/3 exact')), 'report line');
});

test("runHarness: provenance stamps corpus fingerprint + fold sizes", () => {
    const [run] = runHarness(ORACLE, [{name: 'id', fn: (w) => w}],
        {split: 'holdout', meta: {pairId: 'demo', engineVersion: 'v1'}});
    const pv = run.provenance;
    assertEquals([pv.pairId, pv.engineVersion, pv.totalN], ['demo', 'v1', 3]);
    assertEquals(pv.trainN + pv.holdoutN, pv.totalN);          // exhaustive split
    assert(/^[0-9a-f]{8}$/.test(pv.corpusFingerprint), pv.corpusFingerprint);
    assert(run.lines[0].startsWith('[provenance]'), run.lines[0]);
    // Same corpus (order-independent) -> same fingerprint; a changed pair -> not.
    const [same] = runHarness([...ORACLE].reverse(), [{name: 'id', fn: (w) => w}], {split: 'all'});
    assertEquals(same.provenance.corpusFingerprint, pv.corpusFingerprint);
    const [diff] = runHarness([{source: 'z', target: 'z', tag: 't'}],
        [{name: 'id', fn: (w) => w}], {split: 'all'});
    assert(diff.provenance.corpusFingerprint !== pv.corpusFingerprint, 'fingerprint sensitive');
});

test("runHarness: baseline diff", () => {
    const [base] = runHarness(ORACLE, [{name: 'id', fn: (w) => w}], {split: 'all'});
    // A "rules change" that fixes abc and breaks def.
    const changed = (w: string) => w === 'abc' ? 'apc' : w === 'def' ? 'dex' : w;
    const [run] = runHarness(ORACLE, [{name: 'v2', fn: changed}],
                             {split: 'all', baseline: base.results});
    assertEquals(run.fixed, ['abc']);
    assertEquals(run.regressed, [{source: 'def', want: 'def', got: 'dex'}]);
});

test("splitPairs: deterministic, disjoint, exhaustive", () => {
    const many = Array.from({length: 200}, (_, i) =>
        normalizeCorpusPair({source: `word${i}`, target: `word${i}`, tag: 't'}));
    const train = splitPairs(many, 'train').pairs;
    const hold = splitPairs(many, 'holdout').pairs;
    assertEquals(train.length + hold.length, many.length);
    assert(hold.length > 10 && hold.length < 90, `plausible fold: ${hold.length}`);
    assertEquals(splitPairs(many, 'train').pairs.length, train.length);
    const holdSet = new Set(hold.map(p => p.source));
    assert(train.every(p => !holdSet.has(p.source)), 'disjoint');
});
