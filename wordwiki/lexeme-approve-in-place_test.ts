// deno-lint-ignore-file no-explicit-any
/**
 * Approve-in-place: a pending fact's ☰ in the EDITOR (edit mode) offers
 * Approve to an actor who may approve it (approve permission + the
 * two-person rule) - so an approver doesn't have to flip to review mode to
 * settle a change they just witnessed.  Same reviewApprove verb as review
 * mode; its emission is the union of both looks' keys.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, as, TestTimeline, mkEntry, mkChild, mkEdit,
         bornApprove, type Fixture } from "./testing.ts";
import { markupToString } from "../liminal/markup.ts";

// The changes-mode tests' clean seed: spelling, status, subentry, category,
// gloss - all born-approved so tests chain pending versions onto a clean
// published baseline.
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

const metaHtml = (fx: Fixture) => markupToString(fx.ww.lexeme.renderMetaEntry(1000));

test("approve-in-place: a clean entry offers no Approve in any fact ☰", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            seedClean(fx);
            assertEquals(metaHtml(fx).includes("lm-act-approve"), false);
        });
    });
});

test("approve-in-place: an approver sees Approve on the pending fact only", async () => {
    await withTestDb((fx) => {
        const {tl, gls} = as(fx, "djz", () => seedClean(fx));
        as(fx, {actorId: fx.userIds["dmm"], roles: ["approve"]}, () => {
            fx.ww.applyTransaction([mkEdit(gls, 2010, tl.next(),
                                           {attr1: "water pail", change_by_username: "dmm"})],
                                   {quiet: true});
        });
        as(fx, {actorId: fx.userIds["djz"], roles: ["approve"]}, () => {
            const page = metaHtml(fx);
            // Exactly the one pending fact carries the verb.
            assertEquals(page.split("lm-act-approve").length - 1, 1);
            assertStringIncludes(page, `reviewApprove(1000, ${gls.id})`);
        });
    });
});

test("approve-in-place: the two-person rule hides Approve from the author", async () => {
    await withTestDb((fx) => {
        const {tl, gls} = as(fx, "djz", () => seedClean(fx));
        // dmm holds 'approve' but authored the change - no self-approve.
        as(fx, {actorId: fx.userIds["dmm"], roles: ["approve"]}, () => {
            fx.ww.applyTransaction([mkEdit(gls, 2010, tl.next(),
                                           {attr1: "water pail", change_by_username: "dmm"})],
                                   {quiet: true});
            assertEquals(metaHtml(fx).includes("lm-act-approve"), false);
        });
    });
});

test("approve-in-place: no approve permission, no Approve", async () => {
    await withTestDb((fx) => {
        const {tl, gls} = as(fx, "djz", () => seedClean(fx));
        as(fx, {actorId: fx.userIds["dmm"], roles: []}, () => {
            fx.ww.applyTransaction([mkEdit(gls, 2010, tl.next(),
                                           {attr1: "water pail", change_by_username: "djz"})],
                                   {quiet: true});
            assertEquals(metaHtml(fx).includes("lm-act-approve"), false);
        });
    });
});

test("approve-in-place: reviewApprove settles the fact and emits both looks' keys", async () => {
    await withTestDb((fx) => {
        const {tl, gls} = as(fx, "djz", () => seedClean(fx));
        as(fx, {actorId: fx.userIds["dmm"], roles: ["approve"]}, () => {
            fx.ww.applyTransaction([mkEdit(gls, 2010, tl.next(),
                                           {attr1: "water pail", change_by_username: "dmm"})],
                                   {quiet: true});
        });
        as(fx, {actorId: fx.userIds["djz"], roles: ["approve"]}, () => {
            const r = fx.ww.lexeme.reviewApprove(1000, gls.id);
            assertEquals(r.action, "reload");
            // The union: the review page's group + count, AND the editor's
            // fact fragment (the pending dot clears in place).
            assert(r.targets.includes(`.-review-group-${gls.id}-`));
            assert(r.targets.includes(`.-review-pending-1000-`));
            assert(r.targets.includes(`.-fact-${gls.id}-`));
            const page = metaHtml(fx);
            assertEquals(page.includes("lm-act-approve"), false);   // settled
            assertEquals(page.includes("unapproved"), false);
        });
    });
});
