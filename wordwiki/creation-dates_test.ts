// deno-lint-ignore-file no-explicit-any
/**
 * Lexeme creation dates (creation-dates.ts): the shoebox-date parser and the
 * mute-in-place ISO normalization migration (idempotency, the malformed
 * multi-line production value, unparseable values left alone and counted).
 */
import { test } from "../liminal/testing/test.ts";
import { assertEquals } from "../liminal/testing/assert.ts";
import { parseShoeboxDate, normalizeShoeboxDates } from "./creation-dates.ts";
import { createAssertionDml } from "./assertion.ts";
import { Db, setDefaultDb } from "../liminal/db.ts";
import * as timestamp from "../liminal/timestamp.ts";

// --- The parser --------------------------------------------------------------------

test("shoebox parse: legacy dd/Mon/yyyy to ISO; ISO passes through", () => {
    assertEquals(parseShoeboxDate("29/Jul/2023"), "2023-07-29");
    assertEquals(parseShoeboxDate("1/Jan/2001"), "2001-01-01");
    assertEquals(parseShoeboxDate("2023-07-29"), "2023-07-29");   // idempotent
    assertEquals(parseShoeboxDate("  31/Dec/2019 "), "2019-12-31");
});

test("shoebox parse: the multi-line production value takes its first parseable line", () => {
    assertEquals(parseShoeboxDate("31/Oct/2023\n29/Oct/2023"), "2023-10-31");
    assertEquals(parseShoeboxDate("gibberish\n29/Oct/2023"), "2023-10-29");
});

test("shoebox parse: garbage is undefined, never a guess", () => {
    assertEquals(parseShoeboxDate(undefined), undefined);
    assertEquals(parseShoeboxDate(null), undefined);
    assertEquals(parseShoeboxDate(""), undefined);
    assertEquals(parseShoeboxDate("sometime in 2019"), undefined);
    assertEquals(parseShoeboxDate("32/Jan/2019"), undefined);     // day out of range
    assertEquals(parseShoeboxDate("29/Foo/2023"), undefined);     // no such month
});

// --- The normalization migration ---------------------------------------------------

const EOT = timestamp.END_OF_TIME;

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

// A minimal shoebox-date att row (id doubles as assertion_id).
function insertAtt(d: Db, id: number, value: string, valid_to = EOT): void {
    d.execute(
        `INSERT INTO dict (assertion_id, id, ty, ty0, ty1, id1, ty2, id2, ty3, id3,
                           valid_from, valid_to, attr1, attr2)
         VALUES (:id, :id, 'att', 'dct', 'ent', 1, 'sub', 2, 'att', :id,
                 ${timestamp.BEGINNING_OF_TIME}, :valid_to, 'shoebox-date', :value)`,
        {id, value, valid_to} as any);
}
const attValue = (d: Db, id: number) =>
    d.all<{attr2: string}, any>(`SELECT attr2 FROM dict WHERE assertion_id = :id`, {id})[0].attr2;

test("normalize: rewrites current values to ISO in place; a re-run is a no-op", () => {
    withDictDb(d => {
        insertAtt(d, 1, "29/Jul/2023");
        insertAtt(d, 2, "2019-07-31");                    // already ISO
        insertAtt(d, 3, "31/Oct/2023\n29/Oct/2023");      // the malformed one
        insertAtt(d, 4, "no date here");                  // unparseable
        insertAtt(d, 5, "31/Jul/2019", 42);               // superseded: audit trail, untouched

        const s1 = normalizeShoeboxDates();
        assertEquals(s1, {normalized: 2, alreadyIso: 1, unparseable: 1});
        assertEquals(attValue(d, 1), "2023-07-29");
        assertEquals(attValue(d, 3), "2023-10-31");
        assertEquals(attValue(d, 4), "no date here");     // left as-is
        assertEquals(attValue(d, 5), "31/Jul/2019");      // superseded version keeps its text

        // Idempotent: the --expect-no-changes proof relies on this.
        const s2 = normalizeShoeboxDates();
        assertEquals(s2, {normalized: 0, alreadyIso: 3, unparseable: 1});
    });
});
