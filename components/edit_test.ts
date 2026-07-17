// Edit dispatch: the injected permission policy, the block mutations
// (add/edit/move/delete), and the editing-view affordances.
import { test } from "../liminal/testing/test.ts";
import { assertEquals, assert, assertThrows } from "../liminal/testing/assert.ts";
import { openTestDb, clearAllData } from "../liminal/testing/db-harness.ts";
import * as security from "../liminal/security.ts";
import { setSerialized } from "../liminal/serializable.ts";
import { find, findAll, hasClass, testIdOf } from "../liminal/testing/markup-assert.ts";
import { SiteTable, PageTable, BlockTable, siteEditorTables } from "./site.ts";
import { blockKind, readPayload } from "./block-registry.ts";
import { SiteView } from "./site-view.ts";

const site = setSerialized(new SiteTable(), 'site');
const page = setSerialized(new PageTable(), 'page');
const blk = setSerialized(new BlockTable(), 'block');

// A view whose injected policy grants edit (the app's role check stands in here).
class EditableView extends SiteView {
    protected override canEditSite(_site_id: number): boolean { return true; }
}
const editable = setSerialized(new EditableView(site, page, blk), 'siteView');
const denied = setSerialized(new SiteView(site, page, blk), 'siteView');   // default policy: deny

function freshPage(): number {
    openTestDb(siteEditorTables);
    clearAllData(siteEditorTables);
    return security.runSystem(() => {
        const s = site.insert({site_title: 'S'});
        return page.insert({site_id: s, page_title: 'P'});
    });
}
function blocksOf(page_id: number) {
    return security.runSystem(() => blk.forPage.all({page_id}));
}

test("default policy denies every mutation; injected policy allows", () => {
    const p = freshPage();
    security.runSystem(() => {
        assertThrows(() => denied.addBlock(p, 'divider'), Error, 'Not permitted');
        assertEquals(blocksOf(p).length, 0);
        editable.addBlock(p, 'divider');
        assertEquals(blocksOf(p).length, 1);
    });
});

test("addBlock creates a default payload and reloads the page shape", () => {
    const p = freshPage();
    security.runSystem(() => {
        const res = editable.addBlock(p, 'title') as any;
        assertEquals(res.targets, ['.' + blk.pageShapeKey(p)]);
        const b = blocksOf(p)[0];
        assertEquals(b.kind, 'title');
        // Default payload from the kind's schema (level defaults to h2).
        assertEquals(readPayload(blockKind('title')!, b.payload), {level: 'h2', text: ''});
    });
});

test("editBlockPayload writes the posted form state and reloads the block row", () => {
    const p = freshPage();
    security.runSystem(() => {
        editable.addBlock(p, 'title');
        const id = blocksOf(p)[0].block_id;
        const res = editable.editBlockPayload({block_id: id, level: 'h1', text: 'Changed'}) as any;
        assertEquals(res.targets, ['.' + blk.rowKey(id)]);
        assertEquals(readPayload(blockKind('title')!, blk.getById(id).payload), {level: 'h1', text: 'Changed'});
    });
});

test("moveBlockUp / moveBlockDown reorder the flat flow", () => {
    const p = freshPage();
    security.runSystem(() => {
        editable.addBlock(p, 'divider');
        editable.addBlock(p, 'title');
        const [first, second] = blocksOf(p);
        assertEquals([first.kind, second.kind], ['divider', 'title']);
        editable.moveBlockUp(second.block_id);
        assertEquals(blocksOf(p).map(b => b.kind), ['title', 'divider']);
        editable.moveBlockDown(second.block_id);
        assertEquals(blocksOf(p).map(b => b.kind), ['divider', 'title']);
    });
});

test("deleteBlock removes it", () => {
    const p = freshPage();
    security.runSystem(() => {
        editable.addBlock(p, 'divider');
        const id = blocksOf(p)[0].block_id;
        editable.deleteBlock(id);
        assertEquals(blocksOf(p).length, 0);
    });
});

test("editing render adds per-block controls + an add-block menu; output view has neither", () => {
    const p = freshPage();
    const m = security.runSystem(() => {
        editable.addBlock(p, 'title');
        return editable.renderPage(p, true);
    });
    assert(find(m, n => hasClass(n, 'site-page-editing')));
    assert(find(m, n => hasClass(n, 'site-block-edit')));
    assert(findAll(m, n => testIdOf(n)?.startsWith('block-') ?? false).length === 1);
    // The read/output view carries no edit affordances.
    const out = security.runSystem(() => editable.renderPage(p, false));
    assertEquals(findAll(out, n => hasClass(n, 'site-block-edit')).length, 0);
    assertEquals(findAll(out, n => hasClass(n, 'site-page-editing')).length, 0);
});
