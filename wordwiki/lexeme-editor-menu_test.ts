// deno-lint-ignore-file no-explicit-any
/**
 * The tuple ☰ action menu (the liminal UI language - see task.ts in rabid)
 * and the anchored inserts it offers.
 */
import { test } from "../liminal/testing/test.ts";
import { assertEquals, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, as, TestTimeline, mkEntry, mkChild, type Fixture } from "./testing.ts";
import { markupToString } from "../liminal/markup.ts";
import { db } from "../liminal/db.ts";
import * as timestamp from "../liminal/timestamp.ts";

function seed(fx: Fixture): void {
    const tl = new TestTimeline();
    const e = mkEntry(1000, tl.next());
    fx.ww.applyTransaction([e], {quiet: true});
    fx.ww.applyTransaction([mkChild(e, 'spl', 1010, tl.next(),
                                    {attr1: 'samqwan', order_key: '0.5'})], {quiet: true});
    const s = mkChild(e, 'sub', 1100, tl.next(), {order_key: '0.5'});
    fx.ww.applyTransaction([s], {quiet: true});
    fx.ww.applyTransaction([mkChild(s, 'cat', 1110, tl.next(),
                                    {attr1: 'water', order_key: '0.4'})], {quiet: true});
    fx.ww.applyTransaction([mkChild(s, 'cat', 1120, tl.next(),
                                    {attr1: 'fire', order_key: '0.6'})], {quiet: true});
}

test("tuple surface: the ☰ carries every action; edit dialog is just the form", async () => {
    await withTestDb((fx: Fixture) => {
        as(fx, 'djz', () => {
            seed(fx);
            const html = markupToString(fx.ww.lexeme.renderEntry(1000));
            // The menu, with all seven actions wired to the cat tuple.
            for(const needle of [
                'lm-action-menu',
                `editDialog(1000, 1110)`,
                `insertDialog(1000, 1100, 'cat', 1110, 'before')`,
                `insertDialog(1000, 1100, 'cat', 1110, 'after')`,
                // (the moves carry txd speculation deps, whose JSON double
                // quotes flip markupToString's DEBUG attr quoting to
                // backslash-escaped singles - the served HTML escapes properly
                // via linkeDOM)
                String.raw`move(1000, 1110, \'up\')`,
                String.raw`move(1000, 1110, \'down\')`,
                `historyDialog(1000, 1110)`,
                `deleteTuple(1000, 1110)`,
            ]) assertStringIncludes(html, needle);

            // No pencil: the ☰ is the row's single icon, and its Edit item
            // carries class 'edit' (lmEditableClick's delegation target for
            // the body tap).
            assertEquals(html.includes('lm-edit-pencil'), false);
            assertStringIncludes(html, 'dropdown-item edit');

            // Header treatment (task.ts style): quiet icon-only + naming the
            // relation, and a header ☰ naming the add; the old inline
            // "n deleted" link is gone (it lives in the header ☰ now).
            assertStringIncludes(html, "aria-label='New Category'");
            assertStringIncludes(html, 'Add Category…');
            assertEquals(html.includes('lex-deleted-btn'), false);

            // The edit dialog no longer carries the secondary actions.
            const dialog = markupToString(fx.ww.lexeme.editDialog(1000, 1110));
            assertEquals(dialog.includes('Move up'), false);
            assertEquals(dialog.includes('History'), false);
            assertStringIncludes(dialog, 'Save');
        });
    });
});

test("insert before/after: the new tuple lands next to its anchor", async () => {
    await withTestDb((fx: Fixture) => {
        as(fx, 'djz', () => {
            seed(fx);
            // Insert 'earth' BEFORE 'fire' (i.e. between water and fire).
            fx.ww.lexeme.saveTuple({
                entry_id: '1000', parent_fact_id: '1100', child_tag: 'cat',
                anchor_fact_id: '1120', where: 'before',
                category: 'earth', 'before-category': '',
            });
            // And 'air' AFTER 'water' (also between - but before earth).
            fx.ww.lexeme.saveTuple({
                entry_id: '1000', parent_fact_id: '1100', child_tag: 'cat',
                anchor_fact_id: '1110', where: 'after',
                category: 'air', 'before-category': '',
            });
            const values = db().all<{attr1: string}, {end: number}>(
                `SELECT attr1 FROM dict WHERE ty = 'cat' AND valid_to = :end
                 ORDER BY order_key`, {end: timestamp.END_OF_TIME}).map(r => r.attr1);
            assertEquals(values, ['water', 'air', 'earth', 'fire']);

            // No anchor (or a stale one): lands at the end, as before.
            fx.ww.lexeme.saveTuple({
                entry_id: '1000', parent_fact_id: '1100', child_tag: 'cat',
                anchor_fact_id: '99999', where: 'after',
                category: 'metal', 'before-category': '',
            });
            const after = db().all<{attr1: string}, {end: number}>(
                `SELECT attr1 FROM dict WHERE ty = 'cat' AND valid_to = :end
                 ORDER BY order_key`, {end: timestamp.END_OF_TIME}).map(r => r.attr1);
            assertEquals(after, ['water', 'air', 'earth', 'fire', 'metal']);
        });
    });
});
