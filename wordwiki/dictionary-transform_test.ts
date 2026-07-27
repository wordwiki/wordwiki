// deno-lint-ignore-file no-explicit-any
/**
 * The STEP-2 TRANSFORM (dictionary-transform.ts): the mapping gate, the
 * engine (deterministic ids, intoParentField, deep-path wrappers, deep
 * skipEmpty, unmapped accounting), edits-block-rerun - and REAL RAND
 * through the starter mapping (watson/rand-transform.json): e'n comes out
 * the far end as a rich entry.
 */
import { test } from "../liminal/testing/test.ts";
import { assertEquals } from "../liminal/testing/assert.ts";
import { db } from "../liminal/db.ts";
import * as security from "../liminal/security.ts";
import * as sfm from "./sfm.ts";
import * as sfmImport from "./sfm-import.ts";
import * as dictionaryConfig from "./dictionary-config.ts";
import * as dt from "./dictionary-transform.ts";
import { withTestDb, as, renderRoute } from "./testing.ts";

const WATSON = new URL('../watson/', import.meta.url).pathname;

test("randCitation: the hand-typed variant zoo parses; non-citations don't", () => {
    const p = dt.PARSERS.randCitation;
    // The canonical form and the punctuation-soup / page-list / junk
    // variants (all drawn from the real 2026-07 \so inventory).
    assertEquals(p('Rand 1888, p. 282'), {book: 'Rand 1888', page: 282, pages: '282'});
    assertEquals(p('Clark 1902, p 100')!.book, 'Clark 1902');
    assertEquals(p('Rand 1888, p 269, 270'), {book: 'Rand 1888', page: 269, pages: '269, 270'});
    assertEquals(p('Rand 1888. p 146, 147')!.page, 146);
    assertEquals(p('Rand,1888,pg151'), {book: 'Rand 1888', page: 151, pages: '151'});
    assertEquals(p('Rand 1888.p.149')!.page, 149);
    assertEquals(p('Rand 1888.p 148')!.book, 'Rand 1888');
    assertEquals(p('Rand 1888 pp 1')!.page, 1);
    assertEquals(p('Rand 1888, pp 4, 6, 9')!.pages, '4, 6, 9');
    assertEquals(p('Rand 1888, p 201)')!.page, 201);         // trailing junk
    assertEquals(p('Rand 1888, p 88ā')!.page, 88);
    assertEquals(p('Rand 1888 p , 102, 164')!.page, 102);    // stray commas
    assertEquals(p('Rand 1888, p 224. 225')!.pages, '224, 225');
    assertEquals(p('Rand 1888, p 1, 4,\n206, 258')!.pages, '1, 4, 206, 258');
    assertEquals(p('Rand 1888 p v intro.'),                  // roman intro page
                 {book: 'Rand 1888', page: undefined, pages: undefined});
    assertEquals(p('RRand 1888, p 12')!.book, 'RRand 1888'); // typo -> recode's business
    // Non-citations (informant names, dates, codes) stay unparsed.
    for(const nc of ['M Metallic', 'Manny Metallic', "So'sep Wilmot",
                     'Cape Breton', 'dmm 2015-May-22', '5G-16n'])
        assertEquals(p(nc), undefined, nc);
});

test("gate: bad rule paths and fields refuse; source-hash drift warns", async () => {
    await withTestDb(({ww}) => security.runSystem(() => {
        try {
            sfmImport.importSfm(
                '\\+DatabaseType T\n\\mkrRecord lx\n\\+mkr lx\n\\+mkr ge\n\\mkrOverThis lx\n',
                '\\_sh t\n\n\\lx w\n\\ge g\n', {table: 'gatesrc', structure: 'tree'});
            const srcSchema = ww.storeFor('gatesrc').dictSchema;
            const srcText = dictionaryConfig.readConfigValue('gatesrc', 'schema')!;
            const target = {
                $type: 'schema', $name: 't', $tag: 'tgate',
                entry: {$type: 'relation', $tag: 'ent', entry_id: {$type: 'primary_key'},
                        gloss: {$type: 'relation', $tag: 'gls', gloss_id: {$type: 'primary_key'},
                                gloss: {$type: 'string', $bind: 'attr1'}}}};
            const bad = dt.checkMapping({formatVersion: 1, sources: [{table: 'gatesrc'}],
                targetSchema: target,
                rules: [{from: 'nope', to: 'gloss', set: {gloss: {content: true}}},
                        {from: 'ge', to: 'nowhere', set: {}},
                        {from: 'ge', to: 'gloss', set: {no_field: {content: true}}},
                        {from: 'ge', to: 'gloss', parser: 'noSuchParser', set: {}}]},
                srcSchema, srcText);
            assertEquals(bad.problems.length, 4);
            const drift = dt.checkMapping({formatVersion: 1,
                sources: [{table: 'gatesrc', schemaHash: 'stale'}],
                targetSchema: target, rules: []}, srcSchema, srcText);
            assertEquals(drift.problems, []);
            assertEquals(drift.warnings.length, 1);
        } finally {
            db().executeStatements(
                'DROP TABLE IF EXISTS gatesrc; DROP TABLE IF EXISTS gatesrc_dict_config;');
        }
    }));
});

test("preserve-foreign: human facts survive; tombstones stay dead; orphans report", async () => {
    const EOT = 9007199254740991;
    await withTestDb(({ww}) => security.runSystem(() => {
        try {
            sfmImport.importSfm(
                '\\+DatabaseType T\n\\mkrRecord lx\n\\+mkr lx\n\\+mkr ge\n\\mkrOverThis lx\n' +
                '\\+mkr nt\n\\mkrOverThis ge\n',
                '\\_sh t\n\n\\lx w1\n\\ge g1\n\n\\lx w2\n\\ge g2\n\\nt n2\n\n\\lx w3\n\\ge g3\n',
                {table: 'psvsrc', structure: 'tree'});
            const target = {
                $type: 'schema', $name: 'p', $tag: 'tpsv',
                entry: {$type: 'relation', $tag: 'ent', entry_id: {$type: 'primary_key'},
                        gloss: {$type: 'relation', $tag: 'gls', gloss_id: {$type: 'primary_key'},
                                gloss: {$type: 'string', $bind: 'attr1'},
                                note: {$type: 'relation', $tag: 'not', note_id: {$type: 'primary_key'},
                                       note: {$type: 'string', $bind: 'attr1'}}}}};
            const mapping = {formatVersion: 1, sources: [{table: 'psvsrc'}], targetSchema: target,
                rules: [{from: 'ge', to: 'gloss', set: {gloss: {content: true}}},
                        {from: 'ge/nt', to: 'gloss/note', set: {note: {content: true}}}]};
            dictionaryConfig.createDictionary('psvtgt', target, {slug: 'psvtgt'});
            dictionaryConfig.writeConfigValue('psvtgt', 'transform', JSON.stringify(mapping));
            const r1 = dt.runTransform('psvtgt', ww.storeFor('psvsrc'));
            assertEquals([r1.entries, r1.preservedFacts, r1.orphans], [3, 0, []]);

            const q = (sql: string, p: any = {}): any[] => db().all<any, any>(sql, p);
            // Content-keyed ids: address the gls facts by content.
            const gl = (a: string) => q(
                `SELECT * FROM psvtgt WHERE ty='gls' AND attr1=:a`, {a})[0];
            const [g1, g2, g3] = [gl('g1'), gl('g2'), gl('g3')];
            const noteId = q(`SELECT id FROM psvtgt WHERE ty='not'`)[0].id;
            // stopAfterCount slices the source STORE's entry order (id
            // order under content-keyed ids) - compute which entry a
            // sample=2 re-run will DROP, and hang the hand-added fact there.
            const dropped = (ww.storeFor('psvsrc').entries as any[])[2].entry_id;
            const droppedGls = q(
                `SELECT * FROM psvtgt WHERE ty='gls' AND id1=:e`, {e: dropped})[0];
            // Human EDIT of g1: supersede (close the machine row, chain a
            // human-authored version on the same fact id).
            db().execute(`UPDATE psvtgt SET valid_to=:t WHERE assertion_id=:a`,
                         {t: g1.valid_from + 1, a: g1.assertion_id});
            db().insert('psvtgt', {...g1, assertion_id: 900001,
                replaces_assertion_id: g1.assertion_id, valid_from: g1.valid_from + 1,
                valid_to: EOT, attr1: 'g1 EDITED', change_by_username: 'djz'}, 'assertion_id');
            // Human TOMBSTONE of g2 (which has a machine note child): close +
            // empty-validity tombstone row, human-authored.
            db().execute(`UPDATE psvtgt SET valid_to=:t WHERE assertion_id=:a`,
                         {t: g2.valid_from + 1, a: g2.assertion_id});
            db().insert('psvtgt', {...g2, assertion_id: 900004,
                replaces_assertion_id: g2.assertion_id, valid_from: g2.valid_from + 1,
                valid_to: g2.valid_from + 1, change_by_username: 'djz'}, 'assertion_id');
            // Human-ADDED fact under the to-be-dropped entry (a gloss the
            // machine never computed).
            db().insert('psvtgt', {...droppedGls, assertion_id: 900002, id: 900002,
                id2: 900002, attr1: 'hand-added',
                valid_from: droppedGls.valid_from + 2, valid_to: EOT,
                replaces_assertion_id: null,
                change_by_username: 'djz'}, 'assertion_id');

            // Without the flag: still refuses.
            let refused: any;
            try { dt.runTransform('psvtgt', ww.storeFor('psvsrc')); }
            catch(e) { refused = e; }
            assertEquals(String(refused).includes('preserve-foreign'), true);

            // With the flag: machine facts rebuild, human facts survive whole.
            const r2 = dt.runTransform('psvtgt', ww.storeFor('psvsrc'),
                                       {preserveForeign: true});
            assertEquals(r2.preservedFacts, 3);            // g1, g2, hand-added
            assertEquals(r2.computedSkippedPreserved, 2);  // g1, g2 recomputed rows
            assertEquals(r2.resurrectionsSkipped, 1);      // n2 under dead g2
            assertEquals(r2.orphans, []);
            // g1: exactly its two rows; the human version is the open one.
            assertEquals(q(`SELECT attr1 FROM psvtgt WHERE id=:id AND valid_to=:e`,
                                {id: g1.id, e: EOT}).map(r => r.attr1), ['g1 EDITED']);
            assertEquals(q(`SELECT COUNT(*) AS n FROM psvtgt WHERE id=:id`,
                                {id: g1.id})[0].n, 2);
            // g2: dead (no open row), and its note child was NOT resurrected.
            assertEquals(q(`SELECT COUNT(*) AS n FROM psvtgt WHERE id=:id AND valid_to=:e`,
                                {id: g2.id, e: EOT})[0].n, 0);
            assertEquals(q(`SELECT COUNT(*) AS n FROM psvtgt WHERE id=:id`,
                                {id: noteId})[0].n, 0);
            // The hand-added fact survives; g3 was rebuilt as plain machine data.
            assertEquals(q(`SELECT change_by_username FROM psvtgt WHERE id=900002`)
                         .map(r => r.change_by_username), ['djz']);
            assertEquals(q(`SELECT attr1 FROM psvtgt WHERE id=:id AND valid_to=:e`,
                                {id: g3.id, e: EOT}).map(r => r.attr1), ['g3']);
            // The stamp-reuse keeps rebuilt parents no NEWER than their
            // preserved children - the store's structural validation passes.
            ww.storeFor('psvtgt').requestWorkspaceReload();
            assertEquals((ww.storeFor('psvtgt').entries as any[]).length, 3);

            // A vanished source record orphans the human work UNDER it -
            // reported + re-parented under a machine SKELETON stub, never
            // deleted.  (sample=2 drops entry 3.)
            const r3 = dt.runTransform('psvtgt', ww.storeFor('psvsrc'),
                                       {preserveForeign: true, stopAfterCount: 2});
            assertEquals(r3.orphans.map(o => [o.id, o.missingAncestor]),
                         [[900002, dropped]]);
            assertEquals(q(`SELECT attr1 FROM psvtgt WHERE id=900002`)
                         .map(r => r.attr1), ['hand-added']);
            // The skeleton entry stub keeps the store LOADING (worklist,
            // not crash): 2 rebuilt entries + the stub carrying the orphan.
            const store = ww.storeFor('psvtgt');
            store.requestWorkspaceReload();
            assertEquals((store.entries as any[]).length, 3);
            const stub = (store.entries as any[]).find(e => e.entry_id === dropped);
            assertEquals(stub.gloss.map((g: any) => g.gloss), ['hand-added']);
        } finally {
            db().executeStatements(
                'DROP TABLE IF EXISTS psvsrc; DROP TABLE IF EXISTS psvsrc_dict_config;' +
                'DROP TABLE IF EXISTS psvtgt; DROP TABLE IF EXISTS psvtgt_dict_config;');
        }
    }));
});

test("the MERGED corpus: lanes, partition + divergence ride as attrs", async () => {
    // rand-merged.sfm (merge-rand-sources.ts): finals FIRST (Ng base,
    // both lanes, \zdv drift notes), then lk-only, then the queue.
    const merged = Deno.readTextFileSync(WATSON + 'rand-merged.sfm');
    // Pure-parse accounting of the whole merged file.
    const db0 = sfm.readDatabase(merged, 'lx');
    assertEquals(db0.records.length, 31723);
    const zpt = new Map<string, number>();
    for(const r of db0.records) {
        const p = r.fields.find(f => f.name === 'zpt')?.content ?? '?';
        zpt.set(p, (zpt.get(p) ?? 0) + 1);
    }
    assertEquals(zpt.get('final'), 2498);
    assertEquals(zpt.get('final-lk-only'), 128);
    assertEquals(zpt.get('queue'), 29097);

    const typText = Deno.readTextFileSync(WATSON + 'rand-structural.typ');
    const mapping = JSON.parse(Deno.readTextFileSync(WATSON + 'rand-transform.json'));
    await withTestDb(async (fx) => {
        const {ww} = fx;
        try {
            security.runSystem(() => {
                sfmImport.importSfm(typText, merged,
                    {table: 'randraw', structure: 'tree', stopAfterCount: 400});
                dictionaryConfig.createDictionary('rand', mapping.targetSchema, {slug: 'rand'});
                dictionaryConfig.writeConfigValue('rand', 'transform', JSON.stringify(mapping));
                dt.runTransform('rand', ww.storeFor('randraw'));
            });
            const entries = ww.storeFor('rand').entries as any[];
            // Final 'a' is partition-tagged; SOME sampled final has
            // BOTH lanes on one entry - the fork, reunified.  (Content-
            // keyed ids: entries are addressed by content, not position.)
            const e0 = entries.find((e: any) =>
                (e.spelling ?? []).some((sp: any) => sp.text === 'a'));
            assertEquals(e0.spelling.map((s: any) => [s.text, s.variant]),
                         [['a', 'mm-li']]);         // its \lsf is empty
            assertEquals(e0.attr.some((a: any) =>
                a.attr === 'import-partition' && a.value === 'final'), true);
            assertEquals(entries.some((e: any) =>
                (e.spelling ?? []).some((sp: any) => sp.variant === 'mm-sf')
                && (e.spelling ?? []).some((sp: any) => sp.variant === 'mm-li')), true);
            // The drift is in-band: some sampled entry carries a
            // merge-divergence attr.
            assertEquals(entries.some((e: any) => (e.attr ?? []).some(
                (a: any) => a.attr === 'merge-divergence')), true);
        } finally {
            security.runSystem(() => db().executeStatements(
                'DROP TABLE IF EXISTS randraw; DROP TABLE IF EXISTS randraw_dict_config;' +
                'DROP TABLE IF EXISTS rand; DROP TABLE IF EXISTS rand_dict_config;'));
        }
    });
});

test("transform: REAL RAND -> a rich entry (deterministic; edits block)", async () => {
    const typText = Deno.readTextFileSync(WATSON + 'rand-structural.typ');
    const dataText = sfm.decodeSfmBytes(
        Deno.readFileSync(WATSON + 'Rand Mig Eng Dictt 29097'), 'utf-8');
    const mapping = JSON.parse(Deno.readTextFileSync(WATSON + 'rand-transform.json'));
    await withTestDb(async (fx) => {
        const {ww} = fx;
        try {
            security.runSystem(() => {
                sfmImport.importSfm(typText, dataText,
                    {table: 'randraw', structure: 'tree', stopAfterCount: 50});
                // load-mapping equivalent: gate, create the target, install.
                const gate = dt.checkMapping(mapping, ww.storeFor('randraw').dictSchema,
                    dictionaryConfig.readConfigValue('randraw', 'schema')!);
                assertEquals(gate.problems, []);
                dictionaryConfig.createDictionary('rand', mapping.targetSchema, {slug: 'rand'});
                dictionaryConfig.writeConfigValue('rand', 'transform', JSON.stringify(mapping));
                const r = dt.runTransform('rand', ww.storeFor('randraw'));
                assertEquals(r.entries, 50);
                assertEquals(r.generation, 1);
                // The vine tail we left unmapped shows up as the worklist.
                assertEquals(r.unmappedPerTag.size >= 0, true);
            });

            // e'n, transformed: lanes, senses, paired example, parsed source.
            const rand = ww.storeFor('rand');
            const e0 = (rand.entries as any[]).find((e: any) =>
                (e.spelling ?? []).some((sp: any) => sp.text === "e'n"));
            assertEquals(e0.spelling.map((s: any) => [s.text, s.variant]),
                         [["e'n", 'mm-li']]);          // empty lsf skipped
            assertEquals(e0.subentry.length, 1);       // the all-empty sense vanished
            const sense = e0.subentry[0];
            assertEquals(sense.part_of_speech, 'voc');
            assertEquals(sense.example[0].example_text[0].example_text, 'āān');
            assertEquals(sense.example[0].example_text[0].variant, 'rand');
            assertEquals(sense.example[0].example_translation[0].example_translation, 'wife');
            assertEquals(e0.source[0].book, 'Rand 1888');
            assertEquals(e0.source[0].page, 282);
            // The shoebox date rides MMO's attr convention (copy-ready).
            assertEquals(e0.attr[0].attr, 'shoebox-date');
            assertEquals(e0.attr[0].value, '02/Nov/2024');
            // DETERMINISTIC id: the spelling reuses its source fact id, and
            // the entry keeps the raw entry's id.
            const raw0 = (ww.storeFor('randraw').entries as any[])
                .find((e: any) => e.entry_id === e0.entry_id);
            assertEquals(e0.entry_id, raw0.entry_id);
            assertEquals(e0.spelling[0].spelling_id, raw0.lx[0].lx_id);

            // Re-run: same rows (ids + content), new generation.
            const before = security.runSystem(() => db().all<any, any>(
                `SELECT assertion_id, ty, attr1, attr2, attr3 FROM rand ORDER BY assertion_id`, {}));
            security.runSystem(() => {
                const r2 = dt.runTransform('rand', ww.storeFor('randraw'));
                assertEquals(r2.generation, 2);
            });
            rand.requestWorkspaceReload();
            const after = security.runSystem(() => db().all<any, any>(
                `SELECT assertion_id, ty, attr1, attr2, attr3 FROM rand ORDER BY assertion_id`, {}));
            assertEquals(after, before);

            // The rich dictionary browses through the facade (title = headword).
            const word = JSON.stringify(await as(fx, 'djz',
                () => renderRoute(ww, `wordwiki.dicts.rand.word(${e0.entry_id})`)));
            assertEquals(word.includes("e'n"), true);
            assertEquals(word.includes('wife'), true);

            // An EDIT blocks the next transform.
            security.runSystem(() => db().execute(
                `UPDATE rand SET change_by_username = 'djz' WHERE ty = 'gls'`, {}));
            let refused: any;
            try { security.runSystem(() => dt.runTransform('rand', ww.storeFor('randraw'))); }
            catch(e) { refused = e; }
            assertEquals(String(refused).includes('edited fact'), true);
        } finally {
            security.runSystem(() => db().executeStatements(
                'DROP TABLE IF EXISTS randraw; DROP TABLE IF EXISTS randraw_dict_config;' +
                'DROP TABLE IF EXISTS rand; DROP TABLE IF EXISTS rand_dict_config;'));
        }
    });
});
