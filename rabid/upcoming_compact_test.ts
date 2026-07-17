// The compact upcoming-events home pane: one lean row per upcoming PUBLIC event
// (volunteer-only events excluded, catch-all buckets excluded), a phase-aware
// self toggle, and a per-row reload route.  Verified VIA DISPATCH - the pane
// and its reload row must actually route (the route-undeclared lesson).
import { test } from "../liminal/testing/test.ts";
import { assert } from "../liminal/testing/assert.ts";
import { withTestDb, renderRoute, asUser, asSystem, invoke } from "./testing.ts";
import { hasText } from "../liminal/testing/markup-assert.ts";
import { markupToString } from "../liminal/markup.ts";
import { rabid } from "./rabid.ts";
import * as date from "../liminal/date.ts";

// An event a few days out, so it lands inside the pane's 6-week window and reads
// as 'future' (a sign-up, not a check-in).
function upcomingEvent(over: Record<string, any> = {}): number {
    const d = date.orgToday().add({ days: 5 }).toString();
    return asSystem(() => rabid.event.insert({
        event_kind: 'public', description: 'Repair Night', location_description: '',
        location_url: '', is_remote_event: 0, volunteer_only: 0,
        start_time: `${d} 17:00:00`, end_time: `${d} 20:00:00`,
        total_cash_collected: 0, notes: '', ...over,
    }));
}

// The pane is composed into the home page server-side (not reached by URL), so
// it is exercised THROUGH the home route.
test("compact pane on home: lists public upcoming events, excludes volunteer-only, offers Sign up", async () => {
    await withTestDb(async ({ bob }) => {
        upcomingEvent({ description: 'Community Fix-It' });
        upcomingEvent({ description: 'Members Build', volunteer_only: 1 });

        const page = await asUser(bob, () => renderRoute('home'));
        const html = markupToString(page);
        assert(hasText(page, 'Upcoming events'), 'the pane heading is present');
        assert(hasText(page, 'Community Fix-It'), 'the public event is listed');
        assert(!hasText(page, 'Members Build'), 'a volunteer-only event is excluded');
        // A quiet document-native RSVP checkbox - NOT a heavy pill, and NO full
        // roster line (that weight belongs to the /events schedule).
        assert(html.includes('type=checkbox'), 'offers a Going checkbox');
        assert(html.includes('lm-data-table'), 'rendered as a typographic data table');
        assert(!html.includes('lm-row-action'), 'no heavy pill button');
        assert(!html.includes('No one signed up yet'), 'no full roster line (that is the heavy list)');
    });
});

test("compact pane on home: empty window shows the muted note", async () => {
    await withTestDb(async ({ bob }) => {
        const page = await asUser(bob, () => renderRoute('home'));
        assert(hasText(page, 'No upcoming public events'), 'muted empty note');
    });
});

test("compact row: signing up flips the toggle to Going, and the row reload route works", async () => {
    await withTestDb(async ({ bob }) => {
        const e = upcomingEvent();

        // Before: an unchecked Going checkbox.
        const before = await asUser(bob, () => renderRoute(`rabid.event.renderUpcomingPublicEventRowById(${e})`));
        const beforeHtml = markupToString(before);
        assert(beforeHtml.includes('type=checkbox'), 'has a Going checkbox');
        assert(!beforeHtml.includes('checked'), 'unchecked before committing');

        // Sign self up, then re-render the row: the checkbox is now checked.
        await asUser(bob, () => invoke(`rabid.event_commitment.commitSelf($arg0)`, e));
        const after = await asUser(bob, () => renderRoute(`rabid.event.renderUpcomingPublicEventRowById(${e})`));
        assert(markupToString(after).includes('checked'), 'checked after committing');
    });
});
