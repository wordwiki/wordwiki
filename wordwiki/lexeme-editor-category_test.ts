// deno-lint-ignore-file no-explicit-any
/**
 * The lexeme editor's category select (CategorySelectField in
 * lexeme-editor.ts): offered options come from the category table, legacy
 * values survive, changed values are validated server-side, and the
 * pre-import fallback keeps the old free-text input.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertFalse, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, as, TestTimeline, mkEntry, mkChild, type Fixture } from "./testing.ts";
import { markupToString } from "../liminal/markup.ts";
import * as timestamp from "../liminal/timestamp.ts";
import { db } from "../liminal/db.ts";

// An entry (1000) with one subentry (1100) carrying one category tuple
// (1001, value '~old-kinship') - the post-import shape.
function seedEntry(ww: any): void {
    const tl = new TestTimeline();
    const e = mkEntry(1000, tl.next());
    ww.applyTransaction([e], {quiet: true});
    const s = mkChild(e, 'sub', 1100, tl.next(), {order_key: '0.5'});
    ww.applyTransaction([s], {quiet: true});
    ww.applyTransaction([mkChild(s, 'cat', 1001, tl.next(),
                                 {attr1: '~old-kinship', order_key: '0.5'})], {quiet: true});
}

function seedCategories(fx: Fixture): void {
    const cats = fx.ww.categories;
    cats.insert({slug: 'family', name: 'Family & Kinship', theme: 'People & Relationships'});
    cats.insert({slug: 'people', name: 'People', theme: 'People & Relationships'});
    cats.insert({slug: 'weather', name: 'Weather', theme: 'Land, Water & Sky'});
    cats.insert({slug: '~needs-human', name: 'Needs human attention', theme: 'Internal'});
    cats.insert({slug: '~old-kinship', name: 'kinship (old)', theme: 'Old categories', retired: 1});
}

function currentCatValue(): string {
    return db().all<{attr1: string}, {end: number}>(
        `SELECT attr1 FROM dict WHERE ty = 'cat' AND id1 = 1000 AND valid_to = :end`,
        {end: timestamp.END_OF_TIME}).map(r => r.attr1).join('\0');
}

function currentCatAssertionId(): number {
    return db().all<{assertion_id: number}, {end: number}>(
        `SELECT assertion_id FROM dict WHERE ty = 'cat' AND id1 = 1000 AND valid_to = :end`,
        {end: timestamp.END_OF_TIME})[0].assertion_id;
}

test("category edit dialog: theme-grouped select; legacy value kept as marked option", async () => {
    await withTestDb((fx) => {
        as(fx, 'djz', () => {
            seedEntry(fx.ww);
            seedCategories(fx);

            const dialog = markupToString(fx.ww.lexeme.editDialog(1000, 1001));
            // A select grouped by theme, offering active slugs with names...
            assertStringIncludes(dialog, '<select name=category');
            assertStringIncludes(dialog, "<optgroup label='People & Relationships'>");
            assertStringIncludes(dialog, '<option value=family>Family & Kinship (family)</option>');
            assertStringIncludes(dialog, "<option value='~needs-human'>");
            // ...NOT the retired ~old-* import as a regular option...
            assertFalse(dialog.includes("<option value='~old-kinship'>~old-kinship (old)"));
            // ...but the CURRENT retired value is kept as a marked, selected
            // option, labeled with its table name.
            assertStringIncludes(dialog,
                "<option value='~old-kinship' selected=''>kinship (old) - retired (kept until changed)");
        });
    });
});

test("category save: change to an active slug works; to anything else refuses", async () => {
    await withTestDb((fx) => {
        as(fx, 'djz', () => {
            seedEntry(fx.ww);
            seedCategories(fx);

            // Change ~old-kinship -> family (an active slug): saved.
            fx.ww.lexeme.saveTuple({
                entry_id: '1000', fact_id: '1001',
                replaces_assertion_id: String(currentCatAssertionId()),
                category: 'family', 'before-category': '~old-kinship'});
            assertEquals(currentCatValue(), 'family');

            // Change to a value not in the table: refused, value untouched.
            let threw = false;
            try {
                fx.ww.lexeme.saveTuple({
                    entry_id: '1000', fact_id: '1001',
                    replaces_assertion_id: String(currentCatAssertionId()),
                    category: 'made-up-category', 'before-category': 'family'});
            } catch (e) {
                threw = true;
                assertStringIncludes(String(e), 'not an active category');
            }
            assert(threw, 'expected the save to be refused');
            assertEquals(currentCatValue(), 'family');

            // An UNCHANGED legacy value rides through an edit untouched (the
            // before-snapshot match means it is not parsed at all).
            fx.ww.lexeme.saveTuple({
                entry_id: '1000', fact_id: '1001',
                replaces_assertion_id: String(currentCatAssertionId()),
                category: 'family', 'before-category': 'family'});
            assertEquals(currentCatValue(), 'family');
        });
    });
});

test("category insert dialog uses the select; insert saves an active slug", async () => {
    await withTestDb((fx) => {
        as(fx, 'djz', () => {
            seedEntry(fx.ww);
            seedCategories(fx);

            const dialog = markupToString(fx.ww.lexeme.insertDialog(1000, 1100, 'cat'));
            assertStringIncludes(dialog, '<select name=category');

            fx.ww.lexeme.saveTuple({
                entry_id: '1000', parent_fact_id: '1100', child_tag: 'cat',
                category: 'weather', 'before-category': ''});
            assertStringIncludes(currentCatValue(), 'weather');
        });
    });
});

test("pre-import fallback: empty category table keeps the free-text input", async () => {
    await withTestDb((fx) => {
        as(fx, 'djz', () => {
            seedEntry(fx.ww);   // no categories seeded
            const dialog = markupToString(fx.ww.lexeme.editDialog(1000, 1001));
            assertFalse(dialog.includes('<select name=category'));
            assertStringIncludes(dialog, '<input type=text class=\'form-control\' name=category');
        });
    });
});
