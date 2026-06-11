// deno-lint-ignore-file no-explicit-any
/**
 * Lexical form import: the conservative normalization (only unambiguous
 * mappings rewrite data), the worklist report, persistence, idempotency.
 */
import { test } from "../liminal/testing/test.ts";
import { assertEquals } from "../liminal/testing/assert.ts";
import { withTestDb, as, TestTimeline, mkEntry, mkChild } from "./testing.ts";
import { normalizePartOfSpeech, importLexicalForms } from "./lexical-form-import.ts";
import * as timestamp from "../liminal/timestamp.ts";
import { db } from "../liminal/db.ts";

test("normalizePartOfSpeech: only unambiguous mappings, fixed point", () => {
    const slugs = new Set(['vai', 'vii', 'na', 'PTCL']);
    // Already canonical / empty: no change.
    assertEquals(normalizePartOfSpeech('vai', slugs), undefined);
    assertEquals(normalizePartOfSpeech('', slugs), undefined);
    assertEquals(normalizePartOfSpeech(null, slugs), undefined);
    // Whitespace damage and case variants of a slug.
    assertEquals(normalizePartOfSpeech('vii ', slugs), 'vii');
    assertEquals(normalizePartOfSpeech('  na', slugs), 'na');
    assertEquals(normalizePartOfSpeech('ptcl', slugs), 'PTCL');
    // The explicit alias.
    assertEquals(normalizePartOfSpeech('particle', slugs), 'PTCL');
    assertEquals(normalizePartOfSpeech('Particle', slugs), 'PTCL');
    // Information-carrying legacy values: a human's job.
    assertEquals(normalizePartOfSpeech('ni  mass', slugs), undefined);
    assertEquals(normalizePartOfSpeech('na·dk', slugs), undefined);
    assertEquals(normalizePartOfSpeech('Wp ini', slugs), undefined);
    assertEquals(normalizePartOfSpeech('??', slugs), undefined);
});

function seedEntries(ww: any): void {
    const tl = new TestTimeline();
    let id = 1000;
    for(const pos of ['vai', 'vii ', 'particle', 'Wp ini', '']) {
        const e = mkEntry(id, tl.next());
        ww.applyTransaction([e], {quiet: true});
        ww.applyTransaction([mkChild(e, 'sub', id+100, tl.next(),
                                     {attr1: pos === '' ? null : pos, order_key: '0.5'})],
                            {quiet: true});
        id += 1000;
    }
}

function dbPos(): string[] {
    return db().all<{attr1: string|null}, {end: number}>(
        `SELECT attr1 FROM dict WHERE ty = 'sub' AND valid_to = :end ORDER BY id1`,
        {end: timestamp.END_OF_TIME}).map(r => r.attr1 ?? '');
}

test("import: seeds, normalizes the unambiguous, reports the rest; re-run no-op", async () => {
    await withTestDb((fx) => {
        as(fx, 'system', () => {
            seedEntries(fx.ww);

            const stats = importLexicalForms(fx.ww, {username: 'djz'});
            assertEquals(stats.seeded.inserted > 0, true);
            assertEquals(stats.subentriesScanned, 5);
            assertEquals(stats.subentriesNormalized, 2);      // 'vii ' + 'particle'
            assertEquals(stats.subentriesEmpty, 1);
            assertEquals(Array.from(stats.remainingUntabled.entries()),
                         [['Wp ini', 1]]);

            // Persisted (from the db, in entry order), history retained.
            assertEquals(dbPos(), ['vai', 'vii', 'PTCL', 'Wp ini', '']);
            const versions = db().all<{change_by_username: string}, {id: number}>(
                'SELECT change_by_username FROM dict WHERE id = :id ORDER BY valid_from',
                {id: 2100});   // the 'vii ' subentry
            assertEquals(versions.length, 2);
            assertEquals(versions[1].change_by_username, 'djz');

            // Re-run: nothing changes.
            const again = importLexicalForms(fx.ww, {username: 'djz'});
            assertEquals(again.seeded.inserted, 0);
            assertEquals(again.subentriesNormalized, 0);
            assertEquals(Array.from(again.remainingUntabled.keys()), ['Wp ini']);
            assertEquals(dbPos(), ['vai', 'vii', 'PTCL', 'Wp ini', '']);
        });
    });
});
