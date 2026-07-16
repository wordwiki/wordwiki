// deno-lint-ignore-file no-explicit-any
/**
 * The global change feed (change-feed.ts).  Three layers:
 *   - the pure clumping + page-cut functions (session semantics, coverage);
 *   - the feed queries' EXPLAIN QUERY PLAN pins (index ranges, never a scan);
 *   - the rendered feed over the in-memory workspace (clump headers, status
 *     badges tracking later approvals, the immutable-cursor semantics, the
 *     participant filter, and the cursor-stamping redirect).
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, as, mkEntry, mkChild, mkEdit, bornApprove, TestTimeline,
         type Fixture } from "./testing.ts";
import { clumpFeedEvents, cutFeedSlice, feedQueryShapes, feedQuery,
         type FeedEvent, type FeedQuery } from "./change-feed.ts";
import { createAssertionDml } from "./assertion.ts";
import { Db, db, setDefaultDb } from "../liminal/db.ts";
import { isRedirectResponse } from "../liminal/http-server.ts";
import { isTopLevelMarkup } from "../liminal/liminal.ts";
import { markupToString } from "../liminal/markup.ts";
import * as timestamp from "../liminal/timestamp.ts";

// --- Clumping (pure) --------------------------------------------------------------

// A feed event `sec` seconds into an arbitrary (realistic) timeline.
const BASE_SEC = 10_000_000;
const at = (sec: number) => timestamp.makeTimestamp(BASE_SEC + sec, 0);
const ev = (entry_id: number, username: string, sec: number, id = entry_id * 10):
    FeedEvent => ({valid_from: at(sec), id, entry_id, username});

test("clump: one editor's tight run on one lexeme is one clump, events oldest-first", () => {
    const clumps = clumpFeedEvents([ev(1, "sally", 120), ev(1, "sally", 0), ev(1, "sally", 60)]);
    assertEquals(clumps.length, 1);
    assertEquals(clumps[0].events.map(e => e.valid_from), [at(0), at(60), at(120)]);
    assertEquals(clumps[0].from, at(0));
    assertEquals(clumps[0].to, at(120));
});

test("clump: a gap over 30 minutes splits the same editor's work", () => {
    const clumps = clumpFeedEvents([ev(1, "sally", 0), ev(1, "sally", 1801)]);
    assertEquals(clumps.length, 2);
    // ...while exactly-30-minutes does not.
    assertEquals(clumpFeedEvents([ev(1, "sally", 0), ev(1, "sally", 1800)]).length, 1);
});

test("clump: another editor touching the lexeme closes the clump (three clumps result)", () => {
    const clumps = clumpFeedEvents([
        ev(1, "sally", 0), ev(1, "dmm", 60), ev(1, "sally", 120)]);
    assertEquals(clumps.length, 3);
});

test("clump: the editor's work on OTHER lexemes in between does not split", () => {
    const clumps = clumpFeedEvents([
        ev(1, "sally", 0), ev(2, "sally", 60), ev(1, "sally", 120)]);
    assertEquals(clumps.length, 2);   // one per lexeme, both intact
    const c1 = clumps.find(c => c.entry_id === 1)!;
    assertEquals(c1.events.length, 2);
});

test("clump: newest activity first", () => {
    const clumps = clumpFeedEvents([ev(1, "sally", 0), ev(2, "dmm", 60)]);
    assertEquals(clumps.map(c => c.entry_id), [2, 1]);
});

// --- The page cut (pure) ----------------------------------------------------------

test("cut: keeps whole clumps to the target; nextBefore covers everything below", () => {
    // A (2 events, newest) then B; target 1 keeps just A, whole.
    const clumps = clumpFeedEvents([
        ev(1, "sally", 3600), ev(1, "sally", 3660), ev(2, "dmm", 0)]);
    const {kept, nextBefore} = cutFeedSlice(clumps, 1, true);
    assertEquals(kept.map(c => c.entry_id), [1]);
    assertEquals(kept[0].events.length, 2);
    assertEquals(nextBefore, at(3600) - 1);   // B renders on the next page
});

test("cut: a clump interleaved with the kept one is pulled in whole (the fixpoint)", () => {
    // A spans 0..600; B sits inside at 300.  Keeping A must keep B too - the
    // page shows EXACTLY the events at or above its cut timestamp.
    const clumps = clumpFeedEvents([
        ev(1, "sally", 0), ev(1, "sally", 600), ev(2, "dmm", 300)]);
    const {kept, nextBefore} = cutFeedSlice(clumps, 1, true);
    assertEquals(kept.length, 2);
    assertEquals(nextBefore, undefined);      // nothing left below
});

test("cut: reaching the beginning of the record ends the paging", () => {
    const {kept, nextBefore} = cutFeedSlice(clumpFeedEvents([ev(1, "sally", 0)]), 50, true);
    assertEquals(kept.length, 1);
    assertEquals(nextBefore, undefined);
    // ...but a full fetch window means more may exist below the horizon.
    const more = cutFeedSlice(clumpFeedEvents([ev(1, "sally", 0)]), 50, false);
    assertEquals(more.nextBefore, at(0) - 1);
});

// --- Relative time (pure) ---------------------------------------------------------

test("relative time: reads without date arithmetic at every scale", () => {
    const NOW = 1_800_000_000_000;   // an arbitrary wall-clock instant (ms)
    const agoT = (seconds: number) => timestamp.makeTimestamp(
        Math.floor((NOW - timestamp.LOCAL_EPOCH_START)/1000) - seconds, 0);
    const rel = (seconds: number) => timestamp.formatTimestampRelative(agoT(seconds), NOW);
    assertEquals(rel(30), "just now");
    assertEquals(rel(25 * 60), "25 minutes ago");
    assertEquals(rel(60 * 60), "1 hour ago");
    assertEquals(rel(5 * 3600), "5 hours ago");
    assertEquals(rel(26 * 3600), "yesterday");
    assertEquals(rel(3 * 86400), "3 days ago");
    assertEquals(rel(5 * 7 * 86400), "5 weeks ago");
    assertEquals(rel(4 * 31 * 86400), "4 months ago");
    assertEquals(rel(2 * 366 * 86400), "2 years ago");
    assertEquals(timestamp.formatTimestampRelative(timestamp.END_OF_TIME, NOW), "");
});

// --- Query plans ------------------------------------------------------------------

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

test("feed queries: both stay on their index ranges (no table scan)", () => {
    withDictDb(d => {
        for(const sql of feedQueryShapes('dict')) {
            const details = d.all<{detail: string}>(`EXPLAIN QUERY PLAN ${sql}`)
                .map(r => r.detail);
            assert(details.some(det => det.includes('USING INDEX dict_')),
                   `expected an index in the plan for '${sql}', got: ${details.join(' | ')}`);
            assert(!details.some(det => det.startsWith('SCAN')),
                   `plan for '${sql}' degraded to a scan: ${details.join(' | ')}`);
        }
    });
});

// --- Rendered feed ----------------------------------------------------------------

// A born-approved entry.  applyTransaction ALLOCATES each tx's valid_from
// (the mk* `t` args only order the groups), so real times are "now"; tests
// that need a clump gap advance the hybrid logical clock with jumpClock.
function seedFeed(fx: Fixture) {
    const tl = new TestTimeline();
    const e = mkEntry(1000, tl.next(), {change_by_username: "djz"});
    fx.ww.applyTransaction([e], {quiet: true});
    const spl = mkChild(e, "spl", 1010, tl.next(),
                        {attr1: "samqwan", order_key: "0.5", change_by_username: "djz"});
    fx.ww.applyTransaction([spl], {quiet: true});
    bornApprove(fx.ww);
    return {tl, e, spl};
}

// Advance the db's clock `seconds` into the (near) future by burning that many
// seconds' worth of counter ticks; subsequent allocations continue from there
// (nextTime's in-the-future branch).  One timestamp second = RADIX ticks.
const RADIX = timestamp.makeTimestamp(1, 0);
function jumpClock(fx: Fixture, seconds: number): void {
    fx.ww.allocTxTimestamps(seconds * RADIX, {quiet: true});
}

const feedHtml = (fx: Fixture, q: Record<string, any>) =>
    markupToString(fx.ww.feed.renderFeed(feedQuery.normalize(q) as FeedQuery));
const count = (s: string, sub: string) => s.split(sub).length - 1;

test("feed: clumps by editor with headers, statuses, and anchored entry links", async () => {
    await withTestDb((fx) => {
        let anchor = 0;
        as(fx, "djz", () => {
            const {tl, spl} = seedFeed(fx);
            fx.ww.applyTransaction([mkEdit(spl, 2010, tl.next(),
                {attr1: "XYZZY", change_by_username: "sally"})], {quiet: true});
            anchor = fx.ww.lastAllocatedTxTimestamp;

            const html = feedHtml(fx, {to_time: anchor});
            // Only sally's edit is a CHANGE: the born-approved seed is standing
            // corpus, not recent activity, so it produces no clump.
            assertEquals(count(html, "lm-feed-clump"), 1);
            assertStringIncludes(html, "samqwan");           // the edit's "from"
            assertStringIncludes(html, "XYZZY");             // the change itself
            assertStringIncludes(html, "1 pending");         // sally's fact needs approval
            // The word link opens the read-only word VIEW (the change in
            // context), with an edit pencil to the editor carrying the feed's
            // sitting anchor, both in a new tab (the feed must never navigate).
            assertStringIncludes(html, `wordwiki.wordView(1000)`);
            assertStringIncludes(html, `wordwiki.wordEditor(1000,`);
            assertStringIncludes(html, `_blank`);
            assertStringIncludes(html, "Beginning of the record.");
        });
        as(fx, "dmm", () => fx.ww.lexemeOps.approveFact(1010));
        as(fx, "dmm", () => {
            // The SAME query re-renders the same events (the page is a pure
            // function of its URL - the approve event is above to_time), but
            // the status badges read the workspace NOW: pending -> approved.
            const html = feedHtml(fx, {to_time: anchor});
            assertEquals(count(html, "lm-feed-clump"), 1);
            assertStringIncludes(html, "1 approved ✓");
            assertEquals(html.includes("1 pending"), false);
            // A FRESH anchor adds dmm's approval as its own clump (sally's edit
            // still shows); the born-approved seed still doesn't.
            const fresh = feedHtml(fx, {to_time: fx.ww.lastAllocatedTxTimestamp});
            assertEquals(count(fresh, "lm-feed-clump"), 2);
            assertStringIncludes(fresh, "lm-cl-chip-approved");
        });
    });
});

test("feed: the participant filter keeps only that editor's clumps", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, e, spl} = seedFeed(fx);
            // sally edits the spelling; djz adds a pending new spelling (both
            // are real changes, on the same entry but by different editors, so
            // two clumps).
            fx.ww.applyTransaction([mkEdit(spl, 2010, tl.next(),
                {attr1: "XYZZY", change_by_username: "sally"})], {quiet: true});
            fx.ww.applyTransaction([mkChild(e, "spl", 1011, tl.next(),
                {attr1: "PLUGH", order_key: "0.6", change_by_username: "djz"})], {quiet: true});
            const anchor = fx.ww.lastAllocatedTxTimestamp;
            assertEquals(count(feedHtml(fx, {to_time: anchor}), "lm-feed-clump"), 2);
            const filtered = feedHtml(fx, {to_time: anchor, restrict_to_user: "sally"});
            assertEquals(count(filtered, "lm-feed-clump"), 1);   // djz's add clump gone
            assertStringIncludes(filtered, "XYZZY");
        });
    });
});

test("feed: participating mode shows what landed ON TOP of the user's facts", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, spl} = seedFeed(fx);
            // djz edits the spelling (djz's change to fact 1010).
            fx.ww.applyTransaction([mkEdit(spl, 2010, tl.next(),
                {attr1: "XYZZY", change_by_username: "djz"})], {quiet: true});
        });
        // dmm comments on the SAME fact - landing on top of djz's work.
        as(fx, "dmm", () => fx.ww.lexemeOps.commentFact(1010, "are you sure?"));
        as(fx, "djz", () => {
            const anchor = fx.ww.lastAllocatedTxTimestamp;
            // 'by' djz: only djz's own change - one clump, no comment.
            const byMe = feedHtml(fx, {to_time: anchor, restrict_to_user: "djz"});
            assertEquals(count(byMe, "lm-feed-clump"), 1);
            assertEquals(byMe.includes("are you sure?"), false);
            // 'participating' djz: djz's change AND dmm's comment on it - two
            // clumps, the comment now visible.
            const threads = feedHtml(fx,
                {to_time: anchor, restrict_to_user: "djz", user_mode: "participating"});
            assertEquals(count(threads, "lm-feed-clump"), 2);
            assertStringIncludes(threads, "are you sure?");
        });
    });
});

test("feed: hide-user-approvals drops the user's OWN approvals, keeps the work under them", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, spl} = seedFeed(fx);
            // djz edits the spelling (someone's real work)...
            fx.ww.applyTransaction([mkEdit(spl, 2010, tl.next(),
                {attr1: "XYZZY", change_by_username: "djz"})], {quiet: true});
        });
        as(fx, "dmm", () => fx.ww.lexemeOps.approveFact(1010));   // dmm approves djz's edit
        as(fx, "dmm", () => {
            const anchor = fx.ww.lastAllocatedTxTimestamp;
            // dmm participates in fact 1010 (by approving it): threads show
            // djz's edit + dmm's approval = two clumps.
            const shown = feedHtml(fx,
                {to_time: anchor, restrict_to_user: "dmm", user_mode: "participating"});
            assertEquals(count(shown, "lm-feed-clump"), 2);
            assertStringIncludes(shown, "lm-cl-chip-approved");   // dmm's approval EVENT
            // Hiding dmm's OWN approvals drops the approval event/clump but
            // keeps djz's underlying edit (the status badge still reflects the
            // fact's current approved state - only the routine ACTION is hidden).
            const hidden = feedHtml(fx, {to_time: anchor, restrict_to_user: "dmm",
                                         user_mode: "participating", hide_user_approvals: true});
            assertEquals(count(hidden, "lm-feed-clump"), 1);
            assertStringIncludes(hidden, "XYZZY");                     // djz's work stays
            assertEquals(hidden.includes("lm-cl-chip-approved"), false); // dmm's approval event gone
        });
    });
});

test("feed: a born-approved post is ONE line - the mechanical self-approval folds", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => { seedFeed(fx); });
        // The log/tag quick ops insert + self-approve as one bounded act
        // (schema $view.bornApproved).  A whole tag lifecycle: post a log,
        // add a tag, mark it done, remove it - each is a change line ONLY;
        // none of the mechanical self-approvals renders a line or a badge.
        const posted = as(fx, "test", () => fx.ww.lexemeOps.postLog(1000, "BORNTEXT"));
        const tag = as(fx, "test", () => fx.ww.lexemeOps.addTag(1000, "Todo"));
        as(fx, "test", () => fx.ww.lexemeOps.setTagDone(1000, tag.fact_id, true));
        as(fx, "test", () => fx.ww.lexemeOps.removeTag(1000, tag.fact_id));
        const html = feedHtml(fx, {to_time: fx.ww.lastAllocatedTxTimestamp});
        assertEquals(count(html, "lm-feed-clump"), 1);        // one sitting
        assertEquals(count(html, "BORNTEXT"), 1);             // the post, once
        assertEquals(count(html, "lm-cl-chip-deleted"), 1);   // the removal, once
        assertEquals(html.includes("lm-cl-chip-approved"), false);
        assertEquals(html.includes("approved ✓"), false);     // no badge either
        // The same fold at the event level: a full history renders just the
        // change line; baseline mode keeps the quiet standing value.
        const t = fx.ww.lexemeOps.findTupleInEntry(1000, posted.fact_id);
        assertEquals(fx.ww.lexeme.factChangeEvents(t.schema, t, true, true)
            .map((e: any) => e.kind), ["added"]);
        assertEquals(fx.ww.lexeme.factChangeEvents(t.schema, t, false, true)
            .map((e: any) => e.kind), ["baseline"]);
    });
});

test("feed: the source-page filter keeps only that page's entries", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, e} = seedFeed(fx);   // entry 1000, standing corpus
            // The scan world: PDM page 5 holding one bounding group.
            db().execute(`INSERT INTO scanned_document(document_id, friendly_document_id, title)
                          VALUES (1, 'PDM', 'Pacifique')`, {});
            db().execute(`INSERT INTO scanned_page(page_id, document_id, page_number)
                          VALUES (50, 1, 5)`, {});
            db().execute(`INSERT INTO bounding_group(bounding_group_id, document_id, layer_id)
                          VALUES (700, 1, 1)`, {});
            db().execute(`INSERT INTO bounding_box(bounding_box_id, bounding_group_id, document_id,
                                                   layer_id, page_id, x, y, w, h)
                          VALUES (800, 700, 1, 1, 50, 0, 0, 10, 10)`, {});
            // Entry 1000 gains a document reference to that group; entry 3000
            // is real work with no scanned content on the page.
            const sbe = mkChild(e, 'sub', 1100, tl.next(), {change_by_username: 'djz'});
            fx.ww.applyTransaction([sbe], {quiet: true});
            fx.ww.applyTransaction([mkChild(sbe, 'ref', 1110, tl.next(),
                {attr1: 700, change_by_username: 'djz'})], {quiet: true});
            const b = mkEntry(3000, tl.next(), {change_by_username: 'djz'});
            fx.ww.applyTransaction([b], {quiet: true});
            fx.ww.applyTransaction([mkChild(b, 'spl', 3010, tl.next(),
                {attr1: 'OFFPAGE', order_key: '0.5', change_by_username: 'djz'})], {quiet: true});
            const anchor = fx.ww.lastAllocatedTxTimestamp;
            // Unfiltered: both entries' clumps show...
            assertEquals(count(feedHtml(fx, {to_time: anchor}), "lm-feed-clump"), 2);
            // ...page-scoped: only the entry whose reference sits on PDM page 5.
            const filtered = feedHtml(fx, {to_time: anchor, source_page: 5});
            assertEquals(count(filtered, "lm-feed-clump"), 1);
            assertStringIncludes(filtered, "wordwiki.wordView(1000)");
            assertEquals(filtered.includes("OFFPAGE"), false);
            // An unknown page number matches nothing (and does not throw).
            assertEquals(count(feedHtml(fx, {to_time: anchor, source_page: 999}),
                               "lm-feed-clump"), 0);
            // The page's FULL feed view names the scope and offers the
            // shepherding companion links (entry report + page editor).
            const page = fx.ww.feed.changesPage({to_time: anchor, source_page: 5}) as any;
            const pageHtml = markupToString(page.body);
            assertStringIncludes(pageHtml, "entries on PDM page 5");
            assertStringIncludes(pageHtml, `entriesByBookPage("PDM", 5)`);
            assertStringIncludes(pageHtml, `pages.pageEditor("PDM", 5)`);
        });
    });
});

test("feed: a REAL cross-user approval on a born-approved relation still shows", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => { seedFeed(fx); });
        const posted = as(fx, "test", () => fx.ww.lexemeOps.postLog(1000, "BORNTEXT"));
        // djz EDITS the log fact (a normal pending edit), dmm approves it -
        // a real review act by a different user, not plumbing: it renders.
        as(fx, "djz", () => fx.ww.lexemeOps.supersedeFields(
            1000, posted.fact_id, {attr1: "EDITEDTEXT"}));
        as(fx, "dmm", () => fx.ww.lexemeOps.approveFact(posted.fact_id));
        const html = feedHtml(fx, {to_time: fx.ww.lastAllocatedTxTimestamp});
        assertStringIncludes(html, "lm-cl-chip-approved");
        assertStringIncludes(html, "1 approved ✓");
    });
});

test("feed: a clump fragment re-renders in place with its current statuses", async () => {
    await withTestDb((fx) => {
        let editT = 0, anchor = 0;
        as(fx, "djz", () => {
            const {tl, spl} = seedFeed(fx);
            fx.ww.applyTransaction([mkEdit(spl, 2010, tl.next(),
                {attr1: "XYZZY", change_by_username: "sally"})], {quiet: true});
            editT = fx.ww.lastAllocatedTxTimestamp;   // the edit tx's valid_from
            anchor = editT;
        });
        as(fx, "dmm", () => {
            fx.ww.lexemeOps.approveFact(1010);
            // Reload sally's clump by its identity (entry, from, to): same
            // events, updated badge - this is what the return-to-feed reload
            // fetches for just the clumps the reviewer clicked into.
            const g = markupToString(fx.ww.feed.renderFeedClump(
                1000, editT, editT, anchor));
            assertStringIncludes(g, "lm-feed-clump");
            assertStringIncludes(g, "XYZZY");
            assertStringIncludes(g, "1 approved ✓");
        });
    });
});

test("feed: depth is the URL - 'Show older' is the same view with max_rows bumped", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, spl} = seedFeed(fx);
            // Two sally sessions, the clock jumped 31 minutes between them.
            const s1 = mkEdit(spl, 2010, tl.next(), {attr1: "XYZZY", change_by_username: "sally"});
            fx.ww.applyTransaction([s1], {quiet: true});
            jumpClock(fx, 31 * 60);
            fx.ww.applyTransaction([mkEdit(s1, 2020, tl.next(),
                {attr1: "PLUGH", change_by_username: "sally"})], {quiet: true});
            const anchor = fx.ww.lastAllocatedTxTimestamp;

            // The feed body must coerce to HTML over HTTP, not JSON: the
            // dispatcher renders a single top-level ELEMENT (a bare list of
            // clumps would serialize as JSON into the page).
            assert(isTopLevelMarkup(fx.ww.feed.renderFeed(
                feedQuery.normalize({to_time: anchor}) as FeedQuery)));

            // max_rows=1: just the newest clump, whole; Show older carries the
            // SAME query with max_rows bumped by a page (1001).
            const page1 = feedHtml(fx, {to_time: anchor, max_rows: 1});
            assertEquals(count(page1, "lm-feed-clump"), 1);
            assertStringIncludes(page1, "PLUGH");
            // One event line: the older session is off this page (its value
            // still shows - as the from-side of the kept edit's diff).
            assertEquals(count(page1, "lm-cl-row"), 1);
            assertStringIncludes(page1, "Show older");
            assertStringIncludes(page1, `wordwiki.changes({to_time:${anchor},max_rows:1001})`);
            // The deeper view has the rest; nothing below, so no more control.
            const page2 = feedHtml(fx, {to_time: anchor, max_rows: 1001});
            assertStringIncludes(page2, "XYZZY");
            assertStringIncludes(page2, "Beginning of the record.");

            // A CLOSED range is clamped by the range itself: max_rows is
            // ignored (both sessions show despite max_rows=1), and there is
            // no Show older - the range end is the end.
            const ranged = feedHtml(fx, {from_time: 1, to_time: anchor, max_rows: 1});
            assertEquals(count(ranged, "lm-feed-clump"), 2);
            assertStringIncludes(ranged, "XYZZY");
            assertStringIncludes(ranged, "PLUGH");
            assertEquals(ranged.includes("Show older"), false);
            assertStringIncludes(ranged, "Start of the selected range.");
        });
    });
});

test("feed page: a visit with no to_time redirects to the canonical stamped URL", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            seedFeed(fx);
            const t = fx.ww.lastAllocatedTxTimestamp;
            const r: any = fx.ww.feed.changesPage();
            assert(isRedirectResponse(r));
            assertEquals(r.headers.Location, `/ww/wordwiki.changes({to_time:${t}})`);
            // Other filters survive the stamping redirect.
            const r2: any = fx.ww.feed.changesPage({restrict_to_user: "sally"});
            assertEquals(r2.headers.Location,
                         `/ww/wordwiki.changes({to_time:${t},restrict_to_user:"sally"})`);
            // A stamped visit renders the page - no loop.
            assertEquals(isRedirectResponse(fx.ww.feed.changesPage({to_time: t})), false);
        });
    });
});

test("feed filter dialog: generated from the query's own fields; apply navigates", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            seedFeed(fx);
            const t = fx.ww.lastAllocatedTxTimestamp;
            const dialog = markupToString(fx.ww.feed.filterDialog({to_time: t}));
            // The FieldSet's fields, auto-rendered: timestamp pickers, the
            // user dropdown, max rows.
            assertStringIncludes(dialog, "name=from_time");
            assertStringIncludes(dialog, "datetime-local");
            assertStringIncludes(dialog, "name=restrict_to_user");
            assertStringIncludes(dialog, "name=max_rows");
            assertStringIncludes(dialog, "applyFilter");
            // Applying the posted state navigates to its canonical URL; a
            // dropdown pick rides along, empty inputs clear their filters.
            const r = fx.ww.feed.applyFilter(
                {from_time: "", to_time: "", restrict_to_user: "dmm", max_rows: "10"});
            assertEquals(r.action, "navigate");
            assertEquals(r.url, `/ww/wordwiki.changes({restrict_to_user:"dmm",max_rows:10})`);
        });
    });
});
