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
import { isRedirectResponse } from "../liminal/http-server.ts";
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

const reviewHtml = (fx: Fixture, participant = "", full = "", since = 0) =>
    markupToString(fx.ww.lexeme.renderEntry(1000, "review", participant, full, since));
const editHtml = (fx: Fixture) =>
    markupToString(fx.ww.lexeme.renderEntry(1000, "edit"));

test("review queue: a fully-approved entry has no groups - nothing needs approving", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            seedClean(fx);
            const html = reviewHtml(fx);
            assertStringIncludes(html, "Reviewing");
            assertStringIncludes(html, "nothing pending");
            assertStringIncludes(html, "Nothing needs approving");
            assertEquals(html.includes("lm-cl-group"), false);   // no pending groups
            assertStringIncludes(html, "Showing: Everyone");      // admin -> Everyone

            // The accepted history is still reachable via Full history.
            const full = reviewHtml(fx, "everyone", "full");
            assertStringIncludes(full, "lm-cl-group");
            assertStringIncludes(full, "samqwan");                // the accepted value
        });
    });
});

test("review queue: a pending EDIT is one group with the field header, from/to, and the ☰", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, spl} = seedClean(fx);
            // Distinct value so the baseline and the proposal are unambiguous.
            fx.ww.applyTransaction([mkEdit(spl, 2010, tl.next(), {attr1: "XYZZY"})],
                                   {quiet: true});
            const html = reviewHtml(fx);
            assertStringIncludes(html, "lm-cl-group-header");  // grouped by fact
            assertStringIncludes(html, "needs approval");      // the group badge
            assertStringIncludes(html, "lm-cl-detail");        // the change (from/to)
            assertStringIncludes(html, "samqwan");             // the change's "from"
            assertStringIncludes(html, "XYZZY");               // proposed value
            assertStringIncludes(html, "btn-success");         // the DIRECT Approve button
            assertStringIncludes(html, "reviewApprove");       // ...wired to approve
            assertStringIncludes(html, "revertDialog");        // the direct Reject button
            assertStringIncludes(html, "historyDialog");       // revert-to-a-past-value picker (☰)
            assertStringIncludes(html, "1 change pending approval");
        });
    });
});

test("review queue: a small edit shows a char-level diff (the changed letter highlighted)", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, spl} = seedClean(fx);
            // A one-letter change (samqwan -> samqwann), not a total rewrite.
            fx.ww.applyTransaction([mkEdit(spl, 2010, tl.next(), {attr1: "samqwann"})],
                                   {quiet: true});
            const html = reviewHtml(fx);
            assertStringIncludes(html, "lm-cl-detail");          // the change block
            assertStringIncludes(html, "lm-diff-ins'>n</span>"); // only the added letter is marked
        });
    });
});

test("review queue: an edit NOTE rides the event as a sub-line", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, spl} = seedClean(fx);
            fx.ww.applyTransaction([mkEdit(spl, 2010, tl.next(),
                                           {attr1: "XYZZY", change_note: "per the 1888 Rand citation"})],
                                   {quiet: true});
            const html = reviewHtml(fx);
            assertStringIncludes(html, "lm-cl-note");
            assertStringIncludes(html, "per the 1888 Rand citation");
        });
    });
});

test("review queue: a pending ADD is a group with an 'added' event", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, sub} = seedClean(fx);
            fx.ww.applyTransaction([mkChild(sub, "cat", 2200, tl.next(),
                                            {attr1: "weather", order_key: "0.6"})], {quiet: true});
            const html = reviewHtml(fx);
            assertStringIncludes(html, "lm-cl-group");
            assertStringIncludes(html, "lm-cl-added");   // the 'added' event class
            assertStringIncludes(html, "weather");
        });
    });
});

test("review queue: a pending DELETION is a group (overlay walk), gone from edit view", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, cat} = seedClean(fx);
            fx.ww.applyTransaction([mkTombstone(cat, 2110, tl.next())], {quiet: true});

            // Edit mode (current view) drops the deleted category entirely...
            assertEquals(editHtml(fx).includes("water"), false);
            // ...but the queue shows a 'deleted' group, still approvable.
            const html = reviewHtml(fx);
            assertStringIncludes(html, "lm-cl-group");
            assertStringIncludes(html, "lm-cl-deleted");
            assertStringIncludes(html, "water");           // the value being removed
            assertStringIncludes(html, "Approve deletion");
        });
    });
});

test("review: full-history reveals settled facts + versions before the baseline", async () => {
    await withTestDb((fx) => {
        // samqwan published; edited to XYZZY; approved (XYZZY becomes the
        // baseline, samqwan is now a PRE-baseline version).
        as(fx, "djz", () => {
            const {tl, spl} = seedClean(fx);
            fx.ww.applyTransaction([mkEdit(spl, 2010, tl.next(), {attr1: "XYZZY"})], {quiet: true});
        });
        as(fx, "dmm", () => fx.ww.lexemeOps.approveFact(1010));
        as(fx, "djz", () => {
            // The queue (default) is now empty - nothing pending.
            const since = reviewHtml(fx, "everyone", "");
            assertStringIncludes(since, "Nothing needs approving");
            // Full history reveals the (now settled) spelling group, back to the
            // original value.
            const full = reviewHtml(fx, "everyone", "full");
            assertStringIncludes(full, "lm-cl-group");
            assertStringIncludes(full, "samqwan");           // pre-baseline value
            assertStringIncludes(full, "XYZZY");             // accepted value
            // The approval (now the baseline) keeps its "approved" chip.
            assertStringIncludes(full, "lm-cl-chip-approved");
            assertStringIncludes(full, "Full history ✓");
        });
    });
});

test("review count: excludes imported-unapproved drafts, matching the visible groups", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, sub} = seedClean(fx);   // a clean, born-approved baseline
            // Two new pending drafts: one from the automated import, one human.
            fx.ww.applyTransaction([mkChild(sub, "cat", 1130, tl.next(),
                                            {attr1: "imported-cat", order_key: "0.55",
                                             change_by_username: "~category-import"})], {quiet: true});
            fx.ww.applyTransaction([mkChild(sub, "cat", 1140, tl.next(),
                                            {attr1: "human-cat", order_key: "0.6",
                                             change_by_username: "djz"})], {quiet: true});

            const html = reviewHtml(fx);   // queue, everyone
            // The human draft is a group + counted; the imported draft is neither.
            assertStringIncludes(html, "human-cat");
            assertEquals(html.includes("imported-cat"), false);
            assertStringIncludes(html, "1 change pending approval");   // not "2"
        });
    });
});

test("review: full history hides the imported base set (automated authorship)", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const tl = new TestTimeline();
            const e = mkEntry(1000, tl.next());
            fx.ww.applyTransaction([e], {quiet: true});
            fx.ww.applyTransaction([mkChild(e, "spl", 1010, tl.next(),
                                            {attr1: "samqwan", order_key: "0.5"})], {quiet: true});
            fx.ww.applyTransaction([mkChild(e, "sta", 1020, tl.next(),
                                            {attr1: "Completed", order_key: "0.5"})], {quiet: true});
            const sub = mkChild(e, "sub", 1100, tl.next(), {order_key: "0.5"});
            fx.ww.applyTransaction([sub], {quiet: true});
            // One category from the automated import, one authored by a person.
            fx.ww.applyTransaction([mkChild(sub, "cat", 1110, tl.next(),
                                            {attr1: "imported-cat", order_key: "0.5",
                                             change_by_username: "~category-import"})], {quiet: true});
            fx.ww.applyTransaction([mkChild(sub, "cat", 1140, tl.next(),
                                            {attr1: "human-cat", order_key: "0.6",
                                             change_by_username: "djz"})], {quiet: true});
            bornApprove(fx.ww);

            const full = reviewHtml(fx, "everyone", "full");
            assertStringIncludes(full, "human-cat");                  // human activity stays
            assertEquals(full.includes("imported-cat"), false);      // the import base set is gone
        });
    });
});

test("review: the participant filter shows only the chosen user's threads", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, sub, cat} = seedClean(fx);
            // 'sally' edits the existing category; djz proposes a new one.  (We
            // probe with category values, not the spelling - the spelling is in
            // the entry heading regardless of the filter.)
            fx.ww.applyTransaction([mkEdit(cat, 2110, tl.next(),
                                           {attr1: "fire", change_by_username: "sally"})], {quiet: true});
            fx.ww.applyTransaction([mkChild(sub, "cat", 2120, tl.next(),
                                            {attr1: "land", order_key: "0.7",
                                             change_by_username: "djz"})], {quiet: true});

            // Everyone: both threads show.
            const all = reviewHtml(fx, "everyone");
            assertStringIncludes(all, "fire");
            assertStringIncludes(all, "land");

            // Sally: only the category she touched; djz's new one is filtered out.
            const sally = reviewHtml(fx, "sally");
            assertStringIncludes(sally, "fire");
            assertEquals(sally.includes("land"), false);
        });
    });
});

test("review refresh is scoped: actions touch the group + count fragment, not the whole entry", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, spl} = seedClean(fx);
            fx.ww.applyTransaction([mkEdit(spl, 2010, tl.next(), {attr1: "XYZZY"})], {quiet: true});

            // The group is its OWN reloadable htmx fragment; the count is another.
            const html = reviewHtml(fx);
            assertStringIncludes(html, "-review-group-1010-");
            assertStringIncludes(html, "renderReviewGroupFragment(1000, 1010");
            assertStringIncludes(html, "-review-pending-1000-");

            // The approve action reloads ONLY those two - never the entry root.
            const r = fx.ww.lexeme.reviewApprove(1000, 1010);
            assertEquals(r, {action: "reload",
                             targets: [".-review-group-1010-", ".-review-pending-1000-"]});

            // After approval the group fragment re-renders to nothing (it removes
            // itself), while full history still shows the now-settled fact.
            assertEquals(markupToString(
                fx.ww.lexeme.renderReviewGroupFragment(1000, 1010, "everyone", "")), "");
            assertStringIncludes(
                markupToString(fx.ww.lexeme.renderReviewGroupFragment(1000, 1010, "everyone", "full")),
                "lm-cl-group-header");
        });
    });
});

test("review action: approving a pending edit clears it from the queue", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, spl} = seedClean(fx);
            fx.ww.applyTransaction([mkEdit(spl, 2010, tl.next(), {attr1: "XYZZY"})],
                                   {quiet: true});
            assertStringIncludes(reviewHtml(fx), "lm-cl-group"); // a pending group is present
        });
        as(fx, "dmm", () => {
            fx.ww.lexemeOps.approveFact(1010);   // the spelling fact id
            const html = reviewHtml(fx);
            assertStringIncludes(html, "nothing pending");
            assertStringIncludes(html, "Nothing needs approving");  // queue cleared
            assertEquals(html.includes("lm-cl-group"), false);
            // The accepted value is the new baseline (visible in full history).
            assertStringIncludes(reviewHtml(fx, "everyone", "full"), "XYZZY");
        });
    });
});

test("review action: a comment never makes a fact pending (and shows in full history)", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            seedClean(fx);
            fx.ww.lexemeOps.commentFact(1010, "is this the Listuguj spelling?");
            // A comment is not a content change: the queue stays empty.
            const queue = reviewHtml(fx);
            assertStringIncludes(queue, "nothing pending");
            assertEquals(queue.includes("lm-cl-group"), false);
            // But the discussion is there in the full history.
            const full = reviewHtml(fx, "everyone", "full");
            assertStringIncludes(full, "lm-cl-chip-commented");   // the 'comment' kind chip
            assertStringIncludes(full, "is this the Listuguj spelling?");
        });
    });
});

test("edit dialog: carries an optional change-note field", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            seedClean(fx);
            const dialog = markupToString(fx.ww.lexeme.editDialog(1000, 1010));
            assertStringIncludes(dialog, "change_note");
            assertStringIncludes(dialog, "Note (optional)");
        });
    });
});

// --- Sitting receipts (the since-anchor) -----------------------------------------
//
// A review sitting is anchored at the db's top tx timestamp when the page was
// entered (`since`, stamped into the URL by entryPage).  A fact settled by a
// review action NEWER than the anchor stays in the queue as a receipt - flipped
// to "approved ✓"/"rejected" in place - instead of vanishing (which reads as
// "did that work?").  A fresh sitting (new anchor) starts with a clean queue.

test("review receipts: an approval during the sitting flips the group in place", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, spl} = seedClean(fx);
            fx.ww.applyTransaction([mkEdit(spl, 2010, tl.next(), {attr1: "XYZZY"})],
                                   {quiet: true});
        });
        const anchor = fx.ww.lastAllocatedTxTimestamp;   // the sitting opens on the pending edit
        as(fx, "dmm", () => fx.ww.lexemeOps.approveFact(1010));
        as(fx, "dmm", () => {
            // Within the sitting: the group stays, flipped to its outcome.
            const html = reviewHtml(fx, "everyone", "", anchor);
            assertStringIncludes(html, "lm-cl-group");
            assertStringIncludes(html, "approved ✓");
            assertStringIncludes(html, "XYZZY");                      // the accepted value
            assertStringIncludes(html, "lm-cl-chip-approved");        // ...with the approver's chip
            assertEquals(html.includes("needs approval"), false);     // no longer actionable
            assertEquals(html.includes("reviewApprove"), false);
            assertStringIncludes(html, "nothing pending");            // receipts aren't pending
            // A NEW sitting (anchored now): the settled fact has left the queue.
            const fresh = reviewHtml(fx, "everyone", "", fx.ww.lastAllocatedTxTimestamp);
            assertEquals(fresh.includes("lm-cl-group"), false);
            // No anchor (an old link / pre-anchor fragment URL): no receipts.
            assertEquals(reviewHtml(fx).includes("lm-cl-group"), false);
        });
    });
});

test("review receipts: a reject (revert) shows as a rejected receipt with its note", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, spl} = seedClean(fx);
            fx.ww.applyTransaction([mkEdit(spl, 2010, tl.next(), {attr1: "XYZZY"})],
                                   {quiet: true});
        });
        const anchor = fx.ww.lastAllocatedTxTimestamp;
        as(fx, "dmm", () => fx.ww.lexemeOps.revertFact(1010, "not attested in the sources"));
        as(fx, "dmm", () => {
            const html = reviewHtml(fx, "everyone", "", anchor);
            assertStringIncludes(html, "rejected");
            assertStringIncludes(html, "lm-cl-chip-reverted");
            assertStringIncludes(html, "not attested in the sources");
            assertEquals(html.includes("needs approval"), false);
        });
    });
});

test("review receipts: an approved DELETION stays visible as a receipt", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, cat} = seedClean(fx);
            fx.ww.applyTransaction([mkTombstone(cat, 2110, tl.next())], {quiet: true});
        });
        const anchor = fx.ww.lastAllocatedTxTimestamp;
        as(fx, "dmm", () => fx.ww.lexemeOps.approveFact(1110));   // the category fact
        as(fx, "dmm", () => {
            const html = reviewHtml(fx, "everyone", "", anchor);
            assertStringIncludes(html, "deletion approved ✓");
            assertStringIncludes(html, "water");                  // what was removed
            // A fresh sitting hides the settled deletion again.
            const fresh = reviewHtml(fx, "everyone", "", fx.ww.lastAllocatedTxTimestamp);
            assertEquals(fresh.includes("lm-cl-group"), false);
        });
    });
});

test("review receipts: the acted-on group fragment re-renders as a receipt, not empty", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, spl} = seedClean(fx);
            fx.ww.applyTransaction([mkEdit(spl, 2010, tl.next(), {attr1: "XYZZY"})],
                                   {quiet: true});
        });
        const anchor = fx.ww.lastAllocatedTxTimestamp;
        as(fx, "dmm", () => {
            // The anchored queue's group fragment carries the anchor in its own
            // hx-get, so the post-action reload re-renders with the same sitting.
            assertStringIncludes(reviewHtml(fx, "everyone", "", anchor),
                `renderReviewGroupFragment(1000, 1010, 'everyone', '', ${anchor})`);
            fx.ww.lexeme.reviewApprove(1000, 1010);
            const g = markupToString(fx.ww.lexeme.renderReviewGroupFragment(
                1000, 1010, "everyone", "", anchor));
            assertStringIncludes(g, "approved ✓");                // the in-place receipt
            // Un-anchored (legacy), the fragment still removes itself.
            assertEquals(markupToString(fx.ww.lexeme.renderReviewGroupFragment(
                1000, 1010, "everyone", "")), "");
        });
    });
});

test("entry page: an un-anchored visit redirects to the canonical URL with the anchor", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            seedClean(fx);
            const t = fx.ww.lastAllocatedTxTimestamp;
            const r: any = fx.ww.lexeme.entryPage(1000);
            assert(isRedirectResponse(r));
            // No space in the canonical URL (it would show as %20 in the bar).
            assertEquals(r.headers.Location, `/ww/wordwiki.entry(1000,${t})`);
            // The review-mode form keeps the mode across the redirect.
            const r2: any = fx.ww.lexeme.entryPage(1000, "review");
            assertEquals(r2.headers.Location,
                         `/ww/wordwiki.lexeme.entryPage(1000,'review',${t})`);
            // An anchored visit renders the page - no loop.
            assertEquals(isRedirectResponse(fx.ww.lexeme.entryPage(1000, "edit", t)), false);
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
            const html = reviewHtml(fx, "everyone");
            assertStringIncludes(html, "lm-cl-detail");               // the pending change
            assertEquals(html.includes("reviewApprove"), false);
            assertStringIncludes(html, "revertDialog");
        });
        // A different approver (dmm) sees Approve.
        as(fx, {actorId: fx.userIds["dmm"], roles: ["approve"]}, () => {
            assertStringIncludes(reviewHtml(fx), "reviewApprove");
        });
    });
});
