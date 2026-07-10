// deno-lint-ignore-file no-explicit-any
/**
 * The page-editor word sidebar (page-editor-change.md): every word with
 * scanned content on the current page, in READING ORDER (the page-at-a-time
 * PDM transcription workflow), rows carrying data-group-ids for the
 * client's two-way hover sync, and a tail section of tagged groups no word
 * references yet.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertStringIncludes } from "../liminal/testing/assert.ts";
import { db } from "../liminal/db.ts";
import { renderToStringViaLinkeDOM } from '../liminal/markup.ts';
import { withTestDb, TestTimeline, mkEntry, mkChild, bornApprove, type Fixture } from "./testing.ts";
import { renderPageWordSidebarCore, deleteBoundingGroup, deleteUnlinkedGroupsForPage } from "./render-page-editor.ts";
import { as } from "./testing.ts";

// A scanned page with three tagged groups: two referenced by words (seeded
// LOWER on the page first, to prove reading order re-sorts them), one
// untagged.
function seed(fx: Fixture): {page_id: number, layer_id: number,
                             topGroup: number, bottomGroup: number, orphanGroup: number} {
    const document_id = db().insert<any, 'document_id'>('scanned_document',
        {friendly_document_id: 'TST', title: 'Test Doc'}, 'document_id');
    const page_id = db().insert<any, 'page_id'>('scanned_page',
        {document_id, page_number: 1, image_ref: 'content/x.jpg',
         width: 1000, height: 1000, description: ''}, 'page_id');
    const layer_id = db().insert<any, 'layer_id'>('layer',
        {document_id, layer_name: 'Tagging', is_reference_layer: 0}, 'layer_id');
    const mkGroup = (y: number) => {
        const g = db().insert<any, 'bounding_group_id'>('bounding_group',
            {document_id, layer_id, color: 'red'}, 'bounding_group_id');
        db().insert<any, 'bounding_box_id'>('bounding_box',
            {bounding_group_id: g, document_id, layer_id, page_id,
             x: 100, y, w: 200, h: 50}, 'bounding_box_id');
        return g;
    };
    const bottomGroup = mkGroup(800);   // created first, sits LOWER
    const topGroup = mkGroup(100);
    const orphanGroup = mkGroup(500);   // tagged, but no word references it

    const tl = new TestTimeline();
    const mkWord = (base: number, spelling: string, groupId: number) => {
        const e = mkEntry(base, tl.next());
        fx.ww.applyTransaction([e], {quiet: true});
        fx.ww.applyTransaction([mkChild(e, 'spl', base+10, tl.next(),
            {attr1: spelling, variant: 'mm-li', order_key: '0.5'})], {quiet: true});
        const sub = mkChild(e, 'sub', base+20, tl.next());
        fx.ww.applyTransaction([sub], {quiet: true});
        fx.ww.applyTransaction([mkChild(sub, 'ref', base+30, tl.next(),
            {attr1: groupId, order_key: '0.5'})], {quiet: true});
    };
    mkWord(1000, 'alaqsite\'w', bottomGroup);
    mkWord(2000, 'samqwan', topGroup);
    bornApprove(fx.ww);
    return {page_id, layer_id, topGroup, bottomGroup, orphanGroup};
}

test("page word sidebar: reading order, data-group-ids, untagged tail", async () => {
    await withTestDb(async (fx: Fixture) => {
        const {page_id, layer_id, topGroup, bottomGroup, orphanGroup} = seed(fx);
        const html = renderToStringViaLinkeDOM(
            renderPageWordSidebarCore(fx.ww, page_id, layer_id));

        // Both words, with their group ids on the rows.
        assertStringIncludes(html, 'Words on this page (2)');
        assertStringIncludes(html, `data-group-ids="${topGroup}"`);
        assertStringIncludes(html, `data-group-ids="${bottomGroup}"`);
        assertStringIncludes(html, 'samqwan');
        assertStringIncludes(html, "alaqsite'w");

        // READING ORDER: the top-of-page word first, even though the
        // lower word was created first.
        assert(html.indexOf('samqwan') < html.indexOf("alaqsite'w"),
               'rows sorted by page position, not creation order');

        // The untagged tail: the orphan group, and only it.
        assertStringIncludes(html, 'Groups not yet linked to a word (1)');
        assertStringIncludes(html, `Group ${orphanGroup}`);

        // Rows carry the hover-sync hooks.
        assertStringIncludes(html, 'pageWordRowEnter(event)');
        assertStringIncludes(html, 'togglePageWordSidebar()');

        // Each untagged group has a delete × (dz), and the section header
        // has a bulk delete-all ×.
        assertStringIncludes(html, `deletePageGroup(${orphanGroup})`);
        assertStringIncludes(html, 'deleteAllUnlinkedPageGroups()');
    });
});

test("deleteUnlinkedGroupsForPage: deletes only the unlinked groups", async () => {
    await withTestDb(async (fx: Fixture) => {
        const {page_id, layer_id, topGroup, bottomGroup, orphanGroup} = seed(fx);
        const r = as(fx, 'djz', () => deleteUnlinkedGroupsForPage(page_id, layer_id));
        assertEquals(r.deleted, 1);   // just the one orphan
        assert(db().all<any, any>(
            'SELECT 1 FROM bounding_group WHERE bounding_group_id = :g', {g: orphanGroup}).length === 0,
            'orphan deleted');
        // The word-linked groups survive.
        for(const g of [topGroup, bottomGroup])
            assert(db().all<any, any>(
                'SELECT 1 FROM bounding_group WHERE bounding_group_id = :g', {g}).length === 1,
                'linked group survives');
    });
});

test("deleteBoundingGroup: removes an orphaned group; refuses a word-linked one", async () => {
    await withTestDb(async (fx: Fixture) => {
        const {orphanGroup, topGroup} = seed(fx);
        // The orphan (no word references it) deletes cleanly.
        as(fx, 'djz', () => deleteBoundingGroup(orphanGroup));
        assert(db().all<any, any>(
            'SELECT 1 FROM bounding_group WHERE bounding_group_id = :g', {g: orphanGroup}).length === 0,
            'orphan group row deleted');
        assert(db().all<any, any>(
            'SELECT 1 FROM bounding_box WHERE bounding_group_id = :g', {g: orphanGroup}).length === 0,
            'its boxes deleted');
        // A word-linked group is refused (topGroup is referenced by 'samqwan').
        let threw = false;
        try { as(fx, 'djz', () => deleteBoundingGroup(topGroup)); } catch { threw = true; }
        assert(threw, 'refuses a group a word still references');
        assert(db().all<any, any>(
            'SELECT 1 FROM bounding_group WHERE bounding_group_id = :g', {g: topGroup}).length === 1,
            'linked group survives');
    });
});
