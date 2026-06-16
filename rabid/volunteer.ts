// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types

import * as utils from "../liminal/utils.ts";
import {unwrap} from "../liminal/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, sqldate, sqldatetime } from "../liminal/db.ts";
import { Table, Field, PrimaryKeyField, ForeignKeyField, BooleanField, StringField, PhoneField, EmailField, SecretField, EnumField, IntegerField, FloatingPointField, DateTimeField, DateField, CheckboxField, ImageField, TableRenderer, TableView, reloadableItemProps, editButtonProps, renderFieldValue, navChevron, PublicViewable } from "../liminal/table.ts";
import {serializeAs, setSerialized, path} from "../liminal/serializable.ts";

import {block} from "../liminal/strings.ts";
import {Markup, h} from "../liminal/markup.ts";
import {lazy} from '../liminal/lazy.ts';
import * as action from "../liminal/action.ts";
import * as templates from './templates.ts';
import {rabid} from './rabid.ts';
import * as security from "../liminal/security.ts";
import {route, authenticated} from "../liminal/security.ts";
import {activeVolunteerIdsWithin} from "./volunteer-activity.ts";

// 'host' is a volunteer trusted with a bit more visibility - hosts run events
// (e.g. volunteer nights) and are keyholders.  We deliberately use 'host' rather
// than 'staff': Red Raccoon is volunteer-run and volunteer-controlled, and we
// don't want elevated access framed as staff primacy.  'admin' (system control,
// e.g. managing roles) carries this visibility too.
const host = security.or(security.hasRole('host'), security.hasRole('admin'));
const selfOrHost = security.or(security.isSelf, host);
// Private contact fields are visible to self, hosts, or - per the volunteer's own
// opt-in/opt-out flag - to everyone.  Phone defaults private (opt-in); email shared.
const phoneViewable = security.or(selfOrHost, security.recordFlag('phone_number_visible_to_all_volunteers'));
const emailViewable = security.or(selfOrHost, security.recordFlag('email_visible_to_all_volunteers'));
// Editing a volunteer record is for the volunteer themselves, a host, or an
// admin - hosts run the place day-to-day and can edit pretty much anything.
// (Role management - the `permissions` field - stays admin-only.)

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
    email_visible_to_all_volunteers: boolnum;
    phone: string;
    phone_number_visible_to_all_volunteers: boolnum;

    // Skills or Experience You'd Like to Share e.g., bike repair, event planning, fundraising, social media, etc
    skills: string;

    // Whether this person is currently employed as staff (as opposed to a
    // volunteer).  Distinct from pay: staff can volunteer and volunteers can be
    // paid.  Event check-ins snapshot this at check-in time for grant reporting,
    // so changing it here does not rewrite history.  Host/admin managed.
    is_staff: boolnum;

    // Optional photo: a content-store path ('content/photos/…' - see
    // liminal/photo.ts).  Volunteer-supplied by choice.
    photo?: string;


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
            // Field order is also the edit-form order: identity first, then
            // contact, then the incidentals (join_date was previously first,
            // burying Name in the dialog).
            new StringField('name', {indexed: true}),
            new EmailField('email', {indexed: true, unique: true, view: emailViewable, redact: true}),
            // Volunteers may opt their email out of being shown to others (shared by default).
            new BooleanField('email_visible_to_all_volunteers', {default: 1}),
            new PhoneField('phone', {nullable: true, view: phoneViewable, redact: true}),
            // Volunteers may opt their phone in to being shown to others (private by default).
            new BooleanField('phone_number_visible_to_all_volunteers', {default: 0}),
            new StringField('skills', {default: ''}),
            // Employment status (host/admin managed) - snapshotted into event
            // check-ins for grant reporting.  See the interface field comment.
            new BooleanField('is_staff', {default: 0, prompt: 'Staff member', edit: host}),
            // Optional photo (a content-store path - see liminal/photo.ts).
            // Uploading one is the volunteer's own choice: the point is to help
            // other volunteers on a shift learn each other's names.
            new ImageField('photo', 'rabid.photo',
                           {nullable: true, prompt: 'Photo (optional — helps other volunteers learn your name)'}),
            // Day-granularity facts are DateFields (date picker, no time noise).
            new DateField('join_date', {nullable: true}),
            new StringField('emergency_contact_name', {default: '', view: selfOrHost, redact: true}),
            new StringField('emergency_contact_phone', {default: '', view: selfOrHost, redact: true}),
            new StringField('permissions', {nullable: true, edit: security.hasRole('admin')}),
            new BooleanField('inactive', {default: 0}),
            new DateField('marked_inactive_date', {nullable: true}),
            new BooleanField('exit_feedback_requested', {default: 0}),
            new EnumField('exit_reason', exit_reason_enum, {nullable: true}),
            new StringField('exit_feedback', {nullable: true}),
            new BooleanField('deleted', {default: 0}),
        ], [
        ])
    };

    // A volunteer record belongs to itself (its volunteer_id is the owner).
    ownerId(v: Volunteer): number|undefined { return v.volunteer_id; }

    // Open books: any logged-in volunteer can see a field by default.  The few
    // private ones are locked down explicitly above (phone opt-in, email opt-out,
    // emergency contact self-or-host) and redacted to '***' rather than hidden.
    defaultFieldView: security.Permission = security.loggedIn;
    // A volunteer edits their own record; hosts and admins edit anyone.
    // (permissions is admin-only to edit - see the field declaration.)
    defaultFieldEdit: security.Permission = selfOrHost;
    // Row-level: who may edit a volunteer record AT ALL.  Decides which row
    // species the list renders (editable surface with pencil vs. navigable
    // item with chevron) and gates renderForm/saveForm server-side.  Same rule
    // as the field default, declared explicitly: yourself, a host, or an admin.
    override get recordEdit(): security.Permission { return selfOrHost; }

    @path
    get byEmail() {
        return this.prepare<Volunteer, {email: string}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM volunteer
/**/          WHERE email = :email`);
    }

    @path
    get activeVolunteersByName() {
        return this.prepare<Volunteer, {}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM volunteer
/**/          WHERE deleted = 0 AND inactive = 0
/**/          ORDER BY name`);
    }

    @path
    get allVolunteersByName() {
        return this.prepare<Volunteer, {}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM volunteer
/**/          WHERE deleted = 0
/**/          ORDER BY name`);
    }

    @path
    get volunteersForEvent() {
        return this.prepare<Volunteer, {event_id: number}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM event LEFT JOIN volunteer
/**/          WHERE event.volunteer_id = volunteer.volunteer_id
/**/          ORDER BY name`);
    }

    @path
    get tableRenderer(): TableRenderer<Volunteer> {
        const fields = this.fieldsByName;
        // Phone is detail-page-only by policy (see renderVolunteerList).
        return new TableRenderer(this, [fields.name, fields.email]);
    }

    @path
    get tableView(): TableView<Volunteer> {
        return new TableView<Volunteer>(this.tableRenderer, this.activeVolunteersByName.closure());
    }

    // ------------------------------------------------------------------------
    // --- Search (a worked example of "an action that is a NAVIGATION") ------
    // ------------------------------------------------------------------------
    //
    // The popup-action model where the action's result is a PAGE: the dialog
    // collects {text, only_active} and navigates to
    //   /rabid.volunteer.search({text:"Dav",only_active:true})
    // (lmNavigateFormRoute builds the route expression from the form), so a
    // search has a real URL - sharable, back-button-able, refresh-stable - and
    // both the page's own Search button and the dialog pre-populate from the
    // current search, making refinement natural.

    // Matches volunteers whose email starts with the term, or whose name has a
    // word starting with the term (the leading-space trick makes the term match
    // at the start of any word).  An empty term matches everyone in scope.
    // Case-insensitive via LIKE (pinned by PRAGMA case_sensitive_like=OFF at
    // connection open - ASCII folding only).
    @path
    get searchVolunteers() {
        return this.prepare<Volunteer, {text: string, only_active: number}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM volunteer
/**/          WHERE deleted = 0
/**/            AND (:only_active = 0 OR inactive = 0)
/**/            AND ( email LIKE :text || '%'
/**/                  OR (' ' || name) LIKE '% ' || :text || '%' )
/**/          ORDER BY name`);
    }

    // The search results page.  Args arrive from the URL's object literal,
    // which our own dialog produced with these exact types (text fields as
    // strings, checkboxes as booleans - see lmNavigateFormRoute); routes
    // trust their forms, no per-route normalizers.  Absent only_active
    // defaults to true (active volunteers are the common case).
    @route(authenticated)
    search(args: {text?: string, only_active?: boolean} = {}): templates.Page {
        const text = args.text ?? '';
        const only_active = args.only_active ?? true;
        return templates.page('Volunteers — Search', this.renderSearch(text, only_active));
    }

    renderSearch(text: string, only_active: boolean): Markup {
        return [h.div, {class: 'container py-3'},
            [h.div, {class: 'd-flex align-items-center gap-2 mb-2'},
             [h.h2, {class: 'mb-0'}, 'Volunteers'],
             this.searchButton(text, only_active)],
            this.renderVolunteerList(text, only_active),
        ];
    }

    // The Search button: opens the dialog pre-populated with the CURRENT
    // search, so a search can be refined rather than retyped.
    searchButton(text: string, only_active: boolean): Markup {
        const dialogUrl =
            `/rabid.volunteer.searchDialog({text:${JSON.stringify(text)},only_active:${only_active}})`;
        return action.actionButton('Search', {kind: 'modal', dialogUrl},
                                   'btn btn-outline-primary btn-sm');
    }

    // The Volunteers section of the home/volunteers pages (a standin - these
    // will grow into structured summaries; search lives on its own page).
    renderSearchableVolunteers(): Markup {
        return [
            [h.div, {class: 'mb-2'}, this.searchButton('', true)],
            this.renderVolunteerList('', true),
        ];
    }

    // Hand-coded volunteer list, in the standard "navigable item list" markup
    // (mobile-first: a stacked list-group, not a column table).  Each item is a
    // whole-surface-tappable navigable surface (see Table.detailItemProps);
    // tapping anywhere drills in to the detail page, the pencil is the only
    // edit affordance.  Phone is deliberately NOT shown here - it is on the
    // detail page (keeps the list compact, and keeps the mostly-'***'
    // redacted column out of everyone's face).
    @route(authenticated)
    renderVolunteerList(text: string, only_active: boolean): Markup {
        const rows = this.searchVolunteers.all({text, only_active: only_active ? 1 : 0});
        const scopeLabel = only_active ? 'active ' : '';

        // Split into two lists: recently-active (a timesheet entry or event
        // check-in in the last 30 days) and everyone else - the long tail of
        // mostly-inactive volunteers shouldn't bury the people currently around.
        const active = activeVolunteerIdsWithin(30);
        const recent = rows.filter(v => active.has(v.volunteer_id));
        const others = rows.filter(v => !active.has(v.volunteer_id));
        const section = (title: string, list: Volunteer[]): Markup => list.length ? [
            [h.h3, {class: 'h6 text-muted mt-3 mb-1'}, title],
            [h.div, {class: 'list-group lm-list'}, list.map(v => this.renderVolunteerRow(v))],
        ] : undefined;

        return [
            [h.p, {class: 'text-muted small mb-2'},
             text ? `${rows.length} ${scopeLabel}volunteer(s) matching “${text}”`
                  : `${rows.length} ${scopeLabel}volunteer(s)`],
            section('Active — last 30 days', recent),
            section('Other volunteers', others),
        ];
    }

    // One list item: a single row species for every viewer (detailItemProps -
    // tap anywhere drills in to the detail page via the lm-nav-link name
    // link; chevron marks the navigation).  Permissions change what the row
    // OFFERS, never what tapping it does: viewers with row-level edit
    // permission (recordEdit) additionally get the pencil - the only edit
    // affordance.  Reloadable tagging re-renders just this item after a save.
    renderVolunteerRow(v: Volunteer): Markup {
        const id = v.volunteer_id;
        const f = this.fieldsByName;
        const inactiveBadge = v.inactive
            ? [h.span, {class: 'badge text-bg-secondary ms-2'}, 'Inactive'] : undefined;

        const item = this.detailItemProps(id, `rabid.volunteer.renderVolunteerRowById(${id})`);
        return [h.div, {...item, 'data-testid': `volunteer-row-${id}`},
            [h.div, {class: 'lm-item-body'},
             [h.div, {class: 'lm-item-primary'},
              [h.a, {...templates.pageLinkProps(`/rabid.volunteer.detailPage(${id})`),
                     class: 'lm-nav-link'}, v.name],
              inactiveBadge],
             [h.div, {class: 'lm-item-secondary', 'data-testid': `volunteer-${id}-email`},
              renderFieldValue(f.email, v.email)]],
            this.canEditRecord(v) ? this.editPencil(id) : undefined,
            navChevron(),
        ];
    }

    // Reload target for a single list row (after an edit save).
    @route(authenticated)
    renderVolunteerRowById(id: number): Markup {
        return this.renderVolunteerRow(this.getById(id));
    }

    // The search-parameter dialog, pre-populated with the current search so it
    // refines rather than restarts.  Submitting navigates (lmNavigateFormRoute
    // builds the route expression from the form: text fields as JSON-escaped
    // strings, checkboxes as booleans) - the result is the search PAGE.
    @route(authenticated)
    searchDialog(args: {text?: string, only_active?: boolean} = {}): Markup {
        const text = args.text ?? '';
        const only_active = args.only_active ?? true;
        return action.renderParamForm(
            [new StringField('text', {prompt: 'Name or email starts with…', nullable: true}),
             new CheckboxField('only_active', {prompt: 'Only active volunteers'})],
            {text, only_active},
            {
                title: 'Search volunteers',
                submitLabel: 'Search',
                dispatch: {onsubmit: "lmNavigateFormRoute(event, 'rabid.volunteer.search')"},
            });
    }

    // ------------------------------------------------------------------------
    // --- Volunteer detail page ----------------------------------------------
    // ------------------------------------------------------------------------

    // Full page for one volunteer (navigated to by clicking the name in the list):
    // contact info at the top.  Timesheet entries, committed tasks, etc. will be
    // added below later.
    @route(authenticated)
    detailPage(volunteer_id: number): templates.Page {
        const v = this.getById(volunteer_id);
        return templates.page(`${v.name} — Volunteer`, this.renderDetail(volunteer_id));
    }

    // The detail body, as a reloadable fragment (so an edit save re-renders it).
    @route(authenticated)
    renderDetail(volunteer_id: number): Markup {
        const v = this.getById(volunteer_id);
        const f = this.fieldsByName;
        const props = this.reloadableItemProps(volunteer_id, `rabid.volunteer.renderDetail(${volunteer_id})`);
        props.class = 'container py-3 ' + props.class;

        // Emergency contact is two redactable fields; if hidden, show one '***'.
        const emergencyHidden = security.isRedacted(v.emergency_contact_name);
        const emergency = emergencyHidden
            ? renderFieldValue(f.emergency_contact_name, v.emergency_contact_name)
            : ([v.emergency_contact_name, v.emergency_contact_phone].filter(Boolean).join(' · ') || '—');

        // Host-only tools (issuing a password-reset link is a host/admin act).
        const ctx = security.current();
        const viewerIsHost = !!ctx && (ctx.system === true
            || ctx.roles.has('host') || ctx.roles.has('admin'));

        return [h.div, props,
            [h.div, {class: 'd-flex align-items-center gap-2 mb-3'},
             [h.h2, {class: 'mb-0'}, v.name],
             v.inactive ? [h.span, {class: 'badge text-bg-secondary'}, 'Inactive'] : undefined,
             this.canEditRecord(v) ? this.editPencil(volunteer_id) : undefined,
             viewerIsHost
                 ? action.actionButton('Reset password',
                     {kind: 'modal', dialogUrl: `/rabid.resetLinkDialog(${volunteer_id})`},
                     'btn btn-outline-secondary btn-sm ms-auto')
                 : undefined],

            v.photo ? rabid.photo.img(v.photo, 512, {class: 'lm-photo-detail'}) : undefined,

            [h.dl, {class: 'row mb-0'},
             [h.dt, {class: 'col-sm-3'}, 'Email'],
             [h.dd, {class: 'col-sm-9', 'data-testid': 'detail-email'}, renderFieldValue(f.email, v.email) || '—'],
             [h.dt, {class: 'col-sm-3'}, 'Phone'],
             [h.dd, {class: 'col-sm-9', 'data-testid': 'detail-phone'}, renderFieldValue(f.phone, v.phone) || '—'],
             [h.dt, {class: 'col-sm-3'}, 'Skills'],
             [h.dd, {class: 'col-sm-9', 'data-testid': 'detail-skills'}, v.skills || '—'],
             [h.dt, {class: 'col-sm-3'}, 'Emergency contact'],
             [h.dd, {class: 'col-sm-9', 'data-testid': 'detail-emergency'}, emergency],
             [h.dt, {class: 'col-sm-3'}, 'Joined'],
             [h.dd, {class: 'col-sm-9'}, renderFieldValue(f.join_date, v.join_date) || '—'],
            ],

            [h.h4, {class: 'mt-4'}, 'Time'],
            rabid.volunteer_time.renderForVolunteer(volunteer_id),

            // TODO: committed tasks, etc.
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
// --- PasswordReset --------------------------------------------------------------
// --------------------------------------------------------------------------------

// Single-use, expiring password-reset tokens.  The row stores only the SHA-256
// of the token (the usable token appears exactly once, in the generated link),
// so a leaked db cannot be used to redeem outstanding resets.  Used rows are
// kept (used_time set) as a simple audit trail of who issued resets for whom.

export interface PasswordReset {
    password_reset_id: number;
    volunteer_id: number;
    reset_token_hash: string;
    created_time: sqldatetime;
    expires_time: sqldatetime;
    used_time?: sqldatetime;
    // The host/admin who generated the link (null for batch/import-generated).
    created_by_volunteer_id?: number;
}
export type PasswordResetOpt = Partial<PasswordReset>;

export class PasswordResetTable extends Table<PasswordReset> {

    constructor() {
        super('password_reset', [
            new PrimaryKeyField('password_reset_id', {}),
            new ForeignKeyField('volunteer_id', 'volunteer', 'volunteer_id', {indexed: true}),
            new SecretField('reset_token_hash', {}),
            new DateTimeField('created_time', {}),
            new DateTimeField('expires_time', {}),
            new DateTimeField('used_time', {nullable: true}),
            new ForeignKeyField('created_by_volunteer_id', 'volunteer', 'volunteer_id', {nullable: true}),
        ], [
            'CREATE UNIQUE INDEX IF NOT EXISTS password_reset_by_token_hash ON password_reset(reset_token_hash);'
        ])
    };

    @path
    get byTokenHash() {
        return this.prepare<PasswordReset, {reset_token_hash: string}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM password_reset
/**/          WHERE reset_token_hash = :reset_token_hash`);
    }

    // Setting a password consumes ALL of the volunteer's outstanding tokens
    // (not just the one used) - a stale link in an old text message shouldn't
    // still work after the volunteer has a working password.
    markAllUsedForVolunteer(volunteer_id: number, now: string): void {
        db().execute<{volunteer_id: number, now: string}>(block`
/**/   UPDATE password_reset
/**/          SET used_time = :now
/**/          WHERE volunteer_id = :volunteer_id AND used_time IS NULL`, {volunteer_id, now});
    }
}

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

    // Browser-test bridge (see liminal/browser-agent.ts).  Stamped only when this
    // session opts in as a test client.  Together they let the server pick "the"
    // test client deterministically (most-recent opt-in) and report whether it is
    // probably still alive (heartbeat freshness) - and, being in the row, they
    // survive a server restart.  Null on ordinary sessions.
    last_test_client_opt_in?: string;
    last_test_client_heartbeat?: string;
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
            new StringField('last_ip', {}),
            new DateTimeField('last_test_client_opt_in', {nullable: true}),
            new DateTimeField('last_test_client_heartbeat', {nullable: true}),
        ])
    };

    @path
    get getBySessionToken() {
        return this.prepare<VolunteerLoginSession, {session_token: string}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM volunteer_session
/**/          WHERE session_token = :session_token`);
    }

    // The current test client: whichever session opted in most recently.  We
    // always target the most-recent opt-in and never fall back to an older one,
    // even if it has gone silent - deterministic, no surprise of a command landing
    // in a stale tab.  Heartbeat is reported separately (freshness only).
    @path
    get mostRecentTestClient() {
        return this.prepare<VolunteerLoginSession, {}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM volunteer_session
/**/          WHERE last_test_client_opt_in IS NOT NULL
/**/          ORDER BY last_test_client_opt_in DESC
/**/          LIMIT 1`);
    }

    // Stamp opt-in (also stamps heartbeat - opting in is itself a sign of life).
    stampTestClientOptIn(session_token: string, now: string): void {
        db().execute<{session_token: string, now: string}>(block`
/**/   UPDATE volunteer_session
/**/          SET last_test_client_opt_in = :now, last_test_client_heartbeat = :now
/**/          WHERE session_token = :session_token`, {session_token, now});
    }

    // Stamp heartbeat (called on every poll - cheap, indexed update by token).
    stampTestClientHeartbeat(session_token: string, now: string): void {
        db().execute<{session_token: string, now: string}>(block`
/**/   UPDATE volunteer_session
/**/          SET last_test_client_heartbeat = :now
/**/          WHERE session_token = :session_token`, {session_token, now});
    }
}


