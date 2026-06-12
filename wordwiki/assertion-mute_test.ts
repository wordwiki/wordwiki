// deno-lint-ignore-file no-explicit-any
/**
 * The in-place mute API (assertion-mute.ts): rewrites ALL history rows
 * (superseded versions and tombstones included), validates the mapping up
 * front, and invalidates the workspace afterwards.  See the module comment
 * for the rename-vs-assert principle.
 */
import { test } from "../liminal/testing/test.ts";
import { assertEquals, assertThrows } from "../liminal/testing/assert.ts";
import { withTestDb, as, TestTimeline, mkEntry, mkChild, type Fixture } from "./testing.ts";
import { muteAttr1Values } from "./assertion-mute.ts";
import { db } from "../liminal/db.ts";

// A cat fact with real history: 'Fish' edited to 'fish', then a second
// fact 'kinship' that gets deleted - so the mute must reach a superseded
// version, a current version, and both halves of a tombstone chain.
function seedHistory(fx: Fixture): void {
    const tl = new TestTimeline();
    const e = mkEntry(1000, tl.next());
    fx.ww.applyTransaction([e], {quiet: true});
    fx.ww.applyTransaction([mkChild(e, 'spl', 1010, tl.next(),
                                    {attr1: 'samqwan', order_key: '0.5'})], {quiet: true});
    const s = mkChild(e, 'sub', 1100, tl.next(), {order_key: '0.5'});
    fx.ww.applyTransaction([s], {quiet: true});
    fx.ww.applyTransaction([mkChild(s, 'cat', 1110, tl.next(),
                                    {attr1: 'Fish', order_key: '0.2'})], {quiet: true});
    fx.ww.applyTransaction([mkChild(s, 'cat', 1120, tl.next(),
                                    {attr1: 'kinship', order_key: '0.4'})], {quiet: true});
    as(fx, 'djz', () => {
        fx.ww.lexemeOps.supersedeFields(1000, 1110, {attr1: 'fish'});  // edit history
        fx.ww.lexemeOps.tombstoneFact(1000, 1120);                     // tombstone chain
    });
}

function allRows(): {id: number, attr1: string, tomb: boolean}[] {
    return db().all<any, {}>(
        `SELECT id, attr1, (valid_from = valid_to) AS tomb FROM dict
         WHERE ty = 'cat' ORDER BY id, valid_from`, {})
        .map((r: any) => ({id: r.id, attr1: r.attr1, tomb: !!r.tomb}));
}

test("mute rewrites every row: history, current, and tombstones", async () => {
    await withTestDb((fx: Fixture) => {
        as(fx, 'system', () => {
            seedHistory(fx);
            const stats = muteAttr1Values(fx.ww, {ty: 'cat', mapping: new Map([
                ['Fish', '~old-fish'], ['fish', '~old-fish'], ['kinship', '~old-kinship']])});
            assertEquals(stats, {valuesRenamed: 3, rowsUpdated: 4});

            // Same fact ids, same version counts - only the values changed.
            assertEquals(allRows(), [
                {id: 1110, attr1: '~old-fish', tomb: false},     // superseded 'Fish'
                {id: 1110, attr1: '~old-fish', tomb: false},     // current (was 'fish')
                {id: 1120, attr1: '~old-kinship', tomb: false},  // pre-delete version
                {id: 1120, attr1: '~old-kinship', tomb: true},   // the tombstone itself
            ]);

            // The workspace was invalidated: the render model sees the new
            // value (1110 is current; 1120 is deleted and absent).
            const entry = fx.ww.entriesById.get(1000)!;
            assertEquals(entry.subentry[0].category.map((c: any) => c.category),
                         ['~old-fish']);

            // Idempotent: nothing left matching the mapping.
            assertEquals(muteAttr1Values(fx.ww, {ty: 'cat', mapping: new Map([
                ['Fish', '~old-fish']])}), {valuesRenamed: 0, rowsUpdated: 0});
        });
    });
});

test("mute validates the mapping before touching anything", async () => {
    await withTestDb((fx: Fixture) => {
        as(fx, 'system', () => {
            seedHistory(fx);
            // No-op pair.
            assertThrows(() => muteAttr1Values(fx.ww, {ty: 'cat',
                mapping: new Map([['fish', 'fish']])}), Error, 'no-op');
            // Chain: target of one rename is the source of another.
            assertThrows(() => muteAttr1Values(fx.ww, {ty: 'cat',
                mapping: new Map([['Fish', 'fish'], ['fish', '~old-fish']])}),
                Error, 'chained');
            // Empty target.
            assertThrows(() => muteAttr1Values(fx.ww, {ty: 'cat',
                mapping: new Map([['fish', '']])}), Error, 'invalid target');
            // Nothing was changed by the failed validations.
            assertEquals(allRows().map(r => r.attr1),
                         ['Fish', 'fish', 'kinship', 'kinship']);
            // Empty mapping is the idempotent no-op, not an error.
            assertEquals(muteAttr1Values(fx.ww, {ty: 'cat', mapping: new Map()}),
                         {valuesRenamed: 0, rowsUpdated: 0});
        });
    });
});
