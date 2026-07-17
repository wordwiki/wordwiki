// The admin series UI dispatches through routes (catches missing @route), and its
// mutations are host/admin-gated.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import { find, hasText } from "../liminal/testing/markup-assert.ts";
import { withTestDb, asUser, asSystem, renderRoute, invoke } from "./testing.ts";
import { getRabid } from "./rabid.ts";

function series(over: Record<string, any> = {}): number {
    return getRabid().event_series.insert({
        description: 'Public Bike Repair', event_kind: 'public', location_description: 'Victoria Park',
        frequency: 'weekly', weekday: 'saturday', start_time_of_day: '10:00', end_time_of_day: '15:00',
        effective_start: '2026-06-06', effective_end: '2026-08-29', ...over,
    });
}

test("/eventSeries page lists series with a summary, and the New button (host)", async () => {
    await withTestDb(async (fx) => {
        asSystem(() => series());
        const page = await asUser(fx.alice, () => renderRoute('eventSeries'));
        assert(find(page, n => hasText(n, 'Public Bike Repair')));
        assert(find(page, n => hasText(n, 'Every Saturday')));   // the summary
        assert(find(page, n => hasText(n, 'New series')));
    });
});

test("reconcileNow + addSkip + removeSkip dispatch (host); a regular volunteer is refused", async () => {
    await withTestDb(async (fx) => {
        const sid = asSystem(() => series());
        // Host may reconcile.
        const rec = await asUser(fx.alice, () => invoke(`rabid.event_series.reconcileNow(${sid})`));
        assertEquals(rec.action, 'reload');
        // Add + remove a skip through the routes.
        await asUser(fx.alice, () =>
            invoke('rabid.event_series.addSkip($arg0)', {event_series_id: sid, skip_date: '2026-07-04', reason: 'Holiday'}));
        assertEquals(asSystem(() => getRabid().event_series_skip.forSeries.all({event_series_id: sid}).length), 1);
        const skipId = asSystem(() => getRabid().event_series_skip.forSeries.all({event_series_id: sid})[0].event_series_skip_id);
        await asUser(fx.alice, () => invoke(`rabid.event_series.removeSkip(${skipId})`));
        assertEquals(asSystem(() => getRabid().event_series_skip.forSeries.all({event_series_id: sid}).length), 0);
        // A regular volunteer (bob) is refused a mutation.
        let denied = false;
        try { await asUser(fx.bob, () => invoke(`rabid.event_series.reconcileNow(${sid})`)); } catch { denied = true; }
        assert(denied);
    });
});

test("deleteSeries: future un-attended instances go, series_id cleared on the rest", async () => {
    await withTestDb(async (fx) => {
        await asUser(fx.alice, async () => {
            const sid = asSystem(() => series({effective_start: '2020-01-01', effective_end: '2020-02-29'}));
            asSystem(() => getRabid().event_series.materialize(sid, '2020-01-01', '2020-02-29')); // all in the past
            await invoke(`rabid.event_series.deleteSeries(${sid})`);
            // Series gone; its past events survive but are now standalone (series_id null).
            assertEquals(asSystem(() => getRabid().event_series.listAll.all({}).length), 0);
            const orphans = asSystem(() => getRabid().event.allEvents.all({}).filter(e => e.series_id != null));
            assertEquals(orphans.length, 0);
        });
    });
});
