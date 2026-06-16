// "Active within N days" + the volunteer picker built on it.
//   - activeVolunteerIdsWithin(N): a volunteer counts as active if they have a
//     timesheet entry that started, or an event check-in whose event occurred,
//     within N days.  One window mechanism, used for 30 and (planned) 60/120.
//   - VolunteerForeignKeyField: picker lists active-first (alpha) then the rest,
//     with a PICKER-ONLY "(Active 30 Days)" marker on the last active option.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import { withTestDb, asSystem } from "./testing.ts";
import { getRabid } from "./rabid.ts";
import * as date from "../liminal/date.ts";
import { activeVolunteerIdsWithin, VolunteerForeignKeyField } from "./volunteer-activity.ts";

// A datetime `days` ago (so fixtures land inside / outside a window deterministically).
const daysAgo = (days: number) => date.temporalToSqliteDateTime(date.orgNow().subtract({days}));

function newEvent(start: string, end: string): number {
    return getRabid().event.insert({
        event_kind: 'public', description: 'Repair Night', location_description: '',
        location_url: '', is_remote_event: 0, volunteer_only: 0,
        start_time: start, end_time: end, total_cash_collected: 0, notes: '',
    });
}

test("activeVolunteerIdsWithin: timesheet OR recent check-in counts; old activity does not", () =>
    withTestDb(({ alice, bob, carol, dave }) => asSystem(() => {
        const r = getRabid();
        // bob: a timesheet entry 5 days ago -> active.
        r.timesheet_entry.insert({
            volunteer_id: bob, start_time: daysAgo(5), end_time: daysAgo(5),
            notes: 'shop', is_paid_time: 0, km_driven_for_reimbursement: 0,
            km_driven_processed: 0, paid_time_processed: 0,
        });
        // carol: checked into an event that happened 10 days ago -> active.
        const recentEvent = newEvent(daysAgo(10), daysAgo(10));
        r.event_checkin.insert({ event_id: recentEvent, volunteer_id: carol, notes: '' });
        // dave: only an OLD check-in (event 90 days ago) -> NOT active within 30.
        const oldEvent = newEvent(daysAgo(90), daysAgo(90));
        r.event_checkin.insert({ event_id: oldEvent, volunteer_id: dave, notes: '' });
        // alice: nothing -> not active.

        const active30 = activeVolunteerIdsWithin(30);
        assertEquals(active30.has(bob), true);
        assertEquals(active30.has(carol), true);
        assertEquals(active30.has(dave), false);
        assertEquals(active30.has(alice), false);

        // A wider window catches dave's 90-day-old check-in.
        assertEquals(activeVolunteerIdsWithin(120).has(dave), true);
    })));

test("VolunteerForeignKeyField: active-first ordering with a picker-only marker", () =>
    withTestDb(({ bob }) => asSystem(() => {
        const r = getRabid();
        // Make bob ("Bob Shares") recently active; the others stay inactive.
        r.timesheet_entry.insert({
            volunteer_id: bob, start_time: daysAgo(3), end_time: daysAgo(3),
            notes: 'shop', is_paid_time: 0, km_driven_for_reimbursement: 0,
            km_driven_processed: 0, paid_time_processed: 0,
        });
        const field = new VolunteerForeignKeyField('volunteer_id', {});
        const opts = field.loadOptions();

        // The active volunteer comes first and carries the marker; the marker is
        // exactly the boundary (only one option has it).
        assertEquals(opts[0].id, bob);
        assertEquals(opts[0].label, 'Bob Shares (Active 30 Days)');
        assertEquals(opts.filter(o => String(o.label).includes('(Active 30 Days)')).length, 1);
        // The rest follow, alpha, unmarked.
        const rest = opts.slice(1).map(o => o.label);
        assertEquals(rest, ['Alice Host', 'Carol Private', 'Dave Admin']);

        // The marker is PICKER-ONLY: loadLabel (selected display) stays plain.
        assertEquals(field.loadLabel(bob), 'Bob Shares');
    })));

test("VolunteerForeignKeyField: no marker when every shown option is active", () =>
    withTestDb(({ alice, bob, carol, dave }) => asSystem(() => {
        const r = getRabid();
        for (const id of [alice, bob, carol, dave])
            r.timesheet_entry.insert({
                volunteer_id: id, start_time: daysAgo(2), end_time: daysAgo(2),
                notes: 'shop', is_paid_time: 0, km_driven_for_reimbursement: 0,
                km_driven_processed: 0, paid_time_processed: 0,
            });
        const opts = new VolunteerForeignKeyField('volunteer_id', {}).loadOptions();
        assertEquals(opts.some(o => String(o.label).includes('(Active 30 Days)')), false);
    })));
