// The reconciled per-volunteer time view (volunteer_time.ts).  The heart is the
// PURE reducer reconcileTime - overlap-nesting, week grouping, totals - tested
// here with plain TimeSpan arrays (no db, no HTML).  Then a few integration
// tests for the query/render/mutation layer.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertRejects } from "../liminal/testing/assert.ts";
import { withTestDb, renderRoute, invoke, asUser, asSystem } from "./testing.ts";
import { hasText, findAll, testIdOf } from "../liminal/testing/markup-assert.ts";
import { rabid } from "./rabid.ts";
import { reconcileTime, spanHours, hoursBreakdown, WEEK_WINDOW,
         type TimeSpan, type TaskSpan, type HoursTotals, type ConfirmOpts } from "./volunteer_time.ts";

function tk(id: number, doneTime: string,
            opts: {eventId?: number, eventStart?: string, eventEnd?: string|null,
                   eventLabel?: string, title?: string} = {}): TaskSpan {
    return {id, doneTime, title: opts.title ?? `task ${id}`, eventId: opts.eventId,
            eventStart: opts.eventStart, eventEnd: opts.eventEnd, eventLabel: opts.eventLabel};
}

function ts(id: number, start: string, end: string | null, paid = false, confirmed = false): TimeSpan {
    return {source: 'timesheet', id, start, end, hours: spanHours(start, end),
            label: 'work', paid, wasStaff: false, confirmed, notes: ''};
}
function ci(id: number, start: string, end: string | null, wasStaff = false, confirmed = false): TimeSpan {
    return {source: 'checkin', id, start, end, hours: spanHours(start, end),
            label: 'Event', eventId: 100 + id, paid: false, wasStaff, confirmed, notes: ''};
}

// --- The pure reducer ----------------------------------------------------------

test("reconcile: non-overlapping timesheet + check-in both count", () => {
    const m = reconcileTime(1,
        [ts(1, '2026-06-01 09:00:00', '2026-06-01 12:00:00')],          // 3h volunteer
        [ci(2, '2026-06-01 14:00:00', '2026-06-01 16:00:00')]);         // 2h volunteer
    assertEquals(m.weeks.length, 1);
    assertEquals(m.weeks[0].entries.length, 2);
    assertEquals(m.weeks[0].entries.every(e => e.nested.length === 0), true);
    assertEquals(m.hours, 5);
    assertEquals(m.volunteerHours, 5);
    assertEquals(m.paidHours, 0);
});

test("reconcile: an overlapping check-in nests under the timesheet and is NOT counted", () => {
    const m = reconcileTime(1,
        [ts(1, '2026-06-01 09:00:00', '2026-06-01 12:00:00', /*paid*/ true)],  // 3h paid
        [ci(2, '2026-06-01 10:00:00', '2026-06-01 11:00:00')]);                // nested
    assertEquals(m.weeks[0].entries.length, 1);
    assertEquals(m.weeks[0].entries[0].span.id, 1);
    assertEquals(m.weeks[0].entries[0].nested.map(s => s.id), [2]);
    assertEquals(m.hours, 3);              // timesheet only, check-in not added
    assertEquals(m.paidHours, 3);
    assertEquals(m.volunteerHours, 0);
});

test("reconcile: timesheet wins even when the event extends past it (tail dropped)", () => {
    // Checked into the whole event 9–12 but the (authoritative) timesheet is 9–10.
    const m = reconcileTime(1,
        [ts(1, '2026-06-01 09:00:00', '2026-06-01 10:00:00')],         // 1h
        [ci(2, '2026-06-01 09:00:00', '2026-06-01 12:00:00')]);        // 3h, nested
    assertEquals(m.weeks[0].entries.length, 1);
    assertEquals(m.weeks[0].entries[0].nested.map(s => s.id), [2]);
    assertEquals(m.hours, 1);              // the event's extra 2h is NOT counted
});

test("reconcile: a check-in overlapping two timesheets nests under the earliest", () => {
    const m = reconcileTime(1,
        [ts(1, '2026-06-01 09:00:00', '2026-06-01 10:00:00'),
         ts(2, '2026-06-01 11:00:00', '2026-06-01 12:00:00')],
        [ci(3, '2026-06-01 09:30:00', '2026-06-01 11:30:00')]);
    const byId = new Map(m.weeks[0].entries.map(e => [e.span.id, e]));
    assertEquals(byId.get(1)!.nested.map(s => s.id), [3]);
    assertEquals(byId.get(2)!.nested.length, 0);
    assertEquals(m.hours, 2);              // both timesheets count once; check-in nested
});

test("reconcile: groups into weeks, most recent first, with subtotals", () => {
    const m = reconcileTime(1,
        [ts(1, '2026-06-01 09:00:00', '2026-06-01 10:00:00'),          // earlier week
         ts(2, '2026-06-20 09:00:00', '2026-06-20 11:00:00')],         // ~3 weeks later
        []);
    assertEquals(m.weeks.length, 2);
    assertEquals(m.weeks[0].entries[0].span.id, 2);   // recent week first
    assertEquals(m.weeks[1].entries[0].span.id, 1);
    assertEquals(m.weeks[0].hours, 2);
    assertEquals(m.weeks[1].hours, 1);
    assertEquals(m.hours, 3);
});

test("reconcile: paid/volunteer split (paid timesheet vs unpaid + check-ins)", () => {
    const m = reconcileTime(1,
        [ts(1, '2026-06-01 09:00:00', '2026-06-01 11:00:00', /*paid*/ true),   // 2h paid
         ts(2, '2026-06-01 13:00:00', '2026-06-01 14:00:00')],                 // 1h volunteer
        [ci(3, '2026-06-01 15:00:00', '2026-06-01 18:00:00')]);                // 3h volunteer
    assertEquals(m.hours, 6);
    assertEquals(m.paidHours, 2);
    assertEquals(m.volunteerHours, 4);
});

test("reconcile: confirmed/unconfirmed split the volunteer (unpaid) hours", () => {
    const m = reconcileTime(1,
        [ts(1, '2026-06-01 09:00:00', '2026-06-01 11:00:00', /*paid*/ true)],   // 2h paid (not in split)
        [ci(2, '2026-06-02 09:00:00', '2026-06-02 12:00:00', false, /*confirmed*/ true),   // 3h confirmed
         ci(3, '2026-06-03 09:00:00', '2026-06-03 10:00:00', false, /*confirmed*/ false)]); // 1h unconfirmed
    assertEquals(m.volunteerHours, 4);
    assertEquals(m.confirmedHours, 3);
    assertEquals(m.unconfirmedHours, 1);
    // A nested (subsumed) check-in's confirmation never counts - it's not counted hours.
    const nested = reconcileTime(1,
        [ts(1, '2026-06-01 09:00:00', '2026-06-01 12:00:00')],
        [ci(2, '2026-06-01 10:00:00', '2026-06-01 11:00:00', false, true)]);
    assertEquals(nested.confirmedHours, 0);   // the check-in nested under the timesheet
});

// --- hoursBreakdown (pure: a labelled subtotal/total) --------------------------

function totals(p: Partial<HoursTotals>): HoursTotals {
    const volunteerHours = p.volunteerHours ?? 0;
    const paidHours = p.paidHours ?? 0;
    const confirmedHours = p.confirmedHours ?? 0;
    return {
        hours: p.hours ?? (volunteerHours + paidHours),
        paidHours, volunteerHours, confirmedHours,
        unconfirmedHours: p.unconfirmedHours ?? (volunteerHours - confirmedHours),
    };
}
const SHOWN: ConfirmOpts = {show: true, canConfirm: false};   // viewer may see confirmation
const HIDDEN: ConfirmOpts = {show: false, canConfirm: false}; // viewer may not

test("hoursBreakdown: the common single-kind cases are just a number + label", () => {
    assertEquals(hoursBreakdown(totals({volunteerHours: 5.5}), HIDDEN), '5.5 volunteer');
    assertEquals(hoursBreakdown(totals({paidHours: 8}), HIDDEN), '8.0 paid hours');
});

test("hoursBreakdown: confirmed/unconfirmed shown only to permitted viewers", () => {
    const t = totals({volunteerHours: 4.5, confirmedHours: 3, unconfirmedHours: 1.5});
    assertEquals(hoursBreakdown(t, SHOWN), '3.0 confirmed · 1.5 unconfirmed');
    // all-confirmed collapses to a single part
    assertEquals(hoursBreakdown(totals({volunteerHours: 4.5, confirmedHours: 4.5, unconfirmedHours: 0}), SHOWN),
                 '4.5 confirmed');
    // a viewer who may NOT see confirmation reads plain "volunteer" - NO leak,
    // and a regular volunteer (all hours "unconfirmed" internally) never reads it.
    assertEquals(hoursBreakdown(t, HIDDEN), '4.5 volunteer');
});

test("hoursBreakdown: a genuine mix joins parts; zero/residue parts are dropped", () => {
    assertEquals(hoursBreakdown(totals({volunteerHours: 2, paidHours: 6}), HIDDEN),
                 '2.0 volunteer · 6.0 paid hours');
    // carrier-only week (no counted hours) -> a bare "0.0"
    assertEquals(hoursBreakdown(totals({hours: 0}), HIDDEN), '0.0');
    // a floating-point residue (0.3 - (0.1+0.2) = -5.6e-17) must not show "-0.0 unconfirmed"
    assertEquals(hoursBreakdown(
        totals({volunteerHours: 0.3, confirmedHours: 0.1 + 0.2, unconfirmedHours: 0.3 - (0.1 + 0.2)}), SHOWN),
        '0.3 confirmed');
});

// --- Integration: query + render + mutations -----------------------------------

function insertEvent(): number {
    return asSystem(() => rabid.event.insert({
        event_kind: 'public', description: 'Repair Night',
        location_description: 'The shop', location_url: '',
        is_remote_event: 0, volunteer_only: 0,
        start_time: '2026-06-20 19:00:00', end_time: '2026-06-20 21:30:00',
        total_cash_collected: 0, notes: '',
    }));
}

// --- Completed-task placement (pure) -------------------------------------------

test("task: event-subordinate task nests under the event's check-in entry", () => {
    const m = reconcileTime(1, [],
        [ci(5, '2026-06-03 17:00:00', '2026-06-03 20:00:00')],          // checked into event 105
        [tk(9, '2026-06-05 10:00:00', {eventId: 105})]);               // task done 2 days later
    assertEquals(m.weeks[0].entries.length, 1);
    assertEquals(m.weeks[0].entries[0].span.source, 'checkin');
    assertEquals(m.weeks[0].entries[0].tasks.map(t => t.id), [9]);     // attached to the event
});

test("task: event-subordinate with NO check-in is an ORPHAN (hidden unless includeOrphans)", () => {
    const args: [number, TimeSpan[], TimeSpan[], TaskSpan[]] = [1, [], [],
        [tk(9, '2026-06-20 10:00:00',
            {eventId: 105, eventStart: '2026-06-03 17:00:00', eventEnd: '2026-06-03 20:00:00',
             eventLabel: 'Repair Night'})]];
    // Default: no host entry to attach to -> nothing shown.
    assertEquals(reconcileTime(...args).weeks.length, 0);
    // With orphans: a synthesized zero-hour event row in the EVENT's week.
    const m = reconcileTime(...args, /*includeOrphans*/ true);
    assertEquals(m.weeks.length, 1);
    assertEquals(m.weeks[0].weekStart, '2026-06-01');                  // Mon of the event's week, NOT done_time's
    const e = m.weeks[0].entries[0];
    assertEquals(e.span.source, 'event');
    assertEquals(e.span.hours, 0);                                     // no attendance hours
    assertEquals(e.tasks.map(t => t.id), [9]);
    assertEquals(m.hours, 0);                                          // tasks add no hours
});

test("task: a non-event task done during a timesheet shift attaches to that shift", () => {
    const m = reconcileTime(1,
        [ts(1, '2026-06-01 09:00:00', '2026-06-01 17:00:00')],         // an 8h shift
        [],
        [tk(9, '2026-06-01 11:00:00')]);                               // done mid-shift
    assertEquals(m.weeks[0].entries.length, 1);
    assertEquals(m.weeks[0].entries[0].span.source, 'timesheet');
    assertEquals(m.weeks[0].entries[0].tasks.map(t => t.id), [9]);
    assertEquals(m.hours, 8);                                          // task adds nothing
});

test("task: a standalone task (no event, no shift) is an ORPHAN per-day row only with includeOrphans", () => {
    const tasks = [tk(9, '2026-06-02 14:00:00'), tk(10, '2026-06-02 16:00:00')]; // same day
    assertEquals(reconcileTime(1, [], [], tasks).weeks.length, 0);              // hidden by default
    const m = reconcileTime(1, [], [], tasks, /*includeOrphans*/ true);
    assertEquals(m.weeks[0].entries.length, 1);
    assertEquals(m.weeks[0].entries[0].span.source, 'task');
    assertEquals(m.weeks[0].entries[0].tasks.map(t => t.id), [9, 10]);
    assertEquals(m.hours, 0);
});

test("task: tasks default off (empty tasks arg = the old behavior)", () => {
    const m = reconcileTime(1, [ts(1, '2026-06-01 09:00:00', '2026-06-01 12:00:00')], []);
    assertEquals(m.weeks[0].entries.every(e => e.tasks.length === 0), true);
});

test("model: a real timesheet + an overlapping event check-in reconcile to one counted entry", () => {
    return withTestDb(({ bob }) => {
        const eid = insertEvent();
        asSystem(() => rabid.timesheet_entry.insert({
            volunteer_id: bob, start_time: '2026-06-20 19:00:00', end_time: '2026-06-20 21:00:00',
            notes: 'paid shift', is_paid_time: 1, km_driven_for_reimbursement: 0,
            km_driven_processed: 0, paid_time_processed: 0,
        } as any));
        asSystem(() => rabid.event_checkin.insert({event_id: eid, volunteer_id: bob, notes: ''}));

        const m = asSystem(() => rabid.volunteer_time.model(bob));
        assertEquals(m.weeks.length, 1);
        assertEquals(m.weeks[0].entries.length, 1);                 // the check-in nested in
        assertEquals(m.weeks[0].entries[0].span.source, 'timesheet');
        assertEquals(m.weeks[0].entries[0].nested.length, 1);
        assertEquals(m.weeks[0].entries[0].nested[0].source, 'checkin');
        assertEquals(m.hours, 2);                                   // timesheet wins (event is 2.5h)
        assertEquals(m.paidHours, 2);
    });
});

test("model: time_volunteered_minutes counts that duration, not the whole event", () => {
    return withTestDb(({ bob }) => {
        const eid = insertEvent();   // event is 19:00–21:30 = 2.5h
        asSystem(() => rabid.event_checkin.insert(
            {event_id: eid, volunteer_id: bob, notes: '', time_volunteered_minutes: 90}));
        const m = asSystem(() => rabid.volunteer_time.model(bob));
        assertEquals(m.hours, 1.5);                          // 90 min, not the 2.5h event
        const span = m.weeks[0].entries[0].span;
        assertEquals(span.start, '2026-06-20 19:00:00');     // anchored at the event start
        assertEquals(span.end, '2026-06-20 20:30:00');       // start + 90 min (window agrees with hours)
    });
});

test("editCheckin sets and clears time_volunteered_minutes (self-or-host)", () => {
    return withTestDb(async ({ bob }) => {
        const eid = insertEvent();
        await asUser(bob, () => invoke(`rabid.event_checkin.checkSelfIn($arg0)`, eid));
        const cid = asSystem(() =>
            rabid.event_checkin.checkinsForEvent.all({event_id: eid})[0].event_checkin_id);

        // Set it (host posthumously rounding to 90 min).
        await asUser(bob, () => invoke(`rabid.event_checkin.editCheckin($arg0)`,
            {event_checkin_id: String(cid), time_volunteered_minutes: '90', notes: ''}));
        assertEquals(asSystem(() => rabid.volunteer_time.model(bob)).hours, 1.5);

        // Empty input clears it -> back to the whole-event default (2.5h).
        await asUser(bob, () => invoke(`rabid.event_checkin.editCheckin($arg0)`,
            {event_checkin_id: String(cid), time_volunteered_minutes: '', notes: ''}));
        assertEquals(asSystem(() => rabid.volunteer_time.model(bob)).hours, 2.5);
    });
});

test("check-in confirmation: host confirms, self cannot, non-host edit clears it", () => {
    return withTestDb(async ({ alice, bob }) => {
        const eid = insertEvent();
        await asUser(bob, () => invoke(`rabid.event_checkin.checkSelfIn($arg0)`, eid));
        const cid = asSystem(() =>
            rabid.event_checkin.checkinsForEvent.all({event_id: eid})[0].event_checkin_id);

        // The volunteer cannot confirm their own hours (route is host/admin only).
        await asUser(bob, () => assertRejects(
            () => invoke(`rabid.event_checkin.confirmCheckin($arg0)`, cid), Error));

        // A host confirms - stamping who vouched.
        await asUser(alice, () => invoke(`rabid.event_checkin.confirmCheckin($arg0)`, cid));
        assertEquals(asSystem(() => rabid.event_checkin.getById(cid)).confirmed_by, alice);

        // The volunteer then edits their own check-in -> confirmation is cleared.
        await asUser(bob, () => invoke(`rabid.event_checkin.editCheckin($arg0)`,
            {event_checkin_id: String(cid), time_volunteered_minutes: '60', notes: ''}));
        assertEquals(asSystem(() => rabid.event_checkin.getById(cid)).confirmed_by, null);

        // A host editing it, however, preserves an existing confirmation.
        await asUser(alice, () => invoke(`rabid.event_checkin.confirmCheckin($arg0)`, cid));
        await asUser(alice, () => invoke(`rabid.event_checkin.editCheckin($arg0)`,
            {event_checkin_id: String(cid), time_volunteered_minutes: '90', notes: ''}));
        assertEquals(asSystem(() => rabid.event_checkin.getById(cid)).confirmed_by, alice);
    });
});

test("timesheet confirmation: host confirms, non-host edit clears it", () => {
    return withTestDb(async ({ alice, bob }) => {
        const tid = asSystem(() => rabid.timesheet_entry.insert({
            volunteer_id: bob, start_time: '2026-06-20 09:00:00', end_time: '2026-06-20 11:00:00',
            notes: 'shop', is_paid_time: 0, km_driven_for_reimbursement: 0,
            km_driven_processed: 0, paid_time_processed: 0,
        } as any));
        await asUser(alice, () => invoke(`rabid.timesheet_entry.confirm($arg0)`, tid));
        assertEquals(asSystem(() => rabid.timesheet_entry.getById(tid)).confirmed_by, alice);

        // bob edits his own entry through the generic save form -> cleared.
        await asUser(bob, () => invoke(`rabid.timesheet_entry.saveForm($arg0)`, {
            timesheet_entry_id: String(tid),
            notes: 'shop work', 'before-notes': 'shop',
        }));
        assertEquals(asSystem(() => rabid.timesheet_entry.getById(tid)).confirmed_by, null);
    });
});

test("timesheet confirmation: an unpaid confirmed entry counts in confirmedHours and renders a badge", () => {
    return withTestDb(async ({ alice, bob }) => {
        asSystem(() => rabid.volunteer.update(bob, {volunteer_hours_need_confirmation: 1} as any));
        const tid = asSystem(() => rabid.timesheet_entry.insert({
            volunteer_id: bob, start_time: '2026-06-20 09:00:00', end_time: '2026-06-20 12:00:00',  // 3h, unpaid
            notes: 'desk work', is_paid_time: 0, km_driven_for_reimbursement: 0,
            km_driven_processed: 0, paid_time_processed: 0,
        } as any));

        // Unconfirmed: the 3 volunteer hours are all unconfirmed.
        let m = asSystem(() => rabid.volunteer_time.model(bob));
        assertEquals(m.volunteerHours, 3);
        assertEquals(m.confirmedHours, 0);
        assertEquals(m.unconfirmedHours, 3);

        // A host confirms the timesheet -> the hours move to confirmed.
        await asUser(alice, () => invoke(`rabid.timesheet_entry.confirm($arg0)`, tid));
        m = asSystem(() => rabid.volunteer_time.model(bob));
        assertEquals(m.confirmedHours, 3);
        assertEquals(m.unconfirmedHours, 0);

        // The confirmed badge renders for the volunteer's own (timesheet) row.
        await asUser(bob, async () => {
            const view = await renderRoute(`rabid.volunteer_time.renderForVolunteer(${bob})`);
            assert(hasText(view, 'confirmed'));
            assert(hasText(view, 'desk work'));   // it's the timesheet row, not a check-in
        });
    });
});

test("confirmation privacy: self & host see status; other volunteers do NOT", () => {
    return withTestDb(async ({ alice, bob, carol }) => {
        asSystem(() => rabid.volunteer.update(bob, {volunteer_hours_need_confirmation: 1} as any));
        const eid = insertEvent();   // 2.5h event
        await asUser(bob, () => invoke(`rabid.event_checkin.checkSelfIn($arg0)`, eid));
        const cid = asSystem(() =>
            rabid.event_checkin.checkinsForEvent.all({event_id: eid})[0].event_checkin_id);

        // Totals are computed regardless of viewer (server-side only).
        let m = asSystem(() => rabid.volunteer_time.model(bob));
        assert(m.needsConfirmation);
        assertEquals(m.unconfirmedHours, 2.5);
        await asUser(alice, () => invoke(`rabid.event_checkin.confirmCheckin($arg0)`, cid));
        m = asSystem(() => rabid.volunteer_time.model(bob));
        assertEquals(m.confirmedHours, 2.5);

        const view = (vid: number) => renderRoute(`rabid.volunteer_time.renderForVolunteer(${vid})`);
        // Self sees their own confirmed status (read-only badge).
        await asUser(bob, async () => assert(hasText(await view(bob), 'confirmed')));
        // A host sees anyone's.
        await asUser(alice, async () => assert(hasText(await view(bob), 'confirmed')));
        // Another (non-host) volunteer viewing bob's page sees NOTHING about it -
        // this is the leak we're preventing in an open-books org.
        await asUser(carol, async () => {
            const v = await view(bob);
            assert(!hasText(v, 'confirmed'));    // also excludes the 'unconfirmed' substring
        });
    });
});

test("needsConfirmation off (the common case): no confirmation UI", () => {
    return withTestDb(async ({ bob }) => {
        const eid = insertEvent();
        await asUser(bob, () => invoke(`rabid.event_checkin.checkSelfIn($arg0)`, eid));
        const m = asSystem(() => rabid.volunteer_time.model(bob));
        assertEquals(m.needsConfirmation, false);
        await asUser(bob, async () => {
            const view = await renderRoute(`rabid.volunteer_time.renderForVolunteer(${bob})`);
            assert(!hasText(view, 'unconfirmed'));
        });
    });
});

test("Time view renders labelled subtotals/total (volunteer vs paid hours)", () => {
    return withTestDb(async ({ bob, carol }) => {
        asSystem(() => rabid.timesheet_entry.insert({
            volunteer_id: bob, start_time: '2026-06-20 09:00:00', end_time: '2026-06-20 12:00:00',  // 3h unpaid
            notes: 'desk', is_paid_time: 0, km_driven_for_reimbursement: 0,
            km_driven_processed: 0, paid_time_processed: 0,
        } as any));
        asSystem(() => rabid.timesheet_entry.insert({
            volunteer_id: carol, start_time: '2026-06-20 09:00:00', end_time: '2026-06-20 17:00:00',  // 8h paid
            notes: 'shift', is_paid_time: 1, km_driven_for_reimbursement: 0,
            km_driven_processed: 0, paid_time_processed: 0,
        } as any));
        // bob's week + total read "3.0 volunteer"; no paid-hours label.
        await asUser(bob, async () => {
            const v = await renderRoute(`rabid.volunteer_time.renderForVolunteer(${bob})`);
            assert(hasText(v, '3.0 volunteer'));
            assert(!hasText(v, 'paid hours'));
        });
        // carol's are all paid -> "8.0 paid hours"; no volunteer label.
        await asUser(carol, async () => {
            const v = await renderRoute(`rabid.volunteer_time.renderForVolunteer(${carol})`);
            assert(hasText(v, '8.0 paid hours'));
            assert(!hasText(v, 'volunteer'));
        });
    });
});

test("week grouping: a gap separates consecutive weeks (none before the first)", () => {
    return withTestDb(({ bob }) => {
        asSystem(() => {
            // Three entries in three distinct (Monday-started) weeks.
            for(const d of ['2026-06-01', '2026-06-08', '2026-06-15']) {
                rabid.timesheet_entry.insert({
                    volunteer_id: bob, start_time: `${d} 09:00:00`, end_time: `${d} 10:00:00`,
                    notes: 'w', is_paid_time: 0, km_driven_for_reimbursement: 0,
                    km_driven_processed: 0, paid_time_processed: 0,
                } as any);
            }
        });
        return asUser(bob, async () => {
            const v = await renderRoute(`rabid.volunteer_time.renderForVolunteer(${bob})`);
            assertEquals(findAll(v, n => testIdOf(n) === 'time-week').length, 3);   // three week headers
            assertEquals(findAll(v, n => testIdOf(n) === 'week-gap').length, 2);    // a gap BETWEEN weeks only
        });
    });
});

test("renderForVolunteer renders the week-grouped table with a total", () => {
    return withTestDb(({ bob }) => {
        asSystem(() => rabid.timesheet_entry.insert({
            volunteer_id: bob, start_time: '2026-06-20 09:00:00', end_time: '2026-06-20 12:00:00',
            notes: 'shop work', is_paid_time: 0, km_driven_for_reimbursement: 0,
            km_driven_processed: 0, paid_time_processed: 0,
        } as any));
        return asUser(bob, async () => {
            const view = await renderRoute(`rabid.volunteer_time.renderForVolunteer(${bob})`);
            assert(hasText(view, "Week of"));
            assert(hasText(view, "Total"));
            assert(hasText(view, "shop work"));
        });
    });
});

test("renderForVolunteer windows to the last WEEK_WINDOW weeks by default; 'show all' reveals the rest", () => {
    const total = WEEK_WINDOW + 4;   // more than a window, so both states differ
    return withTestDb(({ bob }) => {
        // `total` distinct weeks of time (one entry each, 1h, N weeks back).
        asSystem(() => {
            for(let wk = 0; wk < total; wk++) {
                const d = `2026-${String(3).padStart(2,'0')}-01`;   // anchor; offset by weeks below
                const start = new Date(`${d}T09:00:00Z`); start.setUTCDate(start.getUTCDate() - wk * 7);
                const end = new Date(start.getTime() + 3600_000);
                const iso = (x: Date) => x.toISOString().replace('T',' ').slice(0,19);
                rabid.timesheet_entry.insert({
                    volunteer_id: bob, start_time: iso(start), end_time: iso(end),
                    notes: `week ${wk}`, is_paid_time: 0, km_driven_for_reimbursement: 0,
                    km_driven_processed: 0, paid_time_processed: 0,
                } as any);
            }
        });
        const weekCount = (m: any) => findAll(m, n => testIdOf(n) === 'time-week').length;
        return asUser(bob, async () => {
            const def = await renderRoute(`rabid.volunteer_time.renderForVolunteer(${bob})`);
            assertEquals(weekCount(def), WEEK_WINDOW);             // default window
            assert(hasText(def, `Show all ${total} weeks`));
            assert(hasText(def, `Last ${WEEK_WINDOW} weeks`));     // total reflects the window

            const all = await renderRoute(`rabid.volunteer_time.renderForVolunteer(${bob},false,true)`);
            assertEquals(weekCount(all), total);
            assert(hasText(all, `Show last ${WEEK_WINDOW} weeks`));
        });
    });
});

test("adding time is self-or-host; it reloads the volunteer's time fragment", () => {
    return withTestDb(async ({ bob, carol }) => {
        // A different regular volunteer cannot add time for bob.
        await asUser(carol, () => assertRejects(
            () => invoke(`rabid.volunteer_time.addTimesheet($arg0)`,
                         {volunteer_id: String(bob), start_time: '2026-06-20 09:00:00',
                          end_time: '2026-06-20 10:00:00', notes: 'x'}),
            Error, "not permitted"));   // route layer (@route ownTimeOrHost) denies first

        // bob adds his own; the emitted volunteer fk key is what his time
        // fragment registers (volunteer_time.ts).
        const res = await asUser(bob, () => invoke(`rabid.volunteer_time.addTimesheet($arg0)`,
            {volunteer_id: String(bob), start_time: '2026-06-20 09:00:00',
             end_time: '2026-06-20 10:30:00', notes: 'inventory'}));
        assertEquals(res.action, "reload");
        assert(res.targets.includes(`.-timesheet_entry-volunteer_id-${bob}-`));
        const m = asSystem(() => rabid.volunteer_time.model(bob));
        assertEquals(m.hours, 1.5);
    });
});

test("checking into an event from the volunteer page reloads both fragments", () => {
    return withTestDb(async ({ bob }) => {
        const eid = insertEvent();
        const res = await asUser(bob, () => invoke(`rabid.volunteer_time.checkIntoEvent($arg0)`,
            {volunteer_id: String(bob), event_id: String(eid)}));
        assertEquals(res.action, "reload");
        assert(res.targets.includes(`.-event_checkin-volunteer_id-${bob}-`));
        assert(res.targets.includes(`.-event_checkin-event_id-${eid}-`));
        assertEquals(asSystem(() =>
            rabid.event_checkin.checkinsForEvent.all({event_id: eid})).length, 1);
    });
});

test("checking a volunteer out also reloads their time fragment (cross-context)", () => {
    return withTestDb(async ({ alice, bob }) => {
        const eid = insertEvent();
        await asUser(bob, () => invoke(`rabid.event_checkin.checkSelfIn($arg0)`, eid));
        const res = await asUser(alice, () => invoke(`rabid.event_checkin.checkOut($arg0,$arg1)`, eid, bob));
        assert(res.targets.includes(`.-event_checkin-event_id-${eid}-`));
        assert(res.targets.includes(`.-event_checkin-volunteer_id-${bob}-`));
    });
});

test("model: a completed event task bob attended shows INLINE always; an off-shift task is orphan", () => {
    return withTestDb(({ bob }) => {
        const eid = insertEvent();
        // An event-owned task completed BY bob, who checked in -> a hosted entry.
        const evTask = asSystem(() => {
            const pid = rabid.project.forOwner('event', eid, /*create*/ true)!;
            return rabid.task.insert({project_id: pid, title: 'Set up tables', status: 'open', deleted: 0} as any);
        });
        asUser(bob, () => rabid.task.update(evTask, {status: 'done'}));       // stamps done_by = bob
        asSystem(() => rabid.event_checkin.insert({event_id: eid, volunteer_id: bob, notes: ''}));
        // A personal task done off any shift/event -> orphan.
        const orphan = asSystem(() => {
            const pid = rabid.project.forOwner('volunteer', bob, true)!;
            return rabid.task.insert({project_id: pid, title: 'Read manuals', status: 'open', deleted: 0} as any);
        });
        asUser(bob, () => rabid.task.update(orphan, {status: 'done'}));

        // Default (orphans off): the event task shows inline; the orphan does not.
        const def = asSystem(() => rabid.volunteer_time.model(bob, false));
        const eventEntry = def.weeks.flatMap(w => w.entries).find(e => e.span.eventId === eid);
        assert(eventEntry, 'expected an entry for the event');
        assertEquals(eventEntry!.tasks.map(t => t.title), ['Set up tables']);
        assertEquals(def.weeks.flatMap(w => w.entries).flatMap(e => e.tasks).map(t => t.title),
                     ['Set up tables']);                                      // ONLY the inline one

        // With orphans on: the off-shift task appears too (its own row).
        const on = asSystem(() => rabid.volunteer_time.model(bob, true));
        const titles = on.weeks.flatMap(w => w.entries).flatMap(e => e.tasks).map(t => t.title).sort();
        assertEquals(titles, ['Read manuals', 'Set up tables']);
    });
});
