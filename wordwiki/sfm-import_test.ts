// deno-lint-ignore-file no-explicit-any
/**
 * SFM import step 1 (sfm-import.ts): the .typ-pure schema derivation
 * (both structure modes + the tree-mode depth refusal), the deterministic
 * literal load, the re-import rules (wipe an unedited mirror; refuse an
 * edited one), and a REAL-RAND sample imported and browsed through the
 * facade.
 */
import { test } from "../liminal/testing/test.ts";
import { assertEquals, assertThrows } from "../liminal/testing/assert.ts";
import { db } from "../liminal/db.ts";
import * as security from "../liminal/security.ts";
import * as sfm from "./sfm.ts";
import * as sfmImport from "./sfm-import.ts";
import * as dictionaryConfig from "./dictionary-config.ts";
import { withTestDb, as, renderRoute } from "./testing.ts";

// A STRUCTURAL toy .typ (a real tree, shallow) and a VINE toy (the
// Watson-drop shape: markers chained in record-template order).
const STRUCTURAL_TYP = [
    '\\+DatabaseType Toy\n\\mkrRecord lx\n',
    '\\+mkr lx\n\\nam Lexeme\n',
    '\\+mkr ps\n\\nam Part of speech\n\\mkrOverThis lx\n',
    '\\+mkr ge\n\\mkrOverThis ps\n',
    '\\+mkr 1d\n\\mkrOverThis lx\n',
].join('\n');
const VINE_TYP = [
    '\\+DatabaseType Vine\n\\mkrRecord lx\n',
    '\\+mkr lx\n',
    '\\+mkr a\n\\mkrOverThis lx\n',
    '\\+mkr b\n\\mkrOverThis a\n',
    '\\+mkr c\n\\mkrOverThis b\n',
    '\\+mkr d\n\\mkrOverThis c\n',
    '\\+mkr e\n\\mkrOverThis d\n',   // depth 5 -> relation depth 6: over capacity
].join('\n');

test("derivation: structural tree mode - nesting, prompts, 1d, stability", () => {
    const typ = sfm.parseTyp(STRUCTURAL_TYP);
    const d = sfmImport.typToSchemaJson(typ, {name: 'toyraw', structure: 'tree'});
    assertEquals(d.problems, []);
    const entry = d.schemaJson.entry;
    assertEquals(entry.$tag, 'rec');
    assertEquals(entry.lx.$style.$view.titleRole, 'headword');   // the content child
    assertEquals(entry.ps.$prompt, 'Part of speech');            // \nam
    assertEquals(entry.ps.ge.$tag, 'ge');                        // nested per .typ
    assertEquals(entry.__1d.$tag, '1d');                         // digit-initial marker
    // Stability: a pure function of the .typ.
    assertEquals(JSON.stringify(d.schemaJson),
        JSON.stringify(sfmImport.typToSchemaJson(typ, {name: 'toyraw', structure: 'tree'}).schemaJson));
});

test("derivation: tree mode REFUSES an over-deep vine, naming the markers", () => {
    const typ = sfm.parseTyp(VINE_TYP);
    const d = sfmImport.typToSchemaJson(typ, {name: 'vineraw', structure: 'tree'});
    assertEquals(d.schemaJson, undefined);
    assertEquals(d.problems.length, 1);
    assertEquals(d.problems[0].includes('e'), true);
    assertEquals(d.problems[0].includes('flat'), true);
    // ...and flat mode takes the same .typ without complaint.
    const flat = sfmImport.typToSchemaJson(typ, {name: 'vineraw', structure: 'flat'});
    assertEquals(flat.problems, []);
    assertEquals(flat.schemaJson.entry.e.$tag, 'e');   // direct child at depth 2
});

const STRUCTURAL_DATA =
    '\\_sh v3.0\n\n' +
    '\\lx alpha\n\\ps n\n\\ge first\n\\ge second\n\\1d dual\n\n' +
    '\\lx beta\n\\ge orphan\n';   // ge without ps: the ps level synthesizes

test("import: tree mode - deterministic literal load, browsable, re-run rules", async () => {
    await withTestDb(async (fx) => {
        const {ww} = fx;
        try {
            const r1 = security.runSystem(() => sfmImport.importSfm(
                STRUCTURAL_TYP, STRUCTURAL_DATA, {table: 'toyraw', structure: 'tree'}));
            assertEquals(r1.records, 2);
            assertEquals(r1.problems, []);
            assertEquals(r1.droppedFields, 0);
            assertEquals(r1.generation, 1);

            const store = ww.storeFor('toyraw');
            const entries = store.entries as any[];
            assertEquals(entries.length, 2);
            // Record 1: headword content + nested ps/ge tree + the 1d marker.
            assertEquals(entries[0].lx[0].content, 'alpha');
            assertEquals(entries[0].ps[0].content, 'n');
            assertEquals(entries[0].ps[0].ge.map((g: any) => g.content), ['first', 'second']);
            assertEquals(entries[0].__1d[0].content, 'dual');
            // Record 2: the synthesized ps level (content null) holds the ge.
            assertEquals(entries[1].ps[0].content, null);
            assertEquals(entries[1].ps[0].ge[0].content, 'orphan');
            // seq preserves the file positions.
            assertEquals(entries[0].ps[0].ge.map((g: any) => g.seq), [2, 3]);

            // RE-RUN: an unedited mirror wipes and reloads DETERMINISTICALLY.
            const before = security.runSystem(() => db().all<any, any>(
                `SELECT assertion_id, ty, attr1 FROM toyraw ORDER BY assertion_id`, {}));
            const r2 = security.runSystem(() => sfmImport.importSfm(
                STRUCTURAL_TYP, STRUCTURAL_DATA, {table: 'toyraw', structure: 'tree'}));
            assertEquals(r2.generation, 2);
            store.requestWorkspaceReload();
            const after = security.runSystem(() => db().all<any, any>(
                `SELECT assertion_id, ty, attr1 FROM toyraw ORDER BY assertion_id`, {}));
            assertEquals(after, before);   // same ids, same content

            // An EDIT by anyone else blocks re-import.
            security.runSystem(() => db().execute(
                `UPDATE toyraw SET change_by_username = 'djz' WHERE ty = 'ge' AND attr1 = 'first'`, {}));
            let refused: any;
            try { security.runSystem(() => sfmImport.importSfm(
                STRUCTURAL_TYP, STRUCTURAL_DATA, {table: 'toyraw', structure: 'tree'})); }
            catch(e) { refused = e; }
            assertEquals(String(refused).includes('edited assertion'), true);

            // A NON-mirror dictionary refuses outright.
            let refused2: any;
            try { security.runSystem(() => sfmImport.importSfm(
                STRUCTURAL_TYP, STRUCTURAL_DATA, {table: 'dict'})); }
            catch(e) { refused2 = e; }
            assertEquals(String(refused2).includes('not an import mirror'), true);
        } finally {
            security.runSystem(() => db().executeStatements(
                'DROP TABLE IF EXISTS toyraw; DROP TABLE IF EXISTS toyraw_dict_config;'));
        }
    });
});

test("import: RAND in TREE mode via the STRUCTURAL typ - senses group", async () => {
    // rand-structural.typ (generated by watson/make-structural-typ.ts)
    // encodes Watson's INTENT: \ps opens a sense (repetition = new group),
    // \xe pairs under its \xv - sfm's recovery does the treeing.
    const WATSON = new URL('../watson/', import.meta.url).pathname;
    const typText = Deno.readTextFileSync(WATSON + 'rand-structural.typ');
    const dataText = sfm.decodeSfmBytes(
        Deno.readFileSync(WATSON + 'Rand Mig Eng Dictt 29097'), 'utf-8');
    await withTestDb(async (fx) => {
        const {ww} = fx;
        try {
            const r = security.runSystem(() => sfmImport.importSfm(
                typText, dataText,
                {table: 'randtree', structure: 'tree', stopAfterCount: 50}));
            assertEquals(r.problems, []);
            assertEquals(r.droppedFields, 0);
            const e0 = (ww.storeFor('randtree').entries as any[])[0];
            assertEquals(e0.lx[0].content, "e'n");
            // TWO senses, each its own group; the example PAIRED in its sense.
            assertEquals(e0.ps.length, 2);
            assertEquals(e0.ps[1].content, 'voc');
            assertEquals(e0.ps[1].xv[0].content, 'āān');
            assertEquals(e0.ps[1].xv[0].xe[0].content, 'wife');
            // Lexeme-level fields sit at the record level.
            assertEquals(e0.so[0].content, 'Rand 1888, p 282');
        } finally {
            security.runSystem(() => db().executeStatements(
                'DROP TABLE IF EXISTS randtree; DROP TABLE IF EXISTS randtree_dict_config;'));
        }
    });
});

test("import: a REAL RAND sample (flat), browsed through the facade", async () => {
    const WATSON = new URL('../watson/', import.meta.url).pathname;
    const typText = sfm.decodeSfmBytes(Deno.readFileSync(WATSON + 'MDF.typ'), 'windows-1252');
    const dataText = sfm.decodeSfmBytes(
        Deno.readFileSync(WATSON + 'Rand Mig Eng Dictt 29097'), 'utf-8');
    await withTestDb(async (fx) => {
        const {ww} = fx;
        try {
            // The Watson .typ is an entry-template VINE: tree mode refuses...
            let vineRefused: any;
            try { security.runSystem(() => sfmImport.importSfm(
                typText, dataText, {table: 'randraw', structure: 'tree', stopAfterCount: 5})); }
            catch(e) { vineRefused = e; }
            assertEquals(String(vineRefused).includes('flat'), true);
            // ...and flat mode imports a sample cleanly.
            const r = security.runSystem(() => sfmImport.importSfm(
                typText, dataText,
                {table: 'randraw', structure: 'flat', stopAfterCount: 200,
                 sourceName: 'Rand Mig Eng Dictt 29097'}));
            assertEquals(r.records, 200);
            assertEquals(r.problems, []);
            assertEquals(r.droppedFields, 0);

            const entries = ww.storeFor('randraw').entries as any[];
            assertEquals(entries.length, 200);
            assertEquals(entries[0].lx[0].content, "e'n");
            // The facade browses it, mirror banner included.
            const home = JSON.stringify(await as(fx, 'djz',
                () => renderRoute(ww, `wordwiki.dicts.randraw.home()`)));
            assertEquals(home.includes("e'n"), true);
            assertEquals(home.includes('Import mirror of Rand Mig Eng Dictt 29097'), true);
            const word = JSON.stringify(await as(fx, 'djz',
                () => renderRoute(ww, `wordwiki.dicts.randraw.word(1000)`)));
            assertEquals(word.includes("e'n"), true);
            assertEquals(word.includes('wife'), true);   // the \xe value rides along
        } finally {
            security.runSystem(() => db().executeStatements(
                'DROP TABLE IF EXISTS randraw; DROP TABLE IF EXISTS randraw_dict_config;'));
        }
    });
});
