import * as utils from "../liminal/utils.ts";
import {unwrap} from "../liminal/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, sqldate, sqldatetime } from "../liminal/db.ts";
import { Table, Field, PrimaryKeyField, ForeignKeyField, BooleanField, StringField, PhoneField, EmailField, SecretField, EnumField, IntegerField, FloatingPointField, DateTimeField, TableEditForm, TableRenderer, TableView, reloadableItemProps, editButtonProps, PublicViewable } from "../liminal/table.ts";
import {serializeAs, setSerialized, path} from "../liminal/serializable.ts";

import {block} from "../liminal/strings.ts";
import {Markup} from "../liminal/markup.ts";
import {lazy} from '../liminal/lazy.ts';


export function activeVolunteersByDay(startDate: string, endDate: string): Map<sqldate, Array<Volunteer>> {
    
    // --- Load all volunteer records into a Map<volunteer_id, Volunteer>

    // --- Load all events into a Map<event_id, Event>

    // --- Load all TimesheetEntries starting 31 days before the 'start_date'
    //     Process timesheet entries ...

    // --- Walk forward day by day from the start_date to the end_date maintaining
    //     the 

    
}

export function activeVolunteersByMonth(startDate: string, endDate: string): Map<sqldate, Array<Volunteer>> {
    // --- Get active volunteers by day
    const byDay = activeVolunteersByDay(startDate, endDate);
    
}

export function activeVolunteersByMonthReport(startDate: string, endDate: string): Markup {
    // By month show average number of active volunteers + all volunteers active at some point in that month (with number of days/hours active per volunteer).
}

// Add reports for service and sales of various kinds (including free-kids-bikes, adult-learn-to-ride etc)
