// deno-lint-ignore-file no-explicit-any
/**
 * Stale-page pruning (Publish.pruneOrphanedPages): the publisher deletes
 * orphaned *.html (pages it no longer emits, e.g. a category that became
 * internal) - but ONLY under heavy guards, because it deletes files from a
 * publish root.  Every scenario here runs against a throwaway temp dir with a
 * hand-built emitted-path manifest; nothing touches a real publish root.  The
 * prune does no actor/DB work, so we drive it directly (no `as`).
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertFalse, assertStringIncludes } from "../liminal/testing/assert.ts";
import { exists } from "std/fs/mod.ts";
import { withTestDb, type Fixture } from "./testing.ts";
import { Publish, PublishStatus, PUBLISH_MARKER_FILE } from "./publish.ts";
import { buildPublishSource } from "./publish-source.ts";

// Build a Publish rooted at a fresh temp dir.  We drive pruneOrphanedPages()
// directly with a hand-set manifest, so no real entries/DB seeding is needed.
async function mkPrunable(fx: Fixture, options: any = {}):
    Promise<{pub: Publish, root: string}> {
    const root = await Deno.makeTempDir({prefix: 'wordwiki-prune-test-'});
    const pub = new Publish(new PublishStatus(), await buildPublishSource(fx.ww), root, options);
    return {pub, root};
}

async function touch(root: string, rel: string, body = '<html></html>'): Promise<void> {
    const full = `${root}/${rel}`;
    await Deno.mkdir(full.substring(0, full.lastIndexOf('/')), {recursive: true});
    await Deno.writeTextFile(full, body);
}

const there = (root: string, rel: string) => exists(`${root}/${rel}`);

// Inflate the manifest past the sanity floor with paths that match no file on
// disk (so they never collide with the orphans/live pages a test creates).
function padManifest(pub: Publish, n = 150): void {
    for(let i = 0; i < n; i++) pub.emittedPaths.add(`entries/pad/p${i}.html`);
}

test("prune: NO marker => nothing deleted (opt-in)", async () => {
    await withTestDb(async (fx) => {
        const {pub, root} = await mkPrunable(fx);
        await touch(root, 'categories/orphan.html');
        await touch(root, 'categories/live.html');
        pub.emittedPaths.add('categories/live.html');
        padManifest(pub);                      // manifest is healthy...
        // ...but there is no marker file, so prune must not touch anything.
        await pub.pruneOrphanedPages();
        assert(await there(root, 'categories/orphan.html'), 'orphan kept (no marker)');
        assert(await there(root, 'categories/live.html'));
        assertStringIncludes(pub.status.warnings.join('\n'), PUBLISH_MARKER_FILE);
        await Deno.remove(root, {recursive: true});
    });
});

test("prune: marker + healthy manifest => orphans removed, live + non-html kept", async () => {
    await withTestDb(async (fx) => {
        const {pub, root} = await mkPrunable(fx);
        await touch(root, PUBLISH_MARKER_FILE, '');         // opt in
        await touch(root, 'categories/astronomy.html');     // ORPHAN (the bug)
        await touch(root, 'categories/sky.html');           // live
        await touch(root, 'categories/notes.txt', 'keep');  // non-html -> never touched
        await touch(root, 'entries/g/galq/galq.html');      // live entry
        await touch(root, 'entries/z/gone/gone.html');      // ORPHAN entry
        await touch(root, 'servlet/words/gone.html');       // ORPHAN forwarder
        pub.emittedPaths.add('categories/sky.html');
        pub.emittedPaths.add('entries/g/galq/galq.html');
        padManifest(pub);

        await pub.pruneOrphanedPages();

        assertFalse(await there(root, 'categories/astronomy.html'), 'orphan category removed');
        assertFalse(await there(root, 'entries/z/gone/gone.html'), 'orphan entry removed');
        assertFalse(await there(root, 'servlet/words/gone.html'), 'orphan forwarder removed');
        assert(await there(root, 'categories/sky.html'), 'live category kept');
        assert(await there(root, 'entries/g/galq/galq.html'), 'live entry kept');
        assert(await there(root, 'categories/notes.txt'), 'non-.html never deleted');
        assert(await there(root, PUBLISH_MARKER_FILE), 'marker never deleted');
        assertStringIncludes(pub.status.log.join('\n'), 'removed 3 orphaned');
        await Deno.remove(root, {recursive: true});
    });
});

test("prune: suppressed section's directory is left alone", async () => {
    await withTestDb(async (fx) => {
        // Categories suppressed this run => its tree emitted nothing, so it
        // must NOT be pruned (else every category page looks orphaned).
        const {pub, root} = await mkPrunable(fx, {suppressPublishCategories: true});
        await touch(root, PUBLISH_MARKER_FILE, '');
        await touch(root, 'categories/orphan.html');        // would-be orphan, but section off
        await touch(root, 'entries/e/orphan/orphan.html');  // entries section ran -> orphan
        padManifest(pub);

        await pub.pruneOrphanedPages();

        assert(await there(root, 'categories/orphan.html'), 'suppressed category dir untouched');
        assertFalse(await there(root, 'entries/e/orphan/orphan.html'), 'entry orphan removed');
        await Deno.remove(root, {recursive: true});
    });
});

test("prune: publish errors this run => skip (manifest may be incomplete)", async () => {
    await withTestDb(async (fx) => {
        const {pub, root} = await mkPrunable(fx);
        await touch(root, PUBLISH_MARKER_FILE, '');
        await touch(root, 'categories/orphan.html');
        padManifest(pub);
        pub.status.errors.push('some page failed to render');

        await pub.pruneOrphanedPages();

        assert(await there(root, 'categories/orphan.html'), 'nothing deleted after an errored publish');
        assertStringIncludes(pub.status.log.join('\n'), 'SKIPPED');
        await Deno.remove(root, {recursive: true});
    });
});

test("prune: implausibly small manifest => abort, delete nothing", async () => {
    await withTestDb(async (fx) => {
        const {pub, root} = await mkPrunable(fx);
        await touch(root, PUBLISH_MARKER_FILE, '');
        await touch(root, 'categories/orphan.html');
        pub.emittedPaths.add('categories/live.html');   // only 1 page -> below floor

        await pub.pruneOrphanedPages();

        assert(await there(root, 'categories/orphan.html'), 'nothing deleted when manifest looks broken');
        assertStringIncludes(pub.status.errors.join('\n'), 'ABORTED');
        await Deno.remove(root, {recursive: true});
    });
});
