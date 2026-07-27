// deno-lint-ignore-file no-explicit-any
/**
 * machineSync (machine-sync.ts): the full case table - assert / unchanged
 * / supersede / retract / reassert / human-freeze (+frozen-stale) /
 * human-tombstone-respect - plus diff-first zero-churn and store
 * loadability after a sync.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import { db } from "../liminal/db.ts";
import * as security from "../liminal/security.ts";
import * as dictionaryConfig from "./dictionary-config.ts";
import { machineSync, type ComputedFact } from "./machine-sync.ts";
import { assertionPathToFields } from "./assertion.ts";
import { withTestDb, type Fixture } from "./testing.ts";

const EOT = 9007199254740991;
const AUTHOR = '~test-sync';

function seed(fx: Fixture) {
    dictionaryConfig.createDictionary('mst', {
        $type: 'schema', $name: 'm', $tag: 'tms',
        entry: {$type: 'relation', $tag: 'ent', entry_id: {$type: 'primary_key'},
            link: {$type: 'relation', $tag: 'lnk', link_id: {$type: 'primary_key'},
                   target: {$type: 'integer', $bind: 'attr1'},
                   confidence: {$type: 'string', $bind: 'attr2', $optional: true}}},
    }, {slug: 'mst'});
    // Two entries.
    let t = 9000;
    for(const e of [101, 102])
        db().insert('mst', {...assertionPathToFields([['tms', 0], ['ent', e]]),
            assertion_id: e, id: e, ty: 'ent', valid_from: t++, valid_to: EOT,
            order_key: `k${e}`, change_by_username: 'test'}, 'assertion_id');
    return fx.ww.storeFor('mst');
}

const fact = (id: number, entry: number, target: number, conf: string): ComputedFact => ({
    id, path: [['tms', 0], ['ent', entry], ['lnk', id]], ty: 'lnk',
    fields: {attr1: target, attr2: conf}});

test("machineSync: the case table", async () => {
    await withTestDb((fx) => security.runSystem(() => {
        try {
            const store = seed(fx);
            const q = (sql: string, p: any = {}): any[] => db().all<any, any>(sql, p);

            // ASSERT two facts.
            const r1 = machineSync(store, AUTHOR, ['lnk'],
                [fact(9001, 101, 555, 'high'), fact(9002, 102, 556, 'medium')]);
            assertEquals([r1.asserted, r1.superseded, r1.unchanged], [2, 0, 0]);

            // Diff-first: an identical re-run writes NOTHING.
            const before = q(`SELECT COUNT(*) AS n FROM mst`)[0].n;
            const r2 = machineSync(store, AUTHOR, ['lnk'],
                [fact(9001, 101, 555, 'high'), fact(9002, 102, 556, 'medium')]);
            assertEquals([r2.asserted, r2.unchanged], [0, 2]);
            assertEquals(q(`SELECT COUNT(*) AS n FROM mst`)[0].n, before);

            // SUPERSEDE on content change; RETRACT the no-longer-computed.
            const r3 = machineSync(store, AUTHOR, ['lnk'],
                [fact(9001, 101, 555, 'medium')]);         // conf changed; 9002 gone
            assertEquals([r3.superseded, r3.retracted], [1, 1]);
            assertEquals(q(`SELECT attr2 FROM mst WHERE id=9001 AND valid_to=:e`,
                           {e: EOT}).map(r => r.attr2), ['medium']);
            assertEquals(q(`SELECT COUNT(*) AS n FROM mst WHERE id=9002 AND valid_to=:e`,
                           {e: EOT})[0].n, 0);              // tombstoned

            // REASSERT: the machine computes 9002 again - its own old
            // retraction does not stick.
            const r4 = machineSync(store, AUTHOR, ['lnk'], [
                fact(9001, 101, 555, 'medium'), fact(9002, 102, 556, 'medium')]);
            assertEquals(r4.reasserted, 1);
            assertEquals(q(`SELECT attr2 FROM mst WHERE id=9002 AND valid_to=:e`,
                           {e: EOT}).map(r => r.attr2), ['medium']);

            // HUMAN FREEZE: a human edit on 9001 makes it untouchable; the
            // differing computed value reports frozen-stale.
            const open = q(`SELECT * FROM mst WHERE id=9001 AND valid_to=:e`, {e: EOT})[0];
            db().execute(`UPDATE mst SET valid_to=:t WHERE assertion_id=:a`,
                         {t: open.valid_from + 1, a: open.assertion_id});
            db().insert('mst', {...open, assertion_id: 990001,
                replaces_assertion_id: open.assertion_id,
                valid_from: open.valid_from + 1, valid_to: EOT,
                attr2: 'human-set', change_by_username: 'djz'}, 'assertion_id');
            const r5 = machineSync(store, AUTHOR, ['lnk'], [
                fact(9001, 101, 555, 'high'),               // differs from human's
                fact(9002, 102, 556, 'medium')]);
            assertEquals([r5.skippedHumanOwned, r5.unchanged], [1, 1]);
            assertEquals(r5.frozenStale.map(f => f.id), [9001]);
            assertEquals(q(`SELECT attr2 FROM mst WHERE id=9001 AND valid_to=:e`,
                           {e: EOT}).map(r => r.attr2), ['human-set']);
            // ...and a human-frozen fact is never RETRACTED either.
            const r6 = machineSync(store, AUTHOR, ['lnk'], [fact(9002, 102, 556, 'medium')]);
            assertEquals(r6.retracted, 0);

            // HUMAN TOMBSTONE: a human deletes 9002; the machine never
            // reasserts it.
            const o2 = q(`SELECT * FROM mst WHERE id=9002 AND valid_to=:e`, {e: EOT})[0];
            db().execute(`UPDATE mst SET valid_to=:t WHERE assertion_id=:a`,
                         {t: o2.valid_from + 1, a: o2.assertion_id});
            db().insert('mst', {...o2, assertion_id: 990002,
                replaces_assertion_id: o2.assertion_id,
                valid_from: o2.valid_from + 1, valid_to: o2.valid_from + 1,
                change_by_username: 'djz'}, 'assertion_id');
            const r7 = machineSync(store, AUTHOR, ['lnk'], [fact(9002, 102, 556, 'medium')]);
            assertEquals(r7.skippedHumanTombstoned, 1);
            assertEquals(q(`SELECT COUNT(*) AS n FROM mst WHERE id=9002 AND valid_to=:e`,
                           {e: EOT})[0].n, 0);

            // The store loads (structural validation passes).
            store.requestWorkspaceReload();
            assertEquals((store.entries as any[]).length, 2);
            // A non-system author refuses.
            let threw = false;
            try { machineSync(store, 'djz', ['lnk'], []); } catch { threw = true; }
            assert(threw, 'human author refused');
        } finally {
            db().executeStatements(
                'DROP TABLE IF EXISTS mst; DROP TABLE IF EXISTS mst_dict_config;');
        }
    }));
});
