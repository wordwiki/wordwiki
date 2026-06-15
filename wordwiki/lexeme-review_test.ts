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

const reviewHtml = (fx: Fixture, participant = "", full = "") =>
    markupToString(fx.ww.lexeme.renderEntry(1000, "review", participant, full));
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
            fx.ww.applyTransaction([mkChild(sub, "cat", 1120, tl.next(),
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
