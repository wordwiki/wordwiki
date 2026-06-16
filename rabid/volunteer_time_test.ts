// The reconciled per-volunteer time view (volunteer_time.ts).  The heart is the
// PURE reducer reconcileTime - overlap-nesting, week grouping, totals - tested
// here with plain TimeSpan arrays (no db, no HTML).  Then a few integration
// tests for the query/render/mutation layer.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertRejects } from "../liminal/testing/assert.ts";
import { withTestDb, renderRoute, invoke, asUser, asSystem } from "./testing.ts";
import { hasText } from "../liminal/testing/markup-assert.ts";
import { rabid } from "./rabid.ts";
import { reconcileTime, spanHours, type TimeSpan, type TaskSpan } from "./volunteer_time.ts";

function tk(id: number, doneTime: string,
            opts: {eventId?: number, eventStart?: string, eventEnd?: string|null,
                   eventLabel?: string, title?: string} = {}): TaskSpan {
    return {id, doneTime, title: opts.title ?? `task ${id}`, eventId: opts.eventId,
            eventStart: opts.eventStart, eventEnd: opts.eventEnd, eventLabel: opts.eventLabel};
}

function ts(id: number, start: string, end: string | null, paid = false): TimeSpan {
    return {source: 'timesheet', id, start, end, hours: spanHours(start, end),
            label: 'work', paid, wasStaff: false, notes: ''};
}
function ci(id: number, start: string, end: string | null, wasStaff = false): TimeSpan {
    return {source: 'checkin', id, start, end, hours: spanHours(start, end),
            label: 'Event', eventId: 100 + id, paid: false, wasStaff, notes: ''};
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

test("task: event-subordinate with NO check-in synthesizes a zero-hour event row in the EVENT's week", () => {
    const m = reconcileTime(1, [], [],
        [tk(9, '2026-06-20 10:00:00',                                   // done much later
            {eventId: 105, eventStart: '2026-06-03 17:00:00', eventEnd: '2026-06-03 20:00:00',
             eventLabel: 'Repair Night'})]);
    assertEquals(m.weeks.length, 1);
    assertEquals(m.weeks[0].weekStart, '2026-05-31');                  // the event's week, NOT done_time's
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

test("task: a standalone task (no event, no shift) becomes a per-day task row", () => {
    const m = reconcileTime(1, [], [],
        [tk(9, '2026-06-02 14:00:00'), tk(10, '2026-06-02 16:00:00')]);// same day -> one bucket
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

test("adding time is self-or-host; it reloads the volunteer's time fragment", () => {
    return withTestDb(async ({ bob, carol }) => {
        // A different regular volunteer cannot add time for bob.
        await asUser(carol, () => assertRejects(
            () => invoke(`rabid.volunteer_time.addTimesheet($arg0)`,
                         {volunteer_id: String(bob), start_time: '2026-06-20 09:00:00',
                          end_time: '2026-06-20 10:00:00', notes: 'x'}),
            Error, "not permitted"));   // route layer (@route ownTimeOrHost) denies first

        // bob adds his own; the reload targets his time fragment.
        const res = await asUser(bob, () => invoke(`rabid.volunteer_time.addTimesheet($arg0)`,
            {volunteer_id: String(bob), start_time: '2026-06-20 09:00:00',
             end_time: '2026-06-20 10:30:00', notes: 'inventory'}));
        assertEquals(res.action, "reload");
        assert(res.targets.includes(`.-volunteer_time-${bob}-`));
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
        assert(res.targets.includes(`.-volunteer_time-${bob}-`));
        assert(res.targets.includes(`.-event_checkin-${eid}-`));
        assertEquals(asSystem(() =>
            rabid.event_checkin.checkinsForEvent.all({event_id: eid})).length, 1);
    });
});

test("checking a volunteer out also reloads their time fragment (cross-context)", () => {
    return withTestDb(async ({ alice, bob }) => {
        const eid = insertEvent();
        await asUser(bob, () => invoke(`rabid.event_checkin.checkSelfIn($arg0)`, eid));
        const res = await asUser(alice, () => invoke(`rabid.event_checkin.checkOut($arg0,$arg1)`, eid, bob));
        assert(res.targets.includes(`.-event_checkin-${eid}-`));
        assert(res.targets.includes(`.-volunteer_time-${bob}-`));
    });
});

test("model(showTasks): a task bob completed for an event shows under the event; off by default", () => {
    return withTestDb(({ bob }) => {
        const eid = insertEvent();
        // An event-owned task, completed BY bob (done_by = bob), and bob checked in.
        const tid = asSystem(() => {
            const pid = rabid.project.forOwner('event', eid, /*create*/ true)!;
            return rabid.task.insert({project_id: pid, title: 'Set up tables', status: 'open', deleted: 0} as any);
        });
        asUser(bob, () => rabid.task.update(tid, {status: 'done'}));          // stamps done_by = bob
        asSystem(() => rabid.event_checkin.insert({event_id: eid, volunteer_id: bob, notes: ''}));

        // Off by default.
        const off = asSystem(() => rabid.volunteer_time.model(bob, false));
        assertEquals(off.weeks.flatMap(w => w.entries).every(e => e.tasks.length === 0), true);

        // On: the completed task hangs off the event's entry.
        const on = asSystem(() => rabid.volunteer_time.model(bob, true));
        const eventEntry = on.weeks.flatMap(w => w.entries).find(e => e.span.eventId === eid);
        assert(eventEntry, 'expected an entry for the event');
        assertEquals(eventEntry!.tasks.map(t => t.title), ['Set up tables']);

        // A task someone ELSE completed isn't credited to bob.
        const otherView = asSystem(() => rabid.volunteer_time.model(bob, true));
        assertEquals(otherView.weeks.flatMap(w => w.entries).flatMap(e => e.tasks).length, 1);
    });
});
