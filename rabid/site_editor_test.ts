// The site editor wired into rabid: the shared components render through rabid's
// mounted SiteView, the app-injected `rabid-upcoming-events` block reaches rabid's
// own DB, and the edit policy gates by rabid role (host/admin).
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertThrows } from "../liminal/testing/assert.ts";
import { find, findAll, hasClass } from "../liminal/testing/markup-assert.ts";
import { withTestDb, asUser, asSystem } from "./testing.ts";
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
