// deno-lint-ignore-file no-explicit-any
/**
 * The variant data migration (variant-migrate.ts): each action class over
 * seeded rows, mute-in-place currency (history keeps its original values),
 * idempotency, the hand-triage remainder, and the preconditions (flagged
 * schema, drop gate).
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertThrows } from "../liminal/testing/assert.ts";
import { withTestDb, TestTimeline, mkEntry, mkChild, mkEdit, type Fixture } from "./testing.ts";
import { db } from "../liminal/db.ts";
import * as timestamp from "../liminal/timestamp.ts";
import * as model from "./model.ts";
import { FindingsReport } from "./findings.ts";
import { migrateVariants, blankBackfillByTag, valueFixesByTag } from "./variant-migrate.ts";

const VOCABULARY = ['mm-li', 'mm-sf', 'mm-mp', 'mm-pm', 'mm'];

// Real tags, target-model flags: spl pure keeper, tdo keeper w/ $defaultAll,
// rec $notVariant, nte variant-less.  (Independent of entry-schema.ts, which
// may not carry flags yet.)
const flaggedSchema = model.Schema.parseSchemaFromCompactJson('dict', {
    $type: 'schema', $name: 'dict', $tag: 'dct',
    entry: {
        $type: 'relation', $tag: 'ent',
        entry_id: {$type: 'primary_key'},
        spelling: {
            $type: 'relation', $tag: 'spl',
            spelling_id: {$type: 'primary_key'},
            text: {$type: 'string', $bind: 'attr1'},
            variant: {$type: 'variant'},
        },
        todo: {
            $type: 'relation', $tag: 'tdo',
            todo_id: {$type: 'primary_key'},
            todo: {$type: 'string', $bind: 'attr1'},
            variant: {$type: 'variant', $metaVariant: true, $allowAll: true, $defaultAll: true},
        },
        recording: {
            $type: 'relation', $tag: 'rec',
            recording_id: {$type: 'primary_key'},
            recording: {$type: 'audio', $bind: 'attr1'},
            variant: {$type: 'variant', $notVariant: true},
        },
        note: {
            $type: 'relation', $tag: 'nte',
            note_id: {$type: 'primary_key'},
            note: {$type: 'string', $bind: 'attr1'},
        },
    },
});

const unflaggedSchema = model.Schema.parseSchemaFromCompactJson('dict', {
    $type: 'schema', $name: 'dict', $tag: 'dct',
    entry: {
        $type: 'relation', $tag: 'ent',
        entry_id: {$type: 'primary_key'},
        spelling: {
            $type: 'relation', $tag: 'spl',
            spelling_id: {$type: 'primary_key'},
            text: {$type: 'string', $bind: 'attr1'},
            variant: {$type: 'variant'},
        },
    },
});

const variantOf = (fact_id: number): string | null =>
    db().all<{variant: string|null}, any>(
        `SELECT variant FROM dict WHERE id = :id AND valid_to = :eot`,
        {id: fact_id, eot: timestamp.END_OF_TIME})[0].variant;

function seed(fx: Fixture) {
    // The fill-bookkeeping table outlives withTestDb's data reset (it is the
    // migration's own companion table) - drop it so tests never see another
    // test's fills.
    db().executeStatements('DROP TABLE IF EXISTS variant_migration_fill;');
    const tl = new TestTimeline();
    const e = mkEntry(1000, tl.next());
    fx.ww.applyTransaction([e], {quiet: true});
    const add = (ty: string, id: number, fields: any) => {
        const a = mkChild(e, ty, id, tl.next(), fields);
        fx.ww.applyTransaction([a], {quiet: true});
        return a;
    };
    add('spl', 1010, {attr1: 'samqwan', variant: 'mm-li'});   // clean - untouched
    add('spl', 1011, {attr1: 'plamu', variant: ''});          // '' -> backfill mm-li
    add('spl', 1012, {attr1: 'gopit', variant: 'null'});      // "null" -> backfill mm-li
    add('spl', 1013, {attr1: 'waisis', variant: 'mm'});       // value-fix -> mm-li
    add('spl', 1014, {attr1: 'nipi', variant: "us's'g"});     // hand-triage - untouched
    add('tdo', 1020, {attr1: 'check', variant: null});        // blank -> 'mm' ($defaultAll)
    add('rec', 1030, {attr1: 'r.mp3', variant: 'mm-li'});     // $notVariant -> NULL
    add('nte', 1040, {attr1: 'a note', variant: 'mm-li'});    // variant-less -> NULL
    // A fact with HISTORY: the old version's blank variant must stay blank
    // (mute-in-place touches CURRENT rows only).
    const old = add('spl', 1050, {attr1: 'qalipu', variant: ''});
    fx.ww.applyTransaction([mkEdit(old, 1051, tl.next())], {quiet: true});
}

test("migrate-variants: every action class, then idempotent re-run", async () => {
    await withTestDb((fx) => {
        seed(fx);
        const report = new FindingsReport('migration', {quiet: true});
        const stats = migrateVariants(report, flaggedSchema, VOCABULARY);

        assertEquals(variantOf(1010), 'mm-li');    // untouched
        assertEquals(variantOf(1011), 'mm-li');    // backfilled
        assertEquals(variantOf(1012), 'mm-li');    // "null" then backfilled
        assertEquals(variantOf(1013), 'mm-li');    // value-fix
        assertEquals(variantOf(1014), "us's'g");   // hand-triage untouched
        assertEquals(variantOf(1020), 'mm');       // $defaultAll backfill
        assertEquals(variantOf(1030), null);       // $notVariant dropped
        assertEquals(variantOf(1040), null);       // variant-less dropped
        assertEquals(variantOf(1050), 'mm-li');    // current version backfilled...
        // ...but the superseded version keeps its original blank (audit trail).
        const oldRow = db().all<{variant: string|null}, any>(
            `SELECT variant FROM dict WHERE assertion_id = 1050`, {})[0];
        assertEquals(oldRow.variant, '');

        assert(stats.changed >= 7, `changed ${stats.changed}`);
        assertEquals(stats.byAction['value-fix'], 1);
        assertEquals(stats.byAction['drop-notVariant'], 1);
        assertEquals(stats.byAction['drop-variantless'], 1);

        // The hand-triage remainder is reported, with a link.
        const md = report.toMarkdown();
        assert(md.includes("'us's'g' needs a human decision"), 'hand-triage reported');
        assert(md.includes('/ww/wordwiki.entry(1000)'), 'with a lexeme link');

        // Idempotency: a second run changes nothing.
        const again = migrateVariants(new FindingsReport('again', {quiet: true}),
                                      flaggedSchema, VOCABULARY);
        assertEquals(again.changed, 0);
    });
});

test("migrate-variants: refuses an unflagged schema", async () => {
    await withTestDb((fx) => {
        seed(fx);
        assertThrows(() => migrateVariants(new FindingsReport('m', {quiet: true}),
                                           unflaggedSchema, VOCABULARY),
                     Error, 'no $notVariant flags');
    });
});

test("migrate-variants: refuses when the drop gate fails", async () => {
    await withTestDb((fx) => {
        seed(fx);
        // A rec row with a REAL orthography-ish value the gate rejects.
        const tl = new TestTimeline();
        const e = mkEntry(2000, tl.next());
        fx.ww.applyTransaction([e], {quiet: true});
        fx.ww.applyTransaction([mkChild(e, 'rec', 2030, tl.next(),
                                        {attr1: 'r.mp3', variant: 'zzz'})], {quiet: true});
        assertThrows(() => migrateVariants(new FindingsReport('m', {quiet: true}),
                                           flaggedSchema, VOCABULARY),
                     Error, 'drop gate FAILS');
    });
});

test("migrate-variants --dry-run: reports every case, writes nothing", async () => {
    await withTestDb((fx) => {
        seed(fx);
        const report = new FindingsReport('dry', {quiet: true});
        const stats = migrateVariants(report, flaggedSchema, VOCABULARY, {dryRun: true});

        // Nothing changed in the db...
        assertEquals(variantOf(1011), '');         // blank spelling untouched
        assertEquals(variantOf(1013), 'mm');       // value-fix candidate untouched
        assertEquals(variantOf(1030), 'mm-li');    // $notVariant rec untouched
        // ...but the stats say what WOULD change, same as a real run.
        assert(stats.changed >= 7, `would-change ${stats.changed}`);

        const md = report.toMarkdown();
        // Decision evidence: the mapping is judgeable from the report alone.
        assert(md.includes('Decision evidence'), 'evidence section');
        assert(md.includes('blank becomes'), 'evidence table header');
        // The cases: value fixes enumerated with headword links, backfills sampled.
        assert(md.includes('The cases'), 'cases section');
        assert(md.includes('value-fix Spelling: every case'), 'value-fix enumerated');
        // The case row links by the entry's HEADWORD (its first spelling);
        // the affected row's own text rides the field-text column.
        assert(md.includes('[samqwan](/ww/wordwiki.entry(1000))'), 'headword-linked case row');
        assert(md.includes('| waisis | mm | mm-li |'), 'value-fix case columns');
        assert(md.includes('backfill-blank Spelling: sample'), 'backfill sampled');
        // The dry-run remainder excludes what the run WOULD fix: the 'mm'
        // value-fix candidate must not be listed as hand-triage.
        assert(!md.includes("'mm' needs a human decision"), 'value-fix not in remainder');
        assert(md.includes("'us's'g' needs a human decision"), 'true hand-triage still listed');

        // A real run afterwards still works and changes the same number.
        const real = migrateVariants(new FindingsReport('real', {quiet: true}),
                                     flaggedSchema, VOCABULARY);
        assertEquals(real.changed, stats.changed);
    });
});

test("migrate-variants: a changed decision table revises unedited fills only", async () => {
    await withTestDb((fx) => {
        seed(fx);
        migrateVariants(new FindingsReport('m1', {quiet: true}), flaggedSchema, VOCABULARY);
        // Post-run: spl blanks 1011/1012/1050 filled mm-li; 1013 value-fixed mm-li.

        // A HUMAN touches one filled row: an edit re-versions the fact
        // (carrying the variant the editor saw - ratified).
        const tl2 = new TestTimeline();
        const cur1011 = db().all<any, any>(
            `SELECT * FROM dict WHERE id = 1011 AND valid_to = :eot`, {eot: timestamp.END_OF_TIME})[0];
        fx.ww.applyTransaction([{...cur1011, assertion_id: 9011,
                                 replaces_assertion_id: cur1011.assertion_id,
                                 valid_from: tl2.next(), valid_to: timestamp.END_OF_TIME}], {quiet: true});

        // dz changes his mind: blank spellings should have been mm-sf, and
        // the spl value fix should have gone to mm-sf too.
        const stats = migrateVariants(new FindingsReport('m2', {quiet: true}),
                                      flaggedSchema, VOCABULARY, {
            backfill: {...blankBackfillByTag, spl: 'mm-sf'},
            valueFixes: {...valueFixesByTag, spl: {'mm': 'mm-sf'}},
        });
        // The unedited fills revised...
        assertEquals(variantOf(1012), 'mm-sf');
        assertEquals(variantOf(1050), 'mm-sf');
        assertEquals(variantOf(1013), 'mm-sf');   // the value-fix row too
        // ...the human-re-versioned row is NOT ours anymore.
        assertEquals(variantOf(1011), 'mm-li');
        assertEquals(stats.byAction['revise-fill'], 3);

        // Idempotent under the new tables; and the released row's
        // bookkeeping is gone.
        const again = migrateVariants(new FindingsReport('m3', {quiet: true}),
                                      flaggedSchema, VOCABULARY, {
            backfill: {...blankBackfillByTag, spl: 'mm-sf'},
            valueFixes: {...valueFixesByTag, spl: {'mm': 'mm-sf'}},
        });
        assertEquals(again.changed, 0);
        const orphan = db().all<any, any>(
            `SELECT * FROM variant_migration_fill WHERE assertion_id = :id`,
            {id: cur1011.assertion_id});
        assertEquals(orphan.length, 0);
    });
});
