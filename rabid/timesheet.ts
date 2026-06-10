// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types

import * as utils from "../liminal/utils.ts";
import {unwrap} from "../liminal/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, sqldate, sqldatetime } from "../liminal/db.ts";
import { Table, Field, PrimaryKeyField, ForeignKeyField, BooleanField, StringField, PhoneField, EmailField, SecretField, EnumField, IntegerField, FloatingPointField, DateTimeField, TableRenderer, TableView, reloadableItemProps, editButtonProps, navigableItemProps, navChevron, PublicViewable } from "../liminal/table.ts";
import * as security from "../liminal/security.ts";
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

export interface TimesheetEntry {
    timesheet_entry_id: number;

    volunteer_id: number;

    // Nullable because Can do volunteer time outside of an event.
    event_id?: number;

    // When a timesheet entry is created for an event, if we don't have
    // a specific start_time, we will use the event start_time or setup_time,
    // possibly backing up even more for remote events to cover travel time.
    //
    // This happens when a host adds a volunteer to an event, but doesn't
    // know when they arrived.
    //
    // If this is the case then start_time_is_approximate is also set.
    start_time: string;

    // When a timesheet entry is created during an event, we auto fill out
    // the end_time to be the event end_time, but also set end_time_is_provisional
    // to keep the user check out feature enabled.  This avoids leaving
    // unclosed TimesheetEntries, that would require either manual intervention
    // or batch jobs to resolve.
    //
    // If we book a person for a whole event, we set end_time_is_approximate
    end_time?: string;

    // Set when we are checking a volunteer into an event - ie.
    // using event times, rather than wall clock times.
    start_time_is_approximate: boolnum;
    end_time_is_approximate: boolnum;

    // When a user checks in, we will guess at an end time (usually end
    // of event), but still want to maintain the UI for them to check
    // out manually.
    end_time_is_provisional: boolnum;

    //
    notes: string;

    // Driving information
    km_driven_for_reimbursement: number;
    km_driven_processed: boolnum;

    //
    is_paid_time: number;
    paid_time_processed: boolnum;

    entry_creation_time?: string;
}

export type TimesheetEntryOpt = Partial<TimesheetEntry>;


// Add time that timesheet entry was created.
// Add time that timesheet entry was last edited.
// Add bool to indicate that paid time has been processed
// Add bool to indicat that km_driven has been processed.

export class TimesheetEntryTable extends Table<TimesheetEntry> {
    
    constructor() {
        super ('timesheet_entry', [
            new PrimaryKeyField('timesheet_entry_id', {}),
            new ForeignKeyField('volunteer_id', "volunteer", "volunteer_id", {indexed: true}),
            new ForeignKeyField('event_id', "event", "event_id", {indexed: true, nullable: true}),
            new DateTimeField('start_time'),
            new DateTimeField('end_time', {nullable: true}),
            new BooleanField('start_time_is_approximate', {default: 0}),
            new BooleanField('end_time_is_approximate', {default: 0}),
            new BooleanField('end_time_is_provisional', {default: 0}),
            new StringField('notes', {}),
            new FloatingPointField('km_driven_for_reimbursement', {}),
            new BooleanField('km_driven_processed', {default: 0}),
            new BooleanField('is_paid_time', {default: 0}),
            new BooleanField('paid_time_processed', {default: 0}),
            new StringField('entry_creation_time', {nullable: true}),
        ])
    };

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

    // A volunteer's entries, most recent first, with the event name (if any).
    @path
    get entriesForVolunteer() {
        return db().prepare<TimesheetEntry & {event_description: string|null}, {volunteer_id: number}>(block`
/**/   SELECT timesheet_entry.*, event.description AS event_description
/**/          FROM timesheet_entry
/**/          LEFT JOIN event ON timesheet_entry.event_id = event.event_id
/**/          WHERE timesheet_entry.volunteer_id = :volunteer_id
/**/          ORDER BY timesheet_entry.start_time DESC`);
    }

    // Renders a volunteer's timesheet as a section for the volunteer detail page.
    renderForVolunteer(volunteer_id: number): Markup {
        const entries = this.entriesForVolunteer.all({volunteer_id});
        if(entries.length === 0)
            return [h.p, {class: 'text-muted'}, 'No timesheet entries yet.'];

        const totalHours = entries.reduce((sum, e) => sum + entryHours(e), 0);

        return [h.table, {class: 'table table-sm'},
            [h.tbody, {},
             [h.tr, {},
              [h.th, {}, 'Date'], [h.th, {}, 'Event'],
              [h.th, {class: 'text-end'}, 'Hours'], [h.th, {}, 'Notes']],
             entries.map(e => this.renderEntryRow(e)),
             [h.tr, {},
              [h.td, {colspan: '2', class: 'text-end fw-bold'}, 'Total'],
              [h.td, {class: 'text-end fw-bold'}, totalHours.toFixed(1)],
              [h.td, {}]],
            ]];
    }

    renderEntryRow(e: TimesheetEntry & {event_description: string|null}): Markup {
        const hrs = e.end_time ? entryHours(e) : null;
        return [h.tr, {},
            [h.td, {}, date.sqliteDateTimeToDateString(e.start_time)],
            [h.td, {}, e.event_description || '—'],
            [h.td, {class: 'text-end'}, hrs == null ? '—' : hrs.toFixed(1)],
            [h.td, {}, e.notes || ''],
        ];
    }

    // ------------------------------------------------------------------------
    // --- Standard editable-item list (the baseline; structured per-period
    // --- views come later) ----------------------------------------------------
    // ------------------------------------------------------------------------

    // All entries with the volunteer and event names, most recent first.
    @path
    get allEntriesWithNames() {
        return this.prepare<TimesheetEntry & {volunteer_name: string, event_description: string|null}, {}>(block`
/**/   SELECT timesheet_entry.*, volunteer.name AS volunteer_name,
/**/          event.description AS event_description
/**/          FROM timesheet_entry
/**/          LEFT JOIN volunteer USING (volunteer_id)
/**/          LEFT JOIN event ON timesheet_entry.event_id = event.event_id
/**/          ORDER BY timesheet_entry.start_time DESC`);
    }

    @path
    get entryWithNamesById() {
        return this.prepare<TimesheetEntry & {volunteer_name: string, event_description: string|null},
                            {timesheet_entry_id: number}>(block`
/**/   SELECT timesheet_entry.*, volunteer.name AS volunteer_name,
/**/          event.description AS event_description
/**/          FROM timesheet_entry
/**/          LEFT JOIN volunteer USING (volunteer_id)
/**/          LEFT JOIN event ON timesheet_entry.event_id = event.event_id
/**/          WHERE timesheet_entry_id = :timesheet_entry_id`);
    }

    renderTimesheetList(entries: Array<TimesheetEntry & {volunteer_name: string, event_description: string|null}>): Markup {
        if(entries.length === 0)
            return [h.p, {class: 'text-muted'}, 'No timesheet entries yet.'];
        return [h.div, {class: 'list-group lm-list'},
                entries.map(e => this.renderTimesheetRow(e))];
    }

    renderTimesheetRow(e: TimesheetEntry & {volunteer_name: string, event_description: string|null}): Markup {
        const id = e.timesheet_entry_id;
        const hrs = e.end_time ? `${entryHours(e).toFixed(1)} hrs` : 'not checked out';
        const secondary = [date.sqliteDateTimeToDateString(e.start_time), hrs,
                           e.event_description ?? undefined].filter(Boolean).join(' · ');

        if(this.canEditRecord(e)) {
            const item = this.editableItemProps(id, `rabid.timesheet_entry.renderTimesheetRowById(${id})`);
            return [h.div, {...item, 'data-testid': `timesheet-row-${id}`},
                [h.div, {class: 'lm-item-body'},
                 [h.div, {class: 'lm-item-primary'},
                  templates.pageLink(`/rabid.timesheet_entry.detailPage(${id})`, e.volunteer_name)],
                 [h.div, {class: 'lm-item-secondary'}, secondary]],
                this.editPencil(id),
            ];
        }

        return [h.a, {...navigableItemProps(`/rabid.timesheet_entry.detailPage(${id})`),
                      'data-testid': `timesheet-row-${id}`},
            [h.div, {class: 'lm-item-body'},
             [h.div, {class: 'lm-item-primary'}, e.volunteer_name],
             [h.div, {class: 'lm-item-secondary'}, secondary]],
            navChevron(),
        ];
    }

    // Reload target for a single list row (after an edit save).
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
        const approx = (flag: boolnum) => flag ? ' (approximate)' : '';
        return [h.div, props,
            [h.div, {class: 'd-flex align-items-center gap-2 mb-3'},
             [h.h2, {class: 'mb-0'}, `${e.volunteer_name} — time`],
             this.canEditRecord(e) ? this.editPencil(timesheet_entry_id) : undefined],
            [h.dl, {class: 'row mb-0'},
             row('Volunteer', templates.pageLink(`/rabid.volunteer.detailPage(${e.volunteer_id})`, e.volunteer_name)),
             row('Event', e.event_description || '—'),
             row('Start', date.sqliteDateTimeToString(e.start_time, '—') + approx(e.start_time_is_approximate)),
             row('End', e.end_time
                 ? date.sqliteDateTimeToString(e.end_time) + approx(e.end_time_is_approximate)
                   + (e.end_time_is_provisional ? ' (provisional)' : '')
                 : 'not checked out'),
             row('Hours', e.end_time ? entryHours(e).toFixed(1) : '—'),
             row('Driving', e.km_driven_for_reimbursement
                 ? `${e.km_driven_for_reimbursement} km${e.km_driven_processed ? ' (processed)' : ''}` : '—'),
             row('Notes', e.notes || '—'),
            ],
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



