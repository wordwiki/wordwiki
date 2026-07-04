// deno-lint-ignore-file no-explicit-any
/**
 * The publication tree must stay a tree in both dimensions (publication-model.md).
 * The mutation verbs REFUSE the operations that would orphan a child, the
 * validator flags any orphan that slips in, and repair-assertions cascade-
 * completes the legacy missed-deletes that produced the pre-existing orphans.
 *
 * Directions (one principle):
 *   - publish/approve, restore  -> TOP-DOWN (a child may only join a tree its
 *     parent is already in);
 *   - delete, approve-a-deletion -> BOTTOM-UP (empty the subtree first).
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertStringIncludes, assertThrows } from "../liminal/testing/assert.ts";
import { withTestDb, as, TestTimeline, mkEntry, mkChild, bornApprove, type Fixture } from "./testing.ts";
import { db } from "../liminal/db.ts";
import { validateVersionedDb, validateFacts, type FactView } from "./versioned-db-validate.ts";
import { repairOrphanedLiveChildren } from "./repair-assertions.ts";
import * as timestamp from "../liminal/timestamp.ts";

const EOT = timestamp.END_OF_TIME;

// A Completed, born-approved entry (1000) with an approved subentry (1100) and
// an approved category (1110) under it - a clean published tree to build on.
function seedClean(fx: Fixture) {
    const tl = new TestTimeline();
    const e = mkEntry(1000, tl.next());
    fx.ww.applyTransaction([e], {quiet: true});
    fx.ww.applyTransaction([mkChild(e, "spl", 1010, tl.next(), {attr1: "samqwan", order_key: "0.5"})], {quiet: true});
    fx.ww.applyTransaction([mkChild(e, "sta", 1020, tl.next(), {attr1: "Completed", order_key: "0.5"})], {quiet: true});
    const sub = mkChild(e, "sub", 1100, tl.next(), {order_key: "0.5"});
    fx.ww.applyTransaction([sub], {quiet: true});
    fx.ww.applyTransaction([mkChild(sub, "cat", 1110, tl.next(), {attr1: "water", order_key: "0.5"})], {quiet: true});
    bornApprove(fx.ww);
    return {tl, sub};
}

// --- The gates --------------------------------------------------------------

test("approve gate: cannot approve a child while its parent is unpublished", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl} = seedClean(fx);
            // A NEW pending subentry with a NEW pending gloss under it.
            const sub2 = mkChild({ty0:'dct',ty1:'ent',id1:1000} as any, "sub", 2100, tl.next(),
                {order_key: "0.6", change_by_username: "djz"});
            fx.ww.applyTransaction([sub2], {quiet: true});
            fx.ww.applyTransaction([mkChild(sub2, "gls", 2110, tl.next(),
                {attr1: "fish", order_key: "0.5", change_by_username: "djz"})], {quiet: true});
        });
        // A second reviewer tries to approve the child gloss first: refused.
        as(fx, "dmm", () => {
            assertThrows(() => fx.ww.lexemeOps.approveFact(2110), Error, "parent has not been approved");
            // Approving the parent subentry first is allowed...
            fx.ww.lexemeOps.approveFact(2100);
            // ...and now the child can be approved.
            fx.ww.lexemeOps.approveFact(2110);
            assertEquals(db().all<any,any>(
                `SELECT COUNT(*) c FROM dict WHERE id=2110 AND published_to=${EOT}`, {})[0].c, 1);
        });
    });
});

test("approve-deletion gate: cannot approve a parent's deletion while a child is still published", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            seedClean(fx);
            // Delete the category (leaf) then the subentry - bottom-up, as the
            // delete gate already forces.  Both are now pending deletions, both
            // still published.
            assertEquals(fx.ww.lexemeOps.tombstoneFact(1000, 1110).outcome, "removed");
            assertEquals(fx.ww.lexemeOps.tombstoneFact(1000, 1100).outcome, "removed");
        });
        as(fx, "dmm", () => {
            // Approving the subentry's deletion first would orphan the still-
            // published category: refused.
            assertThrows(() => fx.ww.lexemeOps.approveFact(1100), Error, "contents first");
            // Approve the child's deletion first, then the parent's: allowed.
            fx.ww.lexemeOps.approveFact(1110);
            fx.ww.lexemeOps.approveFact(1100);
            assertEquals(validateVersionedDb(fx.ww.workspace).length, 0);
        });
    });
});

test("delete gate (already enforced): cannot delete a fact with live children", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            seedClean(fx);
            // The subentry has a live category child -> refused.
            assertEquals(fx.ww.lexemeOps.tombstoneFact(1000, 1100).outcome, "has-children");
        });
    });
});

test("restore gate: cannot un-delete a child while its parent is deleted", async () => {
    await withTestDb((fx) => {
        let catTombstone = 0;
        as(fx, "djz", () => {
            seedClean(fx);
            const r = fx.ww.lexemeOps.tombstoneFact(1000, 1110);   // delete the category
            if(r.outcome === "removed") catTombstone = r.replaced.assertion_id;
            fx.ww.lexemeOps.tombstoneFact(1000, 1100);              // then the subentry
        });
        as(fx, "djz", () => {
            // Restore the category while its subentry parent is still deleted: refused.
            const r = fx.ww.lexeme.restoreVersion(1000, 1110, catTombstone);
            assertEquals(r.action, "alert");
            assertStringIncludes(r.message, "parent has been deleted");
        });
    });
});

// --- The validator ----------------------------------------------------------

test("validator: flags an orphaned published/live child of a deleted parent", () => {
    // A live, published child whose parent is neither live nor published.
    const child: FactView = {
        path: "dct/ent:1000/sub:1100/cat:1110", ty: "cat", id: 1110,
        versions: [{assertion_id: 1, valid_from: 100, valid_to: EOT,
                    published_from: 100, published_to: EOT}],
        parentEarliestValidFrom: 50, parentHasPublishedCurrent: false, parentIsLive: false,
    };
    const kinds = validateFacts([child]).map(p => p.invariant);
    assert(kinds.includes("published-child-of-unpublished-parent"), kinds.join());
    assert(kinds.includes("live-child-of-deleted-parent"), kinds.join());
    // The same child under a present parent is clean.
    assertEquals(validateFacts([{...child,
        parentHasPublishedCurrent: true, parentIsLive: true}]), []);
    // A top-level fact (parent = root, undefined flags) is never an orphan.
    assertEquals(validateFacts([{...child, path: "dct/ent:1000", ty: "ent", id: 1000,
        parentHasPublishedCurrent: undefined, parentIsLive: undefined,
        parentEarliestValidFrom: undefined}]), []);
});

// --- The repair -------------------------------------------------------------

test("repair: cascade-tombstones a dangling live child; idempotent; leaves live subtrees alone", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            seedClean(fx);
            // Legacy missed cascade: the subentry deleted, its category left live+published.
            db().execute(
                `UPDATE dict SET valid_to = valid_from WHERE id = 1100 AND valid_to = ${EOT}`, {});
        });
        as(fx, "system", () => {
            const n = repairOrphanedLiveChildren();
            assertEquals(n, 1);                                   // the orphaned category
            // The category is now a tombstone, unpublished.
            const cat = db().all<any,any>(
                `SELECT valid_from, valid_to, published_to FROM dict WHERE id=1110 ORDER BY valid_from DESC LIMIT 1`, {})[0];
            assertEquals(cat.valid_from, cat.valid_to);          // tombstone
            assertEquals(cat.published_to, null);                // publication cleared
            // Idempotent, and the spelling/status (live children of the still-live
            // ENTRY) are untouched.
            assertEquals(repairOrphanedLiveChildren(), 0);
            assertEquals(db().all<any,any>(
                `SELECT COUNT(*) c FROM dict WHERE id=1010 AND valid_to=${EOT}`, {})[0].c, 1);
        });
    });
});
