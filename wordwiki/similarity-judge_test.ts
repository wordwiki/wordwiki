// deno-lint-ignore-file no-explicit-any
/**
 * Similarity PASS 1 (similarity-judge.ts) without an LLM: cluster
 * assembly (presentations + evidence riding in), tolerant output
 * normalization, per-cluster failure isolation, unjudged-candidate
 * defaults, sampling, and the report.  The real memoized stage is
 * exercised by the CLI.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import { db } from "../liminal/db.ts";
import * as security from "../liminal/security.ts";
import * as dictionaryConfig from "./dictionary-config.ts";
import * as sim from "./similarity.ts";
import * as judge from "./similarity-judge.ts";
import { assertionPathToFields } from "./assertion.ts";
import { withTestDb, type Fixture } from "./testing.ts";

const EOT = 9007199254740991;

function seed(fx: Fixture) {
    const {ww} = fx;
    const mkDict = (table: string, tag: string) => dictionaryConfig.createDictionary(table, {
        $type: 'schema', $name: table, $tag: tag,
        entry: {$type: 'relation', $tag: 'ent', entry_id: {$type: 'primary_key'},
            spelling: {$type: 'relation', $tag: 'spl',
                $style: {$view: {titleRole: 'headword'}},
                spelling_id: {$type: 'primary_key'},
                text: {$type: 'string', $bind: 'attr1'},
                variant: {$type: 'variant', $bind: 'variant'}},
            gloss: {$type: 'relation', $tag: 'gls',
                $style: {$view: {titleRole: 'gloss'}},
                gloss_id: {$type: 'primary_key'},
                gloss: {$type: 'string', $bind: 'attr1'}}},
    }, {slug: table});
    mkDict('juda', 'tja');
    mkDict('judb', 'tjb');
    let t = 9000, id = 700;
    const entry = (table: string, tag: string, spelling: string, gloss: string) => {
        const e = ++id;
        const rows: any[] = [
            {...assertionPathToFields([[tag, 0], ['ent', e]]),
             assertion_id: e, id: e, ty: 'ent', valid_from: t++, valid_to: EOT,
             order_key: `k${e}`, change_by_username: 'test'},
            (() => { const spl = ++id;
                return {...assertionPathToFields([[tag, 0], ['ent', e], ['spl', spl]]),
                    assertion_id: spl, id: spl, ty: 'spl', valid_from: t++, valid_to: EOT,
                    order_key: `k${spl}`, attr1: spelling, variant: 'mm-li',
                    change_by_username: 'test'}; })(),
            (() => { const g = ++id;
                return {...assertionPathToFields([[tag, 0], ['ent', e], ['gls', g]]),
                    assertion_id: g, id: g, ty: 'gls', valid_from: t++, valid_to: EOT,
                    order_key: `k${g}`, attr1: gloss, change_by_username: 'test'}; })(),
        ];
        for(const r of rows) db().insert(table, r, 'assertion_id');
        return e;
    };
    const a1 = entry('juda', 'tja', "mui'n", 'a black bear');
    const a2 = entry('juda', 'tja', "sqolj", 'a green frog');
    const b1 = entry('judb', 'tjb', "mui'n", 'bear');
    const b2 = entry('judb', 'tjb', "mui'nji'j", 'bear cub diminutive');
    const b3 = entry('judb', 'tjb', "sqolj", 'frog');
    return {ww, a1, a2, b1, b2, b3};
}

test("judge driver: clusters, tolerant judgments, failure isolation, defaults", async () => {
    await withTestDb(async (fx) => {
        await security.runSystem(async () => {
            try {
                const {ww, a1, a2, b1, b2, b3} = seed(fx);
                sim.rebuildSimilarityIndex(ww.storeFor('juda'));
                sim.rebuildSimilarityIndex(ww.storeFor('judb'));
                const limits = {skel: {form: 4, corroborate: 10},
                                def:  {form: 4, corroborate: 10},
                                cat:  {form: 0, corroborate: 10}};
                const cands = sim.candidatePairs('juda', 'judb', {limits});
                assert(cands.some(c => c.entry_id === a1 && c.target_entry_id === b1));

                // The injected judge sees full cluster inputs...
                const seen: judge.JudgeClusterInput[] = [];
                const fake = (input: judge.JudgeClusterInput): Promise<judge.Judgment[]> => {
                    seen.push(input);
                    if(input.probe.entry_id === a2) throw new Error('boom');   // isolation
                    // Judge b1 same-word; LEAVE b2 unjudged (defaulting).
                    return Promise.resolve([{target_entry_id: b1, verdict: 'same-word',
                                             confidence: 'high', reason: 'same bear'}]);
                };
                const r = await judge.judgeCandidates(
                    null as any, ww.storeFor('juda'), ww.storeFor('judb'), cands,
                    {judge: fake, log: () => {}});

                // Cluster inputs carried presentations + evidence.
                const probeA1 = seen.find(i => i.probe.entry_id === a1)!;
                assertEquals(probeA1.probe.headwords[0].text, "mui'n");
                assertEquals(probeA1.probe.definitions, ['a black bear']);
                assert(probeA1.candidates.every(c => c.evidence.length > 0));

                // a2's cluster failed in isolation; a1's judged.
                assertEquals(r.failedClusters.map(f => f.entry_id), [a2]);
                const p1 = r.pairs.find(p => p.target_entry_id === b1)!;
                assertEquals([p1.verdict, p1.confidence], ['same-word', 'high']);
                // The unjudged candidate defaulted safe.
                const p2 = r.pairs.find(p => p.target_entry_id === b2);
                if(p2) assertEquals([p2.verdict, p2.confidence], ['unrelated', 'low']);
                assert(!r.pairs.some(p => p.entry_id === a2), 'failed cluster emitted no pairs');
                void b3;

                // Sampling caps the cluster count.
                const sampled = await judge.judgeCandidates(
                    null as any, ww.storeFor('juda'), ww.storeFor('judb'), cands,
                    {judge: () => Promise.resolve([]), sampleClusters: 1, log: () => {}});
                assertEquals(sampled.clusters, 1);

                // The report renders.
                const md = judge.judgeReportMarkdown('juda', 'judb', r,
                    () => 'w', {});
                assert(md.includes('same-word: 1'));
            } finally {
                db().executeStatements(
                    'DROP TABLE IF EXISTS juda; DROP TABLE IF EXISTS juda_dict_config;' +
                    'DROP TABLE IF EXISTS judb; DROP TABLE IF EXISTS judb_dict_config;' +
                    'DROP TABLE IF EXISTS similarity_key;');
            }
        });
    });
});
