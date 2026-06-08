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
import * as templates from './templates.ts';

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

    // Hand-coded volunteer list.  The generic TableRenderer is only a quick
    // default; a real view composes the pieces directly so we control the columns
    // and the name-links-to-detail behaviour.
    renderVolunteerList(q: string, scope: string): Markup {
        const rows = this.searchByPrefix.all({q, scope});
        const scopeLabel = scope === 'all' ? 'all' : 'active';
        return [
            [h.p, {class: 'text-muted small mb-2'},
             q ? `${rows.length} ${scopeLabel} volunteer(s) matching “${q}”`
               : `${rows.length} ${scopeLabel} volunteer(s)`],
            [h.table, {class: 'table'},
             [h.tbody, {},
              [h.tr, {}, [h.th, {}, 'Name'], [h.th, {}, 'Email'], [h.th, {}, 'Phone'], [h.th, {}]],
              rows.map(v => this.renderVolunteerRow(v)),
             ],
            ],
        ];
    }

    // One list row.  The name links to the volunteer's detail page; email/phone
    // reuse the field render() helpers (mailto / tel); edit reuses the table's
    // edit button.  reloadableItemProps tags the row so an edit save (which
    // reloads `.-volunteer-<id>-`) re-renders just this row.
    renderVolunteerRow(v: Volunteer): Markup {
        const id = v.volunteer_id;
        const f = this.fieldsByName;
        return [h.tr, this.reloadableItemProps(id, `rabid.volunteer.renderVolunteerRowById(${id})`),
            [h.td, {}, templates.pageLink(`/rabid/rabid.volunteer.detailPage(${id})`, v.name)],
            [h.td, {}, f.email.render(v.email)],
            [h.td, {}, f.phone.render(v.phone)],
            [h.td, {}, this.editButton(id)],
        ];
    }

    // Reload target for a single list row (after an edit save).
    renderVolunteerRowById(id: number): Markup {
        return this.renderVolunteerRow(this.getById(id));
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

    // ------------------------------------------------------------------------
    // --- Volunteer detail page ----------------------------------------------
    // ------------------------------------------------------------------------

    // Full page for one volunteer (navigated to by clicking the name in the list):
    // contact info at the top.  Timesheet entries, committed tasks, etc. will be
    // added below later.
    detailPage(volunteer_id: number): templates.Page {
        const v = this.getById(volunteer_id);
        return templates.page(`${v.name} — Volunteer`, this.renderDetail(volunteer_id));
    }

    // The detail body, as a reloadable fragment (so an edit save re-renders it).
    renderDetail(volunteer_id: number): Markup {
        const v = this.getById(volunteer_id);
        const f = this.fieldsByName;
        const props = this.reloadableItemProps(volunteer_id, `rabid.volunteer.renderDetail(${volunteer_id})`);
        props.class = 'container py-3 ' + props.class;

        const emergency = [v.emergency_contact_name, v.emergency_contact_phone].filter(Boolean).join(' · ');

        return [h.div, props,
            [h.div, {class: 'd-flex align-items-center gap-2 mb-3'},
             [h.h2, {class: 'mb-0'}, v.name],
             v.inactive ? [h.span, {class: 'badge text-bg-secondary'}, 'Inactive'] : undefined,
             this.editButton(volunteer_id)],

            [h.dl, {class: 'row mb-0'},
             [h.dt, {class: 'col-sm-3'}, 'Email'],
             [h.dd, {class: 'col-sm-9'}, f.email.render(v.email) || '—'],
             [h.dt, {class: 'col-sm-3'}, 'Phone'],
             [h.dd, {class: 'col-sm-9'}, f.phone.render(v.phone) || '—'],
             [h.dt, {class: 'col-sm-3'}, 'Skills'],
             [h.dd, {class: 'col-sm-9'}, v.skills || '—'],
             [h.dt, {class: 'col-sm-3'}, 'Emergency contact'],
             [h.dd, {class: 'col-sm-9'}, emergency || '—'],
             [h.dt, {class: 'col-sm-3'}, 'Joined'],
             [h.dd, {class: 'col-sm-9'}, v.join_date || '—'],
            ],

            // TODO: timesheet entries, committed tasks, etc.
        ];
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
