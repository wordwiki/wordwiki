// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types
//
// A volunteer's time, reconciled into ONE chronological, week-grouped view.
//
// A person's time comes from two sources with different roles:
//   - timesheet_entry: the AUTHORITATIVE record (it drives pay), explicit time.
//   - event_checkin:   an attendance shortcut (drives the event-side modeling),
//                      best-effort, "as much as we can get from volunteers".
//
// When the two overlap (a staffer logs a shift AND checks into the event during
// it), the timesheet wins: the check-in becomes a non-counted DETAIL nested
// under the timesheet, and the timesheet's times are taken as the real times.
// Otherwise a check-in stands on its own as volunteer time.  This reconciliation
// is the ONE canonical reduction - the volunteer page renders it, and any hours
// rollup (grant reporting, payroll, exports) must read it too, or staff time
// would be double-counted.
//
// Layering:
//   reconcileTime(...)  - PURE: overlap-nesting + week grouping + totals (no db,
//                         no Markup; unit-tested with plain TimeSpan arrays).
//   VolunteerTimeService.model(id) - runs the two queries, calls reconcileTime.
//   renderVolunteerTime(model)     - PURE render of the intermediate model.

import {db} from "../liminal/db.ts";
import {Markup, h} from "../liminal/markup.ts";
import {reloadableItemProps, pencilIcon, ForeignKeyField} from "../liminal/table.ts";
import * as action from "../liminal/action.ts";
import * as security from "../liminal/security.ts";
import {route, routeMutation, authenticated, hostOrAdmin, selfArg} from "../liminal/security.ts";

// Manage a volunteer's own time, or (host/admin) anyone's.  The volunteer id is
// an arg, so the route can express it without loading a record.
const ownTimeOrHost = security.or(hostOrAdmin, selfArg('volunteer_id'));            // object-arg routes
const ownTimeOrHostPositional = security.or(hostOrAdmin, selfArg(a => Number(a[0]))); // positional-arg routes
import * as templates from "./templates.ts";
import * as date from "../liminal/date.ts";
import {rabid} from "./rabid.ts";
import {TimesheetEntry} from "./timesheet.ts";
import {EventCheckin} from "./event.ts";

// --------------------------------------------------------------------------------
// --- The intermediate model (plain data; no db, no Markup) -----------------------
// --------------------------------------------------------------------------------

// One span of time from either source, normalized to effective start/end.
export interface TimeSpan {
    source: 'timesheet' | 'checkin';
    id: number;                 // timesheet_entry_id | event_checkin_id
    start: string;              // effective start (sqlite datetime)
    end: string | null;        // effective end; null = open (not checked out / ongoing)
    hours: number;             // 0 when open
    label: string;             // notes / "Other work"  |  event name
    eventId?: number;          // check-ins → link target
    paid: boolean;             // timesheet.is_paid_time
    wasStaff: boolean;         // check-in snapshot
    notes: string;
}

// A counted entry, with any check-ins it subsumes hanging off it (not counted).
export interface TimeEntry {
    span: TimeSpan;
    nested: TimeSpan[];
}

export interface TimeWeek {
    weekStart: string;          // Sunday (sqlite date)
    weekEnd: string;            // Saturday (sqlite date)
    entries: TimeEntry[];       // chronological within the week
    hours: number;
    paidHours: number;
    volunteerHours: number;
}

export interface VolunteerTime {
    volunteerId: number;
    weeks: TimeWeek[];          // recent-first
    hours: number;
    paidHours: number;
    volunteerHours: number;
}

// --------------------------------------------------------------------------------
// --- The pure reducer -----------------------------------------------------------
// --------------------------------------------------------------------------------

// SQLite datetime strings are lexicographically ordered, so '<' compares time.
const OPEN_END = '9999-12-31 23:59:59';   // an open span extends to "now and beyond"

function overlaps(a: TimeSpan, b: TimeSpan): boolean {
    return a.start < (b.end ?? OPEN_END) && b.start < (a.end ?? OPEN_END);
}
function byStart(a: TimeSpan, b: TimeSpan): number {
    return a.start < b.start ? -1 : a.start > b.start ? 1 : 0;
}
function sum(xs: number[]): number { return xs.reduce((s, x) => s + x, 0); }

export function spanHours(start: string, end: string | null): number {
    if(!end) return 0;
    return date.sqliteDateTimeToTemporal(end)
        .since(date.sqliteDateTimeToTemporal(start))
        .total({unit: 'hours'});
}

// The Sunday that starts the (Sun..Sat) week containing this datetime.
function weekStartOf(sqliteDateTime: string): string {
    const day = date.sqliteDateToTemporal(date.extractDateFromDateTime(sqliteDateTime));
    const sunday = day.subtract({days: day.dayOfWeek % 7});  // Temporal: Mon=1..Sun=7
    return date.temporalToSqliteDate(sunday);
}

// PURE: given a volunteer's timesheet + check-in spans, produce the reconciled,
// week-grouped, totalled model.  Overlapping check-ins nest under the EARLIEST
// timesheet they overlap and are not counted; the rest stand alone.
export function reconcileTime(volunteerId: number, timesheets: TimeSpan[], checkins: TimeSpan[]): VolunteerTime {
    const tsByStart = [...timesheets].sort(byStart);

    const nestedByTs = new Map<number, TimeSpan[]>();
    const standaloneCheckins: TimeSpan[] = [];
    for(const c of checkins) {
        const host = tsByStart.find(ts => overlaps(ts, c));
        if(host) {
            const arr = nestedByTs.get(host.id);
            if(arr) arr.push(c); else nestedByTs.set(host.id, [c]);
        } else {
            standaloneCheckins.push(c);
        }
    }

    const entries: TimeEntry[] = [
        ...tsByStart.map(ts => ({span: ts, nested: (nestedByTs.get(ts.id) ?? []).sort(byStart)})),
        ...standaloneCheckins.map(c => ({span: c, nested: [] as TimeSpan[]})),
    ].sort((x, y) => byStart(x.span, y.span));

    const byWeek = new Map<string, TimeEntry[]>();
    for(const e of entries) {
        const wk = weekStartOf(e.span.start);
        const arr = byWeek.get(wk);
        if(arr) arr.push(e); else byWeek.set(wk, [e]);
    }

    const weeks: TimeWeek[] = [...byWeek.entries()].map(([weekStart, es]) => {
        const hours = sum(es.map(e => e.span.hours));
        const paidHours = sum(es.filter(e => e.span.source === 'timesheet' && e.span.paid)
                                .map(e => e.span.hours));
        const weekEnd = date.temporalToSqliteDate(
            date.sqliteDateToTemporal(weekStart as any).add({days: 6}));
        return {weekStart, weekEnd, entries: es, hours, paidHours, volunteerHours: hours - paidHours};
    });
    // Recent week first.
    weeks.sort((a, b) => a.weekStart < b.weekStart ? 1 : a.weekStart > b.weekStart ? -1 : 0);

    const hours = sum(weeks.map(w => w.hours));
    const paidHours = sum(weeks.map(w => w.paidHours));
    return {volunteerId, weeks, hours, paidHours, volunteerHours: hours - paidHours};
}

// --------------------------------------------------------------------------------
// --- Source → TimeSpan conversion -----------------------------------------------
// --------------------------------------------------------------------------------

type CheckinRow = EventCheckin & {
    event_description: string | null,
    event_start_time: string | null,
    event_end_time: string | null,
};

function firstLine(s: string): string {
    const line = (s ?? '').split('\n')[0].trim();
    return line.length > 60 ? line.slice(0, 57) + '…' : line;
}

export function timesheetToSpan(t: TimesheetEntry): TimeSpan {
    const end = t.end_time ?? null;
    return {
        source: 'timesheet', id: t.timesheet_entry_id,
        start: t.start_time, end,
        hours: spanHours(t.start_time, end),
        label: (t.notes && t.notes.trim()) ? firstLine(t.notes) : 'Other work',
        paid: !!t.is_paid_time, wasStaff: false, notes: t.notes ?? '',
    };
}

// Returns null for a check-in we can't place on a timeline (an event with no
// times and no override) - it still shows as attendance on the event page.
export function checkinToSpan(c: CheckinRow): TimeSpan | null {
    const start = c.start_time ?? c.event_start_time;
    if(!start) return null;
    const end = c.end_time ?? c.event_end_time ?? null;
    return {
        source: 'checkin', id: c.event_checkin_id,
        start, end,
        hours: spanHours(start, end),
        label: c.event_description ?? 'Event',
        eventId: c.event_id,
        paid: false, wasStaff: !!c.was_staff, notes: c.notes ?? '',
    };
}

// --------------------------------------------------------------------------------
// --- The service (queries + dispatch) -------------------------------------------
// --------------------------------------------------------------------------------

// Self manages their own time; hosts/admins manage anyone's.
function canManage(volunteer_id: number): boolean {
    const ctx = security.current();
    if(!ctx || ctx.system) return true;
    return ctx.actorId === volunteer_id || ctx.roles.has('host') || ctx.roles.has('admin');
}

// Reload the volunteer's time fragment (and, when an event was touched, the
// event page's check-in fragment too - htmx only re-renders selectors present).
function reload(volunteer_id: number, event_id?: number): Markup {
    const targets = [`.-volunteer_time-${volunteer_id}-`];
    if(event_id) targets.push(`.-event_checkin-${event_id}-`);
    return {action: 'reload', targets} as unknown as Markup;
}

export class VolunteerTimeService {

    // Build the intermediate model: query both sources, normalize, reconcile.
    model(volunteer_id: number): VolunteerTime {
        const timesheets = rabid.timesheet_entry.entriesForVolunteer.all({volunteer_id})
            .map(timesheetToSpan);
        const checkins = (rabid.event_checkin.checkinsForVolunteer.all({volunteer_id}) as CheckinRow[])
            .map(checkinToSpan)
            .filter((s): s is TimeSpan => s !== null);
        return reconcileTime(volunteer_id, timesheets, checkins);
    }

    @route(authenticated)
    renderForVolunteer(volunteer_id: number): Markup {
        return renderVolunteerTime(this.model(volunteer_id), volunteer_id);
    }

    // --- Adding ------------------------------------------------------------

    @route(ownTimeOrHostPositional)
    addTimesheetDialog(volunteer_id: number): Markup {
        if(!canManage(volunteer_id)) throw new Error('Not permitted to add time for this volunteer');
        const f = rabid.timesheet_entry.fieldsByName;
        return action.renderParamForm(
            [f.start_time, f.end_time, f.notes],
            {},
            {
                title: 'Add timesheet entry',
                submitLabel: 'Add',
                hidden: {volunteer_id},
                dispatch: {onsubmit:
                    'event.preventDefault(); tx`rabid.volunteer_time.addTimesheet(${getFormJSON(event.target)})`'},
            });
    }

    @routeMutation(ownTimeOrHost)
    addTimesheet(args: {volunteer_id?: string|number, start_time?: string, end_time?: string, notes?: string}): Markup {
        const volunteer_id = Number(args?.volunteer_id);
        if(!canManage(volunteer_id)) throw new Error('Not permitted to add time for this volunteer');
        const start = (args.start_time ?? '').trim();
        if(!start) throw new Error('Start time is required');
        const end = (args.end_time ?? '').trim();
        rabid.timesheet_entry.insert({
            volunteer_id,
            start_time: start,
            end_time: end || null,
            notes: args.notes ?? '',
            is_paid_time: 0,
            km_driven_for_reimbursement: 0,
            km_driven_processed: 0,
            paid_time_processed: 0,
        } as Partial<TimesheetEntry>);
        return reload(volunteer_id);
    }

    @route(ownTimeOrHostPositional)
    checkIntoEventDialog(volunteer_id: number): Markup {
        if(!canManage(volunteer_id)) throw new Error('Not permitted to check in this volunteer');
        return action.renderParamForm(
            [new ForeignKeyField('event_id', 'event', 'event_id', {}, 'description')],
            {},
            {
                title: 'Check into an event',
                submitLabel: 'Check in',
                hidden: {volunteer_id},
                fieldContext: {ownerPath: 'rabid.event_checkin'},
                dispatch: {onsubmit:
                    'event.preventDefault(); tx`rabid.volunteer_time.checkIntoEvent(${getFormJSON(event.target)})`'},
            });
    }

    @routeMutation(ownTimeOrHost)
    checkIntoEvent(args: {volunteer_id?: string|number, event_id?: string|number}): Markup {
        const volunteer_id = Number(args?.volunteer_id);
        const event_id = Number(args?.event_id);
        if(!Number.isInteger(event_id) || !event_id) throw new Error('Please choose an event');
        if(!canManage(volunteer_id)) throw new Error('Not permitted to check in this volunteer');
        const exists = !!db().prepare<{n: number}, {event_id: number, volunteer_id: number}>(
            'SELECT 1 AS n FROM event_checkin WHERE event_id = :event_id AND volunteer_id = :volunteer_id')
            .first({event_id, volunteer_id});
        if(!exists) rabid.event_checkin.insert({event_id, volunteer_id, notes: ''});
        return reload(volunteer_id, event_id);
    }
}

// --------------------------------------------------------------------------------
// --- The renderer (pure: model → Markup) ----------------------------------------
// --------------------------------------------------------------------------------

export function renderVolunteerTime(model: VolunteerTime, volunteer_id: number): Markup {
    const props = reloadableItemProps('volunteer_time', volunteer_id,
        `rabid.volunteer_time.renderForVolunteer(${volunteer_id})`);
    const addMenu = canManage(volunteer_id) ? renderAddMenu(volunteer_id) : undefined;

    if(model.weeks.length === 0)
        return [h.div, props,
            [h.p, {class: 'text-muted'}, 'No time recorded yet.'],
            addMenu];

    return [h.div, props,
        [h.table, {class: 'table table-sm'},
         [h.tbody, {},
          model.weeks.flatMap(w => renderWeek(w, volunteer_id)),
          [h.tr, {class: 'fw-bold border-top'},
           [h.td, {}, 'Total'], [h.td, {}],
           [h.td, {class: 'text-end'}, model.hours.toFixed(1)], [h.td, {}]],
          [h.tr, {},
           [h.td, {colspan: '4', class: 'text-end text-muted small'},
            `volunteer ${model.volunteerHours.toFixed(1)} · paid ${model.paidHours.toFixed(1)}`]],
         ]],
        addMenu,
    ];
}

function renderWeek(w: TimeWeek, volunteer_id: number): Markup[] {
    return [
        [h.tr, {class: 'table-light'},
         [h.td, {colspan: '2', class: 'fw-semibold'}, `Week of ${weekLabel(w)}`],
         [h.td, {class: 'text-end fw-semibold'}, w.hours.toFixed(1)],
         [h.td, {}]],
        ...w.entries.flatMap(e => renderEntry(e, volunteer_id)),
    ];
}

function renderEntry(e: TimeEntry, volunteer_id: number): Markup[] {
    const sp = e.span;
    const label: Markup = sp.eventId
        ? templates.pageLink(`/rabid.event.detailPage(${sp.eventId})`, sp.label)
        : sp.label;
    const tags: Markup = [
        sp.paid ? [h.span, {class: 'badge text-bg-light ms-1'}, 'paid'] : undefined,
        sp.wasStaff ? [h.span, {class: 'text-muted small ms-1'}, '(staff)'] : undefined,
    ];
    const rows: Markup[] = [
        [h.tr, {},
         [h.td, {class: 'text-nowrap'}, dayLabel(sp.start)],
         [h.td, {}, label, tags],
         [h.td, {class: 'text-end text-nowrap'}, sp.end ? sp.hours.toFixed(1) : 'open'],
         [h.td, {class: 'text-end'}, canManage(volunteer_id) ? editAffordance(sp) : undefined]],
    ];
    for(const n of e.nested)
        rows.push([h.tr, {class: 'text-muted small'},
            [h.td, {}],
            [h.td, {colspan: '2'},
             '↳ ',
             n.eventId ? templates.pageLink(`/rabid.event.detailPage(${n.eventId})`, n.label) : n.label,
             ` · event ${timeRange(n)}`],
            [h.td, {}]]);
    return rows;
}

// The pencil routes to the right editor for the row's source.
function editAffordance(sp: TimeSpan): Markup {
    if(sp.source === 'timesheet')
        return rabid.timesheet_entry.editPencil(sp.id);   // generic timesheet edit form
    return action.actionButton(pencilIcon(),
        {kind: 'modal', dialogUrl: `/rabid.event_checkin.editCheckinDialog(${sp.id})`},
        'lm-edit-pencil', {'aria-label': 'Edit check-in'});
}

function renderAddMenu(volunteer_id: number): Markup {
    return action.actionMenu([
        {label: 'Add timesheet entry…',
         mode: {kind: 'modal', dialogUrl: `/rabid.volunteer_time.addTimesheetDialog(${volunteer_id})`}},
        {label: 'Check into an event…',
         mode: {kind: 'modal', dialogUrl: `/rabid.volunteer_time.checkIntoEventDialog(${volunteer_id})`}},
    ], {ariaLabel: 'Add time'});
}

// "Sat Jun 14"
function dayLabel(sqliteDateTime: string): string {
    return date.sqliteDateToTemporal(date.extractDateFromDateTime(sqliteDateTime))
        .toLocaleString('en-US', {weekday: 'short', month: 'short', day: 'numeric'});
}

// "Jun 8 – 14" (or "Jun 29 – Jul 5" across a month boundary)
function weekLabel(w: TimeWeek): string {
    const s = date.sqliteDateToTemporal(w.weekStart as any);
    const e = date.sqliteDateToTemporal(w.weekEnd as any);
    const sStr = s.toLocaleString('en-US', {month: 'short', day: 'numeric'});
    const eStr = e.month === s.month
        ? String(e.day)
        : e.toLocaleString('en-US', {month: 'short', day: 'numeric'});
    return `${sStr} – ${eStr}`;
}

function timeRange(sp: TimeSpan): string {
    const s = date.sqliteDateTimeToTimeString(sp.start);
    return sp.end ? `${s} – ${date.sqliteDateTimeToTimeString(sp.end)}` : `from ${s}`;
}
