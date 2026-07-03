// deno-lint-ignore-file no-explicit-any
/**
 * The monthly activity report (activity-report.ts).  Three layers:
 *   - the pure month-window + bucketing functions (boundaries, tallying,
 *     per-user folding);
 *   - the window fetch's EXPLAIN QUERY PLAN pin (index range, never a scan);
 *   - the rendered report over the in-memory workspace (action counts, the
 *     born-published corpus excluded, month/user links into the feed, the
 *     per-user page, and the filter dialog).
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, as, mkEntry, mkChild, mkEdit, bornApprove, TestTimeline,
         type Fixture } from "./testing.ts";
import { monthWindows, bucketActivity, bucketCreations, userTotals, emptyStats,
         tallyRow, resolveCreationDate, spanMonths, activityQuery, activityQueryShapes,
         type ActivityRow, type ActivityQuery, type EntryCreation } from "./activity-report.ts";
import { createAssertionDml } from "./assertion.ts";
import { db, Db, setDefaultDb } from "../liminal/db.ts";
import { markupToString } from "../liminal/markup.ts";
import * as timestamp from "../liminal/timestamp.ts";

// --- Month windows + bucketing (pure) ----------------------------------------------

// An arbitrary "now": 2026-06-15 12:00 local.
const NOW_MS = +new Date(2026, 5, 15, 12, 0, 0);

// A row `monthsAgo` calendar months before NOW (mid-month), with overrides.
function row(monthsAgo: number, over: Partial<ActivityRow> = {}): ActivityRow {
    const d = new Date(2026, 5 - monthsAgo, 10, 9, 0, 0);
    return {valid_from: timestamp.makeTimestamp(
                Math.floor((+d - timestamp.LOCAL_EPOCH_START)/1000), 0),
            change_action: null, username: 'sally',
            ...over};
}

test("activity windows: contiguous closed ranges, newest first, labelled", () => {
    const w = monthWindows(3, NOW_MS);
    assertEquals(w.map(x => x.label), ["June 2026", "May 2026", "April 2026"]);
    assertEquals(w[1].to, w[0].from - 1);       // no timestamp falls between months
    assertEquals(w[2].to, w[1].from - 1);
    assert(w[0].from < timestamp.makeTimestamp(
        Math.floor((NOW_MS - timestamp.LOCAL_EPOCH_START)/1000), 0));
});

test("activity tally: each row lands in exactly one count", () => {
    const s = emptyStats();
    tallyRow(s, row(0));                                          // a content change
    tallyRow(s, row(0, {change_action: 'approved'}));
    tallyRow(s, row(0, {change_action: 'reverted'}));
    tallyRow(s, row(0, {change_action: 'comment'}));
    assertEquals(s, {changes: 1, newLexemes: 0, approved: 1, rejected: 1, comments: 1});
});

test("creation date: shoebox-date wins (imported), else valid_from, else unknown", () => {
    // An imported lexeme: ent at BEGINNING_OF_TIME, shoebox-date says 2013.
    assertEquals(resolveCreationDate(timestamp.BEGINNING_OF_TIME, "15/Mar/2013"),
                 {year: 2013, month: 3, day: 15});
    // Post-migration the value is ISO.
    assertEquals(resolveCreationDate(timestamp.BEGINNING_OF_TIME, "2013-03-15"),
                 {year: 2013, month: 3, day: 15});
    // A wordwiki-created lexeme: the ent row's valid_from is the truth.
    assertEquals(resolveCreationDate(row(2).valid_from, null),
                 {year: 2026, month: 4, day: 10});
    // Imported with no shoebox-date (a handful): unknown, never the import
    // instant masquerading as a date.
    assertEquals(resolveCreationDate(timestamp.BEGINNING_OF_TIME, null), undefined);
});

const creation = (year: number, month: number, username: string, entry_id = 1):
    EntryCreation => ({entry_id, year, month, day: 10, username});

test("creations bucket into their month's newLexemes, split by user; undated skipped", () => {
    const creations = [
        creation(2026, 6, 'djz'),
        creation(2026, 4, 'djz'),
        creation(2013, 3, ''),     // outside a 3-month window
        creation(0, 0, ''),        // undated - belongs to no month
    ];
    const buckets = bucketActivity([], monthWindows(3, NOW_MS), NOW_MS);
    bucketCreations(creations, buckets, NOW_MS);
    assertEquals(buckets.map(b => b.total.newLexemes), [1, 0, 1]);
    assertEquals(buckets[0].byUser.get('djz')!.newLexemes, 1);
});

test("spanMonths: reaches the earliest change or dated creation; undated ignored", () => {
    // June 2026 - March 2013 inclusive = 160 months.
    assertEquals(spanMonths([], [creation(2013, 3, ''), creation(0, 0, '')], NOW_MS), 160);
    assertEquals(spanMonths([row(4)], [], NOW_MS), 5);
    assertEquals(spanMonths([], [], NOW_MS), 1);
});

test("activity buckets: rows land in their month, split by user", () => {
    const rows = [row(0), row(0, {username: 'dmm', change_action: 'approved'}),
                  row(2), row(2), row(5)];   // row(5) is outside a 3-month window
    const buckets = bucketActivity(rows, monthWindows(3, NOW_MS), NOW_MS);
    assertEquals(buckets[0].total.changes, 1);
    assertEquals(buckets[0].total.approved, 1);
    assertEquals(buckets[0].byUser.get('sally')!.changes, 1);
    assertEquals(buckets[0].byUser.get('dmm')!.approved, 1);
    assertEquals(buckets[1].total.changes, 0);
    assertEquals(buckets[2].total.changes, 2);
    // Per-user window totals fold across months, most active first.
    const totals = userTotals(buckets);
    assertEquals(totals.map(([u, _]) => u), ['sally', 'dmm']);
    assertEquals(totals[0][1].changes, 3);
});

// --- Query plan --------------------------------------------------------------------

test("activity query: stays on its valid_from index range (no table scan)", () => {
    const scratch = Db.openMemory();
    setDefaultDb(scratch);
    try {
        scratch.executeStatements(createAssertionDml('dict'));
        for(const sql of activityQueryShapes('dict')) {
            const details = scratch.all<{detail: string}>(`EXPLAIN QUERY PLAN ${sql}`)
                .map(r => r.detail);
            assert(details.some(det => det.includes('USING INDEX dict_')),
                   `expected an index in the plan for '${sql}', got: ${details.join(' | ')}`);
            assert(!details.some(det => det.startsWith('SCAN')),
                   `plan for '${sql}' degraded to a scan: ${details.join(' | ')}`);
        }
    } finally {
        setDefaultDb(undefined);
        scratch.close();
    }
});

// --- The rendered report -----------------------------------------------------------

const reportHtml = (fx: Fixture, q: Record<string, any>) =>
    markupToString(fx.ww.report.renderReport(activityQuery.normalize(q) as ActivityQuery));

// The pretty-printer breaks elements across lines; fold whitespace away so a
// cell like <td class='text-end'>3</td> can be asserted as one string.
const flat = (html: string) => html.replace(/\s+/g, '');

// All test activity happens "now", so it lands in the report's current month
// (the top table row).
test("report: counts this month's actions; the born-published corpus is invisible", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const tl = new TestTimeline();
            // A born-approved entry: its EDITS are standing content (no
            // changes counted) - but it WAS created now, so the creation-date
            // axis counts it as a new lexeme.
            const e = mkEntry(1000, tl.next(), {change_by_username: "djz"});
            fx.ww.applyTransaction([e], {quiet: true});
            const spl = mkChild(e, "spl", 1010, tl.next(),
                {attr1: "samqwan", order_key: "0.5", change_by_username: "djz"});
            fx.ww.applyTransaction([spl], {quiet: true});
            bornApprove(fx.ww);
            const seeded = flat(reportHtml(fx, {}));
            assertStringIncludes(seeded,
                "<tdclass='text-end'><spanclass='text-muted'>–</span></td>");
            assertStringIncludes(seeded, ">1</a></td>");  // 1 new lexeme (linked), 0 changes

            // sally edits the spelling: 1 change, 0 new lexemes.
            fx.ww.applyTransaction([mkEdit(spl, 2010, tl.next(),
                {attr1: "XYZZY", change_by_username: "sally"})], {quiet: true});
            // djz starts a brand-new lexeme (entry + spelling, both pending):
            // 2 more changes, 1 of them a new lexeme.
            const e2 = mkEntry(3000, tl.next(), {change_by_username: "djz"});
            fx.ww.applyTransaction([e2], {quiet: true});
            fx.ww.applyTransaction([mkChild(e2, "spl", 3010, tl.next(),
                {attr1: "PLUGH", order_key: "0.5", change_by_username: "djz"})], {quiet: true});
            // ...and an UNSTAMPED change (the pre-2026 history): it counts,
            // but its editor line is 'unknown' and carries no filter links
            // (change_by_username IS NULL - the feed's `=` can't reach it).
            fx.ww.applyTransaction([mkChild(e2, "spl", 3011, tl.next(),
                {attr1: "FNORD", order_key: "0.7"})], {quiet: true});
        });
        as(fx, "dmm", () => fx.ww.lexemeOps.approveFact(1010));
        as(fx, "dmm", () => {
            const html = flat(reportHtml(fx, {months: 2}));
            // The current-month row: 4 changes (incl. the unstamped one),
            // 2 new lexemes (entries 1000 + 3000 - creation date, not
            // publication state), 1 approval.  The COUNTS are the links:
            // changes into the month-windowed feed, new lexemes into the
            // created-lexemes page; the month label is plain text.
            const cell = (n: number) => `>${n}</a></td>`;   // a linked count cell
            assertStringIncludes(html, cell(4));
            assertStringIncludes(html, cell(2));
            assertStringIncludes(html, "<tdclass='text-end'>1</td>");   // approved: plain
            assertStringIncludes(html, "wordwiki.changes({from_time:");
            assertStringIncludes(html, "wordwiki.report.createdPage(");
            // Grouped by year: a bold totals row leads the year, its new-
            // lexemes total linking to the whole-year created page.
            assertStringIncludes(html, "lm-activity-year");
            assertStringIncludes(html, `createdPage(${new Date().getFullYear()},0)`);
            // Editor lines: totals with links to the user-filtered feed and
            // to the per-user monthly breakdown.
            assertStringIncludes(html, "Byeditor");
            assertStringIncludes(html, "1change");
            assertStringIncludes(html, "2newlexemes");   // djz's line
            assertStringIncludes(html, "1approved");
            assertStringIncludes(html, 'restrict_to_user:"sally"');
            assertStringIncludes(html, 'wordwiki.activity({months:2,restrict_to_user:"dmm"})');
            // The unstamped history's line: present, unlinked, unfilterable.
            assertStringIncludes(html, "unknown");
            assertEquals(html.includes('restrict_to_user:""'), false);

            // The per-user view: only that editor's actions, no editor lines.
            const sally = flat(reportHtml(fx, {months: 2, restrict_to_user: "sally"}));
            assertStringIncludes(sally, cell(1));
            assertEquals(sally.includes("Byeditor"), false);
            assertEquals(sally.includes(cell(4)), false);
            // ...and its count links carry the user filter into the feed.
            assertStringIncludes(sally, 'restrict_to_user:"sally"');
        });
    });
});

test("created page + no-limit default: undated imports counted and listed", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const tl = new TestTimeline();
            const e = mkEntry(1000, tl.next(), {change_by_username: "djz"});
            fx.ww.applyTransaction([e], {quiet: true});
            // An imported-style lexeme: ent at BEGINNING_OF_TIME with NO
            // shoebox-date - a creation with no date at all.
            db().execute(
                `INSERT INTO dict (assertion_id, id, ty, ty0, ty1, id1, valid_from, valid_to)
                 VALUES (9999, 9999, 'ent', 'dct', 'ent', 9999,
                         ${timestamp.BEGINNING_OF_TIME}, ${timestamp.END_OF_TIME})`, {});

            // The no-limit default view carries the missing-dates line...
            const html = flat(reportHtml(fx, {}));
            assertStringIncludes(html, "withnocreationdate");
            assertStringIncludes(html, "createdPage(0,0)");
            // ...which a months-limited view omits (missing is meaningless
            // against a range limit).
            assertEquals(flat(reportHtml(fx, {months: 2})).includes("withnocreationdate"),
                         false);

            // The created-lexemes page: this month lists entry 1000 with its
            // date; the undated page (0,0) lists the import.
            const now = new Date();
            const pageHtml = (p: any) => markupToString(p.body);
            const created = pageHtml(fx.ww.report.createdPage(
                now.getFullYear(), now.getMonth() + 1));
            assertStringIncludes(created, "Lexemes created in");
            assertStringIncludes(created, "wordwiki.entry(1000)");
            assertEquals(created.includes("wordwiki.entry(9999)"), false);
            // month 0 = the whole year.
            const yearPage = pageHtml(fx.ww.report.createdPage(now.getFullYear(), 0));
            assertStringIncludes(yearPage, `Lexemes created in ${now.getFullYear()}`);
            assertStringIncludes(yearPage, "wordwiki.entry(1000)");
            const undated = pageHtml(fx.ww.report.createdPage(0, 0));
            assertStringIncludes(undated, "Lexemes with no creation date");
            assertStringIncludes(undated, "wordwiki.entry(9999)");
            assertEquals(undated.includes("wordwiki.entry(1000)"), false);
        });
    });
});

test("report filter dialog: generated from the query's own fields; apply navigates", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const dialog = markupToString(fx.ww.report.filterDialog({}));
            assertStringIncludes(dialog, "name=months");
            assertStringIncludes(dialog, "name=restrict_to_user");
            assertStringIncludes(dialog, "applyFilter");
            const r = fx.ww.report.applyFilter({months: "6", restrict_to_user: "dmm"});
            assertEquals(r.action, "navigate");
            assertEquals(r.url, `/ww/wordwiki.activity({months:6,restrict_to_user:"dmm"})`);
        });
    });
});
