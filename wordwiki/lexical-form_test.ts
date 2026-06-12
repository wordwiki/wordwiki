// deno-lint-ignore-file no-explicit-any
/**
 * The lexical form table (controlled part-of-speech vocabulary) and its
 * editor select - the same treatment as categories, so these tests cover
 * the deltas: uppercase slugs (PTCL), the curated seed, and the subentry
 * dialog hookup.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertFalse, assertThrows, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, as, renderRoute, TestTimeline, mkEntry, mkChild, type Fixture } from "./testing.ts";
import { seedLexicalForms, SEED_LEXICAL_FORMS } from "./lexical-form.ts";
import { markupToString } from "../liminal/markup.ts";
import * as timestamp from "../liminal/timestamp.ts";
import { db } from "../liminal/db.ts";

// An entry (1000) with one subentry (1100) whose part_of_speech is the
// legacy junk value 'Wp ini'.
function seedEntry(ww: any): void {
    const tl = new TestTimeline();
    const e = mkEntry(1000, tl.next());
    ww.applyTransaction([e], {quiet: true});
    ww.applyTransaction([mkChild(e, 'sub', 1100, tl.next(),
                                 {attr1: 'Wp ini', order_key: '0.5'})], {quiet: true});
}

function currentPos(): string {
    return db().all<{attr1: string}, {end: number}>(
        `SELECT attr1 FROM dict WHERE ty = 'sub' AND id1 = 1000 AND valid_to = :end`,
        {end: timestamp.END_OF_TIME})[0].attr1;
}

function currentSubAssertionId(): number {
    return db().all<{assertion_id: number}, {end: number}>(
        `SELECT assertion_id FROM dict WHERE ty = 'sub' AND id1 = 1000 AND valid_to = :end`,
        {end: timestamp.END_OF_TIME})[0].assertion_id;
}

test("lexical form slugs: uppercase codes allowed, junk rejected; seed is idempotent", async () => {
    await withTestDb((fx) => {
        as(fx, 'djz', () => {
            const forms = fx.ww.lexicalForms;
            const first = seedLexicalForms(forms);
            assertEquals(first, {inserted: SEED_LEXICAL_FORMS.length, skipped: 0});
            const again = seedLexicalForms(forms);
            assertEquals(again, {inserted: 0, skipped: SEED_LEXICAL_FORMS.length});

            // The established uppercase code seeded as-is (must equal the
            // stored data values for the select to recognize them).
            assertEquals(forms.bySlug.required({slug: 'PTCL'}).name, 'particle');
            // The junk tail can NOT become slugs.
            assertThrows(() => forms.insert({slug: 'vai  PL', name: 'nope'}));
            assertThrows(() => forms.insert({slug: 'ni·dt', name: 'nope'}));
            assertThrows(() => forms.insert({slug: '??', name: 'nope'}));

            // Theme grouping: Nouns, Verbs, Other - in seed order.
            const themes = Array.from(new Set(forms.allByOrder.all({}).map((f: any) => f.theme)));
            assertEquals(themes, ['Nouns', 'Verbs', 'Other']);
        });
    });
});

test("subentry dialog: part-of-speech select offers seeded forms, keeps legacy value", async () => {
    await withTestDb((fx) => {
        as(fx, 'djz', () => {
            seedEntry(fx.ww);
            seedLexicalForms(fx.ww.lexicalForms);

            const dialog = markupToString(fx.ww.lexeme.editDialog(1000, 1100));
            assertStringIncludes(dialog, '<select name=part_of_speech');
            assertStringIncludes(dialog, "<optgroup label=Verbs>");
            assertStringIncludes(dialog, '<option value=vai>verb animate intransitive (vai)</option>');
            assertStringIncludes(dialog, '<option value=PTCL>particle (PTCL)</option>');
            // The legacy junk value is kept as the selected, marked option.
            assertStringIncludes(dialog,
                "<option value='Wp ini' selected=''>Wp ini (not in the lexical form table");
        });
    });
});

test("part-of-speech save: active slug accepted, junk refused, untouched rides through", async () => {
    await withTestDb((fx) => {
        as(fx, 'djz', () => {
            seedEntry(fx.ww);
            seedLexicalForms(fx.ww.lexicalForms);

            fx.ww.lexeme.saveTuple({
                entry_id: '1000', fact_id: '1100',
                replaces_assertion_id: String(currentSubAssertionId()),
                part_of_speech: 'vai', 'before-part_of_speech': 'Wp ini'});
            assertEquals(currentPos(), 'vai');

            let threw = false;
            try {
                fx.ww.lexeme.saveTuple({
                    entry_id: '1000', fact_id: '1100',
                    replaces_assertion_id: String(currentSubAssertionId()),
                    part_of_speech: 'made-up', 'before-part_of_speech': 'vai'});
            } catch (e) {
                threw = true;
                assertStringIncludes(String(e), 'not an active lexical form');
            }
            assert(threw, 'expected the save to be refused');
            assertEquals(currentPos(), 'vai');
        });
    });
});

test("unseeded lexical form table: the free-text input remains", async () => {
    await withTestDb((fx) => {
        as(fx, 'djz', () => {
            seedEntry(fx.ww);   // no forms seeded
            const dialog = markupToString(fx.ww.lexeme.editDialog(1000, 1100));
            assertFalse(dialog.includes('<select name=part_of_speech'));
            assertStringIncludes(dialog, 'name=part_of_speech');   // plain text input
        });
    });
});

test("the lexical form detail page shows the record; the pencil only for admins", async () => {
    await withTestDb(async (fx) => {
        const nonAdmin = as(fx, 'system', () =>
            fx.ww.users.allUsersByName.all({}).find(u => !u.permissions)!.username);
        const id = as(fx, 'djz', () =>
            fx.ww.lexicalForms.insert({slug: 'vai', name: 'verb animate intransitive',
                                       theme: 'Verbs'}));

        const adminPage = markupToString(await as(fx, 'djz', () =>
            renderRoute(fx.ww, `wordwiki.lexicalForms.detailPage(${id})`)));
        assertStringIncludes(adminPage, 'verb animate intransitive');
        assertStringIncludes(adminPage, 'vai');
        assertStringIncludes(adminPage, 'lm-edit-pencil');

        const viewerPage = markupToString(await as(fx, nonAdmin, () =>
            renderRoute(fx.ww, `wordwiki.lexicalForms.detailPage(${id})`)));
        assertStringIncludes(viewerPage, 'verb animate intransitive');
        assertFalse(viewerPage.includes('lm-edit-pencil'));
    });
});
