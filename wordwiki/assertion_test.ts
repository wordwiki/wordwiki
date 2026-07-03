/**
 * highestTimestamp: correctness over a tiny table, plus a query-plan pin.
 * The plan test matters more than it looks: the function runs over the whole
 * assertion table, and we intend to call it per page view (the review page's
 * since-T anchor), so a schema change that dropped or renamed the valid_from /
 * partial valid_to index would silently degrade it to a full table scan.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import { Db, setDefaultDb } from "../liminal/db.ts";
import * as timestamp from "../liminal/timestamp.ts";
import { createAssertionDml, highestTimestamp, highestTimestampQueries } from "./assertion.ts";

const EOT = timestamp.END_OF_TIME;

// Run fn with a fresh private in-memory db, holding a 'dict' assertion table
// with the real production DDL (indexes included), as the ambient db().
function withDictDb(fn: (d: Db) => void): void {
    const scratch = Db.openMemory();
    setDefaultDb(scratch);
    try {
        scratch.executeStatements(createAssertionDml('dict'));
        fn(scratch);
    } finally {
        setDefaultDb(undefined);
        scratch.close();
    }
}

// A minimal assertion row: only the NOT NULL columns (+ distinct fact ids, to
// satisfy the one-current-version-per-fact unique index).
function insert(d: Db, id: number, valid_from: number, valid_to: number): void {
    d.execute(
        `INSERT INTO dict (valid_from, valid_to, id, ty, ty0)
         VALUES (:valid_from, :valid_to, :id, 'ent', 'dct')`,
        {valid_from, valid_to, id});
}

test("highestTimestamp: empty table is BEGINNING_OF_TIME", () => {
    withDictDb(() => {
        assertEquals(highestTimestamp('dict'), timestamp.BEGINNING_OF_TIME);
    });
});

test("highestTimestamp: max over both valid_from and CLOSED valid_to", () => {
    // Realistic timestamps: the function floors its answer at
    // BEGINNING_OF_TIME, so times below it (as a bare 100 would be) never win.
    const T = timestamp.BEGINNING_OF_TIME;
    withDictDb(d => {
        // Highest valid_from wins while every valid_to is open (EOT must not count).
        insert(d, 1000, T+100, EOT);
        insert(d, 1001, T+200, EOT);
        assertEquals(highestTimestamp('dict'), T+200);
        // ...but a later CLOSE of an old version (e.g. a deletion tombstoning
        // valid_to without any new valid_from) must win over valid_from.
        insert(d, 1002, T+150, T+300);
        assertEquals(highestTimestamp('dict'), T+300);
    });
});

test("highestTimestamp: both queries stay on their covering indexes (no scan)", () => {
    withDictDb(d => {
        // A few rows so the planner has a real (if tiny) table to plan over.
        insert(d, 1000, 100, EOT);
        insert(d, 1001, 150, 300);
        for(const sql of highestTimestampQueries('dict')) {
            const details = d.all<{detail: string}>(`EXPLAIN QUERY PLAN ${sql}`)
                .map(r => r.detail);
            assert(details.some(det => det.includes('USING COVERING INDEX dict_valid_')),
                   `expected a covering index in the plan for '${sql}', got: ${details.join(' | ')}`);
            assert(!details.some(det => det.startsWith('SCAN')),
                   `plan for '${sql}' degraded to a scan: ${details.join(' | ')}`);
        }
    });
});
