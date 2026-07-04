// deno-lint-ignore-file no-explicit-any
// Page-state on the rabid list/report pages (liminal.md § On-page view state):
// the shared date-window idiom (timesheets/sales/service/events + the daily
// report) and the include-done toggles (tasks/projects).  Window inserts are
// dated RELATIVE to orgToday so the "last 120 days" default is testable without
// pinning the run date.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, renderRoute, asUser, asSystem, invoke } from "./testing.ts";
import { rabid } from "./rabid.ts";
import { find, attr, tagOf, hasText, getByTestId } from "../liminal/testing/markup-assert.ts";
import * as pageQueries from "./page-queries.ts";
import * as date from "../liminal/date.ts";

// A sqlite datetime N days before today (org zone), at noon.
const daysAgo = (n: number) =>
    `${date.temporalToSqliteDate(date.orgToday().subtract({days: n}))} 12:00:00`;

// --- the shared window helpers ------------------------------------------------

test("windowQuery: literal omits absent bounds; resolveWindow defaults to the last 120 days", () => {
    const fs = pageQueries.windowQuery('w');
    assertEquals(fs.literal(fs.normalize({})), '{}');
    assertEquals(fs.literal(fs.normalize({from: '2026-01-01'})), '{from:"2026-01-01"}');
    assertEquals(fs.literal(fs.normalize({from: '2026-01-01', to: '2026-03-01'})),
                 '{from:"2026-01-01",to:"2026-03-01"}');
    // The drifting default spans exactly DEFAULT_WINDOW_DAYS ending today.
    const w = pageQueries.resolveWindow(fs.normalize({}) as any);
    assertEquals(w.to, date.temporalToSqliteDate(date.orgToday()));
    assertEquals(w.from, date.temporalToSqliteDate(
        date.orgToday().subtract({days: pageQueries.DEFAULT_WINDOW_DAYS})));
});

// --- timesheets (representative of the three windowed lists) ------------------

test("timesheets: default window shows recent, hides old; window bar + Show-older/Filter", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const recent = asSystem(() => rabid.timesheet_entry.insert({
            volunteer_id: bob, start_time: daysAgo(10), end_time: daysAgo(10).replace('12:', '13:'),
            notes: 'recent', is_paid_time: 0, km_driven_for_reimbursement: 0,
            km_driven_processed: 0, paid_time_processed: 0}));
        asSystem(() => rabid.timesheet_entry.insert({
            volunteer_id: bob, start_time: daysAgo(200), end_time: daysAgo(200).replace('12:', '13:'),
            notes: 'ancient', is_paid_time: 0, km_driven_for_reimbursement: 0,
            km_driven_processed: 0, paid_time_processed: 0}));

        const page = await asUser(alice, () => renderRoute(`timesheets({})`));
        assert(!!find(page, n => attr(n, 'data-testid') === 'window-bar'), 'has a window bar');
        // Recent entry shows in the default window; the 200-day-old one doesn't.
        assert(!!find(page, n => attr(n, 'data-testid') === `timesheet-row-${recent}`), 'recent shows');
        const defCount = asSystem(() => rabid.timesheet_entry.entriesInWindow.all(
            pageQueries.resolveWindow({from: null, to: null}))).length;
        assertEquals(defCount, 1);
        // Widening to an explicit window surfaces the old one.
        const wideCount = asSystem(() =>
            rabid.timesheet_entry.entriesInWindow.all({from: '2000-01-01',
                to: date.temporalToSqliteDate(date.orgToday())})).length;
        assertEquals(wideCount, 2);
        // Show-older depth link + a Filter button in the bar.
        const bar = getByTestId(page, 'window-bar');
        assert(hasText(bar, 'Show older'));
        assert(!!find(bar, n => tagOf(n) === 'button' && hasText(n, 'Filter')));
    });
});

test("applyTimesheetsFilter → canonical navigate URL; the empty form is the shortest", async () => {
    await withTestDb(async ({ alice }) => {
        const explicit = await asUser(alice, () => invoke(
            `rabid.timesheet_entry.applyTimesheetsFilter($arg0)`, {from: '2026-01-01', to: '2026-03-01'}));
        assertEquals(explicit, {action: 'navigate',
                                url: '/timesheets({from:"2026-01-01",to:"2026-03-01"})'});
        const empty = await asUser(alice, () =>
            invoke(`rabid.timesheet_entry.applyTimesheetsFilter($arg0)`, {}));
        assertEquals(empty, {action: 'navigate', url: '/timesheets({})'});
    });
});

test("the window bar's Show-older link widens `from` and carries hx-replace-url", async () => {
    await withTestDb(async ({ alice }) => {
        const page = await asUser(alice, () => renderRoute(`sales({})`));
        const bar = getByTestId(page, 'window-bar');
        const older = find(bar, n => tagOf(n) === 'a' && hasText(n, 'Show older'));
        assert(!!older);
        // widened from = today − 2×120 days; the depth link replaces the URL.
        const expectFrom = date.temporalToSqliteDate(
            date.orgToday().subtract({days: 2 * pageQueries.DEFAULT_WINDOW_DAYS}));
        // A boosted link: href + hx-replace-url (replaceState), not hx-get.
        assertStringIncludes(String(attr(older!, 'hx-replace-url')), `/sales({from:"${expectFrom}"})`);
        assertStringIncludes(String(attr(older!, 'href')), `/sales({from:"${expectFrom}"})`);
        assertEquals(attr(older!, 'hx-boost'), 'true');
    });
});

// --- events: past window, upcoming always shown -------------------------------

test("events: upcoming always shown; the Past section is windowed", async () => {
    await withTestDb(async ({ alice }) => {
        asSystem(() => rabid.event.insert({
            event_kind: 'public', description: 'Upcoming Fair',
            location_description: '', location_url: '', is_remote_event: 0, volunteer_only: 0,
            start_time: daysAgo(-7), end_time: null, total_cash_collected: 0, notes: ''} as any));
        asSystem(() => rabid.event.insert({
            event_kind: 'public', description: 'Ancient Fair',
            location_description: '', location_url: '', is_remote_event: 0, volunteer_only: 0,
            start_time: daysAgo(200), end_time: null, total_cash_collected: 0, notes: ''} as any));
        const page = await asUser(alice, () => renderRoute(`events({})`));
        assert(hasText(page, 'Upcoming Fair'), 'future event shows');
        assert(hasText(page, 'Past events'), 'past section heading');
        assert(!hasText(page, 'Ancient Fair'), '200-day-old past event hidden by default');
        const wide = await asUser(alice, () => renderRoute(`events({from:"2000-01-01"})`));
        assert(hasText(wide, 'Ancient Fair'), 'widened window surfaces the old past event');
    });
});

// --- tasks / projects include_done toggles -----------------------------------

test("tasks: include_done relaxes the open-only filter; the toggle flips the URL", async () => {
    await withTestDb(async ({ alice }) => {
        const { project_id } = asSystem(() => {
            const pid = rabid.project.insert({name: 'Drive', deleted: 0});
            rabid.task.insert({project_id: pid, title: 'Open one', status: 'open', deleted: 0} as any);
            rabid.task.insert({project_id: pid, title: 'Done one', status: 'done', deleted: 0} as any);
            return {project_id: pid};
        });
        const openPage = await asUser(alice, () => renderRoute(`tasks({})`));
        assert(hasText(openPage, 'Open one'));
        assert(!hasText(openPage, 'Done one'), 'done task hidden by default');
        const toggle = find(openPage, n => attr(n, 'data-testid') === 'view-toggle');
        assertStringIncludes(String(attr(toggle!, 'href')), '/tasks({include_done:true})');
        assertStringIncludes(String(attr(toggle!, 'hx-replace-url')), '/tasks({include_done:true})');

        const allPage = await asUser(alice, () => renderRoute(`tasks({include_done:true})`));
        assert(hasText(allPage, 'Open one') && hasText(allPage, 'Done one'), 'both show');
    });
});

test("projects: include_done shows Done (deleted) projects", async () => {
    await withTestDb(async ({ alice }) => {
        asSystem(() => {
            rabid.project.insert({name: 'Active Proj', deleted: 0});
            rabid.project.insert({name: 'Done Proj', deleted: 1});
        });
        const active = await asUser(alice, () => renderRoute(`projects({})`));
        assert(hasText(active, 'Active Proj') && !hasText(active, 'Done Proj'));
        const all = await asUser(alice, () => renderRoute(`projects({include_done:true})`));
        assert(hasText(all, 'Active Proj') && hasText(all, 'Done Proj'));
    });
});

// --- daily activity report range ---------------------------------------------

test("daily report: the range rides the route; default is 120 days; filter navigates", async () => {
    await withTestDb(async ({ alice }) => {
        const page = await asUser(alice, () => renderRoute(`dailyActivityReport({})`));
        assert(!!find(page, n => attr(n, 'data-testid') === 'window-bar'), 'report has a window bar');
        const apply = await asUser(alice, () => invoke(
            `rabid.applyDailyReportFilter($arg0)`, {from: '2026-01-01', to: '2026-02-01'}));
        assertEquals(apply, {action: 'navigate',
                             url: '/dailyActivityReport({from:"2026-01-01",to:"2026-02-01"})'});
        // An explicit narrow range renders one table row per day (3 days + header).
        const { findAll } = await import("../liminal/testing/markup-assert.ts");
        const ranged = await asUser(alice, () =>
            renderRoute(`dailyActivityReport({from:"2026-02-01",to:"2026-02-03"})`));
        assertEquals(findAll(ranged, n => tagOf(n) === 'tr').length, 1 + 3);
    });
});
