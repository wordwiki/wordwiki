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
import * as security from "../liminal/security.ts";
import * as dictionaryConfig from "./dictionary-config.ts";
import * as scannedDocument from "./scanned-document.ts";

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

test("sheets: per-dictionary tagging layers stay disjoint; create/attach land in the sheet's dictionary", async () => {
    await withTestDb(async (fx: Fixture) => {
        const {page_id, layer_id: mmoLayer, orphanGroup} = seed(fx);
        const document_id = db().all<any, any>(
            `SELECT document_id FROM scanned_page WHERE page_id=:p`, {p: page_id})[0].document_id;
        try {
            // The seed's 'Tagging' layer predates the sheets column: the
            // startup stamping attributes it to the default dictionary.
            security.runSystem(() => scannedDocument.ensureLayerColumns());
            assertEquals(db().all<any, any>(
                `SELECT dictionary FROM layer WHERE layer_id=:l`, {l: mmoLayer})[0].dictionary,
                'dict');

            // A second dictionary (documentReference at the entry root)
            // gets its OWN clean sheet on the same book.
            security.runSystem(() => dictionaryConfig.createDictionary('shtgt', {
                $type: 'schema', $name: 's', $tag: 'tsht',
                entry: {$type: 'relation', $tag: 'ent',
                        entry_id: {$type: 'primary_key'},
                        document_reference: {$type: 'relation', $tag: 'ref',
                            $role: 'documentReference',
                            document_reference_id: {$type: 'primary_key'},
                            bounding_group_id: {$type: 'integer', $bind: 'attr1',
                                                $style: {$shape: 'boundingGroup'}}}},
            }, {slug: 'shtgt'}));
            const sheet = scannedDocument.getOrCreateTaggingSheet(document_id, 'shtgt');
            assert(sheet !== mmoLayer, 'a fresh sheet, not the MMO layer');
            const mkGroup = (y: number) => {
                const g = db().insert<any, 'bounding_group_id'>('bounding_group',
                    {document_id, layer_id: sheet, color: 'red'}, 'bounding_group_id');
                db().insert<any, 'bounding_box_id'>('bounding_box',
                    {bounding_group_id: g, document_id, layer_id: sheet, page_id,
                     x: 100, y, w: 200, h: 50}, 'bounding_box_id');
                return g;
            };
            const g1 = mkGroup(200), g2 = mkGroup(400);

            // DISJOINT: MMO's sidebar sees its own words + its own orphan,
            // none of the new sheet's groups; the new sheet starts clean.
            const mmoHtml = renderToStringViaLinkeDOM(
                renderPageWordSidebarCore(fx.ww, page_id, mmoLayer));
            assertStringIncludes(mmoHtml, 'Words on this page (2)');
            assertStringIncludes(mmoHtml, 'Groups not yet linked to a word (1)');
            assert(!mmoHtml.includes(`data-group-ids="${g1}"`), 'MMO sheet omits the other sheet');
            const freshHtml = renderToStringViaLinkeDOM(
                renderPageWordSidebarCore(fx.ww, page_id, sheet));
            assertStringIncludes(freshHtml, 'Words on this page (0)');
            assertStringIncludes(freshHtml, 'Groups not yet linked to a word (2)');
            assert(!freshHtml.includes('samqwan'), 'clean sheet shows no MMO words');

            // CREATE lands in the sheet's dictionary, edit URL included.
            const r = as(fx, 'djz', () => fx.ww.newLexemeFromGroup(g1));
            assertStringIncludes(r.editUrl, `wordwiki.dicts.shtgt.lexeme.metaEditPage(${r.entry_id})`);
            const e = fx.ww.storeFor('shtgt').entriesById.get(r.entry_id) as any;
            assertEquals(e.document_reference.map((x: any) => x.bounding_group_id), [g1]);

            // ATTACH the second group to the same word via the group's sheet.
            as(fx, 'djz', () => fx.ww.addReferenceFromGroup(r.entry_id, g2));
            const e2 = fx.ww.storeFor('shtgt').entriesById.get(r.entry_id) as any;
            assertEquals(e2.document_reference.map((x: any) => x.bounding_group_id), [g1, g2]);

            // The sheet's sidebar now shows the word (facade link), and the
            // MMO sidebar is unchanged.
            const after = renderToStringViaLinkeDOM(
                renderPageWordSidebarCore(fx.ww, page_id, sheet));
            assertStringIncludes(after, 'Words on this page (1)');
            assertStringIncludes(after, `wordwiki.dicts.shtgt.word(${r.entry_id})`);
            assertStringIncludes(renderToStringViaLinkeDOM(
                renderPageWordSidebarCore(fx.ww, page_id, mmoLayer)),
                'Words on this page (2)');

            // The delete guard sees references from EVERY dictionary.
            let threw = false;
            try { as(fx, 'djz', () => deleteBoundingGroup(g1)); } catch { threw = true; }
            assert(threw, 'a shtgt-referenced group refuses deletion');
            // ... and the untouched MMO orphan still deletes cleanly.
            as(fx, 'djz', () => deleteBoundingGroup(orphanGroup));
        } finally {
            security.runSystem(() => db().executeStatements(
                'DROP TABLE IF EXISTS shtgt; DROP TABLE IF EXISTS shtgt_dict_config;'));
        }
    });
});

test("createLexemeFromGroup: makes entry+subentry+reference; group leaves the untagged tail", async () => {
    await withTestDb(async (fx: Fixture) => {
        const {page_id, layer_id, orphanGroup} = seed(fx);
        // Before: the orphan is in the untagged tail.
        assertStringIncludes(
            renderToStringViaLinkeDOM(renderPageWordSidebarCore(fx.ww, page_id, layer_id)),
            'Groups not yet linked to a word (1)');

        const {entry_id} = as(fx, 'djz', () => fx.ww.lexemeOps.createLexemeFromGroup(orphanGroup));
        const e = fx.ww.entriesById.get(entry_id);
        assert(e, 'new entry exists');
        assert(e!.subentry.flatMap(s => s.document_reference)
                 .some(r => r.bounding_group_id === orphanGroup),
               'a document_reference points at the group');

        // After: the group is now word-linked - gone from the untagged tail,
        // present as a word row.
        const after = renderToStringViaLinkeDOM(
            renderPageWordSidebarCore(fx.ww, page_id, layer_id));
        assert(!after.includes('Groups not yet linked to a word'),
               'no more untagged groups');
        assertStringIncludes(after, `data-group-ids="${orphanGroup}"`);
    });
});
