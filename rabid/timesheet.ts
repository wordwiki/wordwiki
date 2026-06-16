// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types

import * as utils from "../liminal/utils.ts";
import {unwrap} from "../liminal/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, sqldate, sqldatetime } from "../liminal/db.ts";
import { Table, Field, PrimaryKeyField, ForeignKeyField, BooleanField, StringField, MarkdownField, PhoneField, EmailField, SecretField, EnumField, IntegerField, FloatingPointField, DateTimeField, TableRenderer, TableView, reloadableItemProps, editButtonProps, navChevron, PublicViewable } from "../liminal/table.ts";
import { VolunteerForeignKeyField } from "./volunteer-activity.ts";
import * as security from "../liminal/security.ts";
import {route, routeMutation, authenticated} from "../liminal/security.ts";
import * as templates from './templates.ts';
import {serializeAs, setSerialized, path} from "../liminal/serializable.ts";

import {block} from "../liminal/strings.ts";
import {Markup, h} from "../liminal/markup.ts";
import {lazy} from '../liminal/lazy.ts';
import {SQLiteDateString, SQLiteDateTimeString} from '../liminal/date.ts';
import * as date from '../liminal/date.ts';

// --------------------------------------------------------------------------------
// --- TimesheetEntry -------------------------------------------------------------
// --------------------------------------------------------------------------------

// A volunteer manages their own time; hosts/admins manage anyone's.
const selfOrHost = security.or(security.isSelf,
                               security.hasRole('host'), security.hasRole('admin'));

// A timesheet entry is EXPLICIT recorded time: staff timesheets, and the rarer
// volunteer work done outside of an event (e.g. desk work at home).  Volunteer
// attendance at events is NOT recorded here - it lives in event_checkin, where
// it is far easier to capture accurately (one check-in, retroactive, host can
// check everyone in).  So a timesheet entry always has a real start_time the
// person actually worked - no event linkage, no "approximate" event-derived
// times.
export interface TimesheetEntry {
    timesheet_entry_id: number;

    volunteer_id: number;

    // The actual time worked (explicitly recorded, not derived from an event).
    start_time: string;
    // Filled out at the end of the shift.  There is UI that surfaces the
    // unfinished start/end pairs on the volunteer page + a global version.
    end_time?: string;

    //
    notes: string;

    // Driving information
    km_driven_for_reimbursement: number;
    km_driven_processed: boolnum;

    //
    is_paid_time: number;
    paid_time_processed: boolnum;
    paid_time_processed_note?: string;

    entry_last_edit_time?: string;
    entry_creation_time?: string;
}

export type TimesheetEntryOpt = Partial<TimesheetEntry>;


// A system-managed datetime: stamped by insert/update, never shown in the edit
// form (mirrors the Managed* fields in task.ts).
class ManagedDateTimeField extends DateTimeField {
    override isVisible(): boolean { return false; }
}


export class TimesheetEntryTable extends Table<TimesheetEntry> {
    
    constructor() {
        super ('timesheet_entry', [
            new PrimaryKeyField('timesheet_entry_id', {}),

            // We are a volunteer-primary org, so volunteer is our primary table, and
            // staff are represented as volunteers with the 'is_staff' field set.  Note
            // active staff can also volunteer (in which case is_paid_time is false),
            // and volunteers can be paid (in which case is_paid_time is true).  Also,
            // the same person can be staff for a month, then transition to being a volunteer -
            // so for historical reporting purposes the important bit is the is_paid_time field.
            // VolunteerForeignKeyField: picker shows names, recently-active first.
            new VolunteerForeignKeyField('volunteer_id', {indexed: true}),

            // The actual time worked.  This is EXPLICIT time (staff timesheets,
            // or volunteer work outside an event); event attendance lives in
            // event_checkin, so there is no event linkage or event-derived
            // "approximate" times here - start_time is always real.
            new DateTimeField('start_time'),
            new DateTimeField('end_time', {nullable: true}),
            // Notes are required to be non empty if entry 'is_paid_time'
            new MarkdownField('notes', {}),

            new BooleanField('is_paid_time', {default: 0}),
            // This indicates that the treasurer has entered the time into the payroll system.
            new BooleanField('paid_time_processed', {default: 0}),
            // A free-text note explaining the paid-time processing (e.g. payroll
            // batch reference, or why an entry was held back).
            new StringField('paid_time_processed_note', {nullable: true}),

            // This may happen quite a while after the driving happens (so that our treasurer
            // does not have to do this bi-weekly etc).
            new FloatingPointField('km_driven_for_reimbursement', {}),
            new BooleanField('km_driven_processed', {default: 0}),

            // This is critical for paid shifts.  If is important that staff enter their time shortly
            // after they work the shift - otherwise it will end up being a post-hoc reconstruction.
            // Both are system-managed: stamped on insert, the edit time re-stamped on every save.
            new ManagedDateTimeField('entry_last_edit_time', {nullable: true}),
            new ManagedDateTimeField('entry_creation_time', {nullable: true}),
        ], [
            // (Field `indexed: true` is a no-op - createIndexesDML is a stub - so
            // indexes are declared explicitly here.)  This table grows without
            // bound over the years; index the columns the hot reads filter/sort on:
            //   - (volunteer_id, start_time): the per-volunteer Time view
            //     (entriesForVolunteer: WHERE volunteer_id ORDER BY start_time).
            //   - (start_time): the "active in last N days" scan (WHERE start_time
            //     >= :since) - see volunteer-activity.ts.
            'CREATE INDEX IF NOT EXISTS timesheet_entry_by_volunteer_start ON timesheet_entry(volunteer_id, start_time);',
            'CREATE INDEX IF NOT EXISTS timesheet_entry_by_start_time ON timesheet_entry(start_time);',
        ])
    };

    // Creation/edit timestamps ride on every insert (the generic saveForm insert
    // path included - both are hidden managed fields, absent from the form).
    override insert<P extends Partial<TimesheetEntry>>(tuple: P): number {
        const now = date.currentSqliteDateTime();
        return super.insert({
            entry_creation_time: now,
            entry_last_edit_time: now,
            ...tuple});
    }

    // Every edit re-stamps the last-edit time.  All mutations funnel through here
    // (update() delegates), so the generic saveForm path and direct calls both stamp.
    override updateNamedFields<P extends Partial<TimesheetEntry>>(id: number, fieldNames: Array<keyof P>, fields: P) {
        const amended: any = {...fields, entry_last_edit_time: date.currentSqliteDateTime()};
        const names: any[] = [...fieldNames, 'entry_last_edit_time'];
        super.updateNamedFields(id, names, amended);
    }
    override update<P extends Partial<TimesheetEntry>>(id: number, fields: P) {
        this.updateNamedFields(id, Object.keys(fields) as Array<keyof P>, fields);
    }

    // An edit may be shown inside a volunteer's reconciled time view (volunteer_time.ts),
    // so also reload that fragment - htmx ignores the selector when it isn't present
    // (e.g. an edit from the global Timesheets list).
    @routeMutation(authenticated)   // override re-declares the route perm (base's marker is on Table.saveForm)
    override saveForm(form: Record<string, string>): Markup {
        const result = super.saveForm(form) as any;
        const id = Number(form?.timesheet_entry_id);
        if(result && result.action === 'reload' && Array.isArray(result.targets) && Number.isInteger(id)) {
            const e = security.runSystem(() => this.getById(id));
            if(e) result.targets.push(`.-volunteer_time-${e.volunteer_id}-`);
        }
        return result;
    }

    // A timesheet entry belongs to its volunteer (drives isSelf).
    ownerId(e: TimesheetEntry): number|undefined { return e.volunteer_id; }

    defaultFieldEdit: security.Permission = selfOrHost;
    override get recordEdit(): security.Permission { return selfOrHost; }

    override formTitle(e: TimesheetEntry): string {
        const v = security.runSystem(() =>
            db().prepare<{name: string}, {id: number}>(
                'SELECT name FROM volunteer WHERE volunteer_id = :id').first({id: e.volunteer_id}));
        return `Edit time for ${v?.name ?? 'volunteer'}`;
    }

    @path
    get allTimesheetEntries() {
        return db().prepare<TimesheetEntry, {}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM timesheet_entry
/**/          ORDER BY start_time`);
    }

    @path
    get timesheetEntriesInDayRange() {
        return db().prepare<TimesheetEntry, {start_date: SQLiteDateString, end_date: SQLiteDateString}>(block`
/**/      SELECT * FROM timesheet_entry 
/**/           WHERE start_time >= :start_date 
/**/           AND start_time <= :end_date || ' 23:59:59'`);
    }

    @path
    get timesheetEntriesInTimeRange() {
        return db().prepare<TimesheetEntry, {start_time: SQLiteDateTimeString, end_time: SQLiteDateTimeString}>(block`
/**/      SELECT * FROM timesheet_entry 
/**/           WHERE start_time >= :start_time 
/**/           AND start_time <= :end_time`);
    }
    
    all(): TimesheetEntry[] {
        return this.allTimesheetEntries.all();
    }

    // A volunteer's entries (explicit recorded time), most recent first.
    @path
    get entriesForVolunteer() {
        return db().prepare<TimesheetEntry, {volunteer_id: number}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM timesheet_entry
/**/          WHERE volunteer_id = :volunteer_id
/**/          ORDER BY start_time DESC`);
    }

    // (The per-volunteer timesheet view now lives in volunteer_time.ts, which
    // reconciles these entries with event check-ins into one chronological,
    // week-grouped view; it reads entriesForVolunteer above.)

    // ------------------------------------------------------------------------
    // --- Standard editable-item list (the baseline; structured per-period
    // --- views come later) ----------------------------------------------------
    // ------------------------------------------------------------------------

    // All entries with the volunteer name, most recent first.
    @path
    get allEntriesWithNames() {
        return this.prepare<TimesheetEntry & {volunteer_name: string}, {}>(block`
/**/   SELECT timesheet_entry.*, volunteer.name AS volunteer_name
/**/          FROM timesheet_entry
/**/          LEFT JOIN volunteer USING (volunteer_id)
/**/          ORDER BY timesheet_entry.start_time DESC`);
    }

    @path
    get entryWithNamesById() {
        return this.prepare<TimesheetEntry & {volunteer_name: string},
                            {timesheet_entry_id: number}>(block`
/**/   SELECT timesheet_entry.*, volunteer.name AS volunteer_name
/**/          FROM timesheet_entry
/**/          LEFT JOIN volunteer USING (volunteer_id)
/**/          WHERE timesheet_entry_id = :timesheet_entry_id`);
    }

    renderTimesheetList(entries: Array<TimesheetEntry & {volunteer_name: string}>): Markup {
        if(entries.length === 0)
            return [h.p, {class: 'text-muted'}, 'No timesheet entries yet.'];
        return [h.div, {class: 'list-group lm-list'},
                entries.map(e => this.renderTimesheetRow(e))];
    }

    renderTimesheetRow(e: TimesheetEntry & {volunteer_name: string}): Markup {
        const id = e.timesheet_entry_id;
        // Show the work period as date · begin–end · elapsed.
        const times = e.end_time
            ? `${date.sqliteDateTimeToTimeString(e.start_time)} – ${date.sqliteDateTimeToTimeString(e.end_time)}`
            : `from ${date.sqliteDateTimeToTimeString(e.start_time)}`;
        const hrs = e.end_time ? `${entryHours(e).toFixed(1)} hrs` : 'not checked out';
        const secondary = [date.sqliteDateTimeToDateString(e.start_time), times, hrs].filter(Boolean).join(' · ');

        // One navigable row species for every viewer (Table.detailItemProps:
        // tap anywhere drills in via the lm-nav-link name); the pencil - shown
        // only to viewers with recordEdit - is the only edit affordance.
        const item = this.detailItemProps(id, `rabid.timesheet_entry.renderTimesheetRowById(${id})`);
        return [h.div, {...item, 'data-testid': `timesheet-row-${id}`},
            [h.div, {class: 'lm-item-body'},
             [h.div, {class: 'lm-item-primary'},
              [h.a, {...templates.pageLinkProps(`/rabid.timesheet_entry.detailPage(${id})`),
                     class: 'lm-nav-link'}, e.volunteer_name],
              latePaidBadge(latePaidReconstruction(e))],
             [h.div, {class: 'lm-item-secondary'}, secondary]],
            this.canEditRecord(e) ? this.editPencil(id) : undefined,
            navChevron(),
        ];
    }

    // Reload target for a single list row (after an edit save).
    @route(authenticated)
    renderTimesheetRowById(id: number): Markup {
        const e = this.entryWithNamesById.first({timesheet_entry_id: id});
        if(!e) throw new Error(`No timesheet entry ${id}`);
        return this.renderTimesheetRow(e);
    }

    // The top-level Timesheets page body.  For now the full standard list;
    // structured per-period views come later.
    renderTimesheetsPage(): Markup {
        return [h.div, {class: 'container py-3'},
            [h.h2, {}, 'Timesheets'],
            this.renderTimesheetList(this.allEntriesWithNames.all()),
        ];
    }

    // ------------------------------------------------------------------------
    // --- Timesheet entry detail page -----------------------------------------
    // ------------------------------------------------------------------------

    @route(authenticated)
    detailPage(timesheet_entry_id: number): templates.Page {
        const e = this.entryWithNamesById.first({timesheet_entry_id});
        if(!e) throw new Error(`No timesheet entry ${timesheet_entry_id}`);
        return templates.page(`${e.volunteer_name} — Timesheet entry`,
                              this.renderTimesheetDetail(timesheet_entry_id));
    }

    // Reloadable fragment (an edit save re-renders it).
    renderTimesheetDetail(timesheet_entry_id: number): Markup {
        const e = this.entryWithNamesById.first({timesheet_entry_id});
        if(!e) throw new Error(`No timesheet entry ${timesheet_entry_id}`);
        const props = this.reloadableItemProps(timesheet_entry_id,
            `rabid.timesheet_entry.renderTimesheetDetail(${timesheet_entry_id})`);
        props.class = 'container py-3 ' + props.class;
        const row = (label: string, value: Markup) =>
            [[h.dt, {class: 'col-sm-3'}, label], [h.dd, {class: 'col-sm-9'}, value]];
        return [h.div, props,
            [h.div, {class: 'd-flex align-items-center gap-2 mb-3'},
             [h.h2, {class: 'mb-0'}, `${e.volunteer_name} — time`],
             this.canEditRecord(e) ? this.editPencil(timesheet_entry_id) : undefined],
            latePaidAlert(latePaidReconstruction(e)),
            [h.dl, {class: 'row mb-0'},
             row('Volunteer', templates.pageLink(`/rabid.volunteer.detailPage(${e.volunteer_id})`, e.volunteer_name)),
             row('Start', date.sqliteDateTimeToString(e.start_time, '—')),
             row('End', e.end_time
                 ? date.sqliteDateTimeToString(e.end_time)
                 : 'not checked out'),
             row('Hours', e.end_time ? entryHours(e).toFixed(1) : '—'),
             row('Driving', e.km_driven_for_reimbursement
                 ? `${e.km_driven_for_reimbursement} km${e.km_driven_processed ? ' (processed)' : ''}` : '—'),
             // Paid-time row, shown only when relevant - carries the processing
             // status and the free-text processing note.
             (e.is_paid_time || e.paid_time_processed_note)
                 ? row('Paid time',
                       [e.is_paid_time ? 'Paid' : 'Unpaid',
                        e.is_paid_time ? (e.paid_time_processed ? ' — processed' : ' — not yet processed') : undefined,
                        e.paid_time_processed_note
                            ? [h.div, {class: 'lm-item-secondary'}, e.paid_time_processed_note] : undefined])
                 : undefined,
             row('Notes', e.notes ? this.fieldsByName.notes.render(e.notes) : '—'),
            ],
            // Provenance footer (system-managed timestamps).
            e.entry_creation_time
                ? [h.p, {class: 'text-muted small mt-3 mb-0'},
                   `Recorded ${date.sqliteDateTimeToString(e.entry_creation_time)}`,
                   (e.entry_last_edit_time && e.entry_last_edit_time !== e.entry_creation_time)
                       ? ` · last edited ${date.sqliteDateTimeToString(e.entry_last_edit_time)}` : undefined]
                : undefined,
        ];
    }
}
export const timesheetEntryMetaData = new TimesheetEntryTable();

// Duration of a timesheet entry in hours (0 if not yet ended).
function entryHours(e: TimesheetEntry): number {
    if(!e.end_time) return 0;
    // Temporal, not new Date(): JS Date parsing of 'YYYY-MM-DD HH:MM:SS' is
    // engine-specific luck (see liminal/date.ts).
    return date.sqliteDateTimeToTemporal(e.end_time)
        .since(date.sqliteDateTimeToTemporal(e.start_time))
        .total({unit: 'hours'});
}

// --------------------------------------------------------------------------------
// --- Late-paid-entry warning ----------------------------------------------------
// --------------------------------------------------------------------------------
//
// A PAID entry first recorded, or last edited, well after the work ended is a
// hazy reconstruction - and paid time drives payroll, so it must be checked.  We
// flag it LOUDLY and ALWAYS (every place a paid entry renders).  Non-paid time
// doesn't get the warning: a late volunteer-hours entry doesn't really matter.

const LATE_PAID_HOURS = 24;   // grace window after end_time before it's "late"

export interface LatePaid { kind: 'entered' | 'edited'; daysLate: number; }

// Hours from `endStr` to `t` (positive when t is after the work ended).
function hoursAfterEnd(endStr: string, t: string): number {
    return date.sqliteDateTimeToTemporal(t)
        .since(date.sqliteDateTimeToTemporal(endStr))
        .total({unit: 'hours'});
}

// The late-paid finding for an entry, or null.  Only paid, ended entries qualify;
// "entered late" (born after the window) takes precedence over "edited late".
export function latePaidReconstruction(e: {
        is_paid_time?: number | boolean, end_time?: string | null,
        entry_creation_time?: string | null, entry_last_edit_time?: string | null}): LatePaid | null {
    if(!e.is_paid_time || !e.end_time) return null;
    if(e.entry_creation_time && hoursAfterEnd(e.end_time, e.entry_creation_time) > LATE_PAID_HOURS)
        return {kind: 'entered', daysLate: hoursAfterEnd(e.end_time, e.entry_creation_time) / 24};
    if(e.entry_last_edit_time && hoursAfterEnd(e.end_time, e.entry_last_edit_time) > LATE_PAID_HOURS)
        return {kind: 'edited', daysLate: hoursAfterEnd(e.end_time, e.entry_last_edit_time) / 24};
    return null;
}

export function latePaidMessage(d: LatePaid): string {
    const days = Math.max(1, Math.round(d.daysLate));
    return `Paid time ${d.kind} ${days} day${days === 1 ? '' : 's'} after the work ended — `
         + `late paid entries are hazy reconstructions; verify it.`;
}

// Inline (badge) for compact contexts - list rows, the Time view.
export function latePaidBadge(d: LatePaid | null | undefined): Markup {
    if(!d) return undefined;
    return [h.span, {class: 'badge text-bg-danger ms-1', 'data-testid': 'late-paid',
                     title: latePaidMessage(d)}, '⚠ late paid'];
}

// Block alert for the detail page.
export function latePaidAlert(d: LatePaid | null | undefined): Markup {
    if(!d) return undefined;
    return [h.div, {class: 'alert alert-danger py-1 px-2 my-2', role: 'alert', 'data-testid': 'late-paid'},
            '⚠ ', latePaidMessage(d)];
}



