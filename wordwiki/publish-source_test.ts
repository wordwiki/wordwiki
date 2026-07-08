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
    await withTestDb((fx: Fixture) => {
        seedTwoPublicWords(fx);
        const source = buildPublishSource(fx.ww);
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
    await withTestDb((fx: Fixture) => {
        seedTwoPublicWords(fx);
        const source = buildPublishSource(fx.ww);
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
        const source = buildPublishSource(fx.ww);
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

test("publishSourceFromJson: rejects an unknown formatVersion", async () => {
    await withTestDb(async () => {
        await assertRejects(async () =>
            publishSourceFromJson(JSON.stringify({formatVersion: 999, entries: []})),
            Error, 'formatVersion');
    });
});
