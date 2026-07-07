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
import { migrateVariants } from "./variant-migrate.ts";

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
