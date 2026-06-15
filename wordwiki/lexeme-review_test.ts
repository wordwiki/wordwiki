// deno-lint-ignore-file no-explicit-any
/**
 * Review mode of the lexeme editor (publication-model.md): the structured
 * lexeme shown diffed against its published baseline, with approve / revert /
 * comment.  Two layers are tested here:
 *   - classifyFact (versioned-model.ts): the pure per-fact classification the
 *     renderer and the pending-count read;
 *   - the rendered review surface + the review actions, end-to-end over the
 *     in-memory workspace (render -> act -> render).
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, as, TestTimeline, mkEntry, mkChild, mkEdit, mkTombstone,
         bornApprove, type Fixture } from "./testing.ts";
import { classifyFact } from "./versioned-model.ts";
import { markupToString } from "../liminal/markup.ts";
import * as timestamp from "../liminal/timestamp.ts";

const EOT = timestamp.END_OF_TIME;

// --- classifyFact (pure) --------------------------------------------------------

// A version row, just the fields classifyFact reads.
function v(o: Partial<{valid_from: number, valid_to: number, published_from: number|null,
                       published_to: number|null, change_action: string|null}>): any {
    return {valid_from: 1000, valid_to: EOT, published_from: null, published_to: null,
            change_action: null, ...o};
}

test("classifyFact: clean = the content IS the published-current version", () => {
    const r = classifyFact([v({published_from: 1000, published_to: EOT})], EOT);
    assertEquals(r.state, "clean");
    assertEquals(r.baseline, r.content);
});

test("classifyFact: added = a live fact with no published baseline", () => {
    const r = classifyFact([v({})], EOT);
    assertEquals(r.state, "added");
    assertEquals(r.baseline, undefined);
});

test("classifyFact: edited = a pending version over a published baseline", () => {
    const base = v({valid_from: 1000, valid_to: 2000, published_from: 1000, published_to: EOT});
    const edit = v({valid_from: 2000, valid_to: EOT});  // pending (published_from null)
    const r = classifyFact([base, edit], EOT);
    assertEquals(r.state, "edited");
    assertEquals(r.baseline, base);
    assertEquals(r.content, edit);
});

test("classifyFact: removed = a tombstone over a still-published baseline", () => {
    const base = v({valid_from: 1000, valid_to: 2000, published_from: 1000, published_to: EOT});
    const tomb = v({valid_from: 2000, valid_to: 2000});  // empty interval = tombstone
    assertEquals(classifyFact([base, tomb], EOT).state, "removed");
});

test("classifyFact: hidden = a settled deletion (no standing published value)", () => {
    const made = v({valid_from: 1000, valid_to: 2000});
    const tomb = v({valid_from: 2000, valid_to: 2000});  // never published, then deleted
    assertEquals(classifyFact([made, tomb], EOT).state, "hidden");
});

test("classifyFact: a comment never changes the state; it is collected separately", () => {
    const base = v({published_from: 1000, published_to: EOT});
    const note = v({change_action: "comment"});  // re-asserts the value as discussion
    const r = classifyFact([base, note], EOT);
    assertEquals(r.state, "clean");
    assertEquals(r.comments, [note]);
});

// --- Rendered review surface + actions ------------------------------------------

// A Completed entry: one spelling, one subentry, one category - then born-
// approved, so every fact starts published (clean).  Returns the seed
// assertions so the test can chain pending versions onto them.
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
    bornApprove(fx.ww);
    return {tl, e, spl, sub, cat};
}

const reviewHtml = (fx: Fixture) =>
    markupToString(fx.ww.lexeme.renderEntry(1000, "review"));
const editHtml = (fx: Fixture) =>
    markupToString(fx.ww.lexeme.renderEntry(1000, "edit"));

test("review render: a fully-approved entry is clean - no badges, nothing pending", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            seedClean(fx);
            const html = reviewHtml(fx);
            assertStringIncludes(html, "Reviewing");
            assertStringIncludes(html, "nothing pending");
            assertEquals(html.includes("badge text-bg-success"), false);  // no 'new'
            assertEquals(html.includes("deletion proposed"), false);
            assertStringIncludes(html, "samqwan");                        // the clean value shows
        });
    });
});

test("review render: a pending EDIT shows old->new, the badge, and provenance", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, spl} = seedClean(fx);
            // A pending edit of the spelling (born-approved baseline still stands).
            fx.ww.applyTransaction([mkEdit(spl, 2010, tl.next(), {attr1: "samqwann"})],
                                   {quiet: true});
            const html = reviewHtml(fx);
            assertStringIncludes(html, "edited");
            assertStringIncludes(html, "lm-diff-new");
            assertStringIncludes(html, "samqwan");    // struck baseline
            assertStringIncludes(html, "samqwann");   // proposed value
            assertStringIncludes(html, "edited by");
            // 1 change pending (the spelling).
            assertStringIncludes(html, "1 change pending approval");
        });
    });
});

test("review render: a pending ADD is badged 'new'", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, sub} = seedClean(fx);
            fx.ww.applyTransaction([mkChild(sub, "cat", 2200, tl.next(),
                                            {attr1: "weather", order_key: "0.6"})], {quiet: true});
            const html = reviewHtml(fx);
            assertStringIncludes(html, "badge text-bg-success");  // 'new'
            assertStringIncludes(html, "weather");
        });
    });
});

test("review render: a pending DELETION surfaces (overlay walk) though it is gone from edit view", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, cat} = seedClean(fx);
            fx.ww.applyTransaction([mkTombstone(cat, 2110, tl.next())], {quiet: true});

            // Edit mode (current view) drops the deleted category entirely...
            assertEquals(editHtml(fx).includes("water"), false);
            // ...but review mode shows it, struck, as a pending removal.
            const html = reviewHtml(fx);
            assertStringIncludes(html, "deletion proposed");
            assertStringIncludes(html, "water");
            assertStringIncludes(html, "Approve deletion");
        });
    });
});

test("review action: approving a pending edit publishes it and the fact goes clean", async () => {
    await withTestDb((fx) => {
        // Author the edit as djz; approve as dmm (the two-person rule).
        as(fx, "djz", () => {
            const {tl, spl} = seedClean(fx);
            fx.ww.applyTransaction([mkEdit(spl, 2010, tl.next(), {attr1: "samqwann"})],
                                   {quiet: true});
            assertStringIncludes(reviewHtml(fx), "edited");
        });
        as(fx, "dmm", () => {
            fx.ww.lexemeOps.approveFact(1010);   // the spelling fact id
            const html = reviewHtml(fx);
            assertEquals(html.includes("edited"), false);   // reclassified clean
            assertStringIncludes(html, "nothing pending");
            assertStringIncludes(html, "samqwann");
        });
    });
});

test("review action: a comment renders inline and never publishes", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            seedClean(fx);
            fx.ww.lexemeOps.commentFact(1010, "is this the Listuguj spelling?");
            const html = reviewHtml(fx);
            assertStringIncludes(html, "lm-review-comment");
            assertStringIncludes(html, "is this the Listuguj spelling?");
            // The fact stays clean (a comment is not a content change).
            assertStringIncludes(html, "nothing pending");
        });
    });
});

test("two-person rule: Approve is hidden for self-authored content, shown for a peer", async () => {
    await withTestDb((fx) => {
        // Seed under djz (admin) and capture the CLEAN spelling assertion, then
        // chain a pending edit onto it - authored by djz (change_by_username
        // rides on the copied row).
        let spl: any, tl: TestTimeline;
        as(fx, "djz", () => {
            const seed = seedClean(fx);
            spl = seed.spl; tl = seed.tl;
            fx.ww.applyTransaction([mkEdit(spl, 2010, tl.next(),
                                           {attr1: "samqwann", change_by_username: "djz"})],
                                   {quiet: true});
        });
        // The author reviewing their OWN change, holding only the approve role
        // (no admin => no self-approve): Approve is hidden, revert still offered.
        as(fx, {actorId: fx.userIds["djz"], roles: ["approve"]}, () => {
            const html = reviewHtml(fx);
            assertStringIncludes(html, "edited");
            assertEquals(html.includes("reviewApprove"), false);
            assertStringIncludes(html, "revertDialog");
        });
        // A different approver (dmm) sees Approve.
        as(fx, {actorId: fx.userIds["dmm"], roles: ["approve"]}, () => {
            assertStringIncludes(reviewHtml(fx), "reviewApprove");
        });
    });
});
