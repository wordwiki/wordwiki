// Reconcile: forward-only self-heal.  Creates missing occurrences, deletes future
// instances that no longer match - but never committed activity, never today/past,
// and never MODIFIES an existing instance.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import { withTestDb, asSystem } from "./testing.ts";
import { getRabid } from "./rabid.ts";
import * as date from "../liminal/date.ts";

// Pin "today" so future/past are deterministic.  Season spans the pinned day.
function pinNow(fn: () => void) {
    date.setFixedNow('2026-06-10 09:00:00');
    try { fn(); } finally { date.setFixedNow(null); }
}
function saturdays(over: Record<string, any> = {}): number {
    return getRabid().event_series.insert({
        description: 'Public Bike Repair', event_kind: 'public', location_description: 'Victoria Park',
        frequency: 'weekly', weekday: 'saturday', start_time_of_day: '10:00', end_time_of_day: '15:00',
        effective_start: '2026-06-06', effective_end: '2026-08-29', ...over,
    });
}
function futureDates(sid: number) {
    return getRabid().event.allEvents.all({}).filter(e => e.series_id === sid)
        .map(e => (e.start_time ?? '').slice(0, 10)).sort();
}

test("changing the weekday deletes the now-invalid future occurrences and creates the new ones", async () => {
    await withTestDb(() => pinNow(() => asSystem(() => {
        const r = getRabid();
        const sid = saturdays();
        r.event_series.materialize(sid, '2026-06-10', '2026-07-15');   // Saturdays 13,20,27,Jul4,11
        assertEquals(futureDates(sid).length, 5);
        // Move it to Wednesdays.
        r.event_series.updateNamedFields(sid, ['weekday'], {weekday: 'wednesday'} as any);
        const {created, deleted} = r.event_series.reconcile(sid, 35);
        assert(deleted === 5);                     // all the old Saturdays gone
        assert(created >= 1);                       // new Wednesdays created
        // Every remaining future instance is now a Wednesday (dayOfWeek 3).
        for(const d of futureDates(sid))
            assertEquals(date.sqliteDateToTemporal(d).dayOfWeek, 3);
    })));
});

test("reconcile NEVER deletes an instance with activity, even if it no longer matches", async () => {
    await withTestDb(() => pinNow(() => asSystem(() => {
        const r = getRabid();
        const sid = saturdays();
        r.event_series.materialize(sid, '2026-06-10', '2026-07-15');
        const sat = r.event.allEvents.all({}).find(e => e.series_id === sid)!;
        // Someone signs up for one Saturday.
        r.event_commitment.insert({event_id: sat.event_id, volunteer_id: 1, notes: ''} as any);
        // Retire the series entirely (frequency none => nothing matches).
        r.event_series.updateNamedFields(sid, ['frequency'], {frequency: 'none'} as any);
        const {deleted} = r.event_series.reconcile(sid, 35);
        // The committed instance survives; the rest are gone.
        assert(r.event.allEvents.all({}).some(e => e.event_id === sat.event_id));
        assert(deleted >= 1);
    })));
});

test("reconcile never touches past instances", async () => {
    await withTestDb(() => pinNow(() => asSystem(() => {
        const r = getRabid();
        // A series whose window is entirely in the past, with instances materialized.
        const sid = saturdays({effective_start: '2026-05-01', effective_end: '2026-05-31'});
        r.event_series.materialize(sid, '2026-05-01', '2026-05-31');   // all before pinned 'today'
        const before = futureDates(sid).length;
        assert(before > 0);
        const {deleted} = r.event_series.reconcile(sid, 35);
        assertEquals(deleted, 0);                    // past events untouched
        assertEquals(futureDates(sid).length, before);
    })));
});

test("adding a skip removes that future occurrence on reconcile", async () => {
    await withTestDb(() => pinNow(() => asSystem(() => {
        const r = getRabid();
        const sid = saturdays();
        r.event_series.materialize(sid, '2026-06-10', '2026-07-15');
        assert(futureDates(sid).includes('2026-06-20'));
        r.event_series_skip.insert({event_series_id: sid, skip_date: '2026-06-20', reason: 'Holiday'});
        const {deleted} = r.event_series.reconcile(sid, 35);
        assert(deleted >= 1);
        assert(!futureDates(sid).includes('2026-06-20'));
    })));
});
