// deno-lint-ignore-file no-explicit-any
/**
 * The metadata editor's VIEW-CHANGES mode + Approve all
 * (meta-editor-changes-mode.md): the simple approval flow.  Pending rows
 * annotate what changed vs the published baseline ON their own line (no
 * hierarchy); pending deletions are listed IN THE BAR with their values;
 * Approve all approves exactly what the page shows, through the per-fact
 * approveFact verb (tree ordering, two-person rule).
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, as, TestTimeline, mkEntry, mkChild, mkEdit, mkTombstone,
         bornApprove, type Fixture } from "./testing.ts";
import { markupToString } from "../liminal/markup.ts";

// The review tests' clean seed (spelling, subentry, category) plus a GLOSS -
// the body row the changes-mode annotations hang off (the spelling lives only
// in the title, and the category is $view-hidden - both are BAR material).
// Everything born-approved (published) so tests chain pending versions onto a
// clean baseline.
function seedClean(fx: Fixture) {
    const tl = new TestTimeline();
    const e = mkEntry(1000, tl.next());
    fx.ww.applyTransaction([e], {quiet: true});
    const spl = mkChild(e, "spl", 1010, tl.next(), {attr1: "samqwan", order_key: "0.5"});
    fx.ww.applyTransaction([spl], {quiet: true});
    fx.ww.applyTransaction([mkChild(e, "sta", 1020, tl.next(),
                                    {attr1: "Completed", order_key: "0.5"})], {quiet: true});
    const sub = mkChild(e, "sub", 1100, tl.next(), {order_key: "0.5"});
    fx.ww.applyTransaction([sub], {quiet: true});
    const cat = mkChild(sub, "cat", 1110, tl.next(), {attr1: "water", order_key: "0.5"});
    fx.ww.applyTransaction([cat], {quiet: true});
    const gls = mkChild(sub, "gls", 1200, tl.next(), {attr1: "water bucket", order_key: "0.5"});
    fx.ww.applyTransaction([gls], {quiet: true});
    bornApprove(fx.ww);
    return {tl, e, spl, sub, cat, gls};
}

const metaHtml = (fx: Fixture, changes = false) =>
    markupToString(fx.ww.lexeme.renderMetaEntry(1000, changes));

test("changes mode: a clean entry shows no hint; changes view says so", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            seedClean(fx);
            assertEquals(metaHtml(fx).includes("unapproved"), false);
            assertStringIncludes(metaHtml(fx, true), "No unapproved changes.");
        });
    });
});

test("changes mode: a pending edit - hint in normal view; inline was-diff on the row", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, gls} = seedClean(fx);
            // "water bucket" -> "water pail": the diff has a real DELETION to strike.
            fx.ww.applyTransaction([mkEdit(gls, 2010, tl.next(), {attr1: "water pail"})],
                                   {quiet: true});

            const normal = metaHtml(fx);
            assertStringIncludes(normal, "1 unapproved change — view");   // the way in
            assertEquals(normal.includes("lm-me-chg-was"), false);        // ...but no annotations yet

            const changes = metaHtml(fx, true);
            assertStringIncludes(changes, "water pail");                  // current value, in place
            assertStringIncludes(changes, "lm-me-chg-was");               // "was:" on the same line
            assertStringIncludes(changes, "lm-diff-del'>bucket</span>");  // the replaced word, struck
            assertStringIncludes(changes, "approveAllChanges(1000)");     // admin sees Approve all
            // The mode survives reloads: the root fragment re-fetches ITSELF
            // in changes mode.
            assertStringIncludes(changes, "renderMetaEntry(1000, true)");
        });
    });
});

test("changes mode: a pending ADD gets the changelog's added chip", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, sub} = seedClean(fx);
            fx.ww.applyTransaction([mkChild(sub, "gls", 2200, tl.next(),
                                            {attr1: "pail of water", order_key: "0.6"})], {quiet: true});
            const changes = metaHtml(fx, true);
            assertStringIncludes(changes, "lm-cl-chip-added");
            assertStringIncludes(changes, "pail of water");
        });
    });
});

test("changes mode: a MOVE (identical values, new order key) says 'moved', not 'was: <same>'", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, gls} = seedClean(fx);
            fx.ww.applyTransaction([mkEdit(gls, 2010, tl.next(),
                                           {attr1: "water bucket", order_key: "0.7"})],
                                   {quiet: true});
            const changes = metaHtml(fx, true);
            assertStringIncludes(changes, ">moved</span>");
            assertEquals(changes.includes("lm-me-chg-was"), false);   // no "was: <the same thing>"
            assertStringIncludes(changes, "1 unapproved change");     // still pending, still counted

            fx.ww.lexeme.approveAllChanges(1000);                     // ...and approvable
            assertStringIncludes(metaHtml(fx, true), "No unapproved changes.");
        });
    });
});

test("changes mode: a HEADWORD edit annotates its row (the edit body shows spelling)", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, spl} = seedClean(fx);
            fx.ww.applyTransaction([mkEdit(spl, 2010, tl.next(), {attr1: "samqwen"})],
                                   {quiet: true});
            const changes = metaHtml(fx, true);
            assertStringIncludes(changes, "Spelling: ");                  // the editable section
            assertStringIncludes(changes, "samqwen");                     // new value on the row
            assertStringIncludes(changes, "lm-me-chg-was");               // "was:" inline
            assertStringIncludes(changes, "lm-diff-del'>a</span>");       // the struck old letter
        });
    });
});

test("changes mode: hidden editorial relations render in the EDITOR - edits annotate the row", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, cat} = seedClean(fx);
            // Category is $view.hidden (no READ view) but the editor shows
            // everything (dz), so its pending edit annotates its own row -
            // nothing hides from the page Approve all acts on.
            fx.ww.applyTransaction([mkEdit(cat, 2020, tl.next(), {attr1: "weather"})],
                                   {quiet: true});
            const changes = metaHtml(fx, true);
            assertStringIncludes(changes, "1 unapproved change");
            assertStringIncludes(changes, "Category: ");                  // the editorial row
            assertStringIncludes(changes, "weather");                     // its new value
            assertStringIncludes(changes, "lm-me-chg-was");               // annotated in place
            // ...and the read views still hide it.
            assertEquals(metaHtml(fx).includes("Category: ") &&
                         markupToString(fx.ww.wordView(1000).body).includes("Category: "), false);

            fx.ww.lexeme.approveAllChanges(1000);
            assertStringIncludes(metaHtml(fx, true), "No unapproved changes.");
        });
    });
});

test("changes mode: a pending DELETION is listed in the bar WITH its value", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, cat} = seedClean(fx);
            fx.ww.applyTransaction([mkTombstone(cat, 2110, tl.next())], {quiet: true});
            const changes = metaHtml(fx, true);
            assertStringIncludes(changes, "lm-cl-chip-deleted");
            assertStringIncludes(changes, "water");        // the deleted VALUE, from the baseline
            assertStringIncludes(changes, "1 unapproved change");
        });
    });
});

test("approve all: publishes edits and deletions; the page comes back clean", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {                        // admin: may self-approve
            const {tl, spl, cat} = seedClean(fx);
            fx.ww.applyTransaction([mkEdit(spl, 2010, tl.next(), {attr1: "samqwen"})],
                                   {quiet: true});
            fx.ww.applyTransaction([mkTombstone(cat, 2110, tl.next())], {quiet: true});
            assertStringIncludes(metaHtml(fx, true), "2 unapproved changes");

            const r = fx.ww.lexeme.approveAllChanges(1000);
            assertEquals(r.action, "reload");

            const changes = metaHtml(fx, true);
            assertStringIncludes(changes, "No unapproved changes.");
            assertEquals(changes.includes("lm-pending-dot"), false);
            assertEquals(changes.includes("lm-me-chg-was"), false);
        });
    });
});

test("approve all: a pending parent AND its child publish together (tree order)", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, e} = seedClean(fx);
            // A NEW subentry (structural - counts as no visible change) with a
            // new category under it: the child cannot publish before the
            // parent, so approve-all must run top-down.
            const sub2 = mkChild(e, "sub", 3100, tl.next(), {order_key: "0.7"});
            fx.ww.applyTransaction([sub2], {quiet: true});
            fx.ww.applyTransaction([mkChild(sub2, "cat", 3110, tl.next(),
                                            {attr1: "sky", order_key: "0.5"})], {quiet: true});
            // Only the category is a VISIBLE change (the subentry is structure).
            assertStringIncludes(metaHtml(fx, true), "1 unapproved change");

            fx.ww.lexeme.approveAllChanges(1000);
            assertStringIncludes(metaHtml(fx, true), "No unapproved changes.");
        });
    });
});

test("approve all: nested pending DELETIONS publish bottom-up (child before parent)", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, sub, cat} = seedClean(fx);
            // Delete the child then the parent; approving the PARENT deletion
            // first would violate the no-published-child-under-removed-parent
            // gate, so approve-all must reverse the visit order.
            fx.ww.applyTransaction([mkTombstone(cat, 2110, tl.next())], {quiet: true});
            fx.ww.applyTransaction([mkTombstone(sub, 2100, tl.next())], {quiet: true});

            fx.ww.lexeme.approveAllChanges(1000);
            assertStringIncludes(metaHtml(fx, true), "No unapproved changes.");
        });
    });
});

test("approve all: the two-person rule SKIPS your own changes (they stay pending)", async () => {
    await withTestDb((fx) => {
        const {tl, gls} = as(fx, "djz", () => seedClean(fx));
        // dmm authors an edit, then tries to approve-all WITHOUT admin (a
        // plain 'approve' role may not self-approve) - the edit must survive.
        as(fx, {actorId: fx.userIds["dmm"], roles: ["approve"]}, () => {
            fx.ww.applyTransaction([mkEdit(gls, 2010, tl.next(),
                                           {attr1: "water pail", change_by_username: "dmm"})],
                                   {quiet: true});
            fx.ww.lexeme.approveAllChanges(1000);
            assertStringIncludes(metaHtml(fx, true), "1 unapproved change");
        });
        // A DIFFERENT approver may approve it.
        as(fx, {actorId: fx.userIds["djz"], roles: ["approve"]}, () => {
            fx.ww.lexeme.approveAllChanges(1000);
            assertStringIncludes(metaHtml(fx, true), "No unapproved changes.");
        });
    });
});

test("changes bar: without approve permission there is no Approve all", async () => {
    await withTestDb((fx) => {
        const {tl, gls} = as(fx, "djz", () => seedClean(fx));
        as(fx, {actorId: fx.userIds["dmm"], roles: []}, () => {
            fx.ww.applyTransaction([mkEdit(gls, 2010, tl.next(), {attr1: "water pail"})],
                                   {quiet: true});
            const changes = metaHtml(fx, true);
            assertStringIncludes(changes, "lm-me-chg-was");   // the annotations still show
            assertEquals(changes.includes("approveAllChanges"), false);
        });
    });
});
