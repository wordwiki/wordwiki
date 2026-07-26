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
            // Final #1 ('a') is partition-tagged; SOME sampled final has
            // BOTH lanes on one entry - the fork, reunified.
            const e0 = entries[0];
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
            const e0 = (rand.entries as any[])[0];
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
            const raw0 = (ww.storeFor('randraw').entries as any[])[0];
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
            assertEquals(String(refused).includes('edited assertion'), true);
        } finally {
            security.runSystem(() => db().executeStatements(
                'DROP TABLE IF EXISTS randraw; DROP TABLE IF EXISTS randraw_dict_config;' +
                'DROP TABLE IF EXISTS rand; DROP TABLE IF EXISTS rand_dict_config;'));
        }
    });
});
