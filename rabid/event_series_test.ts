// Schema: event_series + event_series_skip + event.series_id, their queries, and
// the (series, occurrence-day) uniqueness guard.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertThrows } from "../liminal/testing/assert.ts";
import { withTestDb, asSystem } from "./testing.ts";
import { getRabid } from "./rabid.ts";

function weeklySeries(over: Record<string, any> = {}): number {
    return getRabid().event_series.insert({
        description: 'Public Bike Repair', event_kind: 'public',
        location_description: 'Victoria Park', frequency: 'weekly', weekday: 'saturday',
        start_time_of_day: '10:00', end_time_of_day: '15:00',
        effective_start: '2026-06-06', effective_end: '2026-08-29', ...over,
    });
}

test("event_series inserts + round-trips (incl. time-of-day and enums)", async () => {
    await withTestDb(() => asSystem(() => {
        const id = weeklySeries();
        const s = getRabid().event_series.getById(id);
        assertEquals(s.frequency, 'weekly');
        assertEquals(s.weekday, 'saturday');
        assertEquals(s.start_time_of_day, '10:00');
        assertEquals(getRabid().event_series.listAll.all({}).length, 1);
    }));
});

test("activeRecurring excludes 'none' prototypes and ended series", async () => {
    await withTestDb(() => asSystem(() => {
        const r = getRabid();
        weeklySeries();                                                  // active
        weeklySeries({description: 'Ended', effective_end: '2026-05-01'}); // window closed
        r.event_series.insert({description: 'Setup template', event_kind: 'public',
            location_description: '', frequency: 'none'});               // manual prototype
        const active = r.event_series.activeRecurring.all({today: '2026-07-01'});
        assertEquals(active.map(s => s.description), ['Public Bike Repair']);
    }));
});

test("skips: forSeries + skipDates", async () => {
    await withTestDb(() => asSystem(() => {
        const r = getRabid();
        const sid = weeklySeries();
        r.event_series_skip.insert({event_series_id: sid, skip_date: '2026-08-01', reason: 'Long weekend'});
        r.event_series_skip.insert({event_series_id: sid, skip_date: '2026-07-04'});
        assertEquals(r.event_series_skip.forSeries.all({event_series_id: sid}).map(s => s.skip_date),
            ['2026-07-04', '2026-08-01']);
        assertEquals(r.event_series_skip.skipDates(sid), new Set(['2026-07-04', '2026-08-01']));
    }));
});

test("event.series_id links an instance; (series, occurrence-day) is unique", async () => {
    await withTestDb(() => asSystem(() => {
        const r = getRabid();
        const sid = weeklySeries();
        const mk = () => r.event.insert({
            event_kind: 'public', description: 'Public Bike Repair', location_description: 'Victoria Park',
            location_url: '', is_remote_event: 0, volunteer_only: 0, is_catch_all: 0,
            total_cash_collected: 0, notes: '', series_id: sid,
            start_time: '2026-06-06 10:00:00', end_time: '2026-06-06 15:00:00',
        });
        const eid = mk();
        assertEquals(r.event.getById(eid).series_id, sid);
        // A second instance for the SAME series + day violates the uniqueness guard.
        assertThrows(() => mk());
        // A different day is fine.
        assert(r.event.insert({
            event_kind: 'public', description: 'Public Bike Repair', location_description: 'Victoria Park',
            location_url: '', is_remote_event: 0, volunteer_only: 0, is_catch_all: 0,
            total_cash_collected: 0, notes: '', series_id: sid,
            start_time: '2026-06-13 10:00:00', end_time: '2026-06-13 15:00:00',
        }) > 0);
    }));
});
