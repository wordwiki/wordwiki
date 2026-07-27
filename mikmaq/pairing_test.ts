// deno-lint-ignore-file no-explicit-any
/**
 * The pairing plan (mikmaq/pairing.ts planPairs, pure): same-word only,
 * 1:1 per rand entry with the multi-pair worklist, both-side facts with
 * deterministic content-keyed ids, MMO-side rank ordering.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import { planPairs } from "./pairing.ts";
import type { RuledPair } from "../wordwiki/similarity-rules.ts";

const rp = (entry: number, target: number, verdict: any, score: number): RuledPair => ({
    entry_id: entry, target_entry_id: target, verdict, confidence: 'high',
    rule: 'exact-skel+def-overlap', score, exactSkeleton: true, evidence: []});

const TAGS = {randRoot: 'trd', randEntry: 'ent', mmoRoot: 'dct', mmoEntry: 'ent'};

test("planPairs: same-word only, 1:1 with worklist, both sides, determinism", () => {
    const plan = planPairs([
        rp(1, 100, 'same-word', 9),
        rp(1, 101, 'same-word', 5),        // second match -> worklist
        rp(2, 100, 'same-word', 7),        // duplicate rand record -> same MMO
        rp(3, 102, 'related', 8),          // not a pair
        rp(4, 103, 'ambiguous', 8),        // not a pair
    ], TAGS);

    assertEquals(plan.pairs.map(p => [p.rand_entry, p.mmo_entry]).toSorted(),
                 [[1, 100], [2, 100]]);
    assertEquals(plan.multiPairWorklist,
                 [{rand_entry: 1, kept: 100, dropped: [101]}]);

    // rand side: one fact per rand entry, confidence + rule in the fields.
    assertEquals(plan.randFacts.length, 2);
    const f1 = plan.randFacts.find(f => f.path[1][1] === 1)!;
    assertEquals([f1.ty, f1.fields.attr1, f1.fields.attr2], ['mcp', 100, 'high']);

    // MMO side: entry 100 receives BOTH rand duplicates, score-ranked.
    const mmoFor100 = plan.dictFacts.filter(f => f.path[1][1] === 100);
    assertEquals(mmoFor100.map(f => f.fields.attr1), [1, 2]);   // score 9 then 7
    assert(mmoFor100[0].order_key! < mmoFor100[1].order_key!, 'rank order keys');

    // Deterministic ids: replanning yields identical fact ids.
    const again = planPairs([rp(1, 100, 'same-word', 9)], TAGS);
    assertEquals(again.randFacts[0].id, f1.id);
});
