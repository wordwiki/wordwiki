// deno-lint-ignore-file no-explicit-any
/**
 * The structural invariant checker (versioned-db-validate.ts), driven directly
 * through its minimal FactView interface — one deliberately-broken fact per
 * invariant. (This is the same interface the in-core reference oracle will
 * adapt to later, so these cases double as the oracle's conformance bar.)
 */
import { test } from "../liminal/testing/test.ts";
import { assertEquals } from "../liminal/testing/assert.ts";
import { validateFacts, type FactView } from "./versioned-db-validate.ts";
import * as timestamp from "../liminal/timestamp.ts";

const EOT = timestamp.END_OF_TIME;

// A well-formed two-version fact: head (1) replaces nothing, edit (2) replaces
// it and is currently live.
function cleanFact(overrides: Partial<FactView> = {}): FactView {
    return {
        path: "dct/ent:1000", ty: "ent", id: 1000,
        versions: [
            { assertion_id: 1, valid_from: 100, valid_to: 200 },
            { assertion_id: 2, replaces_assertion_id: 1, valid_from: 200, valid_to: EOT },
        ],
        ...overrides,
    };
}

function kinds(facts: FactView[]): string[] {
    return validateFacts(facts).map(p => p.invariant).sort();
}

test("a clean store has no problems", () => {
    assertEquals(validateFacts([cleanFact()]), []);
    // A tombstone tail (deleted fact) is also clean.
    assertEquals(validateFacts([cleanFact({
        versions: [
            { assertion_id: 1, valid_from: 100, valid_to: 200 },
            { assertion_id: 2, replaces_assertion_id: 1, valid_from: 300, valid_to: 300 }, // tombstone
        ],
    })]), []);
    // A restore-after-delete gap (tombstone then a later start) is clean.
    assertEquals(validateFacts([cleanFact({
        versions: [
            { assertion_id: 1, valid_from: 100, valid_to: 100 },                              // tombstone
            { assertion_id: 2, replaces_assertion_id: 1, valid_from: 300, valid_to: EOT },    // restored after gap
        ],
    })]), []);
});

test("each broken invariant is caught", () => {
    // Orphan: a fact with no versions (a referenced-but-unasserted parent).
    assertEquals(kinds([cleanFact({ versions: [] })]), ["fact-has-no-versions"]);

    // The head replaces something (a dangling head — the bug we found in prod).
    assertEquals(kinds([cleanFact({
        versions: [
            { assertion_id: 1, replaces_assertion_id: 1000, valid_from: 100, valid_to: 200 },
            { assertion_id: 2, replaces_assertion_id: 1, valid_from: 200, valid_to: EOT },
        ],
    })]), ["first-version-replaces"]);

    // Broken chain: version 2 replaces the wrong assertion.
    assertEquals(kinds([cleanFact({
        versions: [
            { assertion_id: 1, valid_from: 100, valid_to: 200 },
            { assertion_id: 2, replaces_assertion_id: 99, valid_from: 200, valid_to: EOT },
        ],
    })]), ["broken-replaces-chain"]);

    // Overlapping valid intervals (successor starts before predecessor ended).
    assertEquals(kinds([cleanFact({
        versions: [
            { assertion_id: 1, valid_from: 100, valid_to: 250 },
            { assertion_id: 2, replaces_assertion_id: 1, valid_from: 200, valid_to: EOT },
        ],
    })]), ["overlapping-valid-intervals"]);

    // A reversed interval (ends before it begins).
    assertEquals(kinds([cleanFact({
        versions: [{ assertion_id: 1, valid_from: 300, valid_to: 100 }],
    })]), ["dangling-closed-tail", "valid-interval-reversed"]);

    // A dangling closed tail (newest version closed at a finite time, not a
    // tombstone, no successor).
    assertEquals(kinds([cleanFact({
        versions: [{ assertion_id: 1, valid_from: 100, valid_to: 200 }],
    })]), ["dangling-closed-tail"]);

    // A fact that predates its parent.
    assertEquals(kinds([cleanFact({ parentEarliestValidFrom: 150 })]), ["fact-predates-parent"]);

    // A duplicate assertion_id across two facts.
    assertEquals(kinds([
        cleanFact({ path: "a", id: 1, versions: [{ assertion_id: 7, valid_from: 1, valid_to: EOT }] }),
        cleanFact({ path: "b", id: 2, versions: [{ assertion_id: 7, valid_from: 1, valid_to: EOT }] }),
    ]), ["duplicate-assertion-id"]);
});
