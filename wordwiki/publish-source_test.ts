// deno-lint-ignore-file no-explicit-any
/**
 * The PublishSource bundle (publish-source.ts): the serializable data the
 * public-site generator consumes.  The load-bearing property is that a
 * publish driven from a JSON ROUND-TRIP of the bundle behaves identically
 * to one driven from the in-memory build - that is what makes the dumped
 * artifact trustworthy as the archival stage-3 form.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertRejects } from "../liminal/testing/assert.ts";
import { withTestDb, TestTimeline, mkEntry, mkChild, bornApprove, type Fixture } from "./testing.ts";
import { buildPublishSource, publishSourceFromJson,
         PUBLISH_SOURCE_FORMAT_VERSION } from "./publish-source.ts";
import { Publish, PublishStatus } from "./publish.ts";

// Two public categorized words (the same seeding shape as the category
// publisher tests: old-style Completed, blessed like the cutover).
function seedTwoPublicWords(fx: Fixture): void {
    const tl = new TestTimeline();
    for(const [entryId, spelling, cat] of
        [[1000, 'samqwan', 'water'], [2000, 'waqami', 'water']] as const) {
        const e = mkEntry(entryId, tl.next());
        fx.ww.applyTransaction([e], {quiet: true});
        fx.ww.applyTransaction([mkChild(e, 'spl', entryId+10, tl.next(),
            {attr1: spelling, variant: 'mm-li', order_key: '0.5'})], {quiet: true});
        fx.ww.applyTransaction([mkChild(e, 'sta', entryId+20, tl.next(),
            {attr1: 'Completed', order_key: '0.5'})], {quiet: true});
        const s = mkChild(e, 'sub', entryId+100, tl.next(), {order_key: '0.5'});
        fx.ww.applyTransaction([s], {quiet: true});
        fx.ww.applyTransaction([mkChild(s, 'cat', entryId+200, tl.next(),
            {attr1: cat, order_key: '0.5'})], {quiet: true});
    }
    bornApprove(fx.ww);
}

test("buildPublishSource: shape, and entries keep the live view's identity", async () => {
    await withTestDb(async (fx: Fixture) => {
        seedTwoPublicWords(fx);
        const source = await buildPublishSource(fx.ww);
        assertEquals(source.formatVersion, PUBLISH_SOURCE_FORMAT_VERSION);
        assertEquals(source.orthography, 'mm-li');
        assertEquals(source.dbPurpose, fx.ww.getDbPurpose() ?? 'unmarked');
        assertEquals(source.entries.length, 2);
        // IDENTITY, not equality: the publish staleness check depends on the
        // bundle carrying the live view's array itself.
        assert(source.entries === fx.ww.publishedEntries,
               'in-memory bundle shares the live view entries array');
        // No timestamp on in-memory builds - the bundle stays deterministic.
        assertEquals(source.generatedAt, undefined);
        // The users section: in-data usernames (recording speakers, ...)
        // resolve within the file; automation identities are excluded.
        const djz = source.users.find(u => u.username === 'djz');
        assertEquals(djz?.name, 'David Ziegler');
        assert(source.users.every(u => !u.username.startsWith('~')),
               'automation identities are not users');
    });
});

test("a JSON round-trip of the bundle drives Publish identically", async () => {
    await withTestDb(async (fx: Fixture) => {
        seedTwoPublicWords(fx);
        const source = await buildPublishSource(fx.ww);
        const roundTripped = publishSourceFromJson(JSON.stringify(source));

        const live = new Publish(new PublishStatus(), source);
        const dumped = new Publish(new PublishStatus(), roundTripped);

        // The public-id map (entry-page filenames) and the category model -
        // the derivations everything else hangs off - agree exactly.
        assertEquals(Array.from(dumped.entryToPublicId.values()),
                     Array.from(live.entryToPublicId.values()));
        assertEquals(dumped.publicCategories(), live.publicCategories());
        assertEquals(Array.from(dumped.categoryCounts().entries()),
                     Array.from(live.categoryCounts().entries()));
        assertEquals(Array.from(dumped.entriesByCategory.keys()),
                     Array.from(live.entriesByCategory.keys()));
        assertEquals(dumped.defaultVariant, live.defaultVariant);
    });
});

test("a dump-driven publish emits byte-identical files to a live one", async () => {
    await withTestDb(async (fx: Fixture) => {
        seedTwoPublicWords(fx);
        const source = await buildPublishSource(fx.ww);
        const roundTripped = publishSourceFromJson(JSON.stringify(
            {...source, generatedAt: '2026-07-08T00:00:00.000Z'}));

        const emit = async (src2: any) => {
            const root = await Deno.makeTempDir({prefix: 'wordwiki-from-json-test-'});
            const pub = new Publish(new PublishStatus(), src2, root);
            await Deno.mkdir(`${root}/categories`, {recursive: true});
            await pub.publishTopWords();
            await pub.publishCategory('water');
            const files = new Map<string, string>();
            for(const path of pub.emittedPaths)
                files.set(path, await Deno.readTextFile(`${root}/${path}`));
            await Deno.remove(root, {recursive: true});
            return files;
        };

        const live = await emit(source);
        const dumped = await emit(roundTripped);
        assertEquals(Array.from(dumped.keys()).toSorted(),
                     Array.from(live.keys()).toSorted());
        for(const [path, content] of live)
            assertEquals(dumped.get(path), content, `content differs: ${path}`);
        assert(live.size > 0, 'the comparison actually covered files');
    });
});

test("orthography selection: sf / li / both bundles pick the right entries", async () => {
    await withTestDb(async (fx: Fixture) => {
        seedTwoPublicWords(fx);   // 1000 samqwan, 2000 waqami: li-public (Completed)
        // 3000: SF-ONLY public - an explicit mm-sf pub gate, no Completed
        // status (so the cutover bless creates no li gate).
        const tl = new TestTimeline();
        const e = mkEntry(3000, tl.next());
        fx.ww.applyTransaction([e], {quiet: true});
        fx.ww.applyTransaction([mkChild(e, 'spl', 3010, tl.next(),
            {attr1: 'sfword', variant: 'mm-li', order_key: '0.5'})], {quiet: true});
        fx.ww.applyTransaction([mkChild(e, 'pub', 3020, tl.next(),
            {variant: 'mm-sf', order_key: '0.5'})], {quiet: true});
        bornApprove(fx.ww);

        const ids = (s: any) => s.entries.map((e: any) => e.entry_id).toSorted();

        const li = await buildPublishSource(fx.ww);
        assertEquals(ids(li), [1000, 2000]);
        assertEquals(li.orthographies, ['mm-li']);
        assertEquals(li.variantContent, 'all');
        assert(li.entries === fx.ww.publishedEntries, 'default keeps live identity');

        const sf = await buildPublishSource(fx.ww, {orthographies: ['mm-sf']});
        assertEquals(ids(sf), [3000]);
        assertEquals(sf.orthography, 'mm-sf');

        const both = await buildPublishSource(fx.ww, {orthographies: ['mm-li', 'mm-sf']});
        assertEquals(ids(both), [1000, 2000, 3000]);
        assertEquals(both.orthography, 'mm-li');   // primary = first listed

        // Public ids in the sf bundle: no mm-sf spelling, so the id falls
        // back to the first spelling in any orthography (pinned - it names
        // the entry-page files).
        const pub = new Publish(new PublishStatus(), sf);
        assertEquals(Array.from(pub.entryToPublicId.values()), ['sfword']);
    });
});

test("variantContent 'selected' filters lanes but never provenance", async () => {
    await withTestDb(async (fx: Fixture) => {
        // One li-public word carrying: an li + an sf spelling, an 'en'
        // translation ($notVariant relic), and a document reference whose
        // transliteration is in Pacifique Manuscript orthography
        // ($sourceOrthography provenance).
        const tl = new TestTimeline();
        const e = mkEntry(1000, tl.next());
        fx.ww.applyTransaction([e], {quiet: true});
        fx.ww.applyTransaction([mkChild(e, 'spl', 1010, tl.next(),
            {attr1: 'samqwan', variant: 'mm-li', order_key: '0.5'})], {quiet: true});
        fx.ww.applyTransaction([mkChild(e, 'spl', 1011, tl.next(),
            {attr1: 'samuqwan', variant: 'mm-sf', order_key: '0.6'})], {quiet: true});
        fx.ww.applyTransaction([mkChild(e, 'sta', 1020, tl.next(),
            {attr1: 'Completed', order_key: '0.5'})], {quiet: true});
        const s = mkChild(e, 'sub', 1100, tl.next(), {order_key: '0.5'});
        fx.ww.applyTransaction([s], {quiet: true});
        fx.ww.applyTransaction([mkChild(s, 'tra', 1200, tl.next(),
            {attr1: 'water', variant: 'en', order_key: '0.5'})], {quiet: true});
        const ref = mkChild(s, 'ref', 1300, tl.next(), {attr1: '999999', order_key: '0.5'});
        fx.ww.applyTransaction([ref], {quiet: true});
        fx.ww.applyTransaction([mkChild(ref, 'rtl', 1310, tl.next(),
            {attr1: 'samgwan', variant: 'mm-pm', order_key: '0.5'})], {quiet: true});
        bornApprove(fx.ww);

        const all = await buildPublishSource(fx.ww, {orthographies: ['mm-li']});
        assertEquals(all.entries[0].spelling.length, 2, "'all' keeps every lane");

        const sel = await buildPublishSource(fx.ww,
            {orthographies: ['mm-li'], variantContent: 'selected'});
        const entry = sel.entries[0];
        assertEquals(entry.spelling.map((sp: any) => sp.text), ['samqwan'],
                     'the sf spelling lane is filtered out');
        assertEquals(entry.subentry[0].translation.map((t: any) => t.translation), ['water'],
                     '$notVariant relics are not lanes - kept');
        assertEquals(entry.subentry[0].document_reference[0].transliteration
                         .map((t: any) => t.transliteration), ['samgwan'],
                     '$sourceOrthography provenance always passes');
        assertEquals(entry.public.length, 1, 'the li pub gate row is kept');
        // The LIVE projection was not mutated by the filtering.
        assertEquals(fx.ww.publishedEntries[0].spelling.length, 2);
        // The scan list follows the (filtered) entries' refs.
        assertEquals(sel.scans.map(sc => String(sc.bounding_group_id)), ['999999']);
    });
});

test("the site carries its own seed: data downloads emit the bundle + docs + license", async () => {
    await withTestDb(async (fx: Fixture) => {
        seedTwoPublicWords(fx);
        const source = await buildPublishSource(fx.ww);
        const root = await Deno.makeTempDir({prefix: 'wordwiki-data-downloads-test-'});
        const pub = new Publish(new PublishStatus(), source, root);

        await pub.publishDataDownloads();

        // The bundle on the site is the EXACT source of this publish.
        const onSite = publishSourceFromJson(
            await Deno.readTextFile(`${root}/data/publish-source.json`));
        assertEquals(onSite.entries.length, source.entries.length);
        assertEquals(onSite.formatVersion, source.formatVersion);

        // The format doc rides along.
        const doc = await Deno.readTextFile(`${root}/data/publish-source-format.md`);
        assert(doc.includes('# The publish source'), 'format doc content');

        // The data page: license + file links, and it is in the prune
        // manifest (writePage).
        const page = await Deno.readTextFile(`${root}/data/index.html`);
        assert(page.includes('Creative Commons Attribution-NonCommercial'), 'license stated');
        assert(page.includes('publish-source.json'), 'links the bundle');
        assert(pub.emittedPaths.has('data/index.html'), 'page in the emitted manifest');

        await Deno.remove(root, {recursive: true});
    });
});

test("publishSourceFromJson: rejects an unknown formatVersion", async () => {
    await withTestDb(async () => {
        await assertRejects(async () =>
            publishSourceFromJson(JSON.stringify({formatVersion: 999, entries: []})),
            Error, 'formatVersion');
    });
});
