// deno-lint-ignore-file no-explicit-any
/**
 * Category import tests: the pure pieces (scheme parsing, old-name slugs,
 * desired-cat computation) and the end-to-end db rewrite, including the
 * property the whole design hangs on - a re-run is a no-op.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertThrows } from "../liminal/testing/assert.ts";
import { withTestDb, as, TestTimeline, mkEntry, mkChild } from "./testing.ts";
import { parseSchemeMd, oldCategorySlug, loadAssignments, computeDesiredCats,
         importCategories } from "./category-import.ts";
import { Assertion } from "./assertion.ts";
import * as timestamp from "../liminal/timestamp.ts";
import { db } from "../liminal/db.ts";

// ---------------------------------------------------------------------------
// --- Pure pieces --------------------------------------------------------------
// ---------------------------------------------------------------------------

const SCHEME = `# Scheme header text (ignored)

intro prose (ignored)

## People & Relationships

- **Family & Kinship** (\`family\`) — kin terms (mother, son, aunt),
  marriage and married life.
  Ex: giju' (mother), gwi's (son).
- **People** (\`people\`) — general words for persons.

## Land, Water & Sky

- **Weather** (\`weather\`) — rain, snow, wind, storms.

Folded categories (must NOT parse): old "kinship" went into Family & Kinship.
`;

test("parseSchemeMd: slugs, themes, multi-line descriptions", () => {
    const cats = parseSchemeMd(SCHEME);
    assertEquals(cats.map(c => c.slug), ['family', 'people', 'weather']);
    assertEquals(cats[0].name, 'Family & Kinship');
    assertEquals(cats[0].theme, 'People & Relationships');
    assertEquals(cats[2].theme, 'Land, Water & Sky');
    // Continuation lines fold into the description, Ex line included.
    assertEquals(cats[0].description,
                 "kin terms (mother, son, aunt), marriage and married life. " +
                 "Ex: giju' (mother), gwi's (son).");
});

test("parseSchemeMd parses the real scheme.md (85 categories)", async () => {
    const text = await Deno.readTextFile(
        `${Deno.env.get('HOME')}/wordwiki/categorization/scheme.md`);
    const cats = parseSchemeMd(text);
    assertEquals(cats.length, 85);
    assert(cats.every(c => c.theme && c.name && c.description));
});

test("oldCategorySlug: slugified, merged near-dupes, symbol fallback", () => {
    assertEquals(oldCategorySlug('special day'), '~old-special-day');
    assertEquals(oldCategorySlug('behaviour'), '~old-behaviour');
    assertEquals(oldCategorySlug('Water'), oldCategorySlug('water'));       // case merge
    assertEquals(oldCategorySlug("'appearance '), "), '~old-appearance');
    assertEquals(oldCategorySlug('_'), '~old-sym-5f');                       // junk stays distinct
    assertEquals(oldCategorySlug('-'), '~old-sym-2d');
});

test("computeDesiredCats: first run and the re-run fixed point", () => {
    const assignment = {e: 1, cats: ['family', 'people'], tier: 't100' as const};

    // First run: old free-text values become ~old-*, new cats lead.
    const first = computeDesiredCats(assignment, ['kinship', 'people']);
    assertEquals(first, ['family', 'people', '~tier-top-100', '~old-kinship']);
    // ('people' was both an old value and an assigned cat - not doubled.)

    // Re-run over its own output: unchanged (the idempotency fixed point).
    assertEquals(computeDesiredCats(assignment, first), first);

    // Unassigned entry: values just get prefixed; already-internal kept.
    assertEquals(computeDesiredCats(undefined, ['body', '~old-fish']),
                 ['~old-body', '~old-fish']);
    assertEquals(computeDesiredCats(undefined, ['~old-body', '~old-fish']),
                 ['~old-body', '~old-fish']);

    // needs-human flag.
    assertEquals(computeDesiredCats({e: 2, cats: [], flag: 'needs-human'}, []),
                 ['~needs-human']);
});

test("loadAssignments: later lines win (corrections are appends)", () => {
    const m = loadAssignments(
        '{"e":1,"cats":["body"]}\n' +
        '{"e":2,"cats":["fish"]}\n' +
        '{"e":1,"cats":["family"],"tier":"t10"}\n');
    assertEquals(m.get(1)!.cats, ['family']);
    assertEquals(m.get(1)!.tier, 't10');
    assertEquals(m.get(2)!.cats, ['fish']);
});

// ---------------------------------------------------------------------------
// --- End to end ----------------------------------------------------------------
// ---------------------------------------------------------------------------

// Seed two entries (category tuples live under SUBENTRIES - dct/ent/sub/cat):
//   1000: one subentry with old cats 'kinship' + 'people';
//   2000: TWO subentries - 'fish' on the first, 'kinship' on the second.
function seedEntries(ww: any): void {
    const tl = new TestTimeline();
    const e1 = mkEntry(1000, tl.next());
    ww.applyTransaction([e1], {quiet: true});
    const s1 = mkChild(e1, 'sub', 1100, tl.next(), {order_key: '0.5'});
    ww.applyTransaction([s1], {quiet: true});
    ww.applyTransaction([mkChild(s1, 'cat', 1001, tl.next(), {attr1: 'kinship', order_key: '0.2'})], {quiet: true});
    ww.applyTransaction([mkChild(s1, 'cat', 1002, tl.next(), {attr1: 'people', order_key: '0.4'})], {quiet: true});

    const e2 = mkEntry(2000, tl.next());
    ww.applyTransaction([e2], {quiet: true});
    const s2a = mkChild(e2, 'sub', 2100, tl.next(), {order_key: '0.2'});
    const s2b = mkChild(e2, 'sub', 2200, tl.next(), {order_key: '0.4'});
    ww.applyTransaction([s2a], {quiet: true});
    ww.applyTransaction([s2b], {quiet: true});
    ww.applyTransaction([mkChild(s2a, 'cat', 2001, tl.next(), {attr1: 'fish', order_key: '0.2'})], {quiet: true});
    ww.applyTransaction([mkChild(s2b, 'cat', 2002, tl.next(), {attr1: 'kinship', order_key: '0.2'})], {quiet: true});
}

// The entry's current category values (subentry-major, then order_key), read
// FROM THE DB (not the workspace) - the import must persist, not just mutate
// in memory.
function dbCatValues(entry_id: number): string[] {
    return db().all<{attr1: string}, {entry_id: number, end: number}>(
        `SELECT attr1 FROM dict
                WHERE ty = 'cat' AND id1 = :entry_id AND valid_to = :end
                ORDER BY id2, order_key`,
        {entry_id, end: timestamp.END_OF_TIME}).map(r => r.attr1);
}

const ASSIGNMENTS =
    '{"e":1000,"cats":["family","people"],"tier":"t100"}\n' +
    '{"e":3000,"cats":["weather"]}\n';   // 3000 does not exist in the db

test("import: seeds the table, rewrites entries, persists, re-run is a no-op", async () => {
    await withTestDb((fx) => {
        as(fx, 'system', () => {
            seedEntries(fx.ww);

            const stats = importCategories(fx.ww, {
                schemeText: SCHEME, assignmentsText: ASSIGNMENTS, username: 'djz'});

            // --- Seeding: 3 new + 4 internal + the 3 old names in current
            //     data.  Note old 'people' seeds as '~old-people' even though
            //     'people' is also a new slug: pre-import values live in the
            //     OLD namespace (an unassigned entry carrying old 'people'
            //     must rewrite to '~old-people', so the row must exist).
            assertEquals(stats.seed.seededNew, 3);
            assertEquals(stats.seed.seededInternal, 4);
            assertEquals(stats.seed.seededOld, 3);
            const cats = fx.ww.categories;
            assertEquals(cats.bySlug.required({slug: '~old-kinship'}).retired, 1);
            assertEquals(cats.bySlug.required({slug: 'family'}).theme,
                         'People & Relationships');
            // New vocabulary sorts before internal before old.
            assertEquals(cats.allByOrder.all({}).map((c: any) => c.slug),
                         ['family', 'people', 'weather',
                          '~needs-human', '~tier-top-10', '~tier-top-100', '~tier-top-1000',
                          '~old-fish', '~old-kinship', '~old-people']);

            // --- Rewrite: assigned entry gets new cats + tier + preserved old
            //     (on its primary subentry); the unassigned entry's old values
            //     are prefixed on BOTH its subentries.  (Read from the DB.)
            assertEquals(dbCatValues(1000),
                         ['family', 'people', '~tier-top-100', '~old-kinship']);
            assertEquals(dbCatValues(2000), ['~old-fish', '~old-kinship']);
            assertEquals(stats.rewrite.entriesRewritten, 2);
            assertEquals(stats.rewrite.assignmentsWithoutEntry, 1);

            // --- History: the old tuples are tombstoned, not erased.
            const versions1001 = db().all<Assertion, {id: number}>(
                'SELECT * FROM dict WHERE id = :id ORDER BY valid_from', {id: 1001});
            assertEquals(versions1001.length, 2);
            assertEquals(versions1001[1].valid_from, versions1001[1].valid_to);  // tombstone
            assertEquals(versions1001[1].change_by_username, 'djz');

            // --- Re-run: nothing changes (idempotent).
            const again = importCategories(fx.ww, {
                schemeText: SCHEME, assignmentsText: ASSIGNMENTS, username: 'djz'});
            assertEquals(again.seed.seededNew + again.seed.seededInternal +
                         again.seed.seededOld, 0);
            assertEquals(again.rewrite.entriesRewritten, 0);
            assertEquals(again.rewrite.entriesUnchanged, 2);
            assertEquals(dbCatValues(1000),
                         ['family', 'people', '~tier-top-100', '~old-kinship']);
        });
    });
});

test("import: refuses an empty scheme (wrong file guard)", async () => {
    await withTestDb((fx) => {
        as(fx, 'system', () => {
            assertThrows(() => importCategories(fx.ww, {
                schemeText: 'not a scheme', assignmentsText: '', username: 'djz'}));
        });
    });
});
