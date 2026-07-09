// deno-lint-ignore-file no-explicit-any
/**
 * The multi-orthography publish (multi-ortho-publish.md): one run, all
 * orthographies - a full tree per orthography (/li, /sf) sharing the root
 * stores via ../, the root orthography-chooser (works from a USB stick),
 * the legacy /servlet forwarders at the ROOT targeting the primary tree,
 * the generated Caddy redirect include, and peer cross-links with the
 * existence rule.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, TestTimeline, mkEntry, mkChild, bornApprove, type Fixture } from "./testing.ts";
import { buildAllPublishSources } from "./publish-source.ts";
import { publishMultiTree, PublishStatus } from "./publish.ts";

// One li-public word (Completed -> blessed li gate) and one word public in
// BOTH lanes (li gate + an explicit sf gate), so the trees differ.
function seed(fx: Fixture): void {
    const tl = new TestTimeline();
    const a = mkEntry(1000, tl.next());
    fx.ww.applyTransaction([a], {quiet: true});
    fx.ww.applyTransaction([mkChild(a, 'spl', 1010, tl.next(),
        {attr1: 'samqwan', variant: 'mm-li', order_key: '0.5'})], {quiet: true});
    fx.ww.applyTransaction([mkChild(a, 'sta', 1020, tl.next(),
        {attr1: 'Completed', order_key: '0.5'})], {quiet: true});
    const b = mkEntry(2000, tl.next());
    fx.ww.applyTransaction([b], {quiet: true});
    fx.ww.applyTransaction([mkChild(b, 'spl', 2010, tl.next(),
        {attr1: 'waqami', variant: 'mm-li', order_key: '0.5'})], {quiet: true});
    fx.ww.applyTransaction([mkChild(b, 'spl', 2011, tl.next(),
        {attr1: 'waqamik', variant: 'mm-sf', order_key: '0.6'})], {quiet: true});
    fx.ww.applyTransaction([mkChild(b, 'sta', 2020, tl.next(),
        {attr1: 'Completed', order_key: '0.5'})], {quiet: true});
    fx.ww.applyTransaction([mkChild(b, 'pub', 2030, tl.next(),
        {variant: 'mm-sf', order_key: '0.5'})], {quiet: true});
    bornApprove(fx.ww);
}

test("multi-tree publish: trees, shared stores, chooser, forwarders, peers", async () => {
    await withTestDb(async (fx: Fixture) => {
        seed(fx);
        const sources = await buildAllPublishSources(fx.ww);
        assertEquals(sources.map(s => s.orthographySegment), ['li', 'sf']);

        const root = await Deno.makeTempDir({prefix: 'wordwiki-multi-tree-test-'});
        const status = new PublishStatus();
        status.start();
        await publishMultiTree(status, sources, root);
        status.end();
        assertEquals(status.errors, []);

        const read = (p: string) => Deno.readTextFileSync(`${root}/${p}`);
        const exists = (p: string) => { try { Deno.statSync(`${root}/${p}`); return true; } catch { return false; } };

        // Full trees, tree-relative internals, shared stores one up.
        assert(exists('li/index.html') && exists('sf/index.html'), 'both trees');
        assert(exists('li/entries/s/samqwan/samqwan.html'), 'li entry');
        assert(!exists('sf/entries/s/samqwan') && !exists('sf/entries/w/samqwan'),
               'li-only word absent from the sf tree');
        assert(exists('sf/entries/w/waqamik/waqamik.html'),
               'the both-lanes word, under its SF public id');
        const liHome = read('li/index.html');
        assertStringIncludes(liHome, '../resources/site-theme.css');

        // Peer links with the existence rule.
        const liB = read('li/entries/w/waqami/waqami.html');
        assertStringIncludes(liB, '../../../../sf/entries/w/waqamik/waqamik.html');
        const liA = read('li/entries/s/samqwan/samqwan.html');
        assertStringIncludes(liA, '../../../../sf/index.html');  // no sf page: peer home

        // The root chooser (no server needed) + the generated Caddy include.
        const chooser = read('index.html');
        assertStringIncludes(chooser, 'li/index.html');
        assertStringIncludes(chooser, 'sf/index.html');
        assertStringIncludes(chooser, 'Listuguj');
        assertStringIncludes(chooser, 'Smith-Francis');
        const caddy = read('data/caddy-redirects.conf');
        assertStringIncludes(caddy, 'redir / /li/ 301');
        assertStringIncludes(caddy, 'redir /entries/* /li{uri} 301');

        // Legacy forwarders: at the ROOT, targeting the PRIMARY tree.
        const fwd = read('servlet/words/samqwan.html');
        assertStringIncludes(fwd, '/li/entries/s/samqwan/samqwan.html');
        assert(!exists('li/servlet') && !exists('sf/servlet'), 'servlet stays at the root');

        await Deno.remove(root, {recursive: true});
    });
});
