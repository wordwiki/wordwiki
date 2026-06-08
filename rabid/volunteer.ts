// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types

import * as utils from "../liminal/utils.ts";
import {unwrap} from "../liminal/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, sqldate, sqldatetime } from "../liminal/db.ts";
import { Table, Field, PrimaryKeyField, ForeignKeyField, BooleanField, StringField, PhoneField, EmailField, SecretField, EnumField, IntegerField, FloatingPointField, DateTimeField, TableRenderer, TableView, reloadableItemProps, editButtonProps, PublicViewable } from "../liminal/table.ts";
import {serializeAs, setSerialized, path} from "../liminal/serializable.ts";

import {block} from "../liminal/strings.ts";
import {Markup, h} from "../liminal/markup.ts";
import {lazy} from '../liminal/lazy.ts';
import * as action from "../liminal/action.ts";

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
    phone_number_visible_to_all_volunteers: boolnum;

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
            new BooleanField('phone_number_visible_to_all_volunteers', {default: 0}),
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
    get byEmail() {
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

    // ------------------------------------------------------------------------
    // --- Search (a worked example of "an action with a parameter list") -----
    // ------------------------------------------------------------------------
    //
    // Demonstrates the general popup-action model on something that is NOT a
    // record edit: a button opens a dialog collecting a search term, and
    // submitting it narrows the volunteer list in place.  The search `scope`
    // (active-only vs. all) is a *hidden* parameter - fixed by whichever button
    // opened the dialog, not editable by the user, but submitted along with the
    // typed term.

    // Matches volunteers whose email starts with the term, or whose name has a
    // word starting with the term (the leading-space trick makes the term match
    // at the start of any word).  An empty term matches everyone in scope.
    // LIKE is case-insensitive for ASCII in SQLite, so no lower() is needed.
    @path
    get searchByPrefix() {
        return db().prepare<Volunteer, {q: string, scope: string}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM volunteer
/**/          WHERE deleted = 0
/**/            AND (:scope = 'all' OR inactive = 0)
/**/            AND ( email LIKE :q || '%'
/**/                  OR (' ' || name) LIKE '% ' || :q || '%' )
/**/          ORDER BY name`);
    }

    // The Volunteers section: buttons that open the search dialog with a fixed
    // (hidden) scope, plus the results container (initially the full active list).
    renderSearchableVolunteers(): Markup {
        return [
            [h.div, {class: 'mb-2 d-flex gap-2'},
             action.actionButton('Search active volunteers',
                 {kind: 'modal', dialogUrl: "/rabid/rabid.volunteer.searchDialog('active')"},
                 'btn btn-outline-primary btn-sm'),
             action.actionButton('Search all volunteers',
                 {kind: 'modal', dialogUrl: "/rabid/rabid.volunteer.searchDialog('all')"},
                 'btn btn-outline-secondary btn-sm'),
            ],
            [h.div, {id: 'volunteer-search-results'},
             this.renderVolunteerList('', 'active')],
        ];
    }

    // Returns a fragment (a count line + the table).  rpcHandler now renders a
    // top-level fragment, so render helpers no longer need a single root element.
    renderVolunteerList(q: string, scope: string): Markup {
        const rows = this.searchByPrefix.all({q, scope});
        const scopeLabel = scope === 'all' ? 'all' : 'active';
        return [
            [h.p, {class: 'text-muted small mb-2'},
             q ? `${rows.length} ${scopeLabel} volunteer(s) matching “${q}”`
               : `${rows.length} ${scopeLabel} volunteer(s)`],
            this.tableRenderer.renderTable(rows),
        ];
    }

    // Step 1 (generator): build the parameter dialog using the same Field
    // widgets as the tables.  `scope` rides along as a hidden field.
    searchDialog(scope: string): Markup {
        const inScope = scope === 'all' ? 'all' : 'active';
        return action.renderParamForm(
            [new StringField('q', {prompt: 'Name or email starts with…', nullable: true})],
            {},
            {
                title: inScope === 'all' ? 'Search all volunteers' : 'Search active volunteers',
                submitLabel: 'Search',
                hidden: {scope: inScope},
                dispatch: {
                    'hx-get': '/rabid/rabid.volunteer.searchResults(queryArgs)',
                    'hx-target': '#volunteer-search-results',
                    'hx-swap': 'innerHTML',
                    'hx-on::after-request': 'hideModalEditor()',
                },
            });
    }

    // Step 2 (action): render the narrowed list to swap into the results
    // container.  Reads the typed `q` and the hidden `scope` from the form.
    searchResults(args: {q?: string, scope?: string}): Markup {
        return this.renderVolunteerList(String(args?.q ?? ''), args?.scope === 'all' ? 'all' : 'active');
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

    @path
    get byVolunteerId() {
        return db().prepare<PasswordHash, {volunteer_id: number}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM password_hash
/**/          WHERE volunteer_id = :volunteer_id`);
    }
}
//export const passwordHashMetaData = new PasswordHashTable();

// --------------------------------------------------------------------------------
// --- VolunteerLoginSession ------------------------------------------------------
// --------------------------------------------------------------------------------

// These session tokens are dropped as cookies in browsers.  To end a session,
// erase the VolunteerLoginSession record.

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
