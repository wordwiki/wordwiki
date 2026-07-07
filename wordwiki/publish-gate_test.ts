// deno-lint-ignore-file no-explicit-any
/**
 * The per-orthography publish gate (fix-orthographies.md "Status"): the
 * makePublic/withdraw verbs, the composition rule (entryIsPublicIn +
 * publishedEntries), and the editor's Public row — driven through dispatch
 * where routes are involved (the route-undeclared pattern).
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertRejects } from "../liminal/testing/assert.ts";
import { markupToString } from "../liminal/markup.ts";
import { withTestDb, as, bornApprove, renderRoute, invoke,
         TestTimeline, mkEntry, mkChild, type Fixture } from './testing.ts';
import { db } from '../liminal/db.ts';
import * as timestamp from '../liminal/timestamp.ts';
import * as entrySchema from './entry-schema.ts';

const EOT = timestamp.END_OF_TIME;

// An entry with a spelling and a Complete lifecycle, born-approved (the gate
// verbs require the entry fact itself to be published).
function seedWord(fx: Fixture, entry_id = 1000): void {
    const tl = new TestTimeline();
    const e = mkEntry(entry_id, tl.next());
    fx.ww.applyTransaction([e], {quiet: true});
    fx.ww.applyTransaction([mkChild(e, 'spl', entry_id + 1, tl.next(),
                                    {attr1: 'samqwan', variant: 'mm-li'})], {quiet: true});
    fx.ww.applyTransaction([mkChild(e, 'sta', entry_id + 2, tl.next(),
                                    {attr1: 'Complete'})], {quiet: true});
    bornApprove(fx.ww);
}

const gateRows = (entry_id: number) =>
    db().all<any, any>(
        `SELECT * FROM dict WHERE ty = 'pub' AND id1 = :e ORDER BY valid_from`, {e: entry_id});

test("makePublic: born-published gate fact; composition turns public; idempotent", async () => {
    await withTestDb(async (fx) => {
        seedWord(fx);
        // Not public before the explicit decision, even though everything is
        // approved and the lifecycle is Complete.
        assert(!fx.ww.publishedEntries.some((e: any) => e.entry_id === 1000),
               'approved+Complete is NOT public without the gate');

        const r = await as(fx, 'djz', () =>
            invoke(fx.ww, `wordwiki.lexeme.makePublic($arg0, $arg1)`, 1000, 'mm-li'));
        assertEquals(r.action, 'reload');
        assert(r.targets.includes('.-entry-1000-public-'), 'reloads the Public row');

        const rows = gateRows(1000);
        assertEquals(rows.length, 1);
        const g = rows[0];
        assertEquals(g.variant, 'mm-li');
        assertEquals(g.change_by_username, 'djz');
        assertEquals(g.published_from, g.valid_from);   // born-published
        assertEquals(g.published_to, EOT);
        assertEquals(g.valid_to, EOT);

        // The composition rule: now public in mm-li, still not in mm-sf.
        const entry = fx.ww.entriesById.get(1000)!;
        assert(entrySchema.entryIsPublicIn(entry, 'mm-li'));
        assert(!entrySchema.entryIsPublicIn(entry, 'mm-sf'));
        assert(fx.ww.publishedEntries.some((e: any) => e.entry_id === 1000));

        // Idempotent: a second makePublic adds nothing.
        await as(fx, 'djz', () =>
            invoke(fx.ww, `wordwiki.lexeme.makePublic($arg0, $arg1)`, 1000, 'mm-li'));
        assertEquals(gateRows(1000).length, 1);
    });
});

test("withdraw: tombstones the gate AND closes its published interval", async () => {
    await withTestDb(async (fx) => {
        seedWord(fx);
        await as(fx, 'djz', () =>
            invoke(fx.ww, `wordwiki.lexeme.makePublic($arg0, $arg1)`, 1000, 'mm-li'));
        const r = await as(fx, 'djz', () =>
            invoke(fx.ww, `wordwiki.lexeme.withdraw($arg0, $arg1)`, 1000, 'mm-li'));
        assertEquals(r.action, 'reload');

        const rows = gateRows(1000);
        assertEquals(rows.length, 2);                       // original + tombstone
        const [orig, tomb] = rows;
        assertEquals(tomb.valid_from, tomb.valid_to);       // tombstone
        assertEquals(orig.valid_to, tomb.valid_from);       // chain closed
        assertEquals(orig.published_to, tomb.valid_from);   // published interval closed
        assert(!entrySchema.entryIsPublicIn(fx.ww.entriesById.get(1000)!, 'mm-li'));
        assert(!fx.ww.publishedEntries.some((e: any) => e.entry_id === 1000));

        // Withdrawing again: quietly nothing (no double tombstone).
        await as(fx, 'djz', () =>
            invoke(fx.ww, `wordwiki.lexeme.withdraw($arg0, $arg1)`, 1000, 'mm-li'));
        assertEquals(gateRows(1000).length, 2);
    });
});

test("makePublic: approve permission required; unapproved entries refused", async () => {
    await withTestDb(async (fx) => {
        seedWord(fx);
        // 'test' has only the testing role - no approve.
        await assertRejects(() => as(fx, 'test', () =>
            invoke(fx.ww, `wordwiki.lexeme.makePublic($arg0, $arg1)`, 1000, 'mm-li')));

        // A brand-new (never-approved) entry: the tree-ordering gate refuses.
        const tl = new TestTimeline();
        fx.ww.applyTransaction([mkEntry(2000, tl.next())], {quiet: true});
        await assertRejects(() => as(fx, 'djz', () =>
            invoke(fx.ww, `wordwiki.lexeme.makePublic($arg0, $arg1)`, 2000, 'mm-li')),
            Error, 'not been approved');

        // The wildcard is not a gate orthography.
        await assertRejects(() => as(fx, 'djz', () =>
            invoke(fx.ww, `wordwiki.lexeme.makePublic($arg0, $arg1)`, 1000, 'mm')),
            Error, 'not an orthography');
    });
});

test("composition: an archived word keeps its gate but is not public", async () => {
    await withTestDb(async (fx) => {
        seedWord(fx);
        await as(fx, 'djz', () =>
            invoke(fx.ww, `wordwiki.lexeme.makePublic($arg0, $arg1)`, 1000, 'mm-li'));

        // Archive the word: edit its sta fact to Archived (direct new version).
        const sta = db().all<any, any>(
            `SELECT * FROM dict WHERE id = 1002 AND valid_to = :eot`, {eot: EOT})[0];
        fx.ww.applyTransaction([{...sta, assertion_id: 9002,
                                 replaces_assertion_id: sta.assertion_id, attr1: 'Archived',
                                 valid_from: timestamp.nextTime(timestamp.BEGINNING_OF_TIME),
                                 valid_to: EOT,
                                 published_from: undefined, published_to: undefined}], {quiet: true});
        bornApprove(fx.ww);   // publish the archival so the published view sees it

        const entry = fx.ww.entriesById.get(1000)!;
        assert(entrySchema.isArchivedEntry(entry));
        assert(!entrySchema.entryIsPublicIn(entry, 'mm-li'), 'archived beats the gate');
        // The gate fact itself SURVIVES (un-archiving restores publicness).
        assertEquals(gateRows(1000).filter(r => r.valid_to === EOT).length, 1);
    });
});

test("the Public row: chips reflect the gates; verbs behind the menu for approvers", async () => {
    await withTestDb(async (fx) => {
        seedWord(fx);
        await as(fx, 'djz', () =>
            invoke(fx.ww, `wordwiki.lexeme.makePublic($arg0, $arg1)`, 1000, 'mm-li'));

        const html = markupToString(await as(fx, 'djz', () =>
            renderRoute(fx.ww, 'wordwiki.lexeme.metaPublicRowFragment(1000)')));
        assert(html.includes('-entry-1000-public-'), 'fragment key');
        assert(/Listuguj[^<]*/.test(html) && html.includes('✓'), 'set chip shows the check');
        assert(html.includes('(djz)'), 'attribution on the chip');
        assert(html.includes('Withdraw from Listuguj'), 'withdraw verb for the set gate');
        assert(html.includes('Make public in Smith-Francis'), 'make-public verb for the unset');

        // A non-approver sees the chips but NO verbs.
        const roHtml = markupToString(await as(fx, 'test', () =>
            renderRoute(fx.ww, 'wordwiki.lexeme.metaPublicRowFragment(1000)')));
        assert(!roHtml.includes('Withdraw from'), 'no verbs without approve');
    });
});
