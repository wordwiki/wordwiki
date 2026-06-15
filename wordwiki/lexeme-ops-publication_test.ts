// deno-lint-ignore-file no-explicit-any
/**
 * The app-level publication verbs (LexemeOps.approveFact/revertFact/
 * commentFact): permission enforcement, the self-approve workaround, and
 * persistence to the db. (The pure operation semantics are property-tested
 * against the oracle in reference-model_test.ts; these cover the production
 * wiring on top.)
 */
import { test } from "../liminal/testing/test.ts";
import { assertEquals, assertThrows, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, as, mkEntry, type Fixture } from "./testing.ts";
import { validateVersionedDb } from "./versioned-db-validate.ts";
import { db } from "../liminal/db.ts";
import * as timestamp from "../liminal/timestamp.ts";

const EOT = timestamp.END_OF_TIME;
const T = timestamp.BEGINNING_OF_TIME + 1;

// Seed an entry fact authored (in the data) by `author`. applyTransaction
// allocates the server timestamp; the assertion carries change_by_username.
function seed(fx: Fixture, factId: number, author: string, attr1: string): void {
    as(fx, "system", () =>
        fx.ww.applyTransaction([mkEntry(factId, T, { change_by_username: author, attr1 })],
                               { quiet: true }));
}

function versions(factId: number): any[] {
    return db().all<any, { id: number }>(
        `SELECT assertion_id, valid_to, published_from, published_to, change_action, change_by_username
         FROM dict WHERE id = :id ORDER BY valid_from`, { id: factId });
}
const publishedCurrent = (factId: number) =>
    versions(factId).find((v) => v.published_to === EOT);

test("approveFact: an admin publishes another user's content; it persists", () => {
    return withTestDb((fx: Fixture) => {
        seed(fx, 1000, "djz", "water");                  // content by djz
        as(fx, "dmm", () => fx.ww.lexemeOps.approveFact(1000)); // dmm (admin) approves

        const pub = publishedCurrent(1000);
        assertEquals(pub?.change_action, "approved");
        assertEquals(pub?.change_by_username, "dmm");    // approver on the chain
        assertEquals(pub?.published_to, EOT);
        // The pending content version's valid_to was closed (superseded).
        const vs = versions(1000);
        assertEquals(vs.length, 2);
        assertEquals(vs[0].valid_to !== EOT, true);
        assertEquals(validateVersionedDb(fx.ww.workspace), []);
    });
});

test("approveFact: a user without approve-permission is refused", () => {
    return withTestDb((fx: Fixture) => {
        seed(fx, 1000, "djz", "water");
        // Find a seeded user with neither admin nor approve.
        const nonApprover = as(fx, "system", () =>
            Object.keys(fx.userIds).find((u) => {
                const user = fx.ww.users.byUsername.first({ username: u });
                const perms = (user?.permissions ?? "");
                return !perms.includes("admin") && !perms.includes("approve");
            }))!;
        const e = as(fx, nonApprover, () =>
            assertThrows(() => fx.ww.lexemeOps.approveFact(1000), Error));
        assertStringIncludes((e as Error).message, "approve permission");
        assertEquals(publishedCurrent(1000), undefined);  // nothing published
    });
});

test("self-approve: an admin may approve their own content (the workaround)", () => {
    return withTestDb((fx: Fixture) => {
        seed(fx, 1000, "djz", "water");                  // content by djz
        as(fx, "djz", () => fx.ww.lexemeOps.approveFact(1000)); // djz approves own
        const pub = publishedCurrent(1000);
        assertEquals(pub?.change_action, "approved");
        assertEquals(pub?.change_by_username, "djz");     // self-approval, recorded
    });
});

test("two-person: an approve-only (non-admin) user cannot approve their own", () => {
    return withTestDb((fx: Fixture) => {
        // A reviewer with 'approve' but not 'admin' (so no self-approve).
        const reviewerId = as(fx, "system", () =>
            fx.ww.users.insert({ username: "rev", name: "Rev", permissions: "approve", disabled: 0 }));
        seed(fx, 1000, "rev", "water");                  // content by rev
        const ctx = { actorId: reviewerId, roles: new Set(["approve"]) };
        const e = as(fx, ctx, () =>
            assertThrows(() => fx.ww.lexemeOps.approveFact(1000), Error));
        assertStringIncludes((e as Error).message, "two-person");
        // A different approve-user CAN approve it.
        const rev2 = as(fx, "system", () =>
            fx.ww.users.insert({ username: "rev2", name: "Rev2", permissions: "approve", disabled: 0 }));
        as(fx, { actorId: rev2, roles: new Set(["approve"]) }, () =>
            fx.ww.lexemeOps.approveFact(1000));
        assertEquals(publishedCurrent(1000)?.change_by_username, "rev2");
    });
});

test("revertFact requires a note; revert + comment persist correctly", () => {
    return withTestDb((fx: Fixture) => {
        seed(fx, 1000, "djz", "water");
        as(fx, "dmm", () => fx.ww.lexemeOps.approveFact(1000));

        // revert needs a note.
        as(fx, "dmm", () =>
            assertThrows(() => fx.ww.lexemeOps.revertFact(1000, "  "), Error, "note"));

        // A comment: any logged-in editor; never published.
        as(fx, "djz", () => fx.ww.lexemeOps.commentFact(1000, "add SF spelling?"));
        const vs = versions(1000);
        const comment = vs.at(-1);
        assertEquals(comment.change_action, "comment");
        assertEquals(comment.published_from, null);
        // The published-current is still the approved "water" (comment inert).
        assertEquals(publishedCurrent(1000)?.change_action, "approved");

        // revert with a note publishes a 'reverted' version.
        as(fx, "dmm", () => fx.ww.lexemeOps.revertFact(1000, "wrong sense"));
        assertEquals(publishedCurrent(1000)?.change_action, "reverted");
        assertEquals(validateVersionedDb(fx.ww.workspace), []);
    });
});
