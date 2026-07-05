// deno-lint-ignore-file no-explicit-any
/**
 * LexemeOps - the shared assertion-mutation verbs (lexeme-ops.ts): the
 * tombstone primitive's race outcomes, and removeEntryFromCategory
 * (tombstones EVERY current cat tuple with the slug, across subentries).
 */
import { test } from "../liminal/testing/test.ts";
import { assertEquals, assertThrows, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, as, TestTimeline, mkEntry, mkChild, type Fixture } from "./testing.ts";
import * as timestamp from "../liminal/timestamp.ts";
import { db } from "../liminal/db.ts";
import { markupToString } from "../liminal/markup.ts";

// One entry, two subentries: 'water' tagged on BOTH (plus 'fire' on the
// first) - the multi-subentry case removeEntryFromCategory must sweep.
function seedEntry(ww: any): void {
    const tl = new TestTimeline();
    const e = mkEntry(1000, tl.next());
    ww.applyTransaction([e], {quiet: true});
    ww.applyTransaction([mkChild(e, 'spl', 1010, tl.next(),
                                 {attr1: 'samqwan', order_key: '0.5'})], {quiet: true});
    ww.applyTransaction([mkChild(e, 'sta', 1020, tl.next(),
                                 {attr1: 'Completed', order_key: '0.5'})], {quiet: true});
    const s1 = mkChild(e, 'sub', 1100, tl.next(), {order_key: '0.3'});
    const s2 = mkChild(e, 'sub', 1200, tl.next(), {order_key: '0.6'});
    ww.applyTransaction([s1], {quiet: true});
    ww.applyTransaction([s2], {quiet: true});
    ww.applyTransaction([mkChild(s1, 'cat', 1110, tl.next(),
                                 {attr1: 'water', order_key: '0.3'})], {quiet: true});
    ww.applyTransaction([mkChild(s1, 'cat', 1120, tl.next(),
                                 {attr1: 'fire', order_key: '0.6'})], {quiet: true});
    ww.applyTransaction([mkChild(s2, 'cat', 1210, tl.next(),
                                 {attr1: 'water', order_key: '0.3'})], {quiet: true});
}

function currentCats(): string[] {
    return db().all<{attr1: string}, {end: number}>(
        `SELECT attr1 FROM dict WHERE ty = 'cat' AND valid_to = :end ORDER BY id`,
        {end: timestamp.END_OF_TIME}).map(r => r.attr1);
}

test("removeEntryFromCategory: sweeps all subentries, stamps, idempotent", async () => {
    await withTestDb((fx: Fixture) => {
        as(fx, 'djz', () => {
            seedEntry(fx.ww);
            assertEquals(currentCats().toSorted(), ['fire', 'water', 'water']);

            const r = fx.ww.lexemeOps.removeEntryFromCategory(1000, 'water');
            assertEquals(r.removed, 2);              // both subentries' tuples
            assertEquals(currentCats(), ['fire']);   // 'fire' untouched

            // Stamped with the session user; history preserved (tombstone
            // chains onto the original assertion).
            const versions = db().all<{change_by_username: string|null, valid_from: number, valid_to: number}, {id: number}>(
                'SELECT change_by_username, valid_from, valid_to FROM dict WHERE id = :id ORDER BY valid_from',
                {id: 1110});
            assertEquals(versions.length, 2);
            assertEquals(versions[1].change_by_username, 'djz');
            assertEquals(versions[1].valid_from, versions[1].valid_to);  // tombstone

            // Idempotent: a second remove (or a race) is a no-op.
            assertEquals(fx.ww.lexemeOps.removeEntryFromCategory(1000, 'water').removed, 0);
            assertEquals(currentCats(), ['fire']);
        });
    });
});

test("tombstoneFact: 'has-children' refusal; mutations require a user", async () => {
    await withTestDb((fx: Fixture) => {
        as(fx, 'djz', () => {
            seedEntry(fx.ww);
            // A subentry with children refuses (children-first rule).
            assertEquals(fx.ww.lexemeOps.tombstoneFact(1000, 1100).outcome, 'has-children');
        });
        // No session user: the verb refuses regardless of how it was reached.
        as(fx, 'anon', () => {
            assertThrows(() => fx.ww.lexemeOps.removeEntryFromCategory(1000, 'fire'),
                         Error, 'logged-in');
        });
    });
});

test("category detail page: entries listed with remove buttons; removeEntry reloads", async () => {
    await withTestDb((fx: Fixture) => {
        as(fx, 'djz', () => {
            seedEntry(fx.ww);
            const catId = fx.ww.categories.insert(
                {slug: 'water', name: 'Water & Rivers', theme: 'Nature', retired: 0});

            const detail = markupToString(fx.ww.categories.renderDetail(catId));
            assertStringIncludes(detail, 'Entries (1)');
            assertStringIncludes(detail, 'samqwan');
            assertStringIncludes(detail, `wordwiki.wordView(1000)`);
            assertStringIncludes(detail, `wordwiki.categories.removeEntry(${catId}, 1000)`);

            const r = fx.ww.categories.removeEntry(catId, 1000);
            assertEquals(r, {action: 'reload', targets: [`.-category-${catId}-`]});
            assertStringIncludes(markupToString(fx.ww.categories.renderDetail(catId)),
                                 'Entries (0)');
            assertEquals(currentCats(), ['fire']);
        });
    });
});

// --- supersedeFields: the field-edit primitive (vs tombstoneFact for
// --- deletion).  Exercised here on a subentry's part_of_speech (attr1).

function currentSubPos(): (string|null)[] {
    return db().all<{attr1: string|null}, {end: number}>(
        `SELECT attr1 FROM dict WHERE ty = 'sub' AND valid_to = :end ORDER BY id`,
        {end: timestamp.END_OF_TIME}).map(r => r.attr1);
}

test("supersedeFields: edits a field in place, keeps the tuple, stamps, chains history", async () => {
    await withTestDb((fx: Fixture) => {
        as(fx, 'djz', () => {
            const tl = new TestTimeline();
            const e = mkEntry(1000, tl.next());
            fx.ww.applyTransaction([e], {quiet: true});
            fx.ww.applyTransaction([mkChild(e, 'spl', 1010, tl.next(),
                                            {attr1: 'samqwan', order_key: '0.5'})], {quiet: true});
            fx.ww.applyTransaction([mkChild(e, 'sub', 1100, tl.next(),
                                            {attr1: 'vai', order_key: '0.3'})], {quiet: true});

            const r = fx.ww.lexemeOps.supersedeFields(1000, 1100, {attr1: 'vii'});
            assertEquals(r.outcome, 'updated');
            assertEquals(currentSubPos(), ['vii']);   // tuple SURVIVES, field changed

            // Stamped + history chained onto the replaced version.
            const versions = db().all<{change_by_username: string|null}, {id: number}>(
                'SELECT change_by_username FROM dict WHERE id = :id ORDER BY valid_from',
                {id: 1100});
            assertEquals(versions.length, 2);
            assertEquals(versions[1].change_by_username, 'djz');

            // Refuses to resurrect: supersede after a delete reports the race.
            fx.ww.lexemeOps.tombstoneFact(1000, 1100);
            assertEquals(fx.ww.lexemeOps.supersedeFields(1000, 1100, {attr1: 'na'}).outcome,
                         'already-deleted');
        });
    });
});

test("lexical form detail page: subentries listed, navigating, NO remove button", async () => {
    await withTestDb((fx: Fixture) => {
        as(fx, 'djz', () => {
            const tl = new TestTimeline();
            const e = mkEntry(1000, tl.next());
            fx.ww.applyTransaction([e], {quiet: true});
            fx.ww.applyTransaction([mkChild(e, 'spl', 1010, tl.next(),
                                            {attr1: 'samqwan', order_key: '0.5'})], {quiet: true});
            fx.ww.applyTransaction([mkChild(e, 'sub', 1100, tl.next(),
                                            {attr1: 'vai', order_key: '0.3'})], {quiet: true});
            const formId = fx.ww.lexicalForms.insert(
                {slug: 'vai', name: 'verb animate intransitive', theme: 'Verbs', retired: 0});

            const detail = markupToString(fx.ww.lexicalForms.renderDetail(formId));
            assertStringIncludes(detail, 'Subentries (1)');
            assertStringIncludes(detail, 'samqwan');
            assertStringIncludes(detail, 'wordwiki.wordView(1000)');
            // Deliberately no remove affordance: a wrong POS gets FIXED in
            // the editor, not cleared from here.
            assertEquals(detail.includes('Remove'), false);
        });
    });
});
