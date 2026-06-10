// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types

import * as utils from "../liminal/utils.ts";
import {unwrap} from "../liminal/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, sqldate, sqldatetime } from "../liminal/db.ts";
import { Table, Field, PrimaryKeyField, ForeignKeyField, BooleanField, StringField, PhoneField, EmailField, SecretField, EnumField, IntegerField, FloatingPointField, DateTimeField, TableRenderer, TableView, reloadableItemProps, editButtonProps, PublicViewable } from "../liminal/table.ts";
import {serializeAs, setSerialized, path} from "../liminal/serializable.ts";

import {block} from "../liminal/strings.ts";
import {Markup, h} from "../liminal/markup.ts";
import {lazy} from '../liminal/lazy.ts';
import {SQLiteDateString, SQLiteDateTimeString} from '../liminal/date.ts';
import * as date from '../liminal/date.ts';

// --------------------------------------------------------------------------------
// --- TimesheetEntry -------------------------------------------------------------
// --------------------------------------------------------------------------------

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
}
export const timesheetEntryMetaData = new TimesheetEntryTable();

// Duration of a timesheet entry in hours (0 if not yet ended).
function entryHours(e: TimesheetEntry): number {
    if(!e.end_time) return 0;
    return (new Date(e.end_time).getTime() - new Date(e.start_time).getTime()) / 3600000;
}



