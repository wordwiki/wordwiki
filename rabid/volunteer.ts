// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types

import * as utils from "../liminal/utils.ts";
import {unwrap} from "../liminal/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, sqldate, sqldatetime } from "../liminal/db.ts";
import { Table, Field, PrimaryKeyField, ForeignKeyField, BooleanField, StringField, PhoneField, EmailField, SecretField, EnumField, IntegerField, FloatingPointField, DateTimeField, TableEditForm, TableRenderer, TableView, reloadableItemProps, editButtonProps, PublicViewable } from "../liminal/table.ts";
import {serializeAs, setSerialized, path} from "../liminal/serializable.ts";

import {block} from "../liminal/strings.ts";
import {Markup} from "../liminal/markup.ts";
import {lazy} from '../liminal/lazy.ts';

// --------------------------------------------------------------------------------
// --- Volunteer -----------------------------------------------------------------------
// --------------------------------------------------------------------------------

export const exit_reason_enum: Record<sqldate, string> = {
    'moved': 'Moved',
    'no-time': 'Not enough time to volunteer',
    'other': 'Other',
};

export interface Volunteer {
    volunteer_id: number;

    // Will be null if date is unknown (because the volunteer pre-dates this system
    // and has not filled it out - for new volunteers, this will default to record
    // creation date).
    join_date?: string;
    
    name: string;
    email: string;
    phone: string;

    // Skills or Experience You'd Like to Share e.g., bike repair, event planning, fundraising, social media, etc
    skills: string;
    
    emergency_contact_name: string;
    emergency_contact_phone: string;

    permissions: string;

    // Once a volunteer is manually marked inactive, they will not show up in the common
    // lists etc.
    inactive: boolnum;
    marked_inactive_date: string;
    
    // For volunteers with long inactivity, we may request exit feedback.
    exit_feedback_requested: boolnum;
    exit_reason?: string;
    exit_feedback?: string;
    
    /**
     * We disable volunteers rather than deleting them because they are
     * needed to do historical statistics queries.  Depending on policy and
     * situation, one may choose to change the volunteer, volunteername and
     * email to some anon string on semantic 'delete'.
     */
    deleted: boolnum;
}
export type VolunteerOpt = Partial<Volunteer>;

export class VolunteerTable extends Table<Volunteer> {
    
    constructor() {
        super ('volunteer', [
            new PrimaryKeyField('volunteer_id', {prompt: 'Id'}),
            new DateTimeField('join_date', {nullable: true}),
            new StringField('name', {indexed: true, permissions: PublicViewable}),
            new EmailField('email', {indexed: true, unique: true, permissions: PublicViewable}),
            new PhoneField('phone', {nullable: true, permissions: PublicViewable}),
            new StringField('skills', {default: ''}),
            new StringField('emergency_contact_name', {default: ''}),
            new StringField('emergency_contact_phone', {default: ''}),
            new StringField('permissions', {nullable: true}),
            new BooleanField('inactive', {default: 0}),
            new DateTimeField('marked_inactive_date', {nullable: true}),
            new BooleanField('exit_feedback_requested', {default: 0}),
            new EnumField('exit_reason', exit_reason_enum, {nullable: true}),
            new StringField('exit_feedback', {nullable: true}),
            new BooleanField('deleted', {default: 0}),
        ], [
        ])
    };

    @path
    get getByEmail() {
        return db().prepare<Volunteer, {email: string}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM volunteer
/**/          WHERE email = :email`);
    }

    @path
    get activeVolunteersByName() {
        return db().prepare<Volunteer, {}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM volunteer
/**/          WHERE deleted = 0 AND inactive = 0
/**/          ORDER BY name`);
    }

    @path
    get allVolunteersByName() {
        return db().prepare<Volunteer, {}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM volunteer
/**/          WHERE deleted = 0
/**/          ORDER BY name`);
    }

    @path
    get volunteersForEvent() {
        return db().prepare<Volunteer, {event_id: number}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM event LEFT JOIN volunteer
/**/          WHERE event.volunteer_id = volunteer.volunteer_id
/**/          ORDER BY name`);
    }

    @path
    get tableRenderer(): TableRenderer<Volunteer> {
        const fields = this.fieldsByName;
        return new TableRenderer(this, [fields.name, fields.email, fields.phone]);
    }

    @path
    get tableView(): TableView<Volunteer> {
        return new TableView<Volunteer>(this.tableRenderer, this.activeVolunteersByName.closure());
    }
}

// --------------------------------------------------------------------------------
// --- PasswordHash ----------------------------------------------------------------
// --------------------------------------------------------------------------------

// Note: password hashes are 1-1 with volunteers.  We put them in a separate table
// so that an error in a SQL query involving the volunteer table will not accidentally
// leak a hash.

export interface PasswordHash {
    password_hash_id: number,
    volunteer_id: number,
    password_salt?: string;
    password_hash?: string;
    last_change_time: string,
}
export type PasswordHashOpt = Partial<PasswordHash>;


export class PasswordHashTable extends Table<PasswordHash> {
    
    constructor() {
        super ('password_hash', [
            new PrimaryKeyField('password_hash_id', {}),
            new ForeignKeyField('volunteer_id', 'volunteer', 'volunteer_id', {indexed: true, unique: true, nullable: true}),
            new SecretField('password_salt', {nullable: true}),
            new SecretField('password_hash', {nullable: true}),
            new DateTimeField('last_change_time', {}),
        ],[
            'CREATE UNIQUE INDEX IF NOT EXISTS password_hash_by_volunteer_id ON password_hash(volunteer_id);'
        ])
    };

    ///**/   CREATE UNIQUE INDEX IF NOT EXISTS password_hash_by_volunteer ON password_hash(volunteer_id);

    getByVolunteerId(volunteer_id: number): PasswordHash|undefined {
        return db().prepare<PasswordHash, {volunteer_id: number}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM password_hash
/**/          WHERE volunteer_id = :volunteer_id`).first({volunteer_id});
    }
}
//export const passwordHashMetaData = new PasswordHashTable();

// --------------------------------------------------------------------------------
// --- VolunteerLoginSession ------------------------------------------------------
// --------------------------------------------------------------------------------

export interface VolunteerLoginSession {
    session_id: number;
    session_token: string;
    volunteer_id: number;
    start_time: string;
    last_resume_time: string;
    last_ip: string;
}

export type VolunteerLoginSessionOpt = Partial<VolunteerLoginSession>;

export class VolunteerLoginSessionTable extends Table<VolunteerLoginSession> {
    
    constructor() {
        super ('volunteer_session', [
            new PrimaryKeyField('session_id', {}),
            new StringField('session_token', {indexed: true, unique: true}),
            new ForeignKeyField('volunteer_id', "volunteer", "volunteer_id", {indexed: true}),
            new DateTimeField('start_time', {}),
            new DateTimeField('last_resume_time', {}),
            new StringField('last_ip', {})
        ])
    };

    @path
    get getBySessionToken() {
        return db().prepare<VolunteerLoginSession, {session_token: string}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM volunteer_session
/**/          WHERE session_token = :session_token`);
    }
}
//export const volunteerLoginSessionMetaData = new VolunteerLoginSessionTable();

// --------------------------------------------------------------------------------
// --- TimesheetEntry -------------------------------------------------------------
// --------------------------------------------------------------------------------

export interface TimesheetEntry {
    timesheet_entry_id: number;

    volunteer_id: number;

    // Nullable because Can do volunteer time outside of an event.
    event_id?: number;
    
    // To allow for commit for partial event.  
    start_time?: string;
    end_time?: string;

    //
    notes: string;

    // Driving information
    km_driven_for_reimbursement: number;

    //
    is_paid_time: number;

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
            new DateTimeField('start_time', {nullable: true}),
            new DateTimeField('end_time', {nullable: true}),
            new StringField('notes', {}),
            new FloatingPointField('km_driven_for_reimbursement', {}),
            new BooleanField('is_paid_time', {}),
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

    all(): TimesheetEntry[] {
        return this.allTimesheetEntries.all();
    }
}
export const timesheetEntryMetaData = new TimesheetEntryTable();



// ---------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------

// export const routes = ()=> ({
//     renderAllVolunteers,
//     renderVolunteerRow,
//     renderVolunteerEditor,
//     getVolunteer,
//     getVolunteers,
//     saveVolunteer,
//     //renderDate,
//     //greet,
// });

// export const allVolunteerDml =
//     new VolunteerTable().createDMLString() +
//     passwordHashMetaData.createDMLString() +
//     volunteerLoginSessionMetaData.createDMLString() +
//     timesheetEntryMetaData.createDMLString(
