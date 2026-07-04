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
import {reloadableProps, pencilIcon, ForeignKeyField, FieldSet, CheckboxField, type Tuple} from "../liminal/table.ts";
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
    confirmed: boolean;        // hours vouched for by a host (confirmed_by set)
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
    weekStart: string;          // Monday (sqlite date)
    weekEnd: string;            // Sunday (sqlite date) - payroll week ends Sunday night
    entries: TimeEntry[];       // chronological within the week
    hours: number;
    paidHours: number;
    volunteerHours: number;
    confirmedHours: number;     // counted volunteer hours a host has confirmed
    unconfirmedHours: number;   // counted volunteer hours awaiting confirmation
}

export interface VolunteerTime {
    volunteerId: number;
    weeks: TimeWeek[];          // recent-first
    hours: number;
    paidHours: number;
    volunteerHours: number;
    confirmedHours: number;
    unconfirmedHours: number;
    // This volunteer's hours must be host-confirmed (community service etc):
    // drives whether the Time view shows confirmed/unconfirmed state at all.
    needsConfirmation: boolean;
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

// The Monday that starts the (Mon..Sun) PAYROLL week containing this datetime.
// Payroll weeks end Sunday night, so a week runs Monday through Sunday.
function weekStartOf(sqliteDateTime: string): string {
    const day = date.sqliteDateToTemporal(date.extractDateFromDateTime(sqliteDateTime));
    const monday = day.subtract({days: day.dayOfWeek - 1});  // Temporal: Mon=1..Sun=7
    return date.temporalToSqliteDate(monday);
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
        const volunteerHours = hours - paidHours;
        // Confirmed/unconfirmed split the VOLUNTEER (unpaid) hours - paid staff
        // time isn't part of the vouch-for-my-hours workflow.
        const confirmedHours = sum(es.filter(e => !e.span.paid && e.span.confirmed)
                                     .map(e => e.span.hours));
        const weekEnd = date.temporalToSqliteDate(
            date.sqliteDateToTemporal(weekStart as any).add({days: 6}));
        return {weekStart, weekEnd, entries: es, hours, paidHours, volunteerHours,
                confirmedHours, unconfirmedHours: volunteerHours - confirmedHours};
    });
    // Recent week first.
    weeks.sort((a, b) => a.weekStart < b.weekStart ? 1 : a.weekStart > b.weekStart ? -1 : 0);

    const hours = sum(weeks.map(w => w.hours));
    const paidHours = sum(weeks.map(w => w.paidHours));
    const confirmedHours = sum(weeks.map(w => w.confirmedHours));
    return {volunteerId, weeks, hours, paidHours, volunteerHours: hours - paidHours,
            confirmedHours, unconfirmedHours: (hours - paidHours) - confirmedHours,
            needsConfirmation: false};
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
                   eventId: eid, paid: false, wasStaff: false, confirmed: false, notes: ''},
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
                   hours: 0, label: '', paid: false, wasStaff: false, confirmed: false, notes: ''},
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
        wasStaff: false, confirmed: t.confirmed_by != null, notes: t.notes ?? '',
    };
}

// Returns null for a check-in we can't place on a timeline (an event with no
// times and no override) - it still shows as attendance on the event page.
export function checkinToSpan(c: CheckinRow): TimeSpan | null {
    const start = c.start_time ?? c.event_start_time;
    if(!start) return null;
    // An explicit time_volunteered wins: anchor at the effective start and run for
    // exactly that long, so the displayed window and the counted hours agree (and
    // overlap-nesting under a timesheet still works).  It may exceed the event
    // length (extra setup time).  Otherwise fall back to the event window (or an
    // explicit start/end override).
    let end: string | null;
    let hours: number;
    if(c.time_volunteered_minutes != null) {
        hours = c.time_volunteered_minutes / 60;
        end = date.temporalToSqliteDateTime(
            date.sqliteDateTimeToTemporal(start).add({minutes: c.time_volunteered_minutes}));
    } else {
        end = c.end_time ?? c.event_end_time ?? null;
        hours = spanHours(start, end);
    }
    return {
        source: 'checkin', id: c.event_checkin_id,
        start, end,
        hours,
        label: c.event_description ?? 'Event',
        eventId: c.event_id,
        paid: false, wasStaff: !!c.was_staff, confirmed: c.confirmed_by != null,
        notes: c.notes ?? '',
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

// Whether the CURRENT viewer may SEE this volunteer's hours-confirmation state
// (the confirmed/unconfirmed badges + the summary split).  SENSITIVE: that a
// volunteer's hours need confirming reveals they're doing community service
// (sometimes court-ordered), which must not leak to OTHER volunteers - this is
// an open-books org where anyone can view anyone's page.  The volunteer
// themselves may see their own status, and hosts (who do the confirming and are
// trusted to be discreet) may see anyone's.
//
// SINGLE CHANGE POINT for the VIEW rule - tighten here (e.g. a dedicated
// permission/role) without touching the renderers.  Distinct from the confirm
// ACTION, which stays host/admin-only at the route (viewerIsHostOrAdmin below).
function canViewHoursConfirmation(volunteer_id: number): boolean {
    const ctx = security.current();
    if(!ctx || ctx.system) return true;
    return ctx.actorId === volunteer_id || ctx.roles.has('host') || ctx.roles.has('admin');
}

// Confirming hours is host/admin-only (NOT self - the whole point is a vouch by
// someone other than the person whose hours they are).
function viewerIsHostOrAdmin(): boolean {
    const ctx = security.current();
    if(!ctx || ctx.system) return true;
    return ctx.roles.has('host') || ctx.roles.has('admin');
}

// The mutations below write through the timesheet_entry / event_checkin
// table funnels, whose automatic dirty-key emission (volunteer_id / event_id
// fk keys) notifies the Time fragment and any event check-in fragment - no
// hand target lists needed.
const RELOAD: Markup = {action: 'reload'} as unknown as Markup;

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
        const m = reconcileTime(volunteer_id, timesheets, checkins, tasks, showOrphanTasks);
        const needsConfirmation = !!security.runSystem(() =>
            db().prepare<{n: boolean}, {id: number}>(
                'SELECT volunteer_hours_need_confirmation AS n FROM volunteer WHERE volunteer_id = :id')
                .first({id: volunteer_id}))?.n;
        return {...m, needsConfirmation};
    }

    @route(authenticated)
    renderForVolunteer(volunteer_id: number, vt?: Record<string, any>): Markup {
        const view = timeViewQuery.normalize(vt) as TimeView;
        return renderVolunteerTime(this.model(volunteer_id, view.orphan_tasks), volunteer_id, view);
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
        return RELOAD;
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
        return RELOAD;
    }
}

// --------------------------------------------------------------------------------
// --- The renderer (pure: model → Markup) ----------------------------------------
// --------------------------------------------------------------------------------

// Default to the most recent N weeks (recent-first); "Show all" reveals the rest.
export const WEEK_WINDOW = 8;

// The Time view's own page-query section (liminal.md § On-page view state ("the unit of
// state is the SECTION"): two boolean view knobs, carried as a `{}` argument
// in the route expression of the Time fragment AND the volunteer detail page.
// Both default false, so the common view canonicalizes away
// (/rabid.volunteer.detailPage(7) == the collapsed, own-shift-only view).
export const timeViewQuery = new FieldSet('time_view', [
    new CheckboxField('orphan_tasks', {prompt: 'Show other completed tasks', default: false}),
    new CheckboxField('all_weeks', {prompt: 'Show all weeks', default: false}),
]);
export interface TimeView extends Tuple {
    orphan_tasks: boolean;
    all_weeks: boolean;
}

export function renderVolunteerTime(model: VolunteerTime, volunteer_id: number,
                                    view: TimeView = {orphan_tasks: false, all_weeks: false}): Markup {
    const {orphan_tasks: showOrphanTasks, all_weeks: showAllWeeks} = view;
    const domId = `volunteer-time-${volunteer_id}`;
    // The Time FRAGMENT re-renders itself under the current view (its reload
    // URL carries it, so an add/edit reload keeps the view); the PAGE URL
    // carries the same view so a bookmark/refresh reproduces it.
    const fragmentRoute = (v: TimeView) =>
        `rabid.volunteer_time.renderForVolunteer(${volunteer_id},${timeViewQuery.literal(v)})`;
    const pageUrl = (v: TimeView) =>
        `/rabid.volunteer.detailPage(${volunteer_id},${timeViewQuery.literal(v)})`;
    // The view is derived from the volunteer's timesheet entries and event
    // check-ins, so it registers those tables' volunteer fk keys - which the
    // page's own add/edit/confirm buttons notify automatically.  (Completed
    // tasks also feed the view, but tasks aren't edited from this page, so
    // per the editable-pages rule it does NOT register a task key.)
    const props = reloadableProps(
        [rabid.timesheet_entry.fkKey('volunteer_id', volunteer_id),
         rabid.event_checkin.fkKey('volunteer_id', volunteer_id)],
        fragmentRoute(view), {id: domId});
    // A view toggle is a DEPTH/refinement change (liminal.md view-state taxonomy): it
    // swaps the fragment in place AND updates the page URL via hx-replace-url
    // (replaceState - refresh keeps the view; Back leaves the page rather than
    // un-toggling).
    const toggle = (label: string, next: TimeView): Markup =>
        [h.button, {type: 'button', class: 'btn btn-sm btn-link p-0',
            'hx-get': fragmentRoute(next), 'hx-target': `#${domId}`, 'hx-swap': 'outerHTML',
            'hx-replace-url': pageUrl(next)}, label];
    const addMenu = canManage(volunteer_id) ? renderAddMenu(volunteer_id) : undefined;
    // The orphans toggle governs only the off-shift / un-attended-event tasks;
    // tasks done during a shift/event are shown inline regardless.
    const orphanToggle = toggle(showOrphanTasks ? 'Hide other completed tasks' : 'Show other completed tasks',
                                {...view, orphan_tasks: !showOrphanTasks});
    const windowed = !showAllWeeks && model.weeks.length > WEEK_WINDOW;
    const weeksToggle: Markup = model.weeks.length > WEEK_WINDOW
        ? toggle(showAllWeeks ? `Show last ${WEEK_WINDOW} weeks` : `Show all ${model.weeks.length} weeks`,
                 {...view, all_weeks: !showAllWeeks})
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

    // Confirmation surface (badges + confirmed split + confirm action) appears
    // only when this volunteer's hours need vouching AND the viewer is allowed to
    // see that fact (self or host - see canViewHoursConfirmation).  Acting on it
    // (confirm/unconfirm) is host-only, a separate check.
    const conf: ConfirmOpts = {
        show: model.needsConfirmation && canViewHoursConfirmation(volunteer_id),
        canConfirm: viewerIsHostOrAdmin(),
    };
    // Grand total over the shown weeks, as a labelled breakdown (same mechanism
    // as the per-week subtotals - see hoursBreakdown).
    const confirmedHours = sum(w => w.confirmedHours);
    const volunteerHours = hours - paidHours;
    const totals: HoursTotals = {hours, paidHours, volunteerHours,
                                 confirmedHours, unconfirmedHours: volunteerHours - confirmedHours};

    return [h.div, props,
        [h.table, {class: 'table table-sm'},
         [h.tbody, {},
          shown.flatMap((w, i) => renderWeek(w, volunteer_id, i === 0, conf)),
          [h.tr, {class: 'fw-bold border-top'},
           [h.td, {colspan: '2'}, totalLabel],
           [h.td, {colspan: '2', class: 'text-end'}, hoursBreakdown(totals, conf)]],
         ]],
        footer,
    ];
}

// Per-render confirmation context, threaded into the row renderers.  `show`:
// may this viewer see confirmation state at all (self/host).  `canConfirm`: may
// they act on it (host only) - false means read-only badges.
export interface ConfirmOpts { show: boolean; canConfirm: boolean; }

// The fields hoursBreakdown reads (a TimeWeek subtotal or the grand total).
export type HoursTotals = {hours: number, paidHours: number, volunteerHours: number,
                           confirmedHours: number, unconfirmedHours: number};

// A subtotal/total as a labelled breakdown of its non-zero kinds, e.g.
// "5.5 volunteer", "8.0 paid hours", "3.0 confirmed · 1.5 unconfirmed".  In
// practice a person has one kind per week (regular -> volunteer, staff -> paid),
// so this is usually just a number plus a label; community-service people
// mid-confirmation show a confirmed/unconfirmed mix.
//
// confirmed/unconfirmed (a sub-split of the volunteer hours) appear ONLY when
// the viewer may see confirmation state (conf.show).  Otherwise those same hours
// read as plain "volunteer" - so a regular volunteer never reads "unconfirmed",
// and a community-service person's status never leaks to other volunteers.
export function hoursBreakdown(t: HoursTotals, conf: ConfirmOpts): string {
    // Round to a tenth and drop zero (and -0.0) parts.
    const part = (v: number, label: string): string | null => {
        const r = Math.round(v * 10) / 10;
        return r === 0 ? null : `${r.toFixed(1)} ${label}`;
    };
    const parts = (conf.show
        ? [part(t.confirmedHours, 'confirmed'), part(t.unconfirmedHours, 'unconfirmed')]
        : [part(t.volunteerHours, 'volunteer')]
    ).concat(part(t.paidHours, 'paid hours'));
    const shown = parts.filter((x): x is string => x !== null);
    return shown.length ? shown.join(' · ') : t.hours.toFixed(1);
}

function renderWeek(w: TimeWeek, volunteer_id: number, isFirst: boolean, conf: ConfirmOpts): Markup[] {
    return [
        // A generous blank gap before each week (except the first).  The week
        // header carries that week's total at the TOP of its block, which is
        // unconventional (a total usually sits below its rows), so the grouping
        // must be unmistakable: a big gap above + the header band capped by a
        // heavy bottom rule (and NO top rule) makes it read as a heading for the
        // rows BELOW it, not a footer for the rows above.
        isFirst ? undefined
            : [h.tr, {'aria-hidden': 'true', 'data-testid': 'week-gap'},
               [h.td, {colspan: '4', style: 'height: 2rem; border: 0; padding: 0;'}]],
        [h.tr, {class: 'table-light fw-semibold', 'data-testid': 'time-week',
                style: 'border-top: 0; border-bottom: 2px solid var(--bs-secondary-color);'},
         [h.td, {colspan: '2', style: 'border-bottom: 0;'}, `Week of ${weekLabel(w)}`],
         [h.td, {colspan: '2', class: 'text-end', style: 'border-bottom: 0;'}, hoursBreakdown(w, conf)]],
        ...w.entries.flatMap(e => renderEntry(e, volunteer_id, conf)),
    ];
}

function renderEntry(e: TimeEntry, volunteer_id: number, conf: ConfirmOpts): Markup[] {
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
        confirmAffordance(sp, conf),
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

// Confirmation state for a counted entry, only for volunteers whose hours must
// be vouched for.  A host sees an actionable confirm/unconfirm toggle; the
// volunteer themselves sees a read-only badge of the current state.  Carriers
// (synthesized event/task rows) and paid time carry no confirmation.
function confirmAffordance(sp: TimeSpan, conf: ConfirmOpts): Markup {
    if(!conf.show || sp.paid) return undefined;
    if(sp.source !== 'timesheet' && sp.source !== 'checkin') return undefined;
    const expr = (verb: string) => sp.source === 'timesheet'
        ? `rabid.timesheet_entry.${verb}(${sp.id})`
        : `rabid.event_checkin.${verb}Checkin(${sp.id})`;
    if(sp.confirmed) {
        // host: click to revoke; self: read-only confirmed badge.
        return conf.canConfirm
            ? action.actionButton('confirmed ✓', {kind: 'immediate', expr: expr('unconfirm')},
                                  'badge text-bg-success border-0 ms-1',
                                  {title: 'Confirmed — click to revoke'})
            : [h.span, {class: 'badge text-bg-success ms-1', title: 'Hours confirmed by a host'}, 'confirmed'];
    }
    // host: offer to confirm; self: read-only "awaiting" badge.
    return conf.canConfirm
        ? action.actionButton('Confirm', {kind: 'immediate', expr: expr('confirm')},
                              'badge text-bg-warning border-0 ms-1',
                              {title: 'Confirm these hours'})
        : [h.span, {class: 'badge text-bg-light text-muted ms-1', title: 'Awaiting host confirmation'},
           'unconfirmed'];
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
