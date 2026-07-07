// The per-day "Ad-hoc" catch-all event: the bucket for activity (services, sales)
// that wasn't part of any scheduled event.  catchAllForDate is find-or-create,
// 1-1 per calendar day (partial unique index), with NULL clock times.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertThrows } from "../liminal/testing/assert.ts";
import { withTestDb, asSystem } from "./testing.ts";
import { getRabid } from "./rabid.ts";
import * as date from "../liminal/date.ts";

test("catchAllForDate: lazy find-or-create, 1-1 per day", () =>
    withTestDb(() => asSystem(() => {
        const e = getRabid().event;
        const day = '2026-07-06';
        assertEquals(e.catchAllForDate(day, false), undefined);   // not yet
        const id = e.catchAllForDate(day, true);                  // create
        assert(id !== undefined);
        assertEquals(e.catchAllForDate(day, true), id);           // same one
        assertEquals(e.catchAllForDate(day, false), id);          // found without create
    })));

test("a catch-all is flagged, day-stamped, and has NULL clock times", () =>
    withTestDb(() => asSystem(() => {
        const e = getRabid().event;
        const day = '2026-07-06';
        const ev = e.getById(e.catchAllForDate(day, true)!);
        assertEquals(ev.is_catch_all, 1);
        assertEquals(ev.catch_all_date, day);
        assert(ev.start_time == null, 'catch-all has no start time');
        assert(ev.end_time == null, 'catch-all has no end time');
    })));

test("distinct days get distinct catch-alls that coexist", () =>
    withTestDb(() => asSystem(() => {
        const e = getRabid().event;
        const a = e.catchAllForDate('2026-07-06', true);
        const b = e.catchAllForDate('2026-07-07', true);
        assert(a !== b);
        assertEquals(e.catchAllForDate('2026-07-06', false), a);
        assertEquals(e.catchAllForDate('2026-07-07', false), b);
    })));

test("catchAllForToday resolves the org wall-clock day", () =>
    withTestDb(() => asSystem(() => {
        const e = getRabid().event;
        const today = date.temporalToSqliteDate(date.orgToday());
        const id = e.catchAllForToday(true);
        assertEquals(id, e.catchAllForDate(today, false));
        assertEquals(e.getById(id!).catch_all_date, today);
    })));

test("the partial unique index blocks a second catch-all for the same day", () =>
    withTestDb(() => asSystem(() => {
        const e = getRabid().event;
        const day = '2026-07-06';
        e.catchAllForDate(day, true);
        // A direct duplicate insert (bypassing find-or-create) must be rejected by
        // the unique index - this is what makes catchAllForDate race-safe.
        assertThrows(() => e.insert({
            is_catch_all: 1, catch_all_date: day,
            event_kind: 'shopTime', description: ''} as any));
    })));

test("normal events are unconstrained by the catch-all index (NULLs are distinct)", () =>
    withTestDb(() => asSystem(() => {
        const e = getRabid().event;
        // Two ordinary events (catch_all_date NULL) coexist fine.
        const mk = () => e.insert({
            event_kind: 'public', description: 'Saturday in the Park',
            location_description: '', location_url: '', is_remote_event: 0,
            volunteer_only: 0, start_time: '2026-06-20 10:00:00',
            end_time: '2026-06-20 15:00:00', total_cash_collected: 0, notes: ''});
        const a = mk(), b = mk();
        assert(a !== b);
        assertEquals(e.getById(a).is_catch_all, 0);
    })));
