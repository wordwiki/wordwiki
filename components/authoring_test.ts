// The authoring UI: site index, page editor shell, and the create/delete
// mutations with their admin policy.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertThrows } from "../liminal/testing/assert.ts";
import { openTestDb, clearAllData } from "../liminal/testing/db-harness.ts";
import * as security from "../liminal/security.ts";
import { setSerialized } from "../liminal/serializable.ts";
import { find, findAll, attr, hasText, hasClass } from "../liminal/testing/markup-assert.ts";
import { SiteTable, PageTable, BlockTable, siteEditorTables } from "./site.ts";
import { SiteView } from "./site-view.ts";

const site = setSerialized(new SiteTable(), 'site');
const page = setSerialized(new PageTable(), 'page');
const blk = setSerialized(new BlockTable(), 'block');

class AdminView extends SiteView {
    protected override canEditSite(): boolean { return true; }
    protected override canAdminSites(): boolean { return true; }
}
const admin = setSerialized(new AdminView(site, page, blk), 'siteView');
const guest = setSerialized(new SiteView(site, page, blk), 'siteView');   // default: deny admin

function fresh() {
    openTestDb(siteEditorTables);
    clearAllData(siteEditorTables);
}

test("createSite / createPage build the tree; default policy denies both", () => {
    fresh();
    security.runSystem(() => {
        assertThrows(() => guest.createSite({site_title: 'Nope'}), Error, 'Not permitted');
        const r1 = admin.createSite({site_title: 'redraccoon.org'}) as any;
        assertEquals(r1.targets, ['.' + site.listShapeKey()]);
        const site_id = site.listAll.all({})[0].site_id;

        assertThrows(() => guest.createPage({site_id, page_title: 'X'}), Error, 'Not permitted');
        const r2 = admin.createPage({site_id, page_title: 'Welcome', slug: ''}) as any;
        assertEquals(r2.targets, ['.' + page.siteShapeKey(site_id)]);
        assertEquals(page.forSite.all({site_id}).map(p => p.page_title), ['Welcome']);
    });
});

test("site index lists sites + pages and links to the editor; create buttons are admin-only", () => {
    fresh();
    const site_id = security.runSystem(() => {
        const s = site.insert({site_title: 'RRBR'});
        admin_seed(s);
        return s;
    });
    const m = security.runSystem(() => admin.renderSiteIndex());
    assert(find(m, n => hasText(n, 'RRBR')));
    const link = find(m, n => (attr(n, 'href') ?? '').includes('({page:'))!;
    assert(link);
    assertEquals(attr(link, 'href'), `/site({page:${firstPageId(site_id)}})`);
    // Admin sees New-site / New-page buttons; a guest sees none.
    assert(find(m, n => hasText(n, 'New site')));
    const g = security.runSystem(() => guest.renderSiteIndex());
    assertEquals(findAll(g, n => hasText(n, 'New page')).length, 0);
});

test("page editor renders a back link, header, and the editable flow", () => {
    fresh();
    const pid = security.runSystem(() => {
        const s = site.insert({site_title: 'S'});
        return page.insert({site_id: s, page_title: 'About', published: 1});
    });
    const m = security.runSystem(() => admin.renderPageEditor(pid));
    assert(find(m, n => hasText(n, '← All pages')));
    assert(find(m, n => hasText(n, 'About')));
    assert(find(m, n => hasClass(n, 'badge') && hasText(n, 'Published')));
    assert(find(m, n => hasClass(n, 'site-page-editing')));   // the editable flow
});

test("renderAuthoringHome routes: ?page -> editor, else index", () => {
    fresh();
    const pid = security.runSystem(() => {
        const s = site.insert({site_title: 'S'});
        return page.insert({site_id: s, page_title: 'Home'});
    });
    const editor = security.runSystem(() => admin.renderAuthoringHome({page: pid}));
    assert(find(editor, n => hasText(n, '← All pages')));
    const index = security.runSystem(() => admin.renderAuthoringHome({}));
    assert(find(index, n => hasText(n, 'New site')));
});

test("deletePage removes it and reloads the site's page list", () => {
    fresh();
    security.runSystem(() => {
        const s = site.insert({site_title: 'S'});
        const pid = page.insert({site_id: s, page_title: 'Doomed'});
        const res = admin.deletePage(pid) as any;
        assertEquals(res.targets, ['.' + page.siteShapeKey(s)]);
        assertEquals(page.forSite.all({site_id: s}).length, 0);
    });
});

function admin_seed(site_id: number) {
    page.insert({site_id, page_title: 'Welcome'});
}
function firstPageId(site_id: number): number {
    return page.forSite.all({site_id})[0].page_id;
}
