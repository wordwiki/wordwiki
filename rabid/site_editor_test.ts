// The site editor wired into rabid: the shared components render through rabid's
// mounted SiteView, the app-injected `rabid-upcoming-events` block reaches rabid's
// own DB, and the edit policy gates by rabid role (host/admin).
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertThrows } from "../liminal/testing/assert.ts";
import { find, findAll, hasClass, hasText } from "../liminal/testing/markup-assert.ts";
import { withTestDb, asUser, asSystem, renderRoute, invoke } from "./testing.ts";
import { getRabid } from "./rabid.ts";
import { blockKind } from "../components/block-registry.ts";

test("rabid mounts the site editor: a site + page + block flow renders through SiteView", async () => {
    await withTestDb((fx) => {
        const r = getRabid();
        const { page_id } = asSystem(() => {
            const site_id = r.site.insert({site_title: 'redraccoon.org'});
            const page_id = r.sitePage.insert({site_id, page_title: 'Welcome'});
            return { page_id };
        });
        // Host adds two blocks through the shared edit dispatch.
        asUser(fx.alice, () => {
            r.siteView.addBlock(page_id, 'title');
            r.siteView.addBlock(page_id, 'rabid-upcoming-events');
        });
        const m = asUser(fx.alice, () => r.siteView.renderPage(page_id, false));
        // Rabid's chrome wraps the flow; the block flow rendered.
        assert(find(m, n => hasClass(n, 'rabid-site-page')));
        assert(find(m, n => hasClass(n, 'site-page')));
        // The app-injected block rendered rabid content (NOT an unknown-block stub).
        assert(find(m, n => hasClass(n, 'site-block-rabid-events')));
        assertEquals(findAll(m, n => hasClass(n, 'site-block-unknown')).length, 0);
    });
});

test("the rabid-upcoming-events block is registered from the app (the injection seam)", () => {
    const k = blockKind('rabid-upcoming-events');
    assert(k && k.category === 'app');
});

// Route-level dispatch (the direct-call tests above would miss a missing @route -
// see the route-undeclared bug pattern): the /site page + the authoring mutations
// must resolve through the interpreter, POST-gated.
test("authoring UI dispatches through routes (page + create mutations)", async () => {
    await withTestDb(async (fx) => {
        // The /site index page renders.
        const index = await asUser(fx.alice, () => renderRoute('site'));
        assert(find(index, n => hasText(n, 'New site')));
        // createSite -> createPage over the route layer, then the editor page renders.
        const s = await asUser(fx.alice, () => invoke('rabid.siteView.createSite($arg0)', {site_title: 'Live'}));
        assertEquals(s.action, 'reload');
        const site_id = asSystem(() => getRabid().site.listAll.all({})[0].site_id);
        await asUser(fx.alice, () => invoke('rabid.siteView.createPage($arg0)', {site_id, page_title: 'Home'}));
        const page_id = asSystem(() => getRabid().sitePage.forSite.all({site_id})[0].page_id);
        const editor = await asUser(fx.alice, () => renderRoute(`site({page:${page_id}})`));
        assert(find(editor, n => hasText(n, '← All pages')));
        // A regular volunteer is refused at the route layer too.
        await asUser(fx.bob, async () => {
            let threw = false;
            try { await invoke('rabid.siteView.createSite($arg0)', {site_title: 'No'}); } catch { threw = true; }
            assert(threw);
        });
    });
});

test("edit policy: host/admin may edit, a regular volunteer may not", async () => {
    await withTestDb((fx) => {
        const r = getRabid();
        const page_id = asSystem(() => {
            const site_id = r.site.insert({site_title: 'S'});
            return r.sitePage.insert({site_id, page_title: 'P'});
        });
        // A regular volunteer is blocked by the injected canEditSite policy.
        asUser(fx.bob, () =>
            assertThrows(() => r.siteView.addBlock(page_id, 'divider'), Error, 'Not permitted'));
        assertEquals(asSystem(() => r.block.forPage.all({page_id}).length), 0);
        // Host and admin may.
        asUser(fx.alice, () => r.siteView.addBlock(page_id, 'divider'));
        asUser(fx.dave, () => r.siteView.addBlock(page_id, 'title'));
        assertEquals(asSystem(() => r.block.forPage.all({page_id}).length), 2);
    });
});
