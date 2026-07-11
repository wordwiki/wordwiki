// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types

import * as utils from "../liminal/utils.ts";
import {unwrap} from "../liminal/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, sqldate, sqldatetime } from "../liminal/db.ts";
import * as date from "../liminal/date.ts";
import { Table, FieldSet, Field, PrimaryKeyField, ForeignKeyField, BooleanField, StringField, PhoneField, EmailField, SecretField, EnumField, IntegerField, FloatingPointField, DateTimeField, DateField, CheckboxField, ImageField, TableRenderer, TableView, reloadableItemProps, editButtonProps, renderFieldValue, navChevron, PublicViewable, type Tuple } from "../liminal/table.ts";
import {serializeAs, setSerialized, path} from "../liminal/serializable.ts";

import {block, plural} from "../liminal/strings.ts";
import {Markup, h} from "../liminal/markup.ts";
import {lazy} from '../liminal/lazy.ts';
import * as action from "../liminal/action.ts";
import * as templates from './templates.ts';
import * as volunteer_time from './volunteer_time.ts';
import {rabid} from './rabid.ts';
import * as security from "../liminal/security.ts";
import {route, routeMutation, authenticated} from "../liminal/security.ts";
import {activeVolunteerIdsWithin} from "./volunteer-activity.ts";

// 'host' is a volunteer trusted with a bit more visibility - hosts run events
// (e.g. volunteer nights) and are keyholders.  We deliberately use 'host' rather
// than 'staff': Red Raccoon is volunteer-run and volunteer-controlled, and we
// don't want elevated access framed as staff primacy.  'admin' (system control,
// e.g. managing roles) carries this visibility too.
const host = security.or(security.hasRole('host'), security.hasRole('admin'));
const admin = security.hasRole('admin');
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

export interface Volunteer {
    volunteer_id: number;

    // Will be null if date is unknown (because the volunteer pre-dates this system
    // and has not filled it out - for new volunteers, this will default to record
    // creation date).
    join_date?: string;
    
    name: string;

    // An optional shorter name for compact contexts (event sign-up lists, etc).
    // Usually just the first name; people add an initial only to disambiguate
    // duplicate first names ("David Z" while there was also a "David B").  When
    // blank, callers fall back to the first word of `name` (see shortName()).
    short_name: string;

    email: string;
    email_visible_to_all_volunteers: boolnum;
    phone: string;
    phone_number_visible_to_all_volunteers: boolnum;

    // Skills & interests to share: what they can do AND what they'd like to get
    // involved in (bike repair, event planning, fundraising, social media, ...).
    skills_and_interests: string;

    // Whether this person is currently employed as staff (as opposed to a
    // volunteer).  Distinct from pay: staff can volunteer and volunteers can be
    // paid.  Event check-ins snapshot this at check-in time for grant reporting,
    // so changing it here does not rewrite history.  Host/admin managed.
    is_staff: boolnum;

    // A small minority of volunteers (e.g. high-school community-service hours)
    // need their recorded hours vouched for: they enter time themselves, and a
    // host confirms it (see confirmed_by on timesheet_entry / event_checkin).
    // When set, the Time view shows confirmed/unconfirmed state and a host can
    // confirm.  Host/admin managed.
    volunteer_hours_need_confirmation: boolnum;

    // Optional photo: a content-store path ('content/photos/…' - see
    // liminal/photo.ts).  Volunteer-supplied by choice.
    photo?: string;


    emergency_contact_name: string;
    emergency_contact_phone: string;

    permissions: string;

    // Once a volunteer is archived, they will not show up in the common lists
    // etc. (their history is kept).  This is the manual roster on/off switch -
    // distinct from soft-`deleted`, and distinct from the 30-day "active"
    // convention (recently volunteered) used to order the lists.
    archived: boolnum;
    archived_date: string;

    /**
     * We disable volunteers rather than deleting them because they are
     * needed to do historical statistics queries.  Depending on policy and
     * situation, one may choose to change the volunteer, volunteername and
     * email to some anon string on semantic 'delete'.
     */
    deleted: boolnum;
}
export type VolunteerOpt = Partial<Volunteer>;

// shortName (compact display name) lives in its own dependency-free module so
// the import-cycle-sensitive volunteer-activity.ts can share it; re-exported here
// so existing `import {shortName} from "./volunteer.ts"` callers keep working.
export {shortName, memberShortName, type NamedVolunteer, type MemberName} from "./volunteer-name.ts";

// The volunteer-search page query (liminal.md § On-page view state): the view state that
// rides in the search page's route expression, as a `{}` argument.  One
// FieldSet declaration is the URL codec (normalize/literal), the
// auto-generated filter dialog (renderParamForm over its fields), and the
// typed query below.  `text` defaults to '' and `include_archived` to false,
// so the common view (current roster, no term) canonicalizes to the shortest
// URL `/rabid.volunteer.search({})`.
export const volunteerQuery = new FieldSet('volunteer_query', [
    new StringField('text', {prompt: 'Name or email starts with…', default: ''}),
    new CheckboxField('include_archived', {prompt: 'Include archived volunteers', default: false}),
]);
export interface VolunteerQuery extends Tuple {
    text: string;
    include_archived: boolean;
}

export class VolunteerTable extends Table<Volunteer> {
    
    constructor() {
        super ('volunteer', [
            new PrimaryKeyField('volunteer_id', {prompt: 'Id'}),
            // Field order is also the edit-form order: identity first, then
            // contact, then the incidentals (join_date was previously first,
            // burying Name in the dialog).
            new StringField('name', {indexed: true}),
            // Optional short name for compact lists; blank falls back to the
            // first word of `name` (see shortName()).
            new StringField('short_name', {default: '', prompt: 'Short name (optional)'}),
            new EmailField('email', {indexed: true, unique: true, view: emailViewable, redact: true}),
            // Volunteers may opt their email out of being shown to others (shared by default).
            new BooleanField('email_visible_to_all_volunteers', {default: 1}),
            new PhoneField('phone', {nullable: true, view: phoneViewable, redact: true}),
            // Volunteers may opt their phone in to being shown to others (private by default).
            new BooleanField('phone_number_visible_to_all_volunteers', {default: 0}),
            new StringField('skills_and_interests', {prompt: 'Skills & interests', default: ''}),
            // Employment status (host/admin managed) - snapshotted into event
            // check-ins for grant reporting.  See the interface field comment.
            new BooleanField('is_staff', {default: 0, prompt: 'Staff member', edit: host}),
            // Community-service hours etc: this person's time must be host-confirmed.
            // SENSITIVE - that someone needs confirmation reveals they're doing
            // community service (sometimes court-ordered).  Unlike the open-books
            // default, only the volunteer themselves and hosts may see it (hosts
            // manage it); to others it's redacted.  Mirrors the VIEW rule in
            // volunteer_time.canViewHoursConfirmation.
            new BooleanField('volunteer_hours_need_confirmation',
                             {default: 0, prompt: 'Hours need host confirmation',
                              view: selfOrHost, redact: true, edit: host}),
            // Optional photo (a content-store path - see liminal/photo.ts).
            // Uploading one is the volunteer's own choice: the point is to help
            // other volunteers on a shift learn each other's names.
            new ImageField('photo', 'rabid.photo',
                           {aspect: 'portrait', nullable: true,
                            prompt: 'Photo (optional — helps other volunteers learn your name)'}),
            // Day-granularity facts are DateFields (date picker, no time noise).
            new DateField('join_date', {nullable: true}),
            new StringField('emergency_contact_name', {default: '', view: selfOrHost, redact: true}),
            new StringField('emergency_contact_phone', {default: '', view: selfOrHost, redact: true}),
            new StringField('permissions', {nullable: true, edit: security.hasRole('admin')}),
            // Archive + soft-delete are never hand-edited in a form - they're
            // deliberate administrative acts driven by the ☰ menu on the detail page
            // (which also stamps archived_date), so the popup editor stays about the
            // volunteer's own details.  The columns remain (list filtering + badges).
            new BooleanField('archived', {default: 0, edit: security.never}),
            new DateField('archived_date', {nullable: true, edit: security.never}),
            new BooleanField('deleted', {default: 0, edit: security.never}),
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
/**/          WHERE deleted = 0 AND archived = 0
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
    // collects the volunteerQuery `{}` and applySearch navigates to
    //   /rabid.volunteer.search({text:"Dav"})
    // (the FieldSet builds the canonical URL server-side - see liminal.md § On-page view state),
    // so a search has a real URL - sharable, back-button-able, refresh-stable
    // - and both the page's own Search button and the dialog pre-populate from
    // the current search, making refinement natural.

    // Matches volunteers whose email starts with the term, or whose name has a
    // word starting with the term (the leading-space trick makes the term match
    // at the start of any word).  An empty term matches everyone in scope.
    // Case-insensitive via LIKE (pinned by PRAGMA case_sensitive_like=OFF at
    // connection open - ASCII folding only).
    @path
    get searchVolunteers() {
        return this.prepare<Volunteer, {text: string, include_archived: number}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM volunteer
/**/          WHERE deleted = 0
/**/            AND (:include_archived = 1 OR archived = 0)
/**/            AND ( email LIKE :text || '%'
/**/                  OR (' ' || name) LIKE '% ' || :text || '%' )
/**/          ORDER BY name`);
    }

    // The search results page.  Its view state (search text, archived toggle)
    // is a page-query `{}` argument carried in the route expression and
    // decoded by volunteerQuery - the ONE declaration that is the URL codec,
    // the auto-generated dialog, and the typed query (see liminal.md § On-page view state).
    // normalize() is the per-route guard: unknown keys rejected, each value
    // coerced by its field's type, absent/null → default (include_archived
    // defaults to false - the current roster is the common case).
    @route(authenticated)
    search(q?: Record<string, any>): templates.Page {
        const query = volunteerQuery.normalize(q) as VolunteerQuery;
        return templates.page('Volunteers — Search',
                              this.renderSearch(query.text, query.include_archived));
    }

    renderSearch(text: string, include_archived: boolean): Markup {
        // The ☰ (page-level actions: Add volunteer + the search quick-picks/dialog)
        // sits on the title, like the events page.
        return [h.div, {class: 'container py-3'},
            [h.div, {class: 'd-flex align-items-center gap-2 mb-2'},
             [h.h2, {class: 'mb-0'}, 'Volunteers'],
             this.searchMenu(text, include_archived)],
            this.renderVolunteerList(text, include_archived),
        ];
    }

    // The search menu: a quiet ☰ that sits next to the results line.  The
    // common "shaped" searches (current roster vs everyone, incl. archived)
    // navigate straight to the matching results page - one tap, no dialog;
    // "Search by name…" opens the full parameter dialog, pre-populated with the
    // CURRENT search so it refines rather than restarts.
    searchMenu(text: string, include_archived: boolean): Markup {
        // All URLs go through volunteerQuery.literal (never string-built), so
        // they are canonical - defaults omitted, equal views equal URLs.
        const searchUrl = (q: VolunteerQuery) =>
            `/rabid.volunteer.search(${volunteerQuery.literal(q)})`;
        // Creating a volunteer is host/admin-only (recordEdit on an empty record
        // resolves to `host`); shown as a quiet ☰ item, not a prominent button.
        const canCreate = this.canEditRecord({} as Volunteer);
        const items: action.ActionMenuItem[] = [];
        if(canCreate) {
            items.push({label: 'Add new volunteer…',
                        mode: {kind: 'modal', dialogUrl: '/rabid.volunteer.newDialog()'}});
            items.push('divider');
        }
        items.push(
            {label: 'Current volunteers',
             link: templates.pageLinkProps(searchUrl(volunteerQuery.normalize({include_archived: false}) as VolunteerQuery))},
            {label: 'All volunteers',
             link: templates.pageLinkProps(searchUrl(volunteerQuery.normalize({include_archived: true}) as VolunteerQuery))},
            'divider',
            {label: 'Search by name…',
             mode: {kind: 'modal',
                    dialogUrl: `/rabid.volunteer.searchDialog(${volunteerQuery.literal({text, include_archived})})`}});
        return action.actionMenu(items, {ariaLabel: 'Volunteer actions'});
    }

    // The create dialog: the record edit form over an empty record.  renderForm
    // gates on recordEdit (host for an empty record), so a non-host is refused
    // server-side too; the @route gate refuses first.
    @route(host)
    newDialog(): Markup {
        return this.renderForm({} as Volunteer);
    }

    // The top-level Volunteers page body (dispatched from the navbar's
    // /volunteers).  Mirrors renderEventsPage: a container with an h2 title
    // wrapping the standard searchable list.
    renderVolunteersPage(): Markup {
        return this.renderSearch('', false);
    }

    // The Volunteers section of the home/volunteers pages (a standin - these
    // will grow into structured summaries; search lives on its own page).
    renderSearchableVolunteers(): Markup {
        return this.renderVolunteerList('', false);
    }

    // Hand-coded volunteer list, in the standard "navigable item list" markup
    // (mobile-first: a stacked list-group, not a column table).  Each item is a
    // whole-surface-tappable navigable surface (see Table.detailItemProps);
    // tapping anywhere drills in to the detail page, the pencil is the only
    // edit affordance.  Phone is deliberately NOT shown here - it is on the
    // detail page (keeps the list compact, and keeps the mostly-'***'
    // redacted column out of everyone's face).
    @route(authenticated)
    renderVolunteerList(text: string, include_archived: boolean): Markup {
        const rows = this.searchVolunteers.all({text, include_archived: include_archived ? 1 : 0});
        const scopeLabel = include_archived ? '' : 'current ';

        // Split into two lists: recently-active (a timesheet entry or event
        // check-in in the last 30 days) and everyone else - the long tail of
        // not-recently-seen volunteers shouldn't bury the people currently around.
        // A more forgiving window than the quick-pickers' 30 days: this list
        // isn't trying to keep a picker short, so demoting someone to "other"
        // after only a month is hasty.
        const ACTIVE_WINDOW_DAYS = 60;
        const active = activeVolunteerIdsWithin(ACTIVE_WINDOW_DAYS);
        const recent = rows.filter(v => active.has(v.volunteer_id));
        const others = rows.filter(v => !active.has(v.volunteer_id));
        // A DATA TABLE, not flat sections (design-language.md): volunteers are
        // many uniform records (name + skills) you scan and compare, where
        // aligned columns read better.  Split into recently-active vs the long
        // tail via colspan section rows.
        const sectionHeading = (title: string): Markup =>
            [h.tr, {class: 'lm-data-section'}, [h.td, {colspan: '2'}, title]];
        // The active/inactive split only earns its headings when there IS a
        // recently-active group to set apart - otherwise (a quiet stretch, or a
        // dataset without activity) everyone is "other", and a lone "Other
        // volunteers" heading is just noise.  Then: plain, unlabelled list.
        const body = recent.length === 0
            ? rows.map(v => this.renderVolunteerRow(v))
            : [sectionHeading(`Active — last ${ACTIVE_WINDOW_DAYS} days`), recent.map(v => this.renderVolunteerRow(v)),
               others.length ? [sectionHeading('Other volunteers'), others.map(v => this.renderVolunteerRow(v))] : undefined];

        const countLabel = `${rows.length} ${scopeLabel}${plural(rows.length, 'volunteer')}`;
        // The ☰ (search + Add) sits on the page title (renderSearch), not here -
        // it's page-level actions, and consistent with the events page.  This
        // fragment shows just the results summary.
        return [
            [h.p, {class: 'text-muted small mb-2'},
             text ? `${countLabel} matching “${text}”` : countLabel],
            rows.length === 0
                ? [h.p, {class: 'text-muted'}, 'No volunteers.']
                : [h.table, {class: 'lm-data-table'},
                   [h.thead, {},
                    [h.tr, {},
                     [h.th, {}, 'Name'],
                     [h.th, {}, 'Skills & interests']]],
                   [h.tbody, {}, body]],
        ];
    }

    // A navigable data-table row: the whole row drills in to the detail page via
    // the accent-coloured name; no per-row pencil (edit whole-record fields from
    // the detail page).  Reloadable tagging (outerHTML swap of the <tr>)
    // re-renders just this row after a save.
    renderVolunteerRow(v: Volunteer): Markup {
        const id = v.volunteer_id;
        const f = this.fieldsByName;
        const archivedBadge = v.archived
            ? [h.span, {class: 'badge text-bg-secondary ms-2'}, 'Archived'] : undefined;

        const item = this.reloadableItemProps(id, `rabid.volunteer.renderVolunteerRowById(${id})`);
        item.class = 'lm-navigable ' + item.class;
        item.onclick = 'lmNavigableClick(event)';
        return [h.tr, {...item, 'data-testid': `volunteer-row-${id}`},
            [h.td, {},
             [h.a, {...templates.pageLinkProps(`/rabid.volunteer.detailPage(${id})`),
                    class: 'lm-nav-link'}, v.name],
             archivedBadge],
            // Skills & interests give the list some texture; email is on the
            // detail page (a click away - fine).
            [h.td, {class: 'text-muted', 'data-testid': `volunteer-${id}-skills`},
             renderFieldValue(f.skills_and_interests, v.skills_and_interests)],
        ];
    }

    // Reload target for a single list row (after an edit save).
    @route(authenticated)
    renderVolunteerRowById(id: number): Markup {
        return this.renderVolunteerRow(this.getById(id));
    }

    // The search-parameter dialog, pre-populated with the current search so it
    // refines rather than restarts.  The dialog IS the schema: its inputs are
    // volunteerQuery.fields, so adding a filter to the FieldSet adds it to the
    // URL, the dialog, and the typed query at once.  Submitting dispatches
    // applySearch (server-side form → canonical URL → navigate).
    @route(authenticated)
    searchDialog(q?: Record<string, any>): Markup {
        const query = volunteerQuery.normalize(q) as VolunteerQuery;
        return action.renderParamForm(
            volunteerQuery.fields, query,
            {
                title: 'Search volunteers',
                submitLabel: 'Search',
                dispatch: {onsubmit: 'event.preventDefault(); tx`rabid.volunteer.applySearch(${getFormJSON(event.target)})`'},
            });
    }

    // Filter-dialog postback → canonical search URL → real navigation (a
    // distinct filter is a distinct view; Back walks filter history).
    // parseFormValues reads the dialog's COMPLETE state (empty inputs fall to
    // defaults), then literal renders the shortest canonical URL.
    @route(authenticated)
    applySearch(form: Record<string, any>): any {
        const query = volunteerQuery.parseFormValues(form) as VolunteerQuery;
        return {action: 'navigate',
                url: `/rabid.volunteer.search(${volunteerQuery.literal(query)})`};
    }

    // ------------------------------------------------------------------------
    // --- Volunteer detail page ----------------------------------------------
    // ------------------------------------------------------------------------

    // Full page for one volunteer (navigated to by clicking the name in the list):
    // contact info at the top.  Timesheet entries, committed tasks, etc. will be
    // added below later.
    // `vt` is the Time-view section's page-query state (see
    // volunteer_time.timeViewQuery); threaded through so a bookmark/refresh of
    // an expanded Time view reproduces it.  Normalized where it's consumed
    // (renderForVolunteer), so the page just passes the literal along.
    // --- Administrative actions (the detail page's ☰ menu) --------------------
    // Archive / soft-delete are deliberate admin acts, not form edits.  Each is a
    // reload: updateNamedFields emits the volunteer's row key, and the detail fragment
    // watches it, so the badges + the menu's own labels refresh in place.

    @routeMutation(admin)
    archive(volunteer_id: number): Markup {
        // Stamp the archive date automatically (the whole reason this isn't a form edit).
        this.updateNamedFields(volunteer_id, ['archived', 'archived_date'],
            {archived: 1, archived_date: date.currentSqliteDate()} as Partial<Volunteer>);
        return {action: 'reload'} as unknown as Markup;
    }
    @routeMutation(admin)
    unarchive(volunteer_id: number): Markup {
        this.updateNamedFields(volunteer_id, ['archived', 'archived_date'],
            {archived: 0, archived_date: null} as unknown as Partial<Volunteer>);
        return {action: 'reload'} as unknown as Markup;
    }
    // Soft delete: disable (kept for historical stats), never erased.  Not named
    // `delete` - that's Table's hard-delete funnel.
    @routeMutation(admin)
    softDelete(volunteer_id: number): Markup {
        this.updateNamedFields(volunteer_id, ['deleted'], {deleted: 1} as Partial<Volunteer>);
        return {action: 'reload'} as unknown as Markup;
    }
    @routeMutation(admin)
    undelete(volunteer_id: number): Markup {
        this.updateNamedFields(volunteer_id, ['deleted'], {deleted: 0} as Partial<Volunteer>);
        return {action: 'reload'} as unknown as Markup;
    }

    // The detail page's ☰: the less-common actions (edit stays a pencil, per the
    // app-wide convention; photo + reset also have their own affordances but live here
    // too).  Items appear by permission + state; undefined when the viewer has none.
    private volunteerActionMenu(v: Volunteer, viewerIsHost: boolean, viewerIsAdmin: boolean): Markup {
        const id = v.volunteer_id;
        const items: action.ActionMenuItem[] = [];
        if(this.canEditRecord(v))
            items.push({label: v.photo ? 'Edit photo…' : 'Add photo…',
                mode: {kind: 'modal', dialogUrl: `/rabid.volunteer.renderPhotoEditForm(${id},"photo")`}});
        if(viewerIsHost)
            items.push({label: 'Reset password…',
                mode: {kind: 'modal', dialogUrl: `/rabid.resetLinkDialog(${id})`}});
        if(viewerIsAdmin) {
            items.push(v.archived
                ? {label: 'Unarchive', mode: {kind: 'confirm',
                    message: `Return ${v.name} to the active roster?`, expr: `rabid.volunteer.unarchive(${id})`}}
                : {label: 'Archive', mode: {kind: 'confirm',
                    message: `Archive ${v.name}? They leave the current roster; their history is kept.`,
                    expr: `rabid.volunteer.archive(${id})`}});
            items.push(v.deleted
                ? {label: 'Restore', mode: {kind: 'confirm',
                    message: `Restore ${v.name} to active?`, expr: `rabid.volunteer.undelete(${id})`}}
                : {label: 'Delete', mode: {kind: 'confirm',
                    message: `Delete ${v.name}? They are disabled and hidden from lists - kept for history, not erased.`,
                    expr: `rabid.volunteer.softDelete(${id})`}});
        }
        return items.length ? action.actionMenu(items, {ariaLabel: `${v.name} actions`}) : undefined as unknown as Markup;
    }

    @route(authenticated)
    detailPage(volunteer_id: number, vt?: Record<string, any>): templates.Page {
        const v = this.getById(volunteer_id);
        return templates.page(`${v.name} — Volunteer`, this.renderDetail(volunteer_id, vt));
    }

    // The detail body, as a reloadable fragment (so an edit save re-renders it).
    // The fragment's reload URL carries `vt` so a detail reload (a record edit)
    // preserves the embedded Time view's current expansion.
    @route(authenticated)
    renderDetail(volunteer_id: number, vt?: Record<string, any>): Markup {
        const v = this.getById(volunteer_id);
        const f = this.fieldsByName;
        const vtLiteral = volunteer_time.timeViewQuery.literal(
            volunteer_time.timeViewQuery.normalize(vt));
        const props = this.reloadableItemProps(volunteer_id,
            `rabid.volunteer.renderDetail(${volunteer_id},${vtLiteral})`);
        props.class = 'container py-3 ' + props.class;

        // Empty fields are ELIDED (no "Label: —" rows) - even on your own
        // profile - so the card shows only what's actually filled in.  A REDACTED
        // value ('***') is kept: it deliberately signals a value exists but is
        // private (the open-books model), which is information, not emptiness.
        const dtdd = (label: string, valueMarkup: Markup, testid?: string): Markup =>
            [[h.dt, {class: 'col-sm-3'}, label],
             [h.dd, {class: 'col-sm-9', ...(testid ? {'data-testid': testid} : {})}, valueMarkup]];
        const fieldRow = (label: string, fld: Field, value: any, testid?: string): Markup => {
            if (!security.isRedacted(value) && (value == null || String(value).trim() === ''))
                return undefined;   // elide empty (but never an existing-but-private '***')
            return dtdd(label, renderFieldValue(fld, value), testid);
        };

        // Emergency contact is two redactable fields shown as one row: '***' when
        // hidden, the combined value when present, elided when truly empty.
        const emergencyRow: Markup = security.isRedacted(v.emergency_contact_name)
            ? dtdd('Emergency contact',
                   renderFieldValue(f.emergency_contact_name, v.emergency_contact_name), 'detail-emergency')
            : (() => {
                const combined = [v.emergency_contact_name, v.emergency_contact_phone].filter(Boolean).join(' · ');
                return combined ? dtdd('Emergency contact', combined, 'detail-emergency') : undefined;
              })();

        // Viewer roles: reset-password is a host/admin act; archive/delete are admin.
        const ctx = security.current();
        const viewerIsHost = !!ctx && (ctx.system === true
            || ctx.roles.has('host') || ctx.roles.has('admin'));
        const viewerIsAdmin = !!ctx && (ctx.system === true || ctx.roles.has('admin'));

        return [h.div, props,
            [h.div, {class: 'd-flex align-items-center gap-2 mb-3'},
             [h.h2, {class: 'mb-0'}, v.name],
             v.archived ? [h.span, {class: 'badge text-bg-secondary'}, 'Archived'] : undefined,
             v.deleted ? [h.span, {class: 'badge text-bg-danger'}, 'Deleted'] : undefined,
             // Edit stays a pencil (the app-wide "edit this" affordance).
             this.canEditRecord(v) ? this.editPencil(volunteer_id) : undefined,
             // A standalone Add/Edit Photo button, kept prominent to ENCOURAGE photos
             // (it's also in the ☰).
             this.photoButton(volunteer_id, 'photo'),
             // The ☰: reset password + archive/delete (and photo), pushed to the right.
             [h.span, {class: 'ms-auto'}, this.volunteerActionMenu(v, viewerIsHost, viewerIsAdmin)]],

            v.photo ? rabid.photo.aspectImg(v.photo, 'portrait', 'detail', {class: 'lm-photo-detail'}) : undefined,

            [h.dl, {class: 'row mb-0'},
             fieldRow('Email', f.email, v.email, 'detail-email'),
             fieldRow('Phone', f.phone, v.phone, 'detail-phone'),
             fieldRow('Skills & interests', f.skills_and_interests, v.skills_and_interests, 'detail-skills_and_interests'),
             emergencyRow,
             fieldRow('Joined', f.join_date, v.join_date),
            ],

            [h.h4, {class: 'mt-4'}, 'Time'],
            rabid.volunteer_time.renderForVolunteer(volunteer_id, vt),

            // The volunteer's own 1-1 project: personal tasks, created lazily on
            // the first add (self-or-host editable, via the owner delegation).
            [h.div, {class: 'mt-4'},
             rabid.task.renderOwnerTasks('volunteer', volunteer_id)],
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


