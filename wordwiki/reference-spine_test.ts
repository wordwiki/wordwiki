// deno-lint-ignore-file no-explicit-any
/**
 * The REF SPINE generalization (rand-references-design.md §3.2): the
 * documentReference role's planting point is SCHEMA DATA - MMO plants it
 * under subentry (spine length 1), rand directly under the entry root
 * (spine length 0) - and createLexemeFromGroup / addReferenceToEntry
 * synthesize/reuse whatever chain the schema declares.  (The MMO
 * create-from-group regression lives in page-word-sidebar_test.ts.)
 */
import { test } from "../liminal/testing/test.ts";
import { assertEquals } from "../liminal/testing/assert.ts";
import { db } from "../liminal/db.ts";
import * as security from "../liminal/security.ts";
import * as dictionaryConfig from "./dictionary-config.ts";
import { editorAppFor } from "./dictionary-pages.ts";
import { withTestDb, as, renderRoute } from "./testing.ts";

test("ref spine 0: create + attach plant document_reference at the entry root", async () => {
    await withTestDb(async (fx) => {
        const {ww} = fx;
        try {
            security.runSystem(() => {
                dictionaryConfig.createDictionary('spinetgt', {
                    $type: 'schema', $name: 's', $tag: 'tspn',
                    entry: {$type: 'relation', $tag: 'ent',
                            entry_id: {$type: 'primary_key'},
                            document_reference: {$type: 'relation', $tag: 'ref',
                                $role: 'documentReference',
                                document_reference_id: {$type: 'primary_key'},
                                bounding_group_id: {$type: 'integer', $bind: 'attr1',
                                                    $style: {$shape: 'boundingGroup'}}}},
                }, {slug: 'spinetgt'});
            });
            const store = ww.storeFor('spinetgt');
            const ops = editorAppFor(ww, store).lexemeOps;

            // CREATE: entry + ref, NO intermediate tuple (spine length 0).
            const {entry_id} = as(fx, 'djz', () => ops.createLexemeFromGroup(4242));
            const rows = security.runSystem(() => db().all<any, any>(
                `SELECT ty, id1, id2, attr1 FROM spinetgt ORDER BY valid_from`, {}));
            assertEquals(rows.length, 2);
            assertEquals(rows.map((r: any) => r.ty), ['ent', 'ref']);
            assertEquals(rows[1].id1, entry_id);      // ref directly under entry
            assertEquals(rows[1].attr1, 4242);

            // ATTACH to the same (existing) entry: one more ref fact, still
            // at the entry root, appended after the first.
            const {fact_id} = as(fx, 'djz', () => ops.addReferenceToEntry(entry_id, 5555));
            const e = store.entriesById.get(entry_id) as any;
            assertEquals(e.document_reference.map((r: any) => r.bounding_group_id),
                         [4242, 5555]);
            assertEquals(e.document_reference[1].document_reference_id, fact_id);

            // The facade word page renders the references (§3.5): these
            // group ids point at no real scan, so renderStandaloneGroup's
            // 'Empty Group' marker shows - the page itself must not crash.
            const word = JSON.stringify(await as(fx, 'djz',
                () => renderRoute(ww, `wordwiki.dicts.spinetgt.word(${entry_id})`)));
            assertEquals(word.includes('lm-me-scan'), true);
            assertEquals(word.includes('Empty Group'), true);
        } finally {
            security.runSystem(() => db().executeStatements(
                'DROP TABLE IF EXISTS spinetgt; DROP TABLE IF EXISTS spinetgt_dict_config;'));
        }
    });
});

test("ref spine 1 (MMO): attach reuses the FIRST live subentry", async () => {
    await withTestDb(async (fx) => {
        const {ww} = fx;
        // A fresh word from a group: entry + synthesized subentry + ref.
        const {entry_id} = as(fx, 'djz', () => ww.lexemeOps.createLexemeFromGroup(777));
        const e1 = ww.entriesById.get(entry_id) as any;
        assertEquals(e1.subentry.length, 1);
        assertEquals(e1.subentry[0].document_reference.map((r: any) => r.bounding_group_id),
                     [777]);

        // Attach: the ref joins the SAME subentry - no second spine tuple.
        as(fx, 'djz', () => ww.lexemeOps.addReferenceToEntry(entry_id, 888));
        const e2 = ww.entriesById.get(entry_id) as any;
        assertEquals(e2.subentry.length, 1);
        assertEquals(e2.subentry[0].document_reference.map((r: any) => r.bounding_group_id),
                     [777, 888]);
    });
});
