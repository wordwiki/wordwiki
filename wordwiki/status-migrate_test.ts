// deno-lint-ignore-file no-explicit-any
/**
 * The status-remodel migration (status-migrate.ts): gates born from
 * Completed, the PDM-only exception, lifecycle renames, sta variant
 * blanking, 'Unknown' synthesis, the once-per-db marker, and dry-run.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import { withTestDb, TestTimeline, mkEntry, mkChild, type Fixture } from './testing.ts';
import { db } from '../liminal/db.ts';
import * as timestamp from '../liminal/timestamp.ts';
import { FindingsReport } from './findings.ts';
import { migrateStatus } from './status-migrate.ts';
import { backfillPublication } from './publication-backfill.ts';

const EOT = timestamp.END_OF_TIME;

function seed(fx: Fixture) {
    const tl = new TestTimeline();
    const mk = (entry_id: number, status: string|undefined, variant?: string) => {
        const e = mkEntry(entry_id, tl.next());
        fx.ww.applyTransaction([e], {quiet: true});
        fx.ww.applyTransaction([mkChild(e, 'spl', entry_id + 1, tl.next(),
                                        {attr1: `word${entry_id}`, variant: 'mm-li'})], {quiet: true});
        if(status !== undefined)
            fx.ww.applyTransaction([mkChild(e, 'sta', entry_id + 2, tl.next(),
                                            {attr1: status, variant})], {quiet: true});
    };
    mk(1000, 'Completed', 'mm-li');          // gate mm-li
    mk(2000, 'Completed', undefined);        // blank variant -> default mm-li
    mk(3000, 'CompletedAsPDMOnly', 'mm-li'); // NO gate, renamed
    mk(4000, 'InProcess', 'mm-li');          // no gate, variant blanked
    mk(5000, undefined);                     // no status: synthesized Unknown
    backfillPublication();                   // the pipeline order: Phase 0 first
}

const currentSta = (entry_id: number) => db().all<any, any>(
    `SELECT * FROM dict WHERE ty = 'sta' AND id1 = :e AND valid_to = :eot`,
    {e: entry_id, eot: EOT});
const gates = (entry_id: number) => db().all<any, any>(
    `SELECT * FROM dict WHERE ty = 'pub' AND id1 = :e AND valid_to = :eot`,
    {e: entry_id, eot: EOT});

test("migrate-status: gates, renames, blanking, synthesis; once-per-db marker", async () => {
    await withTestDb((fx) => {
        seed(fx);
        const store = new Map<string, string>();
        const config = { get: (k: string) => store.get(k), set: (k: string, v: string) => { store.set(k, v); } };
        const report = new FindingsReport('status', {quiet: true});
        const stats = migrateStatus(report, {config, now: fx.ww.allocTxTimestamps(1, {quiet: true})});

        // Gates: the two Completed entries, born-published, migration-stamped.
        for(const e of [1000, 2000]) {
            const g = gates(e);
            assertEquals(g.length, 1, `gate for ${e}`);
            assertEquals(g[0].variant, 'mm-li');
            assertEquals(g[0].change_by_username, '~status-migrate');
            assertEquals(g[0].published_to, EOT);
            assertEquals(g[0].published_from, g[0].valid_from);
        }
        // No gates for PDM-only / InProcess; the PDM word is NAMED in the report.
        assertEquals(gates(3000).length, 0);
        assertEquals(gates(4000).length, 0);
        assert(report.toMarkdown().includes('word3000'), 'PDM-only word named');

        // Renames + whole-lexeme blanking.
        assertEquals(currentSta(1000)[0].attr1, 'Complete');
        assertEquals(currentSta(3000)[0].attr1, 'CompleteAsPDMOnly');
        assertEquals(currentSta(4000)[0].attr1, 'InProcess');
        for(const e of [1000, 2000, 3000, 4000])
            assertEquals(currentSta(e)[0].variant, null, `sta variant blanked for ${e}`);

        // Synthesis for the statusless entry.
        const synth = currentSta(5000);
        assertEquals(synth.length, 1);
        assertEquals(synth[0].attr1, 'Unknown');
        assertEquals(synth[0].change_by_username, '~status-migrate');

        assert(stats.changed > 0);
        assertEquals(typeof store.get('status-migration-done'), 'string');

        // The composition end-to-end: gated words are public, others are not.
        fx.ww.requestWorkspaceReload();
        const publicIds = new Set(fx.ww.publishedEntries.map((e: any) => e.entry_id));
        assert(publicIds.has(1000) && publicIds.has(2000));
        assert(!publicIds.has(3000), 'PDM-only left the public site');
        assert(!publicIds.has(4000) && !publicIds.has(5000));

        // The marker makes a re-run a hard no-op - even though a NEW
        // Complete-but-deliberately-unpublic word now exists.
        const e6 = mkEntry(6000, timestamp.nextTime(timestamp.BEGINNING_OF_TIME));
        fx.ww.applyTransaction([e6], {quiet: true});
        fx.ww.applyTransaction([mkChild(e6, 'sta', 6002,
            timestamp.nextTime(timestamp.BEGINNING_OF_TIME), {attr1: 'Complete'})], {quiet: true});
        const again = migrateStatus(new FindingsReport('again', {quiet: true}),
            {config, now: fx.ww.allocTxTimestamps(1, {quiet: true})});
        assertEquals(again.skippedByMarker, true);
        assertEquals(again.changed, 0);
        assertEquals(gates(6000).length, 0, 'deliberately-unpublic word not gated');
    });
});

test("migrate-status --dry-run: reports, changes nothing, sets no marker", async () => {
    await withTestDb((fx) => {
        seed(fx);
        const store = new Map<string, string>();
        const config = { get: (k: string) => store.get(k), set: (k: string, v: string) => { store.set(k, v); } };
        const report = new FindingsReport('dry', {quiet: true});
        const stats = migrateStatus(report, {config, dryRun: true, now: fx.ww.allocTxTimestamps(1, {quiet: true})});

        assert(stats.changed > 0, 'reports would-changes');
        assertEquals(gates(1000).length, 0, 'no gate written');
        assertEquals(currentSta(1000)[0].attr1, 'Completed', 'no rename written');
        assertEquals(store.get('status-migration-done'), undefined, 'no marker');
        assert(report.toMarkdown().includes('DRY RUN'), 'labelled');

        // The real run afterwards still works.
        const real = migrateStatus(new FindingsReport('real', {quiet: true}),
            {config, now: fx.ww.allocTxTimestamps(1, {quiet: true})});
        assertEquals(real.changed, stats.changed);
        assertEquals(gates(1000).length, 1);
    });
});
