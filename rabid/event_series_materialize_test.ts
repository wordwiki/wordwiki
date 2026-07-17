// Materialization: creating event instances from a series - idempotent, skip-aware,
// horizon-bounded, and reusable as the bulk-import path over a past window.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import { withTestDb, asSystem } from "./testing.ts";
import { getRabid } from "./rabid.ts";
import * as date from "../liminal/date.ts";

function summerSaturdays(over: Record<string, any> = {}): number {
    return getRabid().event_series.insert({
        description: 'Public Bike Repair', event_kind: 'public', location_description: 'Victoria Park',
        frequency: 'weekly', weekday: 'saturday', start_time_of_day: '10:00', end_time_of_day: '15:00',
        effective_start: '2026-06-06', effective_end: '2026-08-29', ...over,
    });
}
function instances(series_id: number) {
    return getRabid().event.allEvents.all({})
        .filter(e => e.series_id === series_id)
        .map(e => e.start_time ?? '').sort();
}

test("materialize creates one event per occurrence, inheriting the prototype", async () => {
    await withTestDb(() => asSystem(() => {
        const r = getRabid();
        const sid = summerSaturdays();
        const n = r.event_series.materialize(sid, '2026-06-01', '2026-06-30');
        assertEquals(n, 4);   // June Saturdays: 6,13,20,27
        const evs = r.event.allEvents.all({}).filter(e => e.series_id === sid);
        assertEquals(evs.map(e => e.start_time).sort(),
            ['2026-06-06 10:00:00', '2026-06-13 10:00:00', '2026-06-20 10:00:00', '2026-06-27 10:00:00']);
        // Prototype inherited.
        assertEquals(evs[0].description, 'Public Bike Repair');
        assertEquals(evs[0].location_description, 'Victoria Park');
        assertEquals(evs[0].end_time, '2026-06-06 15:00:00');
    }));
});

test("materialize is idempotent - a second run creates nothing", async () => {
    await withTestDb(() => asSystem(() => {
        const r = getRabid();
        const sid = summerSaturdays();
        assertEquals(r.event_series.materialize(sid, '2026-06-01', '2026-06-30'), 4);
        assertEquals(r.event_series.materialize(sid, '2026-06-01', '2026-06-30'), 0);  // no dupes
        assertEquals(instances(sid).length, 4);
    }));
});

test("materialize skips holiday-exception dates", async () => {
    await withTestDb(() => asSystem(() => {
        const r = getRabid();
        const sid = summerSaturdays();
        r.event_series_skip.insert({event_series_id: sid, skip_date: '2026-06-13', reason: 'Long weekend'});
        r.event_series.materialize(sid, '2026-06-01', '2026-06-30');
        assertEquals(instances(sid),
            ['2026-06-06 10:00:00', '2026-06-20 10:00:00', '2026-06-27 10:00:00']);  // no June 13
    }));
});

test("ensureMaterialized populates active series to the horizon (and only within the window)", async () => {
    await withTestDb(() => asSystem(() => {
        const r = getRabid();
        // Season around 'now': pin today so the horizon is deterministic.
        date.setFixedNow('2026-06-10 09:00:00');
        try {
            const sid = summerSaturdays({effective_start: '2026-06-06', effective_end: '2026-08-29'});
            r.event_series.insert({description: 'One-off', event_kind: 'public',
                location_description: '', frequency: 'none'});   // not materialized
            const n = r.event_series.ensureMaterialized(35);     // today .. +35d
            // From 2026-06-10, +35d = 2026-07-15: Saturdays 13, 20, 27, Jul 4, 11.
            assertEquals(n, 5);
            assertEquals(instances(sid), [
                '2026-06-13 10:00:00', '2026-06-20 10:00:00', '2026-06-27 10:00:00',
                '2026-07-04 10:00:00', '2026-07-11 10:00:00']);
            // Idempotent on re-run.
            assertEquals(r.event_series.ensureMaterialized(35), 0);
        } finally {
            date.setFixedNow(null);
        }
    }));
});

test("bulk import = materialize over a PAST window", async () => {
    await withTestDb(() => asSystem(() => {
        const r = getRabid();
        const sid = summerSaturdays({effective_start: '2023-06-01', effective_end: '2023-08-31'});
        const n = r.event_series.materialize(sid, '2023-06-01', '2023-06-30');
        assertEquals(n, 4);
        assert(instances(sid).every(t => t.startsWith('2023-06')));
    }));
});
