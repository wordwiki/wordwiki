// The public schedule block: rendered from RULES (no materialized instances),
// showing cadence, location, next date, and upcoming skips.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import { find, findAll, hasText, hasClass } from "../liminal/testing/markup-assert.ts";
import { withTestDb, asSystem } from "./testing.ts";
import { getRabid } from "./rabid.ts";
import { blockKind } from "../components/block-registry.ts";
import * as date from "../liminal/date.ts";

test("rabid-schedule block is app-registered", () => {
    const k = blockKind('rabid-schedule');
    assert(k && k.category === 'app');
});

test("schedule renders active series from rules (cadence, location, next, skip); ignores ended + one-offs", async () => {
    await withTestDb(() => asSystem(() => {
        date.setFixedNow('2026-06-10 09:00:00');
        try {
            const r = getRabid();
            const sid = r.event_series.insert({
                description: 'Public Bike Repair', event_kind: 'public', location_description: 'Victoria Park',
                frequency: 'weekly', weekday: 'saturday', start_time_of_day: '10:00', end_time_of_day: '15:00',
                effective_start: '2026-06-06', effective_end: '2026-08-29',
            });
            r.event_series.insert({description: 'Winter Repair', event_kind: 'public', location_description: '',
                frequency: 'weekly', weekday: 'sunday', start_time_of_day: '10:00',
                effective_start: '2025-12-01', effective_end: '2026-03-01'});   // ended
            r.event_series.insert({description: 'Setup template', event_kind: 'public',
                location_description: '', frequency: 'none'});                     // one-off
            r.event_series_skip.insert({event_series_id: sid, skip_date: '2026-08-01', reason: 'Long weekend'});

            const m = r.event_series.renderPublicSchedule();
            // Only the active series shows.
            assertEquals(findAll(m, n => hasClass(n, 'rrbr-schedule-row')).length, 1);
            assert(find(m, n => hasText(n, 'Public Bike Repair')));
            assert(find(m, n => hasClass(n, 'rrbr-schedule-when') && hasText(n, 'Saturdays')));
            assert(find(m, n => hasText(n, '10:00 AM')));                 // friendly time
            assert(find(m, n => hasClass(n, 'rrbr-schedule-loc') && hasText(n, 'Victoria Park')));
            assert(find(m, n => hasClass(n, 'rrbr-schedule-next')));       // a next date
            // The upcoming skip is annotated (schedule shows it with no materialized event).
            assert(find(m, n => hasClass(n, 'rrbr-schedule-skips') && hasText(n, 'Long weekend')));
            // Ended + one-off are absent.
            assertEquals(findAll(m, n => hasText(n, 'Winter Repair')).length, 0);
            assertEquals(findAll(m, n => hasText(n, 'Setup template')).length, 0);
        } finally {
            date.setFixedNow(null);
        }
    }));
});
