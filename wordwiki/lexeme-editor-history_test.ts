// deno-lint-ignore-file no-explicit-any
/**
 * Automated-change (batch import / migration) treatment in the editor:
 * '~' authors badge and fold in the history dialog, migration removals are
 * marked in the deleted dialog, and restore refuses to cross a migration
 * boundary (server-side, not just hidden buttons).
 */
import { test } from "../liminal/testing/test.ts";
import { assertEquals, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, as, TestTimeline, mkEntry, mkChild, type Fixture } from "./testing.ts";
import { isAutomatedUsername, SYSTEM_USERS } from "./user.ts";
import { markupToString } from "../liminal/markup.ts";

test("system users: seeded disabled; isAutomatedUsername is the test", async () => {
    assertEquals(isAutomatedUsername('~category-import'), true);
    assertEquals(isAutomatedUsername('djz'), false);
    assertEquals(isAutomatedUsername(null), false);
    await withTestDb((fx: Fixture) => {
        as(fx, 'system', () => {
            for(const {username} of SYSTEM_USERS) {
                const u = fx.ww.users.byUsername.first({username});
                assertEquals(u !== undefined, true, username);
                assertEquals(u!.disabled, 1, `${username} must not be able to log in`);
            }
        });
    });
});

function seedEntryWithCat(fx: Fixture): void {
    const tl = new TestTimeline();
    const e = mkEntry(1000, tl.next());
    fx.ww.applyTransaction([e], {quiet: true});
    fx.ww.applyTransaction([mkChild(e, 'spl', 1010, tl.next(),
                                    {attr1: 'samqwan', order_key: '0.5'})], {quiet: true});
    fx.ww.applyTransaction([mkChild(e, 'sub', 1100, tl.next(),
                                    {attr1: 'vai', order_key: '0.5'})], {quiet: true});
    fx.ww.applyTransaction([mkChild(mkChild(e, 'sub', 1100, tl.next(), {}), 'cat', 1110, tl.next(),
                                    {attr1: 'liquid', order_key: '0.5'})], {quiet: true});
}

test("history: automated runs fold, pre-migration versions are not restorable", async () => {
    await withTestDb((fx: Fixture) => {
        seedEntryWithCat(fx);   // v1 'liquid' (human-era seed)
        // The migration: two consecutive automated versions.
        as(fx, '~category-import', () => {
            fx.ww.lexemeOps.supersedeFields(1000, 1110, {attr1: 'water'});
            fx.ww.lexemeOps.supersedeFields(1000, 1110, {attr1: 'water-rivers'});
        });
        // A later human edit.
        as(fx, 'djz', () => {
            fx.ww.lexemeOps.supersedeFields(1000, 1110, {attr1: 'fire'});

            const html = markupToString(fx.ww.lexeme.historyDialog(1000, 1110));
            assertStringIncludes(html, 'automated');                  // badge
            assertStringIncludes(html, '2 automated changes');       // folded run
            assertStringIncludes(html, '<details');
            assertStringIncludes(html, 'not restorable (predates a vocabulary migration)');

            // Server-side barrier: restoring v1 ('liquid') is refused...
            const versions = fx.ww.lexemeOps.findTupleInEntry(1000, 1110).tupleVersions;
            const v1 = versions[0].assertion;
            const r1 = fx.ww.lexeme.restoreVersion(1000, 1110, v1.assertion_id);
            assertEquals(r1.action, 'alert');
            assertStringIncludes(r1.message, 'predates a batch vocabulary migration');

            // ...but the migration's own (final) version restores fine.
            const vMigration = versions[2].assertion;   // 'water-rivers'
            assertEquals(vMigration.change_by_username, '~category-import');
            const r2 = fx.ww.lexeme.restoreVersion(1000, 1110, vMigration.assertion_id);
            assertEquals(r2.action, 'reload');
        });
    });
});

test("deleted dialog: migration removals are marked and not restorable", async () => {
    await withTestDb((fx: Fixture) => {
        seedEntryWithCat(fx);
        as(fx, '~category-import', () => {
            assertEquals(fx.ww.lexemeOps.tombstoneFact(1000, 1110).outcome, 'removed');
        });
        as(fx, 'djz', () => {
            const html = markupToString(fx.ww.lexeme.deletedDialog(1000, 1100, 'cat'));
            assertStringIncludes(html, 'by migration');
            assertStringIncludes(html, 'not restorable (retired by a vocabulary migration)');
            assertEquals(html.includes('Restore'), false);

            // Server-side: restoring the retired tuple's last real values is
            // refused (the tombstone is the newer automated version).
            const lastReal = fx.ww.lexemeOps.findTupleInEntry(1000, 1110).tupleVersions[0].assertion;
            const r = fx.ww.lexeme.restoreVersion(1000, 1110, lastReal.assertion_id);
            assertEquals(r.action, 'alert');
            assertStringIncludes(r.message, 'predates a batch vocabulary migration');
        });
    });
});
