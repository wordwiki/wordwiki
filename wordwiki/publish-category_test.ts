// deno-lint-ignore-file no-explicit-any
/**
 * The public-site category policy (Publish.publicCategories /
 * publicCategoryName / publicEntryCategories): internal '~' categories are
 * never emitted, display names come from the category table, ordering
 * follows the table, and a pre-import db degrades gracefully.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, as, TestTimeline, mkEntry, mkChild, bornApprove, type Fixture } from "./testing.ts";
import { Publish, PublishStatus } from "./publish.ts";

// A PUBLISHED entry (status Completed) with one subentry carrying the given
// category values - the shape the publisher consumes.
function seedPublishedEntry(ww: any, tl: TestTimeline, entryId: number,
                            spelling: string, cats: string[]): void {
    const e = mkEntry(entryId, tl.next());
    ww.applyTransaction([e], {quiet: true});
    ww.applyTransaction([mkChild(e, 'spl', entryId+10, tl.next(),
                                 {attr1: spelling, order_key: '0.5'})], {quiet: true});
    ww.applyTransaction([mkChild(e, 'sta', entryId+20, tl.next(),
                                 {attr1: 'Completed', order_key: '0.5'})], {quiet: true});
    const s = mkChild(e, 'sub', entryId+100, tl.next(), {order_key: '0.5'});
    ww.applyTransaction([s], {quiet: true});
    cats.forEach((cat, i) =>
        ww.applyTransaction([mkChild(s, 'cat', entryId+200+i, tl.next(),
                                     {attr1: cat, order_key: `0.${i+2}`})], {quiet: true}));
}

function mkPublish(fx: Fixture): Publish {
    bornApprove(fx.ww);  // the public site is the published projection now
    return new Publish(new PublishStatus(), fx.ww, fx.ww.publishedEntries);
}

test("public categories: internal '~' slugs filtered, table order, display names", async () => {
    await withTestDb((fx) => {
        as(fx, 'djz', () => {
            const tl = new TestTimeline();
            // Seed in NON-alphabetical table order: weather before family.
            fx.ww.categories.insert({slug: 'weather', name: 'Weather', theme: 'Land, Water & Sky'});
            fx.ww.categories.insert({slug: 'family', name: 'Family & Kinship', theme: 'People & Relationships'});
            fx.ww.categories.insert({slug: '~old-kinship', name: 'kinship (old)', retired: 1});

            seedPublishedEntry(fx.ww, tl, 1000, 'aaa', ['family', '~old-kinship', '~tier-top-10']);
            seedPublishedEntry(fx.ww, tl, 2000, 'bbb', ['weather', 'family', '~needs-human']);
            seedPublishedEntry(fx.ww, tl, 3000, 'ccc', ['zz-not-in-table']);

            const pub = mkPublish(fx);

            // The directory/page list: no '~' slugs anywhere; table order first
            // (weather then family), un-tabled values after, with counts.
            assertEquals(pub.publicCategories(),
                         [['weather', 1], ['family', 2], ['zz-not-in-table', 1]]);

            // Display names from the table; raw value when there is no row.
            assertEquals(pub.publicCategoryName('family'), 'Family & Kinship');
            assertEquals(pub.publicCategoryName('zz-not-in-table'), 'zz-not-in-table');

            // The per-entry related-category sections: internal filtered.
            const e1000 = fx.ww.publishedEntries.find((e: any) => e.entry_id === 1000)!;
            assertEquals(pub.publicEntryCategories(e1000), ['family']);
            const e2000 = fx.ww.publishedEntries.find((e: any) => e.entry_id === 2000)!;
            assertEquals(pub.publicEntryCategories(e2000), ['weather', 'family']);
        });
    });
});

test("publicCategoryGroups: theme groups, internal filtered, un-tabled trail", async () => {
    await withTestDb((fx) => {
        as(fx, 'djz', () => {
            const tl = new TestTimeline();
            fx.ww.categories.insert({slug: 'people', name: 'People', theme: 'People & Relationships'});
            fx.ww.categories.insert({slug: 'family', name: 'Family & Kinship', theme: 'People & Relationships'});
            fx.ww.categories.insert({slug: 'weather', name: 'Weather', theme: 'Land, Water & Sky'});
            fx.ww.categories.insert({slug: '~old-kinship', name: 'kinship (old)', theme: 'Old categories', retired: 1});

            seedPublishedEntry(fx.ww, tl, 1000, 'aaa', ['people', 'family', '~old-kinship']);
            seedPublishedEntry(fx.ww, tl, 2000, 'bbb', ['weather', 'zz-not-in-table']);

            const groups = mkPublish(fx).publicCategoryGroups();
            // Themes alphabetical by title; the un-tabled 'Other categories'
            // group always trails.
            assertEquals(groups.map(g => g.theme),
                         ['Land, Water & Sky', 'People & Relationships', 'Other categories']);
            // Sorted by display name within the theme; counts attached;
            // the internal ~old-* category is nowhere.
            assertEquals(groups[1].cats,
                         [{slug: 'family', name: 'Family & Kinship', count: 1},
                          {slug: 'people', name: 'People', count: 1}]);
            assertEquals(groups[2].cats,
                         [{slug: 'zz-not-in-table', name: 'zz-not-in-table', count: 1}]);
        });
    });
});

test("public categories: pre-import db (empty table) degrades to raw values", async () => {
    await withTestDb((fx) => {
        as(fx, 'djz', () => {
            const tl = new TestTimeline();
            seedPublishedEntry(fx.ww, tl, 1000, 'aaa', ['kinship', 'fish']);

            const pub = mkPublish(fx);
            // No table rows: alphabetical, raw names - but '~' would still
            // filter (the marker lives in the data, not the table).
            assertEquals(pub.publicCategories(), [['fish', 1], ['kinship', 1]]);
            assertEquals(pub.publicCategoryName('kinship'), 'kinship');
            // The grouped form: one plain 'Categories' group.
            assertEquals(pub.publicCategoryGroups(),
                         [{theme: 'Categories',
                           cats: [{slug: 'fish', name: 'fish', count: 1},
                                  {slug: 'kinship', name: 'kinship', count: 1}]}]);
        });
    });
});

// --- Top Words -------------------------------------------------------------
// Tier tags are stored most-specific (an entry carries only its tightest
// tier), so each Top Words bucket is CUMULATIVE: it unions every tier up to
// and including its own.  cumulativeTierEntries does that union + dedup + sort.

test("Top Words: buckets are cumulative, deduped, and spelling-sorted", async () => {
    await withTestDb((fx) => {
        as(fx, 'djz', () => {
            const tl = new TestTimeline();
            // ccc is in the top-10; aaa in top-100; bbb in top-1000.  ddd is
            // double-tagged (top-10 AND top-100) to exercise dedup.
            seedPublishedEntry(fx.ww, tl, 1000, 'ccc', ['~tier-top-10']);
            seedPublishedEntry(fx.ww, tl, 1500, 'ddd', ['~tier-top-10', '~tier-top-100']);
            seedPublishedEntry(fx.ww, tl, 2000, 'aaa', ['~tier-top-100']);
            seedPublishedEntry(fx.ww, tl, 3000, 'bbb', ['~tier-top-1000']);

            const pub = mkPublish(fx);
            const ids = (slugs: string[]) =>
                pub.cumulativeTierEntries(slugs).map((e: any) => e.entry_id);

            // top-10 bucket: just the two top-10 entries, spelling-sorted (ccc,ddd).
            assertEquals(ids(['~tier-top-10']), [1000, 1500]);
            // top-100 = top-10 ∪ top-100, ddd appears ONCE; sorted aaa,ccc,ddd.
            assertEquals(ids(['~tier-top-10', '~tier-top-100']), [2000, 1000, 1500]);
            // top-1000 = all three: aaa,bbb,ccc,ddd.
            assertEquals(ids(['~tier-top-10', '~tier-top-100', '~tier-top-1000']),
                         [2000, 3000, 1000, 1500]);
        });
    });
});

test("Top Words: publishTopWords emits a directory + a page per tier with cumulative counts", async () => {
    await withTestDb(async (fx) => {
        // Seed under the actor (synchronous prefix), then do file IO after.
        const root = as(fx, 'djz', () => {
            const tl = new TestTimeline();
            seedPublishedEntry(fx.ww, tl, 1000, 'ccc', ['~tier-top-10']);
            seedPublishedEntry(fx.ww, tl, 2000, 'aaa', ['~tier-top-100']);
            seedPublishedEntry(fx.ww, tl, 3000, 'bbb', ['~tier-top-1000']);
            bornApprove(fx.ww);
            return undefined;
        });
        void root;
        const tmp = await Deno.makeTempDir({prefix: 'wordwiki-topwords-test-'});
        const pub = new Publish(new PublishStatus(), fx.ww, fx.ww.publishedEntries, tmp);

        await pub.publishTopWords();

        // The directory page and one page per tier were written...
        assert(pub.emittedPaths.has('top-words.html'));
        assert(pub.emittedPaths.has('top-words/top-10.html'));
        assert(pub.emittedPaths.has('top-words/top-100.html'));
        assert(pub.emittedPaths.has('top-words/top-1000.html'));

        // ...with cumulative counts (1 / 2 / 3) on the directory page.
        const dir = await Deno.readTextFile(`${tmp}/top-words.html`);
        assertStringIncludes(dir, 'Top 10 words');
        assertStringIncludes(dir, '(1 entries)');
        assertStringIncludes(dir, 'Top 100 words');
        assertStringIncludes(dir, '(2 entries)');
        assertStringIncludes(dir, 'Top 1000 words');
        assertStringIncludes(dir, '(3 entries)');

        await Deno.remove(tmp, {recursive: true});
    });
});
