// Site-editor schema: Site -> PageFragment -> Block, ordering, and the block
// payload round-trip through the registry.  Uses the generic in-memory harness
// (no app coupling).
import { test } from "../liminal/testing/test.ts";
import { assertEquals } from "../liminal/testing/assert.ts";
import { openTestDb, clearAllData } from "../liminal/testing/db-harness.ts";
import * as security from "../liminal/security.ts";
import { FieldSet, StringField, EnumField } from "../liminal/table.ts";
import { setSerialized } from "../liminal/serializable.ts";
import { SiteTable, PageTable, BlockTable, siteEditorTables } from "./site.ts";
import { registerBlockKind, unregisterBlockKind, readPayload, writePayload,
         type BlockKind } from "./block-registry.ts";

// Standalone (unmounted) table instances: a real app stamps these with their
// route path via the `@path get block()` mount; here we stamp them by hand so the
// `@path`-decorated query getters can serialize.
const site = setSerialized(new SiteTable(), 'site');
const page = setSerialized(new PageTable(), 'page');
const blk = setSerialized(new BlockTable(), 'block');

function fresh() {
    openTestDb(siteEditorTables);
    clearAllData(siteEditorTables);
}

test("page fragments append in nav order within a site", () => {
    fresh();
    security.runSystem(() => {
        const s = site.insert({site_title: 'RRBR'});
        const home = page.insert({site_id: s, page_title: 'Home', slug: ''});
        const about = page.insert({site_id: s, page_title: 'About', slug: 'about'});
        const pages = page.forSite.all({site_id: s});
        assertEquals(pages.map(p => p.page_title), ['Home', 'About']);
        // nav_order is a managed, strictly-increasing order key.
        assertEquals(pages[0].nav_order < pages[1].nav_order, true);
        assertEquals([home, about].every(Number.isInteger), true);
    });
});

test("blocks form a flat ordered flow per page (append + explicit key)", () => {
    fresh();
    security.runSystem(() => {
        const s = site.insert({site_title: 'S'});
        const p = page.insert({site_id: s, page_title: 'P'});
        const other = page.insert({site_id: s, page_title: 'Other'});
        blk.insert({page_id: p, kind: 'divider', payload: '{}'});
        blk.insert({page_id: p, kind: 'title', payload: '{}'});
        // A block on a different page must not appear in p's flow.
        blk.insert({page_id: other, kind: 'divider', payload: '{}'});
        const flow = blk.forPage.all({page_id: p});
        assertEquals(flow.map(b => b.kind), ['divider', 'title']);
        assertEquals(flow[0].order_key < flow[1].order_key, true);
    });
});

test("block payload round-trips through the registry read/write path", () => {
    fresh();
    const kind: BlockKind = {
        kind: 'test-title', label: 'Title',
        schema: new FieldSet('test-title', [
            new EnumField('level', {h1:'h1', h2:'h2'}, {default: 'h2'}),
            new StringField('text', {default: ''}),
        ]),
        render: (pl) => ['h2', {}, pl.text],
    };
    registerBlockKind(kind);
    try {
        security.runSystem(() => {
            const s = site.insert({site_title: 'S'});
            const pf = page.insert({site_id: s, page_title: 'P'});
            const id = blk.insert({page_id: pf, kind: kind.kind,
                                   payload: writePayload(kind, {level: 'h1', text: 'Hi'})});
            const stored = blk.getById(id);
            assertEquals(stored.kind, 'test-title');
            assertEquals(readPayload(kind, stored.payload), {level: 'h1', text: 'Hi'});
        });
    } finally {
        unregisterBlockKind(kind.kind);
    }
});

test("pageShapeKey is a stable per-fragment selector", () => {
    assertEquals(blk.pageShapeKey(42), '-block-page-42-shape-');
});
