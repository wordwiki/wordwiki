// deno-lint-ignore-file no-explicit-any
/**
 * The structural repairs (repair-assertions.ts): dangling chain heads are
 * nulled, the repair is idempotent, and a mid-chain dangling reference is
 * refused (not silently "fixed").
 */
import { test } from "../liminal/testing/test.ts";
import { assertEquals, assertThrows, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, type Fixture } from "./testing.ts";
import { repairDanglingChainHeads } from "./repair-assertions.ts";
import { db } from "../liminal/db.ts";
import * as timestamp from "../liminal/timestamp.ts";

const EOT = timestamp.END_OF_TIME;

// Insert a raw dict row (bypassing the workspace, which would reject a
// dangling chain - the whole point is to seed corruption).
function rawAssertion(a: Record<string, any>): void {
    db().insert("dict", {
        ty0: "dct", ty1: "ent", id1: a.id, ty: "ent",
        attr1: null, valid_to: EOT, ...a,
    }, "assertion_id");
}

function replacesOf(assertion_id: number): number | null {
    return db().required<{ r: number | null }, { a: number }>(
        "SELECT replaces_assertion_id AS r FROM dict WHERE assertion_id = :a",
        { a: assertion_id }).r;
}

test("repairDanglingChainHeads: nulls a born-dangling head, idempotent", async () => {
    await withTestDb((_fx: Fixture) => {
        // Fact 1000: head (assertion 11) claims to replace a never-written
        // version (= the fact id), then a real edit (12) on top.
        rawAssertion({ assertion_id: 11, replaces_assertion_id: 1000, id: 1000, valid_from: 100, valid_to: 200 });
        rawAssertion({ assertion_id: 12, replaces_assertion_id: 11, id: 1000, valid_from: 200 });
        // Fact 2000: a clean, untouched chain (head replaces nothing).
        rawAssertion({ assertion_id: 21, replaces_assertion_id: null, id: 2000, valid_from: 100, valid_to: 200 });
        rawAssertion({ assertion_id: 22, replaces_assertion_id: 21, id: 2000, valid_from: 200 });

        const stats = repairDanglingChainHeads();
        assertEquals(stats.danglingChainHeadsFixed, 1);
        assertEquals(replacesOf(11), null);       // dangling head nulled
        assertEquals(replacesOf(12), 11);          // the rest of the chain untouched
        assertEquals(replacesOf(21), null);        // clean fact untouched
        assertEquals(replacesOf(22), 21);

        // Idempotent: a second run finds nothing.
        assertEquals(repairDanglingChainHeads().danglingChainHeadsFixed, 0);
    });
});

test("repairDanglingChainHeads: refuses a MID-CHAIN dangling reference", async () => {
    await withTestDb((_fx: Fixture) => {
        // Fact 3000: a proper head (31), then a version (32) whose replaces
        // points at a NON-EXISTENT assertion (99) - a real mid-chain break,
        // not a born-dangling head. Nulling it would split the chain, so the
        // repair must refuse.
        rawAssertion({ assertion_id: 31, replaces_assertion_id: null, id: 3000, valid_from: 100, valid_to: 200 });
        rawAssertion({ assertion_id: 32, replaces_assertion_id: 99, id: 3000, valid_from: 200 });

        const e = assertThrows(() => repairDanglingChainHeads(), Error);
        assertStringIncludes((e as Error).message, "mid-chain break");
        // Nothing was changed (the transaction rolled back).
        assertEquals(replacesOf(32), 99);
    });
});
