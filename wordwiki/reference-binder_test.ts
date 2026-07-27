// deno-lint-ignore-file no-explicit-any
/**
 * The reference binder (reference-binder.ts) WITHOUT an LLM: the page
 * input assembly (citation-relation probe, candidates, box ordering), the
 * landing (sheet group + copied boxes + '~<dict>-binder'-authored ref),
 * idempotence (hand tags / earlier runs win), thresholds, and the dry run
 * writing nothing.  The extractor is injected - the real Opus stage rides
 * the memoized extract.ts substrate and is exercised by the CLI.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import { db } from "../liminal/db.ts";
import * as security from "../liminal/security.ts";
import * as dictionaryConfig from "./dictionary-config.ts";
import * as scannedDocument from "./scanned-document.ts";
import * as binder from "./reference-binder.ts";
import { assertionPathToFields } from "./assertion.ts";
import { withTestDb, type Fixture } from "./testing.ts";

const EOT = 9007199254740991;

function seed(fx: Fixture) {
    const {ww} = fx;
    dictionaryConfig.createDictionary('bndt', {
        $type: 'schema', $name: 'b', $tag: 'tbnd',
        entry: {$type: 'relation', $tag: 'ent', entry_id: {$type: 'primary_key'},
            spelling: {$type: 'relation', $tag: 'spl',
                $style: {$view: {titleRole: 'headword'}},
                spelling_id: {$type: 'primary_key'},
                text: {$type: 'string', $bind: 'attr1'},
                variant: {$type: 'variant', $bind: 'variant'}},
            gloss: {$type: 'relation', $tag: 'gls',
                $style: {$view: {titleRole: 'gloss'}},
                gloss_id: {$type: 'primary_key'},
                gloss: {$type: 'string', $bind: 'attr1'}},
            example_text: {$type: 'relation', $tag: 'etx',
                example_text_id: {$type: 'primary_key'},
                example_text: {$type: 'string', $bind: 'attr1'},
                variant: {$type: 'variant', $bind: 'variant', $mixed: true,
                          $sourceOrthography: true}},
            example_translation: {$type: 'relation', $tag: 'etr',
                example_translation_id: {$type: 'primary_key'},
                example_translation: {$type: 'string', $bind: 'attr1'}},
            source: {$type: 'relation', $tag: 'src',
                source_id: {$type: 'primary_key'},
                source: {$type: 'string', $bind: 'attr1'},
                book: {$type: 'string', $bind: 'attr2', $optional: true},
                page: {$type: 'integer', $bind: 'attr3', $optional: true}},
            document_reference: {$type: 'relation', $tag: 'ref',
                $role: 'documentReference',
                document_reference_id: {$type: 'primary_key'},
                bounding_group_id: {$type: 'integer', $bind: 'attr1',
                                    $style: {$shape: 'boundingGroup'}}}},
    }, {slug: 'bndt'});

    // Entries: e1 cites p.7; e2 cites p.7 and p.9.
    let t = 5000, id = 100;
    const rows: any[] = [];
    const mk = (path: [string, number][], ty: string, extra: any = {}) => {
        const fid = path[path.length - 1][1];
        rows.push({...assertionPathToFields(path), assertion_id: fid, id: fid, ty,
                   valid_from: t++, valid_to: EOT, order_key: `k${fid}`,
                   change_by_username: 'test', ...extra});
    };
    const entry = (spelling: string, gloss: string, pages: number[],
                   sourceSpelling?: string, english?: string) => {
        const e = ++id;
        mk([['tbnd', 0], ['ent', e]], 'ent');
        mk([['tbnd', 0], ['ent', e], ['spl', ++id]], 'spl',
           {attr1: spelling, variant: 'mm-li'});
        mk([['tbnd', 0], ['ent', e], ['gls', ++id]], 'gls', {attr1: gloss});
        if(sourceSpelling !== undefined)
            mk([['tbnd', 0], ['ent', e], ['etx', ++id]], 'etx',
               {attr1: sourceSpelling, variant: 'trand'});
        if(english !== undefined)
            mk([['tbnd', 0], ['ent', e], ['etr', ++id]], 'etr', {attr1: english});
        for(const p of pages)
            mk([['tbnd', 0], ['ent', e], ['src', ++id]], 'src',
               {attr1: `Test 1888, p ${p}`, attr2: 'Test 1888', attr3: p});
        return e;
    };
    const e1 = entry('abate\'w', 'to abate', [7], 'abatew', 'abate somewhat');
    const e2 = entry('abed\'i', 'abed', [7, 9]);
    entry('zzz', 'elsewhere', [9]);
    for(const r of rows) db().insert('bndt', r, 'assertion_id');

    // The scanned book: one page with printed number 7, three Text lines.
    const document_id = db().insert<any, 'document_id'>('scanned_document',
        {friendly_document_id: 'BND', title: 'Test Book 1888'}, 'document_id');
    const page_id = db().insert<any, 'page_id'>('scanned_page',
        {document_id, page_number: 3, printed_page_number: 7,
         image_ref: 'content/x.jpg', width: 1000, height: 1000, description: ''}, 'page_id');
    const textLayer = scannedDocument.getOrCreateNamedLayer(document_id, 'Text', 1);
    const box = (y: number, text: string, w = 500) => db().insert<any, 'bounding_box_id'>(
        'bounding_box', {document_id, layer_id: textLayer, page_id,
                         x: 100, y, w, h: 40, text}, 'bounding_box_id');
    // b1 is TRUNCATED (the OCR missed the line's accented tail): 200px wide
    // in a column whose right edge is 600 (the other boxes).
    const b1 = box(100, 'To abate,', 200);
    const b2 = box(150, 'continuation line.');
    const b3 = box(200, 'Something else.');
    return {ww, e1, e2, document_id, page_id, b1, b2, b3};
}

test("binder: input assembly, landing on the sheet, idempotence, thresholds, dry run", async () => {
    await withTestDb(async (fx) => {
        await security.runSystem(async () => {
            const {ww, e1, e2, document_id, page_id, b1, b2, b3} = seed(fx);
            try {
                const store = ww.storeFor('bndt');
                const doc = scannedDocument.selectScannedDocumentByFriendlyId()
                    .required({friendly_document_id: 'BND'});

                // INPUT: printed p.7 resolves the scan page; candidates are
                // the two entries citing it, with full cited-page lists.
                const input = binder.pageBinderInput(store, doc, 'Test 1888', 7,
                                                      {sourceLane: 'trand'})!;
                assertEquals([input.page_id, input.boxes.length], [page_id, 3]);
                assertEquals(input.candidates.map(c => [c.entry_id, c.cited_pages]),
                             [[e1, [7]], [e2, [7, 9]]]);
                assertEquals(input.candidates[0].headwords, [{text: "abate'w", lane: 'mm-li'}]);
                assertEquals(input.candidates[0].glosses, ['to abate']);
                // The v2 PRIMARY keys: the book's own text, round-tripping.
                assertEquals(input.candidates[0].english, ['abate somewhat']);
                assertEquals(input.candidates[0].source_spelling, ['abatew']);
                assertEquals(input.candidates[1].english, []);
                assertEquals(input.candidates[1].source_spelling, []);
                assertEquals(binder.pageBinderInput(store, doc, 'Test 1888', 99), undefined);

                // The fake extraction: e1 on lines b1+b2 (high), e2 not
                // found (a p.9 dweller), b3 unclaimed.
                const extraction: binder.BinderExtraction = {
                    bindings: [{entry_id: e1, box_ids: [b1, b2],
                                extend_box_ids: [b1],       // truncated: widen
                                confidence: 'high'},
                               {entry_id: e2, box_ids: [b3], confidence: 'low'}],
                    unmatched_entries: [],
                    unclaimed_regions: ['Something else.'],
                };
                const opts = (apply: boolean) => ({
                    book: 'BND', dictionary: 'bndt', citedBook: 'Test 1888',
                    printedPages: [7], apply, minConfidence: 'medium' as const,
                    sourceLane: 'trand',
                    extract: () => Promise.resolve(extraction), log: () => {}});

                // DRY RUN: proposals reported, NOTHING written.
                const dry = await binder.bindPages(ww, opts(false));
                assertEquals(dry[0].bound.map(b => b.entry_id), [e1]);
                assertEquals(dry[0].bound[0].boxTexts,
                             ['To abate,', 'continuation line.']);
                // The truncated box's rect widens to the column edge (600).
                assertEquals(dry[0].bound[0].rects.map(x => [x.id, x.w, x.extended]),
                             [[b1, 500, true], [b2, 500, false]]);
                assertEquals(dry[0].belowThreshold.map(b => [b.entry_id, b.confidence]),
                             [[e2, 'low']]);
                assertEquals(db().all<any, any>(
                    `SELECT 1 FROM bndt WHERE ty='ref'`, {}).length, 0);

                // APPLY: a group on the DICTIONARY'S SHEET, boxes copied
                // (imported_from preserved), the ref authored by the binder.
                const applied = await binder.bindPages(ww, opts(true));
                assertEquals(applied[0].bound.map(b => b.entry_id), [e1]);
                const sheet = scannedDocument.selectLayerByLayerName().required(
                    {document_id, layer_name: 'Tagging:bndt'});
                assertEquals(sheet.dictionary, 'bndt');
                const groups = db().all<any, any>(
                    `SELECT bounding_group_id FROM bounding_group WHERE layer_id=:l`,
                    {l: sheet.layer_id});
                assertEquals(groups.length, 1);
                const copied = db().all<any, any>(
                    `SELECT imported_from_bounding_box_id AS src, w FROM bounding_box ` +
                    `WHERE bounding_group_id=:g ORDER BY src`, {g: groups[0].bounding_group_id});
                assertEquals(copied.map((c: any) => c.src), [b1, b2]);
                // The COPY of the truncated box landed widened; the Text-layer
                // original is untouched.
                assertEquals(copied.map((c: any) => c.w), [500, 500]);
                assertEquals(db().all<any, any>(
                    `SELECT w FROM bounding_box WHERE bounding_box_id=:b`, {b: b1})[0].w, 200);
                const ref = db().all<any, any>(
                    `SELECT id1, attr1, change_by_username FROM bndt WHERE ty='ref'`, {});
                assertEquals(ref.length, 1);
                assertEquals([ref[0].id1, ref[0].attr1, ref[0].change_by_username],
                             [e1, groups[0].bounding_group_id, '~bndt-binder']);

                // IDEMPOTENT: a re-run tops up, never re-binds (hand tags
                // and earlier runs win).
                const again = await binder.bindPages(ww, opts(true));
                assertEquals(again[0].bound, []);
                assertEquals(again[0].alreadyReferenced, [e1]);
                assertEquals(db().all<any, any>(
                    `SELECT 1 FROM bndt WHERE ty='ref'`, {}).length, 1);

                // The report reads like the worklist it is.
                const md = binder.bindReportMarkdown(
                    {book: 'BND', dictionary: 'bndt', citedBook: 'Test 1888', apply: true},
                    applied);
                assert(md.includes("**abate'w**"), 'bound entry in report');
                assert(md.includes('unclaimed region: Something else.'), 'unclaimed listed');
            } finally {
                db().executeStatements(
                    'DROP TABLE IF EXISTS bndt; DROP TABLE IF EXISTS bndt_dict_config;');
            }
        });
    });
});
