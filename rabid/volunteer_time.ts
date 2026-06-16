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
import {TimesheetEntry, lateEntryWarning, lateEntryBadge, type LateEntry} from "./timesheet.ts";
import {EventCheckin} from "./event.ts";

// --------------------------------------------------------------------------------
// --- The intermediate model (plain data; no db, no Markup) -----------------------
// --------------------------------------------------------------------------------

// One span of time, normalized to effective start/end.  'timesheet'/'checkin'
// carry real time (and hours); 'event'/'task' are zero-hour CARRIERS for
// completed-task grouping (a synthesized event row when the volunteer did an
// event's task without checking in; a per-day bucket of standalone tasks).
export interface TimeSpan {
    source: 'timesheet' | 'checkin' | 'event' | 'task';
    id: number;                 // timesheet_entry_id | event_checkin_id | event_id | 0
    start: string;              // effective start (sqlite datetime)
    end: string | null;        // effective end; null = open (not checked out / ongoing)
    hours: number;             // 0 when open / for event|task carriers
    label: string;             // notes / "Other work"  |  event name
    eventId?: number;          // check-ins / event carriers → link target
    paid: boolean;             // timesheet.is_paid_time
    lateEntry?: LateEntry | null; // paid entry recorded/edited long after the work (loud warning)
    wasStaff: boolean;         // check-in snapshot
    notes: string;
}

// A completed task, credited to the volunteer who finished it (done_by).  A point
// in time (done_time), carrying no hours - it annotates the timeline.
export interface TaskSpan {
    id: number;                 // task_id
    doneTime: string;           // sqlite datetime (task.done_time)
    title: string;
    eventId?: number;           // set when the task's project is event-owned
    eventStart?: string;        // event context, to synthesize a grouping row
    eventEnd?: string | null;   // when the volunteer didn't check in
    eventLabel?: string;
}

// A counted entry, with any check-ins it subsumes hanging off it (not counted)
// and any completed tasks attached to it (event- or shift-subordinate).
export interface TimeEntry {
    span: TimeSpan;
    nested: TimeSpan[];
    tasks: TaskSpan[];
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
function byDone(a: TaskSpan, b: TaskSpan): number {
    return a.doneTime < b.doneTime ? -1 : a.doneTime > b.doneTime ? 1 : 0;
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

// PURE: given a volunteer's timesheet + check-in spans (and optionally their
// completed tasks), produce the reconciled, week-grouped, totalled model.
// Overlapping check-ins nest under the EARLIEST timesheet they overlap and are
// not counted; the rest stand alone.  Completed tasks (no hours) are placed:
//   1. event-subordinate (task's project is event-owned) -> under that event's
//      entry.  Event grouping OVERRIDES done_time (it lands in the event's week).
//   2. else shift-subordinate -> under the timesheet whose window contains
//      done_time.
// Those two are INLINE annotations on an entry that already exists - always
// shown (they're the data-driven description of that shift/event).  An ORPHAN
// task (an event-owned one the volunteer never checked into, or one done off any
// shift) has no host entry; it only appears - as its own carrier row - when
// includeOrphans is set (the noisier, list-like part, toggled in the UI).
export function reconcileTime(volunteerId: number, timesheets: TimeSpan[], checkins: TimeSpan[],
                              tasks: TaskSpan[] = [], includeOrphans = false): VolunteerTime {
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
        ...tsByStart.map(ts => ({span: ts, nested: (nestedByTs.get(ts.id) ?? []).sort(byStart), tasks: [] as TaskSpan[]})),
        ...standaloneCheckins.map(c => ({span: c, nested: [] as TimeSpan[], tasks: [] as TaskSpan[]})),
    ];

    placeTasks(entries, tsByStart, tasks, includeOrphans);
    for(const e of entries) e.tasks.sort(byDone);
    entries.sort((x, y) => byStart(x.span, y.span));

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

// Attach completed tasks to entries (mutating).  Hosted tasks (event the
// volunteer attended, or a shift containing done_time) attach INLINE always.
// Orphan tasks (un-attended event, or off any shift) only appear - as their own
// carrier row - when includeOrphans is set.
function placeTasks(entries: TimeEntry[], tsByStart: TimeSpan[], tasks: TaskSpan[],
                    includeOrphans: boolean): void {
    if(tasks.length === 0) return;

    // 1. Event-subordinate: the entry that represents the event is a standalone
    // check-in (span.eventId) or a check-in nested under a timesheet.
    const entryForEvent = (eid: number) => entries.find(e =>
        e.span.eventId === eid || e.nested.some(n => n.eventId === eid));
    const byEvent = new Map<number, TaskSpan[]>();
    for(const t of tasks.filter(t => t.eventId != null)) {
        const arr = byEvent.get(t.eventId!);
        if(arr) arr.push(t); else byEvent.set(t.eventId!, [t]);
    }
    for(const [eid, group] of byEvent) {
        const host = entryForEvent(eid);
        if(host) { host.tasks.push(...group); continue; }   // inline (always)
        if(!includeOrphans) continue;                        // orphan: hidden by default
        // No check-in: synthesize a zero-hour event row so the event still groups
        // its tasks (event grouping overrides done_time -> the event's week).
        const s = group[0];
        entries.push({
            span: {source: 'event', id: eid, start: s.eventStart ?? s.doneTime,
                   end: s.eventEnd ?? null, hours: 0, label: s.eventLabel ?? 'Event',
                   eventId: eid, paid: false, wasStaff: false, notes: ''},
            nested: [], tasks: group,
        });
    }

    // 2/3. Non-event tasks: inline under the timesheet whose window contains
    // done_time; else (orphan) a per-day bucket, only when includeOrphans.
    const standaloneByDay = new Map<string, TaskSpan[]>();
    for(const t of tasks.filter(t => t.eventId == null)) {
        const host = tsByStart.find(ts => ts.start <= t.doneTime && t.doneTime <= (ts.end ?? OPEN_END));
        if(host) {
            entries.find(e => e.span.source === 'timesheet' && e.span.id === host.id)!.tasks.push(t);
        } else if(includeOrphans) {
            const day = date.extractDateFromDateTime(t.doneTime);
            const arr = standaloneByDay.get(day);
            if(arr) arr.push(t); else standaloneByDay.set(day, [t]);
        }
    }
    for(const [day, dayTasks] of standaloneByDay)
        entries.push({
            span: {source: 'task', id: 0, start: `${day} 00:00:00`, end: null,
                   hours: 0, label: '', paid: false, wasStaff: false, notes: ''},
            nested: [], tasks: dayTasks,
        });
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
        paid: !!t.is_paid_time, lateEntry: lateEntryWarning(t),
        wasStaff: false, notes: t.notes ?? '',
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

// A completed-task row (the volunteer's done_by tasks, joined to project owner and
// - when event-owned - the event), as returned by task.completedByVolunteer.
export type CompletedTaskRow = {
    task_id: number, title: string, done_time: string,
    project_owner_table: string | null, project_owner_id: number | null,
    event_start: string | null, event_end: string | null, event_label: string | null,
};

export function taskToSpan(t: CompletedTaskRow): TaskSpan {
    const isEvent = t.project_owner_table === 'event' && t.project_owner_id != null;
    return {
        id: t.task_id, doneTime: t.done_time, title: t.title,
        eventId: isEvent ? t.project_owner_id! : undefined,
        eventStart: isEvent ? (t.event_start ?? undefined) : undefined,
        eventEnd: isEvent ? t.event_end : undefined,
        eventLabel: isEvent ? (t.event_label ?? undefined) : undefined,
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

    // Build the intermediate model: query the sources, normalize, reconcile.
    // Completed tasks (the volunteer's own, by done_by) are ALWAYS folded in -
    // the ones done during a shift/event annotate that entry inline (the
    // data-driven description).  showOrphanTasks additionally surfaces the
    // un-hosted ones (off-shift / un-attended-event) as their own rows.
    model(volunteer_id: number, showOrphanTasks = false): VolunteerTime {
        const timesheets = rabid.timesheet_entry.entriesForVolunteer.all({volunteer_id})
            .map(timesheetToSpan);
        const checkins = (rabid.event_checkin.checkinsForVolunteer.all({volunteer_id}) as CheckinRow[])
            .map(checkinToSpan)
            .filter((s): s is TimeSpan => s !== null);
        const tasks = (rabid.task.completedByVolunteer.all({volunteer_id}) as CompletedTaskRow[])
            .map(taskToSpan);
        return reconcileTime(volunteer_id, timesheets, checkins, tasks, showOrphanTasks);
    }

    @route(authenticated)
    renderForVolunteer(volunteer_id: number, showOrphanTasks = false, showAllWeeks = false): Markup {
        return renderVolunteerTime(this.model(volunteer_id, showOrphanTasks), volunteer_id,
                                   showOrphanTasks, showAllWeeks);
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

// Default to the most recent N weeks (recent-first); "Show all" reveals the rest.
export const WEEK_WINDOW = 8;

export function renderVolunteerTime(model: VolunteerTime, volunteer_id: number,
                                    showOrphanTasks = false, showAllWeeks = false): Markup {
    const domId = `volunteer-time-${volunteer_id}`;
    const route = (orphans: boolean, all: boolean) =>
        `rabid.volunteer_time.renderForVolunteer(${volunteer_id},${orphans},${all})`;
    // The reload URL carries both view flags, so a reload (after an add/edit)
    // keeps the current view; each toggle swaps the fragment in place.
    const props = reloadableItemProps('volunteer_time', volunteer_id,
        route(showOrphanTasks, showAllWeeks), {id: domId});
    const linkBtn = (label: string, hxGet: string): Markup =>
        [h.button, {type: 'button', class: 'btn btn-sm btn-link p-0',
            'hx-get': hxGet, 'hx-target': `#${domId}`, 'hx-swap': 'outerHTML'}, label];
    const addMenu = canManage(volunteer_id) ? renderAddMenu(volunteer_id) : undefined;
    // The orphans toggle governs only the off-shift / un-attended-event tasks;
    // tasks done during a shift/event are shown inline regardless.
    const orphanToggle = linkBtn(showOrphanTasks ? 'Hide other completed tasks' : 'Show other completed tasks',
                                 route(!showOrphanTasks, showAllWeeks));
    const windowed = !showAllWeeks && model.weeks.length > WEEK_WINDOW;
    const weeksToggle: Markup = model.weeks.length > WEEK_WINDOW
        ? linkBtn(showAllWeeks ? `Show last ${WEEK_WINDOW} weeks` : `Show all ${model.weeks.length} weeks`,
                  route(showOrphanTasks, !showAllWeeks))
        : undefined;
    const footer: Markup = [h.div, {class: 'd-flex align-items-center flex-wrap gap-3 mt-1'},
                            weeksToggle, orphanToggle, addMenu];

    if(model.weeks.length === 0)
        return [h.div, props,
            [h.p, {class: 'text-muted'}, 'No time recorded yet.'],
            footer];

    // Show the most recent N weeks by default; the total reflects what's shown.
    const shown = showAllWeeks ? model.weeks : model.weeks.slice(0, WEEK_WINDOW);
    const sum = (f: (w: TimeWeek) => number) => shown.reduce((s, w) => s + f(w), 0);
    const hours = sum(w => w.hours), paidHours = sum(w => w.paidHours);
    const totalLabel = windowed ? `Last ${WEEK_WINDOW} weeks` : 'Total';

    return [h.div, props,
        [h.table, {class: 'table table-sm'},
         [h.tbody, {},
          shown.flatMap((w, i) => renderWeek(w, volunteer_id, i === 0)),
          [h.tr, {class: 'fw-bold border-top'},
           [h.td, {}, totalLabel], [h.td, {}],
           [h.td, {class: 'text-end'}, hours.toFixed(1)], [h.td, {}]],
          [h.tr, {},
           [h.td, {colspan: '4', class: 'text-end text-muted small'},
            `volunteer ${(hours - paidHours).toFixed(1)} · paid ${paidHours.toFixed(1)}`]],
         ]],
        footer,
    ];
}

function renderWeek(w: TimeWeek, volunteer_id: number, isFirst: boolean): Markup[] {
    return [
        // A blank spacer row before each week (except the first) so the week
        // header - which carries that week's total - reads as the start of the
        // block BELOW it, not a footer for the rows above.
        isFirst ? undefined
            : [h.tr, {'aria-hidden': 'true'},
               [h.td, {colspan: '4', style: 'height: 1.25rem; border: 0;'}]],
        [h.tr, {class: 'table-light border-top', 'data-testid': 'time-week'},
         [h.td, {colspan: '2', class: 'fw-semibold'}, `Week of ${weekLabel(w)}`],
         [h.td, {class: 'text-end fw-semibold'}, w.hours.toFixed(1)],
         [h.td, {}]],
        ...w.entries.flatMap(e => renderEntry(e, volunteer_id)),
    ];
}

function renderEntry(e: TimeEntry, volunteer_id: number): Markup[] {
    const sp = e.span;

    // A per-day bucket of standalone completed tasks (no event, no shift).
    if(sp.source === 'task')
        return [[h.tr, {class: 'small'},
            [h.td, {class: 'text-nowrap text-muted'}, dayLabel(sp.start)],
            [h.td, {colspan: '3'}, renderTaskChips(e.tasks)]]];

    // timesheet | checkin | event(synthesized).  'event' is a zero-hour carrier:
    // the volunteer did an event's task without checking in - show the event so
    // its tasks group under it, but no times/hours/edit.
    const carrier = sp.source === 'event';
    const label: Markup = sp.eventId
        ? templates.pageLink(`/rabid.event.detailPage(${sp.eventId})`, sp.label)
        : sp.label;
    const tags: Markup = [
        sp.paid ? [h.span, {class: 'badge text-bg-light ms-1'}, 'paid'] : undefined,
        lateEntryBadge(sp.lateEntry),
        sp.wasStaff ? [h.span, {class: 'text-muted small ms-1'}, '(staff)'] : undefined,
    ];
    // Check-ins this entry subsumes are PART of the entry (the timesheet's times
    // are authoritative) - render them as muted sub-lines inside the entry, not
    // as separate rows divided from it.
    const nestedLines: Markup = e.nested.map(n =>
        [h.div, {class: 'text-muted small'},
         '↳ ',
         n.eventId ? templates.pageLink(`/rabid.event.detailPage(${n.eventId})`, n.label) : n.label,
         ` · event ${timeRange(n)}`]);
    return [
        [h.tr, {},
         [h.td, {class: 'text-nowrap'},
          dayLabel(sp.start),
          // Begin–end clock times for the work period (elapsed is the hours column).
          [h.div, {class: 'text-muted small'}, carrier ? 'event' : timeRange(sp)]],
         [h.td, {}, label, tags, nestedLines,
          e.tasks.length ? renderTaskChips(e.tasks) : undefined],
         [h.td, {class: 'text-end text-nowrap'}, carrier ? '—' : (sp.end ? sp.hours.toFixed(1) : 'open')],
         [h.td, {class: 'text-end'}, (!carrier && canManage(volunteer_id)) ? editAffordance(sp) : undefined]],
    ];
}

// Completed tasks as compact chips (several per line) - the "what got done" layer.
function renderTaskChips(tasks: TaskSpan[]): Markup {
    return [h.div, {class: 'mt-1 d-flex flex-wrap gap-1'},
        tasks.map(t =>
            [h.a, {...templates.pageLinkProps(`/rabid.task.detailPage(${t.id})`),
                   class: 'badge text-bg-light border text-decoration-none',
                   'data-testid': `done-task-${t.id}`},
             '✓ ', t.title])];
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
