// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types

import * as utils from "../liminal/utils.ts";
import {unwrap} from "../liminal/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "../liminal/db.ts";
import * as date from "../liminal/date.ts";
import { Table, TableView, TableRenderer, Field, FieldSet, PrimaryKeyField, ForeignKeyField, BooleanField, StringField, MarkdownField, EnumField, DateField, CheckboxField, IntegerField, FloatingPointField, DateTimeField, ImageField, navChevron, pencilIcon, reloadableProps, liveReloadableProps, sel, type Tuple } from "../liminal/table.ts";
import * as dirty from "../liminal/dirty.ts";
import { VolunteerForeignKeyField, activeVolunteersWithin } from "./volunteer-activity.ts";
import { shortName, memberShortName, type MemberName } from "./volunteer.ts";
import {block, plural} from "../liminal/strings.ts";
import {serializeAs, setSerialized, path} from "../liminal/serializable.ts";
import { faker } from "@faker-js/faker";
import {Markup, h} from "../liminal/markup.ts";
import * as security from "../liminal/security.ts";
import {route, routeMutation, authenticated, selfArg} from "../liminal/security.ts";   // hostOrAdmin is defined locally below
import * as templates from './templates.ts';
import * as pageQueries from './page-queries.ts';
import * as action from "../liminal/action.ts";
import * as orderkey from "../liminal/orderkey.ts";
import {rabid} from './rabid.ts';

export const routes = ()=> ({
});

// --------------------------------------------------------------------------------
// --- Event ----------------------------------------------------------------------
// --------------------------------------------------------------------------------

// Hosts run events: only hosts/admins edit event records.  (Volunteers
// participate via commitments, not by editing the event.)
const hostOrAdmin = security.or(security.hasRole('host'), security.hasRole('admin'));

// A volunteer manages their own event check-ins (self-signup, retroactive
// check-in); hosts/admins manage anyone's (e.g. checking everyone in at once).
const checkinSelfOrHost = security.or(security.isSelf, hostOrAdmin);

export const event_kind_enum: Record<string, string> = {
    'public': 'Public Event',
    'training': 'Volunteer Training',
    'trainingCourse': 'Training Course',
    'shopTime': 'Shop Time',
};

// The shared events-filter TYPE - used for BOTH the upcoming and past filters
// (same fields, dialog, and apply code): a date window (from/to, nullable ->
// resolved per context) + "include volunteers-only events" (default off, so both
// sections default to the public-facing view).  A DEFAULT-OFF checkbox on
// purpose: an unchecked box submits nothing, so a default-ON "public only" could
// never be turned off through the form.  The only per-context difference is the
// window direction (see resolveUpcomingWindow vs page-queries.resolveWindow).
export function eventFilterQuery(name: string): FieldSet {
    return new FieldSet(name, [
        new DateField('from', {prompt: 'From', nullable: true}),
        new DateField('to', {prompt: 'To', nullable: true}),
        // Default CHECKED - the intuitive framing where checking a filter NARROWS
        // the result set.  (A default-checked box can now be turned off through
        // the form: an unchecked box posts nothing, and CheckboxField reads that
        // absence as false rather than the default - see table.ts.)  The default
        // view is away events (volunteers commit to those, not in-shop), public.
        new CheckboxField('away_only', {prompt: 'Away events only', default: true}),
        new CheckboxField('public_only', {prompt: 'Public events only', default: true}),
    ]);
}
export interface EventFilter extends Tuple {
    from: string | null;
    to: string | null;
    away_only: boolean;
    public_only: boolean;
}
// The upcoming window: now → +1 month by default (a forward window, vs the
// past filter's backward resolveWindow).
export function resolveUpcomingWindow(q: EventFilter): pageQueries.ResolvedWindow {
    const today = date.orgToday();
    return {
        from: q.from ?? date.temporalToSqliteDate(today),
        to: q.to ?? date.temporalToSqliteDate(today.add({months: 1})),
    };
}

export interface Event {
    event_id: number;
    event_kind: string;
    description: string;

    location_description: string;
    location_url: string;
    // Should be set to true for events that are not held at our shop
    is_remote_event: boolnum;

    volunteer_only: boolnum;

    // The volunteer running this event (usually one).  A single FK, not a
    // sign-up-style list - much less machinery; edited via the event form's
    // volunteer picker.
    host_id?: number;

    // A per-day "Ad-hoc" catch-all event: the bucket for activity (services,
    // sales) that wasn't part of any scheduled event.  is_catch_all flags it;
    // catch_all_date is its SOLE day encoding (a catch-all has NULL start/end
    // times - it's not clock-bounded) and is 1-1 per calendar day.
    is_catch_all: boolnum;
    catch_all_date?: string;

    shop_load_time?: string;
    setup_time?: string;

    start_time?: string;
    end_time?: string;

    total_cash_collected: number;

    notes: string;

    // Photos live in the generic gallery (gallery.ts), attached to this event.
}

export type EventOpt = Partial<Event>;

export class EventTable extends Table<Event> {
    
    constructor() {
        super ('event', [
            new PrimaryKeyField('event_id', {}),
            new EnumField('event_kind', event_kind_enum, {}),
            new StringField('description', {}),
            // Optional (default '') - without the default these render as
            // REQUIRED inputs, and a host editing an event with no location
            // URL could never save (the browser silently blocks the submit).
            new StringField('location_description', {default: ''}),
            new StringField('location_url', {default: ''}),
            new BooleanField('is_remote_event', {default: 0}),
            new BooleanField('volunteer_only', {default: 0}),
            new VolunteerForeignKeyField('host_id', {nullable: true, indexed: true, prompt: 'Host'}),
            new BooleanField('is_catch_all', {default: 0}),
            new DateField('catch_all_date', {nullable: true}),
            new DateTimeField('shop_load_time', {nullable: true}),
            new DateTimeField('setup_time', {nullable: true}),
            new DateTimeField('start_time', {nullable: true}),
            new DateTimeField('end_time', {nullable: true}),
            new FloatingPointField('total_cash_collected', {default: 0}),
            new MarkdownField('notes', {default: ''}),
            // Photos live in the generic gallery (gallery.ts), not fields here.
        ],[
            'CREATE INDEX IF NOT EXISTS event_by_start_time ON event(start_time);',
            // At most one catch-all ("Ad-hoc") event per calendar day.  NULLs are
            // distinct in SQLite, so normal events (catch_all_date IS NULL) are
            // unconstrained; this closes the catchAllForDate check-then-create race.
            'CREATE UNIQUE INDEX IF NOT EXISTS event_catch_all_by_date ON event(catch_all_date) WHERE catch_all_date IS NOT NULL;',
        ])
    };

    // All fields stay viewable (events are org-public information); editing is
    // host/admin only, at both the field and row level.  recordEdit drives the
    // two row species in the standard list below.
    defaultFieldEdit: security.Permission = hostOrAdmin;
    override get recordEdit(): security.Permission { return hostOrAdmin; }

    // Edit-dialog title: the event has no 'name' column, so the base default
    // would say just "Edit event" - say which one.
    override formTitle(e: Event): string {
        return `Edit ${e.description || 'event'}`;
    }

    // Events label by description (no 'name'/'title' column) - so an owned
    // project's derived name resolves to the event's description.
    override recordLabel(e: Event): string {
        // A catch-all carries no description; it labels by its day so it reads
        // sensibly as a service/sale's parent link and on its own page.
        if(e.is_catch_all && e.catch_all_date)
            return `Ad-hoc — ${date.sqliteDateToString(e.catch_all_date, '', {month: 'short', day: 'numeric'})}`;
        return e.description || `event ${e.event_id}`;
    }

    @path
    get allEvents() {
        return db().prepare<Event, {}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM event
/**/          ORDER BY start_time`);
    }


    @path
    get upcomingEvents() {
        return db().prepare<Event, {start_time: string}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM event
/**/          WHERE event.start_time >= start_time
/**/          ORDER BY start_time`);
    }

    // The per-day catch-all ("Ad-hoc") event, found by its day.  At most one per
    // day (partial unique index); `create` materializes it lazily - the only way
    // a catch-all comes into being (mirrors project.forOwner).  `IS :day` matches
    // the day; normal events (catch_all_date NULL) never match.
    @path
    get catchAllByDate() {
        return this.prepare<Event, {day: string}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM event
/**/          WHERE catch_all_date IS :day
/**/          LIMIT 1`);
    }
    catchAllForDate(day: string, create = false): number | undefined {
        const existing = security.runSystem(() => this.catchAllByDate.first({day}));
        if(existing) return existing.event_id;
        if(!create) return undefined;
        // NULL start/end times on purpose: a catch-all is not clock-bounded, so it
        // can never be "concurrent with" a timesheet range and never lands in a
        // dated schedule row.  The day is carried solely by catch_all_date.
        return this.insert({
            is_catch_all: 1, catch_all_date: day,
            event_kind: 'shopTime', description: ''} as Partial<Event>);
    }
    // "Today" always resolves in org wall-clock time (a UTC clock would shift the
    // day boundary by the server's zone).
    catchAllForToday(create = false): number | undefined {
        return this.catchAllForDate(date.temporalToSqliteDate(date.orgToday()), create);
    }

    @path
    get tableRenderer(): TableRenderer<Event> {
        return new TableRenderer(this, this.fields);
    }

    @path
    get tableView(): TableView<Event> {
        return new TableView<Event>(this.tableRenderer, this.allEvents.closure());
    }

    // ------------------------------------------------------------------------
    // --- Standard editable-item list (same model as the volunteer list) -----
    // ------------------------------------------------------------------------
    //
    // Two self-describing row species by recordEdit: hosts get the editable
    // surface (pencil, whole row opens the edit dialog, description links to
    // the detail page); everyone else gets a navigable item (chevron, whole
    // row IS the detail-page link).

    renderEventList(events: Event[]): Markup {
        return [h.div, {class: 'list-group lm-list'},
                events.map(e => this.renderEventRow(e))];
    }

    // The top-level Events page body (dispatched from the navbar's /events): the
    // same week-grouped, phase-aware schedule table the home page uses, over ALL
    // events - ordered UPCOMING FIRST (soonest first), THEN started events most-
    // recent first, so you land on what's coming and history is below.
    // Upcoming (and undated) events always show — they're the bounded, forward-
    // looking part.  PAST events are the unbounded, ever-growing part, so they
    // get a date window (page-state; liminal.md § On-page view state): the last
    // 120 days by default, with Show older / a Filter to widen.
    // One shared filter type, two independent parameters: the events route is
    // events(upcoming, past), each decoded by the SAME eventFilter, so editing
    // one never disturbs the other while they share fields/dialog/apply code.
    // Both default to public-only (include_volunteer_only off); only the window
    // DIRECTION differs (upcoming: next month; past: last 120 days).
    static readonly eventFilter = eventFilterQuery('events_filter');

    renderEventsPage(up?: Record<string, any>, past?: Record<string, any>): Markup {
        const upQ = EventTable.eventFilter.normalize(up) as EventFilter;
        const pastQ = EventTable.eventFilter.normalize(past) as EventFilter;
        const upW = resolveUpcomingWindow(upQ);
        const pastW = pageQueries.resolveWindow(pastQ);
        const now = date.temporalToSqliteDateTime(date.orgNow());
        const all = this.allEvents.all();                                  // ascending by start_time
        const inRange = (e: Event, from: string, to: string) => {
            const d = (e.start_time as string).slice(0, 10);
            return d >= from && d <= to;
        };
        // Away events only (is_remote_event) + public only by default; unchecking
        // either widens.  Volunteers commit to away events, not in-shop ones.
        // Catch-alls ("Ad-hoc" day buckets) are never listed here: they aren't
        // scheduled events, only activity buckets reached via Today's Ad-hoc / a
        // service's parent link.  (Their NULL start_time already keeps them out of
        // future/past; this also keeps them out of the undated section.)
        const matches = (e: Event, q: EventFilter) =>
            !e.is_catch_all
            && (!q.public_only || !e.volunteer_only)
            && (!q.away_only || !!e.is_remote_event);
        // "Now": events happening around this moment (see isNowEvent) - they get
        // their own top section and are lifted OUT of Upcoming/Past so they appear
        // once.  Unlike Upcoming, Now ignores the away/public filter (you want to
        // see whatever is happening, in-shop or not).
        const nowEvents = all.filter(e => this.isNowEvent(e));
        const nowIds = new Set(nowEvents.map(e => e.event_id));
        const future = all.filter(e => e.start_time && e.start_time > now && !nowIds.has(e.event_id)
                                       && inRange(e, upW.from, upW.to) && matches(e, upQ));
        const undated = all.filter(e => !e.start_time && matches(e, upQ));   // TBD: window N/A
        const pastEvents = all.filter(e => e.start_time && e.start_time <= now && !nowIds.has(e.event_id)
                                     && inRange(e, pastW.from, pastW.to) && matches(e, pastQ))
            .reverse();                                                       // most recent first
        const upcoming = [...future, ...undated];

        // The PAGE ☰ (on the title) is reserved for adding events; each section's
        // filter editor is a ☰ on its own summary line (renderSummaryMenu).
        const pageMenu: action.ActionMenuItem[] = [];
        if(this.canEditRecord({} as Event))
            pageMenu.push({label: 'Add event…',
                           mode: {kind: 'modal', dialogUrl: '/rabid.event.newDialog()'}});
        // Summarise the active restrictions, like the volunteer list / the past
        // window bar: the default view is "away only · public only".
        const condition = (q: EventFilter) => [
            q.away_only ? 'away only' : undefined,
            q.public_only ? 'public only' : undefined,
        ].filter(Boolean).join(' · ') || 'all events';
        const upSummary = `${upcoming.length} upcoming ${plural(upcoming.length, 'event')} · `
            + `${date.sqliteDateToString(upW.from)} – ${date.sqliteDateToString(upW.to)}`
            + ` · ${condition(upQ)}`;
        const upMenu: action.ActionMenuItem[] = [{label: 'Filter…',
            mode: {kind: 'modal',
                   dialogUrl: `/rabid.event.upcomingFilterDialog(${EventTable.eventFilter.literal(upQ)}, ${EventTable.eventFilter.literal(pastQ)})`}}];
        // Slash-separated jump-nav (like the event detail page): Now (only when
        // there is one) / Upcoming / Past.
        const navLinks: [string, string][] = [
            ...(nowEvents.length ? [['now', 'Now'] as [string, string]] : []),
            ['upcoming', 'Upcoming'], ['past', 'Past'],
        ];
        return [h.div, {class: 'container py-3'},
            [h.div, {class: 'd-flex align-items-center gap-2 mb-2'},
             [h.h2, {class: 'mb-0'}, 'Events'],
             pageMenu.length ? action.actionMenu(pageMenu, {ariaLabel: 'Event actions'}) : undefined],
            [h.nav, {class: 'lm-section-nav small mb-3 pb-2 border-bottom', 'aria-label': 'Sections'},
             ...navLinks.flatMap(([id, label], i) => [
                 i > 0 ? [h.span, {class: 'text-muted mx-2'}, '/'] : undefined,
                 [h.a, {href: '#' + id, class: 'link-secondary text-decoration-none'}, label]])],
            // The Now section - omitted entirely (heading included) when empty.
            nowEvents.length
                ? [h.div, {},
                   [h.h4, {id: 'now', class: 'mt-4 mb-1'}, 'Now'],
                   this.renderNowEvents(nowEvents)]
                : undefined,
            [h.h4, {id: 'upcoming', class: 'mt-4 mb-1'}, 'Upcoming events'],
            pageQueries.renderSummaryMenu(upSummary, upMenu, 'upcoming-bar'),
            upcoming.length > 0
                ? this.renderEventScheduleTable(upcoming)
                : [h.p, {class: 'text-muted'}, 'No upcoming events in this range.'],
            [h.h4, {id: 'past', class: 'mt-4 mb-1'}, 'Past events'],
            pageQueries.renderWindowBar({
                fieldSet: EventTable.eventFilter, pageRoute: 'events',
                filterDialogRoute: 'rabid.event.pastFilterDialog',
                otherArgs: EventTable.eventFilter.literal(upQ),
                conditionText: condition(pastQ),
                q: pastQ, count: pastEvents.length, noun: 'past event'}),
            pastEvents.length > 0
                ? this.renderEventScheduleTable(pastEvents)
                : [h.p, {class: 'text-muted'}, 'No past events in this range.'],
        ];
    }

    // The create dialog: the record form over an empty event (renderForm/@route
    // both gate on recordEdit = hostOrAdmin).
    @route(hostOrAdmin)
    newDialog(): Markup {
        return this.renderForm({} as Event);
    }

    // The two filter dialogs + applies share renderFilterDialog / applyFilterNavigate;
    // each carries the sibling filter's literal so it's preserved.
    @route(authenticated)
    upcomingFilterDialog(up?: Record<string, any>, past?: Record<string, any>): Markup {
        return pageQueries.renderFilterDialog(
            EventTable.eventFilter, EventTable.eventFilter.normalize(up),
            'rabid.event.applyUpcomingFilter',
            {title: 'Filter upcoming events',
             applyArgsAfter: EventTable.eventFilter.literal(EventTable.eventFilter.normalize(past))});
    }
    @route(authenticated)
    applyUpcomingFilter(form: Record<string, any>, past?: Record<string, any>): any {
        return pageQueries.applyFilterNavigate(EventTable.eventFilter, form, 'events',
            {after: EventTable.eventFilter.literal(EventTable.eventFilter.normalize(past))});
    }
    @route(authenticated)
    pastFilterDialog(up?: Record<string, any>, past?: Record<string, any>): Markup {
        return pageQueries.renderFilterDialog(
            EventTable.eventFilter, EventTable.eventFilter.normalize(past),
            'rabid.event.applyPastFilter',
            {title: 'Filter past events',
             applyArgsBefore: EventTable.eventFilter.literal(EventTable.eventFilter.normalize(up))});
    }
    @route(authenticated)
    applyPastFilter(up: Record<string, any>, form: Record<string, any>): any {
        return pageQueries.applyFilterNavigate(EventTable.eventFilter, form, 'events',
            {before: EventTable.eventFilter.literal(EventTable.eventFilter.normalize(up))});
    }

    // "Sat, Jun 13, 2026, 7:00 PM - 9:30 PM" (year included: unlike the
    // upcoming-events cards, a full list spans years).
    timeRangeText(e: Event): string {
        if(!e.start_time) return '';
        let s = date.sqliteDateTimeToString(e.start_time, '', {
            weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
            hour: 'numeric', minute: '2-digit', hour12: true});
        if(e.end_time)
            s += ` - ${date.sqliteDateTimeToTimeString(e.end_time)}`;
        return s;
    }

    // Quiet metadata tags: only the EXCEPTIONAL facts.  'public' is the default
    // kind, so it gets no badge (an unbadged event is public) - that removes the
    // green-on-every-row noise; only Training/Shop Time and the volunteers-only
    // flag show.  'Remote' is NOT a badge: it rides the location line instead
    // (see remoteText) - non-remote events are at our shop and need no location.
    eventBadges(e: Event): Markup {
        return [
            e.event_kind && e.event_kind !== 'public'
                ? [h.span, {class: `card-badge event-${e.event_kind}`},
                   event_kind_enum[e.event_kind] ?? e.event_kind]
                : undefined,
            e.volunteer_only ? [h.span, {class: 'volunteer-only-badge'}, 'Volunteers only'] : undefined,
        ];
    }

    // The location line, shown ONLY for remote events (non-remote are at our
    // shop, so a location is noise).  This line also carries the "Remote" signal,
    // which is why there's no separate Remote badge.  '' for at-shop events.
    remoteText(e: Event): string {
        if (!e.is_remote_event) return '';
        return e.location_description ? `Remote · ${e.location_description}` : 'Remote';
    }

    renderEventRow(e: Event): Markup {
        const id = e.event_id;
        const secondary = [this.timeRangeText(e), this.remoteText(e)].filter(Boolean).join(' · ');

        // One navigable row species for every viewer (Table.detailItemProps:
        // tap anywhere drills in via the lm-nav-link title); the pencil - shown
        // only to viewers with recordEdit - is the only edit affordance.
        const item = this.detailItemProps(id, `rabid.event.renderEventRowById(${id})`);
        return [h.div, {...item, 'data-testid': `event-row-${id}`},
            [h.div, {class: 'lm-item-body'},
             [h.div, {class: 'lm-item-primary'},
              [h.a, {...templates.pageLinkProps(`/rabid.event.detailPage(${id})`),
                     class: 'lm-nav-link'}, e.description || 'Untitled Event'],
              this.eventBadges(e)],
             [h.div, {class: 'lm-item-secondary'}, secondary]],
            this.canEditRecord(e) ? this.editPencil(id) : undefined,
            navChevron(),
        ];
    }

    // Reload target for a single list row (after an edit save).
    @route(authenticated)
    renderEventRowById(id: number): Markup {
        return this.renderEventRow(this.getById(id));
    }

    // ------------------------------------------------------------------------
    // --- Event detail page ---------------------------------------------------
    // ------------------------------------------------------------------------

    // The navigable destination for list rows: the summary card (time,
    // location, committed volunteers) under a header with the host-only pencil.
    @route(authenticated)
    detailPage(event_id: number): templates.Page {
        const e = this.getById(event_id);
        return templates.page(`${e.description || 'Event'} — Event`, this.renderEventDetail(event_id));
    }

    // The event page.  The OUTER is a plain container that never reloads as a whole;
    // each part below is its own fragment keyed on the data it shows, so an event
    // edit reloads only the header (title + summary), a service change only the
    // Services section, etc. - not the whole page.
    @route(authenticated)
    renderEventDetail(event_id: number): Markup {
        const e = this.getById(event_id);
        return [h.div, {class: 'container py-3'},
            // Title + jump-nav + summary, keyed on the event row - an event edit
            // reloads just this.
            this.renderEventHeader(event_id),
            // "Volunteers": the checked-in face grid (match faces to names on a busy
            // shift) - first, before the activity log.  The summary's Checked-in row
            // is elided above (hideCheckins) in favour of this.  Not on a catch-all.
            e.is_catch_all ? undefined : rabid.event_checkin.renderCheckinGrid(event_id),
            // The log: services + sales recorded at this event (the heart of the
            // event-centric model; on a catch-all it is essentially the whole page).
            this.renderEventActivity(event_id),
            // The event's own 1-1 project: tasks to do for this event, created
            // lazily on the first add.  docHeading -> a peer document-section
            // heading like the checklists below.  Wrapped in a stable #tasks anchor.
            [h.div, {id: 'tasks'},
             rabid.task.renderOwnerTasks('event', event_id, null, /*docHeading*/ true),
             // Checklists instantiated from templates (setup/cleanup), each a
             // document section; adding a new one is the ☰ above.
             rabid.task.renderOwnerChecklists('event', event_id)],
            // Photos: the generic gallery (gallery.ts), attached to this event.
            rabid.gallery_photo.renderGallery('event', event_id),
            // Service Record Sheets: a SECOND gallery on the event (scope) holding
            // photos of the paper service-record clipboard sheets - the durable
            // capture that a later scan/extract turns into service rows (scan-extract.md).
            e.is_catch_all ? undefined
                : rabid.gallery_photo.renderGallery('event', event_id, 'service-sheets', 'Service Record Sheets'),
            // Retrospectives: volunteer feedback on how the event went (markdown,
            // optionally anonymous) - the last section, below everything.
            this.renderEventRetrospectives(event_id),
            // A modest tail spacer so the lower jump-links can scroll their section
            // near the top even when little content follows.  Half a viewport - a
            // mild, common technique; tune/remove freely.
            [h.div, {'aria-hidden': 'true', style: 'min-height: 50vh'}],
        ];
    }

    // The event's header: title (with the Edit pencil + ☰), the jump-nav, and the
    // summary.  Its OWN fragment keyed on the event row, so an event edit reloads
    // just this - the title (e.g. a changed description) and the summary fields -
    // and not the whole page.
    @route(authenticated)
    renderEventHeader(event_id: number): Markup {
        const e = this.getById(event_id);
        const props = this.reloadableItemProps(event_id, `rabid.event.renderEventHeader(${event_id})`);
        const editUrl = `/rabid.event.renderForm(rabid.event.getById(${event_id}))`;
        const canEdit = this.canEditRecord(e);
        return [h.div, props,
            // Editing the event lives on the TITLE row - a pencil AND a ☰ (both, for
            // obviousness; the ☰ leaves room for Archive/etc. later).  With the
            // summary de-carded (bare) below, the details flow right under this.
            [h.div, {class: 'd-flex align-items-center gap-2 mb-3'},
             [h.h2, {class: 'mb-0'}, this.recordLabel(e)],
             canEdit
                 ? action.actionButton(pencilIcon(), {kind: 'modal', dialogUrl: editUrl},
                     'btn btn-link p-0 lm-edit-pencil', {'aria-label': 'Edit event', title: 'Edit event'})
                 : undefined,
             canEdit
                 ? action.actionMenu([{label: 'Edit event…', mode: {kind: 'modal', dialogUrl: editUrl}}],
                     {ariaLabel: 'Event actions'})
                 : undefined],
            this.renderSectionNav(),
            // De-carded (bare): flows directly under the title.  No repeated title
            // (the h2 above IS it); notes live inside it now.
            this.renderEventSummary(event_id, {titleLink: false, hideTitle: true,
                                               editableCheckins: true, hideNotes: false,
                                               bare: true, hideCheckins: true}),
        ];
    }

    // The jump-link bar under the title: scrolls to each section by fragment id.
    // The targets (#services / #sales / #tasks / #photos / #retrospectives) are set
    // on the section wrappers.  A link whose section isn't shown for this viewer
    // simply doesn't scroll - harmless.  Styled to match the document: small, muted,
    // slash-separated secondary links (not default browser blue), a quiet strip.
    private renderSectionNav(): Markup {
        const links: [string, string][] = [
            ['volunteers', 'Volunteers here'], ['services', 'Services'], ['sales', 'Sales & giveaways'],
            ['tasks', 'Tasks'], ['photos', 'Photos'], ['retrospectives', 'Retrospectives'],
        ];
        return [h.nav, {class: 'lm-section-nav small mb-4 pb-2 border-bottom', 'aria-label': 'Sections'},
            links.map(([id, label], i) => [
                i > 0 ? [h.span, {class: 'text-muted mx-2'}, '/'] : undefined,
                [h.a, {href: `#${id}`, class: 'link-secondary text-decoration-none'}, label],
            ])];
    }

    // The event's activity log: two INDEPENDENT peer document sections, Services
    // and Sales & giveaways (no "Activity" umbrella - the whole page IS activity).
    // Each is its own reloadable fragment keyed on its own table's event fk (so
    // adding a service re-renders only the Services list, not Sales) with its own
    // add affordance next to its own heading.
    @route(authenticated)
    renderEventActivity(event_id: number): Markup {
        return [h.div, {},
            this.renderEventServices(event_id),
            this.renderEventSales(event_id)];
    }

    // The Services section: its own reloadable fragment (reloads only on a service
    // change for this event) with a quick + (one kind of add).  For a non-editor
    // with no services there's nothing to show or add, so it renders nothing.
    @route(authenticated)
    renderEventServices(event_id: number): Markup {
        const services = security.runSystem(() => rabid.service.servicesForEvent.all({event_id}));
        const canAdd = rabid.service.canEditRecord({event_id} as any);
        if(!canAdd && services.length === 0) return undefined as unknown as Markup;
        // LIVE on the SHAPE key: another host adding/removing a service on this
        // event re-renders the section for everyone (long-poll); EDITING one reloads
        // just its row (renderServiceRow is row-keyed) - not the whole list.
        const props = liveReloadableProps([rabid.service.shapeKey('event_id', event_id)],
            `rabid.event.renderEventServices(${event_id})`);
        return [h.div, {...props, id: 'services'},
            [h.div, {class: 'lm-doc-section-head'},
             [h.h4, {class: 'lm-doc-section-label'}, 'Services'],
             canAdd
                 ? action.actionButton(action.plusIcon(),
                     {kind: 'modal', dialogUrl: `/rabid.service.newServiceForEventDialog(${event_id})`},
                     'lm-menu-button', {'aria-label': 'Add service', title: 'Add service'})
                 : undefined],
            [h.div, {class: 'lm-subsection'},
             services.length
                 ? rabid.service.renderServiceList(services)
                 : [h.p, {class: 'text-muted small mb-0'}, 'No services yet.']]];
    }

    // The Sales & giveaways section: mirrors renderEventServices, keyed on the sale
    // event fk, with a per-kind Add ☰ (a sale can't use a single quick + - the kind
    // must be picked, and it shapes the dialog).
    @route(authenticated)
    renderEventSales(event_id: number): Markup {
        const sales = security.runSystem(() => rabid.sale.salesForEvent.all({event_id}));
        const canAdd = rabid.sale.canEditRecord({event_id} as any);
        if(!canAdd && sales.length === 0) return undefined as unknown as Markup;
        // LIVE on the SHAPE key (see renderEventServices): edit reloads only the row.
        const props = liveReloadableProps([rabid.sale.shapeKey('event_id', event_id)],
            `rabid.event.renderEventSales(${event_id})`);
        return [h.div, {...props, id: 'sales'},
            [h.div, {class: 'lm-doc-section-head'},
             [h.h4, {class: 'lm-doc-section-label'}, 'Sales & giveaways'],
             canAdd
                 ? action.actionMenu(rabid.sale.saleAddMenuItems(event_id),
                     {ariaLabel: 'Add a sale'})
                 : undefined],
            [h.div, {class: 'lm-subsection'},
             sales.length
                 ? rabid.sale.renderSaleList(sales)
                 : [h.p, {class: 'text-muted small mb-0'}, 'No sales yet.']]];
    }

    // The detail page's notes: the event's own prose, not a labelled field - so
    // no heading.  Clean document body (lm-doc-lead), consistent with committee
    // descriptions - no orange accent bar (that reads as a callout).
    renderEventNotes(e: Event): Markup {
        if (!e.notes || !e.notes.trim()) return undefined as unknown as Markup;
        return [h.div, {class: 'lm-markdown lm-doc-lead mb-4'},
            this.fieldsByName.notes.render(e.notes)];
    }


    // Retrospectives: volunteer feedback on how the event went (markdown, optionally
    // anonymous).  Always shown (to any logged-in volunteer) - we want feedback, so
    // it's never hidden; the "+" is open to all.  A shape-keyed section (add/delete
    // reload it; an edit reloads just the row).  A small note below explains it.
    @route(authenticated)
    renderEventRetrospectives(event_id: number): Markup {
        // Hosts-only entries are hidden from non-host volunteers.
        const isHost = retroViewerIsHost();
        const retros = security.runSystem(() => rabid.event_retrospective.forEvent.all({event_id}))
            .filter(r => isHost || !r.host_only);
        const canAdd = security.current()?.actorId != null;
        // LIVE on the shape key: a retrospective posted by someone else appears for
        // everyone (long-poll).
        const props = liveReloadableProps([rabid.event_retrospective.shapeKey('event_id', event_id)],
            `rabid.event.renderEventRetrospectives(${event_id})`);
        return [h.div, {...props, id: 'retrospectives', 'data-testid': 'event-retrospectives'},
            [h.div, {class: 'lm-doc-section-head'},
             [h.h4, {class: 'lm-doc-section-label'}, 'Retrospectives'],
             canAdd
                 ? action.actionButton(action.plusIcon(),
                     {kind: 'modal', dialogUrl: `/rabid.event_retrospective.newRetrospectiveDialog(${event_id})`},
                     'lm-menu-button', {'aria-label': 'Add retrospective', title: 'Add retrospective'})
                 : undefined],
            [h.div, {class: 'lm-subsection'},
             retros.length
                 ? retros.map(r => rabid.event_retrospective.renderRow(r))
                 : [h.p, {class: 'text-muted small mb-0'}, 'No retrospectives yet.']],
            [h.p, {class: 'text-muted small fst-italic mt-2 mb-0'},
             'Retrospectives are your feedback on how the event went — what worked, what could '
             + 'be better. All feedback is welcome, including criticism; tick “Post anonymously” '
             + 'to leave it unattributed.']];
    }

    // The home page's upcoming events, as a week-grouped compact table (the same
    // shape as the volunteer Time view): a header band per week, then one tight
    // row per event - far less bulky than the old summary cards, so other home
    // sections below it actually get seen.  Heading is an h3 to match the page's
    // sibling sections (Volunteers, Events).
    renderUpcomingEvents(): Markup {
        // All date math in org wall-clock time via Temporal (a new Date()/UTC
        // version would shift the bounds and week labels by the server's zone).
        const today = date.orgToday();
        const startDate = `${today.toString()} 00:00:00`;
        const endDate = `${today.add({days: 42}).toString()} 23:59:59`; // 6 weeks = 42 days

        const upcomingEvents = db().prepare<Event, {start_date: string, end_date: string}>(block`
            SELECT ${this.allFields}
            FROM event
            WHERE start_time >= :start_date
              AND start_time <= :end_date
            ORDER BY start_time`).all({start_date: startDate, end_date: endDate});

        return [h.div, {class: 'upcoming-events'},
            [h.h3, {}, 'Upcoming Events'],
            upcomingEvents.length === 0
                ? [h.p, {class: 'text-muted'}, 'No upcoming events scheduled in the next 6 weeks.']
                : this.renderEventScheduleTable(upcomingEvents)];
    }

    // The reusable week-grouped, phase-aware schedule table for a set of events
    // (the home upcoming list and the Events page both render through this).
    // Events are grouped/ordered as given - the caller chooses the window and
    // sort.  Undated events (no start_time) can't be week-grouped, so they get
    // their own trailing "No date set" section rather than being dropped.
    renderEventScheduleTable(events: Event[]): Markup {
        // Two batch queries for the whole set: who committed (sign-ups) and who
        // checked in (attendance).  Each row picks the right one by phase, and
        // 'ghosts' (committed but absent) is a free set-diff of the two.
        const ids = events.map(e => e.event_id);
        const commitments = this.peopleByEvents('event_commitment', ids);
        const checkins = this.peopleByEvents('event_checkin', ids);
        const actorId = security.current()?.actorId;

        // Group by week (Sunday-start; Temporal dayOfWeek is Mon=1..Sun=7),
        // preserving the caller's order so weeks stay in sequence.
        const eventsByWeek = new Map<string, Event[]>();
        const undated: Event[] = [];
        for (const event of events) {
            if (!event.start_time) { undated.push(event); continue; }
            const eventDay = date.sqliteDateToTemporal(date.extractDateFromDateTime(event.start_time));
            const weekKey = eventDay.subtract({days: eventDay.dayOfWeek % 7}).toString();
            if (!eventsByWeek.has(weekKey)) eventsByWeek.set(weekKey, []);
            eventsByWeek.get(weekKey)!.push(event);
        }

        const rows: Markup[] = [];
        let first = true;
        for (const [weekKey, evs] of eventsByWeek) {
            rows.push(...this.renderUpcomingWeek(weekKey, evs, commitments, checkins, actorId, first));
            first = false;
        }
        if (undated.length) {
            rows.push(this.renderScheduleSectionHeader('No date set', undated.length, !first));
            for (const e of undated)
                rows.push(this.renderEventScheduleRow(
                    e, commitments.get(e.event_id) ?? [], checkins.get(e.event_id) ?? [], actorId));
        }

        return [h.table, {class: 'table table-sm align-middle'}, [h.tbody, {}, ...rows]];
    }

    // The "Now" section: the same schedule rows, but in NOW MODE (self-toggle is
    // "I am Here" / check-in, attendance line instead of sign-ups) and without the
    // week grouping (they're all ~now).
    private renderNowEvents(events: Event[]): Markup {
        const ids = events.map(e => e.event_id);
        const commitments = this.peopleByEvents('event_commitment', ids);
        const checkins = this.peopleByEvents('event_checkin', ids);
        const actorId = security.current()?.actorId;
        return [h.table, {class: 'table table-sm align-middle'},
            [h.tbody, {}, ...events.map(e => this.renderEventScheduleRow(
                e, commitments.get(e.event_id) ?? [], checkins.get(e.event_id) ?? [], actorId, /*nowMode*/ true))]];
    }

    // The current phase of an event by its times: future (not started), running
    // (started, not yet ended), or past (ended).  Drives whether a schedule row
    // shows sign-ups (future) or attendance (running/past).
    private eventPhase(e: Event): 'future' | 'running' | 'past' {
        const now = date.temporalToSqliteDateTime(date.orgNow());
        if (!e.start_time || e.start_time > now) return 'future';
        if (e.end_time && e.end_time < now) return 'past';
        return 'running';
    }

    // "Now": a real (non-catch-all) scheduled event that is happening around now -
    // from 30 min before it starts until 30 min after it ends.  These get their own
    // Events-page section, and their self-toggle is a check-in ("I am Here") rather
    // than a sign-up.  Used both to build the section and (per row) to reload it in
    // the same mode.
    private isNowEvent(e: Event): boolean {
        if (e.is_catch_all || !e.start_time) return false;
        const nowT = date.orgNow();
        const soon = date.temporalToSqliteDateTime(nowT.add({minutes: 30}));      // starts within 30 min
        const cutoff = date.temporalToSqliteDateTime(nowT.subtract({minutes: 30})); // ends no earlier than 30 min ago
        return e.start_time <= soon && (e.end_time ?? e.start_time) >= cutoff;
    }

    // People (short-names + ids) attached to a set of events, in one query, from
    // either the commitment ('signed up') or check-in ('was there') table.
    // event_id -> [{id, name}], alpha by full name.  The table name is a trusted
    // literal (the union type), so interpolating it is safe.
    private peopleByEvents(table: 'event_commitment' | 'event_checkin',
                           eventIds: number[]): Map<number, Array<{id: number, name: string}>> {
        const out = new Map<number, Array<{id: number, name: string}>>();
        if (eventIds.length === 0) return out;
        const rows = db().all<{event_id: number, volunteer_id: number, name: string, short_name: string|null}, {}>(`
            SELECT t.event_id, v.volunteer_id, v.name, v.short_name
              FROM ${table} t JOIN volunteer v USING (volunteer_id)
             WHERE v.deleted = 0 AND t.event_id IN (${eventIds.map(Number).join(',')})
             ORDER BY v.name`, {});
        for (const r of rows) {
            if (!out.has(r.event_id)) out.set(r.event_id, []);
            out.get(r.event_id)!.push({id: r.volunteer_id, name: shortName(r)});
        }
        return out;
    }

    // A schedule-table section header band (a week, or "No date set"): a gap
    // above it (so it reads as a heading for the rows BELOW, like the Time view)
    // plus the label and the event count.  Three columns: label spans 2, count
    // right-aligned in the third.
    private renderScheduleSectionHeader(label: string, count: number, withGap: boolean): Markup {
        return [
            withGap
                ? [h.tr, {'aria-hidden': 'true', 'data-testid': 'upcoming-week-gap'},
                   [h.td, {colspan: '3', style: 'height: 1.5rem; border: 0; padding: 0;'}]]
                : undefined,
            [h.tr, {class: 'table-light fw-semibold', 'data-testid': 'upcoming-week',
                    style: 'border-top: 0; border-bottom: 2px solid var(--bs-secondary-color);'},
             [h.td, {colspan: '2', style: 'border-bottom: 0;'}, label],
             [h.td, {class: 'text-end text-muted small text-nowrap', style: 'border-bottom: 0;'},
              `${count} ${count === 1 ? 'event' : 'events'}`]],
        ];
    }

    // One week of the schedule table: a section header, then a row per event.
    private renderUpcomingWeek(weekKey: string, events: Event[],
                               commitments: Map<number, Array<{id: number, name: string}>>,
                               checkins: Map<number, Array<{id: number, name: string}>>,
                               actorId: number|undefined, isFirst: boolean): Markup[] {
        const weekStart = date.sqliteDateToTemporal(weekKey);
        const weekEnd = weekStart.add({days: 6});
        const sStr = weekStart.toLocaleString('en-US', {month: 'short', day: 'numeric'});
        const eStr = weekEnd.month === weekStart.month
            ? String(weekEnd.day)
            : weekEnd.toLocaleString('en-US', {month: 'short', day: 'numeric'});
        return [
            this.renderScheduleSectionHeader(`Week of ${sStr} – ${eStr}`, events.length, !isFirst),
            ...events.map(e => this.renderEventScheduleRow(
                e, commitments.get(e.event_id) ?? [], checkins.get(e.event_id) ?? [], actorId)),
        ];
    }

    // Reload one schedule row (after a self sign-up / check-in toggle, or a
    // host check-in from the running-row menu).  The row joins the reload group
    // of whichever table its phase mutates (event_commitment for future,
    // event_checkin for running/past), so the matching mutation re-renders it.
    @route(authenticated)
    renderEventScheduleRowById(event_id: number): Markup {
        const e = this.getById(event_id);
        const commitments = this.peopleByEvents('event_commitment', [event_id]).get(event_id) ?? [];
        const checkins = this.peopleByEvents('event_checkin', [event_id]).get(event_id) ?? [];
        // Recompute now-mode so a reloaded row (after a check-in) keeps the "I am
        // Here" behaviour that its section rendered it with.
        return this.renderEventScheduleRow(e, commitments, checkins, security.current()?.actorId,
                                           this.isNowEvent(e));
    }

    // One event as a compact, PHASE-AWARE table row: WHEN (day + from–to time,
    // plus remote prep times) · WHAT (name, badges, remote line, and who is
    // signed up / here / attended IN FULL, with the committed-but-absent 'ghosts'
    // below) · a self toggle (sign up / check in) + a running-event check-in menu
    // + a chevron.  The WHOLE row navigates to the detail page; there is no edit
    // pencil - editing lives there.  No "N" count column: the full roster is
    // shown (volunteers gauge who'll be there by name) and dropping a column buys
    // real width on narrow/mobile screens.
    renderEventScheduleRow(e: Event, commitments: Array<{id: number, name: string}>,
                           checkins: Array<{id: number, name: string}>,
                           actorId: number|undefined, nowMode: boolean = false): Markup {
        const id = e.event_id;
        const phase = this.eventPhase(e);
        const day = e.start_time
            ? date.sqliteDateTimeToString(e.start_time, '', {weekday: 'short', month: 'short', day: 'numeric'})
            : '';
        // From–to, not just from (e.g. "5:00 PM – 8:00 PM").
        const time = e.start_time
            ? (e.end_time
                ? `${date.sqliteDateTimeToTimeString(e.start_time)} – ${date.sqliteDateTimeToTimeString(e.end_time)}`
                : date.sqliteDateTimeToTimeString(e.start_time))
            : '';
        const remote = this.remoteText(e);

        // Future shows commitments; running/past (and NOW mode) show attendance,
        // with 'ghosts' (committed but not checked in) as a quiet second line.  In
        // now mode a not-yet-started event is treated as attendance too - you're
        // checking IN, not signing up.
        const future = phase === 'future' && !nowMode;
        const attending = future ? commitments : checkins;
        const selfAttending = actorId !== undefined && attending.some(p => p.id === actorId);
        const checkedInIds = new Set(checkins.map(p => p.id));
        const ghosts = future ? [] : commitments.filter(c => !checkedInIds.has(c.id));
        const line = nowMode
            ? {label: 'Here', empty: 'No one here yet'}
            : ({
                future:  {label: 'Going',    empty: 'No one signed up yet'},
                running: {label: 'Here now', empty: 'No one here yet'},
                past:    {label: 'Attended', empty: 'No one checked in'},
              } as const)[phase];
        const ghostLabel = (nowMode || phase === 'running') ? 'Not here yet' : 'Not checked in';

        // The toggle mutates event_commitment (future) or event_checkin
        // (running/past) - register THAT table's event fk key so the mutation's
        // automatic emission re-renders us.
        const attendKey = future
            ? rabid.event_commitment.fkKey('event_id', id)
            : rabid.event_checkin.fkKey('event_id', id);
        const props = reloadableProps([attendKey],
            `rabid.event.renderEventScheduleRowById(${id})`,
            {'data-testid': `event-schedule-${id}`, onclick: 'lmNavigableClick(event)'});
        props.class = 'lm-navigable ' + props.class;

        return [h.tr, props,
            [h.td, {class: 'text-nowrap align-top'},
             day,
             time ? [h.div, {class: 'text-muted small'}, time] : undefined,
             // Remote events: the prep times volunteers plan around (load up at
             // the shop, set up at the venue), under the main time - same as the
             // detail card.  At-shop events don't need them here.
             e.is_remote_event && e.shop_load_time
                ? [h.div, {class: 'text-muted small'},
                   [h.span, {class: 'card-subtime-label'}, 'Shop load '],
                   date.sqliteDateTimeToTimeString(e.shop_load_time)] : undefined,
             e.is_remote_event && e.setup_time
                ? [h.div, {class: 'text-muted small'},
                   [h.span, {class: 'card-subtime-label'}, 'Setup '],
                   date.sqliteDateTimeToTimeString(e.setup_time)] : undefined],
            [h.td, {class: 'align-top'},
             [h.a, {...templates.pageLinkProps(`/rabid.event.detailPage(${id})`), class: 'lm-nav-link'},
              e.description || 'Untitled Event'],
             this.eventBadges(e),
             remote ? [h.div, {class: 'text-muted small'}, remote] : undefined,
             this.renderPeopleLine(line.label, attending, actorId, line.empty),
             ghosts.length ? this.renderPeopleLine(ghostLabel, ghosts, actorId, undefined, {ghost: true}) : undefined],
            [h.td, {class: 'text-end text-nowrap align-top'},
             [h.div, {class: 'd-inline-flex align-items-center gap-2'},
              this.renderSelfAttendToggle(id, phase, selfAttending, actorId, nowMode),
              (nowMode || phase === 'running') ? this.renderRowCheckinMenu(e, checkedInIds, actorId) : undefined,
              navChevron()]],
        ];
    }

    // A "who's involved" line, shown IN FULL (no cap).  Volunteers span a wide
    // range of skill, and skilled volunteers decide whether they're needed by
    // seeing exactly who else is coming; we don't (and culturally can't) label
    // skill in the UI, so the whole roster has to be visible.  Self comes first
    // and visually distinct ("You") so a volunteer can spot their own events.
    // `ghost` styles the committed-but-absent line apart from the attendees.
    private renderPeopleLine(label: string, people: Array<{id: number, name: string}>,
                             actorId: number|undefined, emptyText: string|undefined,
                             opts: {ghost?: boolean} = {}): Markup {
        if (people.length === 0)
            return emptyText ? [h.div, {class: 'text-muted small fst-italic'}, emptyText] : undefined;
        const selfIn = actorId !== undefined && people.some(p => p.id === actorId);
        const others = people.filter(p => p.id !== actorId);
        const parts: Markup[] = [];
        if (selfIn) parts.push([h.span, {class: 'upcoming-going-self'}, 'You']);
        for (const o of others) parts.push(o.name);
        const joined: Markup[] = parts.flatMap((p, i) => i === 0 ? [p] : [', ', p]);
        return [h.div, {class: 'text-muted small ' + (opts.ghost ? 'upcoming-ghosts' : 'upcoming-going')},
            [h.span, {class: 'upcoming-people-label'}, label + ': '], ...joined];
    }

    // The self toggle (finger-sized lm-row-action pill, modelled on the timesheet
    // 'confirmed' badge), phase-tuned: future = sign up / Going ✓ (commitment);
    // running = Check in / Here ✓ and past = I was there / Was there ✓ (check-in,
    // which works retroactively).  Logged-in volunteers only.
    private renderSelfAttendToggle(event_id: number, phase: 'future'|'running'|'past',
                                   selfAttending: boolean, actorId: number|undefined,
                                   nowMode: boolean = false): Markup {
        if (actorId === undefined) return undefined;
        // Now mode is a check-in ("I am Here"), even for an event that hasn't quite
        // started - so skip the sign-up branch.
        if (phase === 'future' && !nowMode) {
            return selfAttending
                ? action.actionButton('Going ✓',
                    {kind: 'immediate', expr: `rabid.event_commitment.uncommit(${event_id},${actorId})`},
                    'btn btn-success lm-row-action', {title: "You're signed up — click to cancel"})
                : action.actionButton('Sign up',
                    {kind: 'immediate', expr: `rabid.event_commitment.commitSelf(${event_id})`},
                    'btn btn-outline-primary lm-row-action', {title: 'Sign up for this event'});
        }
        const onLabel = nowMode ? 'Here ✓' : (phase === 'running' ? 'Here ✓' : 'Was there ✓');
        const offLabel = nowMode ? 'I am Here' : (phase === 'running' ? 'Check in' : 'I was there');
        const offTitle = nowMode ? "Check yourself in - you're here"
            : (phase === 'running' ? 'Check yourself in' : 'Record that you were there');
        return selfAttending
            ? action.actionButton(onLabel,
                {kind: 'immediate', expr: `rabid.event_checkin.checkOut(${event_id},${actorId})`},
                'btn btn-success lm-row-action', {title: "You're checked in — click to undo"})
            : action.actionButton(offLabel,
                {kind: 'immediate', expr: `rabid.event_checkin.checkSelfIn(${event_id})`},
                'btn btn-outline-primary lm-row-action', {title: offTitle});
    }

    // On a RUNNING event, a host can check in people who are there without leaving
    // the list: a ☰ of the recently-active volunteers not yet checked in, plus the
    // full picker.  Host/admin only (checkInVolunteer is gated) - others just
    // self check in.  Mirrors the detail page's check-in menu (adds only).
    private renderRowCheckinMenu(e: Event, checkedInIds: Set<number>, actorId: number|undefined): Markup {
        const ctx = security.current();
        const canManage = !ctx || ctx.system ? true : hostOrAdmin({ctx});
        if (!canManage) return undefined;
        const id = e.event_id;
        const items: action.ActionMenuItem[] = [];
        for (const v of activeVolunteersWithin(30)
                .filter(v => !checkedInIds.has(v.volunteer_id) && v.volunteer_id !== actorId))
            items.push({label: `Check in ${v.name}`,
                        mode: {kind: 'immediate',
                               expr: `rabid.event_checkin.checkInVolunteer(${id},${v.volunteer_id})`}});
        items.push({label: 'Check someone in…',
                    mode: {kind: 'modal', dialogUrl: `/rabid.event_checkin.checkInDialog(${id})`}});
        return action.actionMenu(items, {ariaLabel: 'Check someone in'});
    }

       // TODO make single line version for rendering in home page etc.
    // TODO make volunteer names be clickable to volunteer page
    // TODO include whether a volunteer has said they will drive etc (also consider
    //      things like driver needed).
    // TODO generalize badges so don't need a CSS per badge.
    // TODO 
    // The summary card.  titleLink: the title links to the event's detail page
    // (the home upcoming-events cards) - the detail page itself passes false,
    // since there it would be a pointless self-link.
    @route(authenticated)
    renderEventSummary(event_id: number, opts: {titleLink?: boolean, editableCheckins?: boolean, hideNotes?: boolean, hideTitle?: boolean, bare?: boolean, hideCheckins?: boolean} = {}): Markup {
        const titleLink = opts.titleLink ?? true;

        // Get the event
        const event = db().prepare<Event, {event_id: number}>(block`
            SELECT ${this.allFields}
            FROM event
            WHERE event_id = :event_id`).first({event_id});
        
        if (!event) {
            return [h.div, {class: 'card-not-found'}, `Event ${event_id} not found`];
        }
        
        // Get commitments ("signed up") for this event
        const commitments = db().prepare<{name: string, short_name: string}, {event_id: number}>(block`
            SELECT volunteer.name, volunteer.short_name
            FROM event_commitment
            LEFT JOIN volunteer USING (volunteer_id)
            WHERE event_id = :event_id
            ORDER BY volunteer.name`).all({event_id});

        // Get check-ins ("showed up") for this event.
        const checkins = db().prepare<{name: string, short_name: string, was_staff: boolnum}, {event_id: number}>(block`
            SELECT volunteer.name, volunteer.short_name, event_checkin.was_staff
            FROM event_checkin
            LEFT JOIN volunteer USING (volunteer_id)
            WHERE event_id = :event_id
            ORDER BY volunteer.name`).all({event_id});
        
        // Build time summary ("Sat, May 4, 3:30 PM - 6:00 PM")
        const timeParts: string[] = [];
        if (event.start_time) {
            timeParts.push(date.sqliteDateTimeToString(event.start_time, '', {
                weekday: 'short', month: 'short', day: 'numeric',
                hour: 'numeric', minute: '2-digit', hour12: true}));
            if (event.end_time) {
                timeParts.push(` - ${date.sqliteDateTimeToTimeString(event.end_time)}`);
            }
        }
        
        // Build the event summary markup
        const headerElements: Markup[] = [];
        
        // Event name, linking to the detail page (unless we ARE the detail page).
        // The detail page passes hideTitle - the h2 above already shows it and links
        // to the same page - so the summary card doesn't repeat it.
        if(!opts.hideTitle) {
            const title = [h.strong, {}, this.recordLabel(event)];
            headerElements.push(
                titleLink
                    ? [h.a, {...templates.pageLinkProps(`/rabid.event.detailPage(${event_id})`),
                             class: 'card-title'}, title]
                    : [h.span, {class: 'card-title'}, title]
            );
        }
        
        // Event kind badge - only for the exceptional kinds (public is the
        // unmarked default; Remote rides the location row, not a badge).
        if (event.event_kind && event.event_kind !== 'public' && !event.is_catch_all) {
            headerElements.push(' ');
            headerElements.push(
                [h.span, {class: `card-badge event-${event.event_kind}`},
                    event_kind_enum[event.event_kind] || event.event_kind
                ]
            );
        }

        // Volunteer-only indicator
        if (event.volunteer_only) {
            headerElements.push(' ');
            headerElements.push(
                [h.span, {class: 'volunteer-only-badge'}, '(Volunteers Only)']
            );
        }

        // Build grid rows for details
        const gridRows: Markup[] = [];

        // Host row (the volunteer running the event) - not on a catch-all.
        if (!event.is_catch_all && event.host_id) {
            const host = security.runSystem(() => db().prepare<{name: string, short_name: string}, {id: number}>(
                'SELECT name, short_name FROM volunteer WHERE volunteer_id = :id').first({id: event.host_id!}));
            if (host)
                gridRows.push([h.div, {class: 'card-detail-row'},
                    [h.div, {}, 'Host:'],
                    [h.div, {}, templates.pageLink(`/rabid.volunteer.detailPage(${event.host_id})`, shortName(host))]]);
        }

        // Schedule row: the headline event time, with the prep times (shop load,
        // setup) stacked BENEATH it - same row, same label - so a volunteer
        // reading for "the time" can't one-and-done on the start time and miss
        // when they're actually needed.
        const mainTime = timeParts.join('');
        const subTimes: Markup[] = [];
        if (event.shop_load_time) {
            subTimes.push([h.div, {class: 'card-subtime'},
                [h.span, {class: 'card-subtime-label'}, 'Shop load '],
                date.sqliteDateTimeToTimeString(event.shop_load_time)]);
        }
        if (event.setup_time) {
            subTimes.push([h.div, {class: 'card-subtime'},
                [h.span, {class: 'card-subtime-label'}, 'Setup '],
                date.sqliteDateTimeToTimeString(event.setup_time)]);
        }
        if (mainTime || subTimes.length > 0) {
            gridRows.push(
                [h.div, {class: 'card-detail-row'},
                    [h.div, {}, 'Time:'],
                    [h.div, {},
                        mainTime ? [h.div, {class: 'card-time-main'}, mainTime] : undefined,
                        ...subTimes]
                ]
            );
        }

        // Location row - only for remote events (non-remote are at our shop, so a
        // location is noise).  The label says "Remote" since that's the point.
        if (event.is_remote_event) {
            const locationValue: Markup[] = [];
            if (event.location_description && event.location_url) {
                locationValue.push(
                    [h.a, {href: event.location_url, target: '_blank', class: 'location-link'},
                        event.location_description
                    ]
                );
            } else if (event.location_description) {
                locationValue.push(event.location_description);
            } else {
                locationValue.push([h.span, {class: 'text-muted'}, 'location TBD']);
            }

            gridRows.push(
                [h.div, {class: 'card-detail-row'},
                    [h.div, {}, 'Remote:'],
                    [h.div, {}, ...locationValue]
                ]
            );
        }
        
        // Attendance (sign-ups + check-ins) is meaningless on a catch-all: it is
        // not an event volunteers "attend" (they log drop-in time via timesheets),
        // and full-event check-in there would corrupt attendance reporting.  So a
        // catch-all shows no sign-up / check-in rows at all.
        if (!event.is_catch_all) {
        // Signed-up row (commitments).  On the detail page (editableCheckins) the
        // value IS the sign-up editor (always shown, so the ☰ is reachable even
        // with nobody signed up yet); elsewhere (cards) it's a read-only names list.
        if (opts.editableCheckins) {
            gridRows.push(
                [h.div, {class: 'card-detail-row'},
                    [h.div, {}, 'Signed up:'],
                    [h.div, {}, rabid.event_commitment.renderCommitmentEditor(event_id)]
                ]
            );
        } else if (commitments.length > 0) {
            gridRows.push(
                [h.div, {class: 'card-detail-row'},
                    [h.div, {}, 'Signed up:'],
                    [h.div, {},
                        `(${commitments.length}) ${commitments.map(c => shortName(c)).join(', ')}`
                    ]
                ]
            );
        } else {
            gridRows.push(
                [h.div, {class: 'card-detail-row'},
                    [h.div, {}, 'Signed up:'],
                    [h.div, {class: 'card-empty-value'},
                        [h.em, {}, 'No volunteers signed up yet']
                    ]
                ]
            );
        }

        // Checked-in row (actual attendance).  Elided (hideCheckins) when the page
        // renders the face grid instead.  On the detail page (editableCheckins) the
        // value IS the check-in editor (always shown, so the ☰ is reachable even
        // with nobody checked in yet); elsewhere (cards) it's a read-only names
        // list, shown only once someone has checked in.  Staff are marked.
        if (opts.hideCheckins) {
            // nothing - the face grid section carries check-ins
        } else if (opts.editableCheckins) {
            gridRows.push(
                [h.div, {class: 'card-detail-row'},
                    [h.div, {}, 'Checked in:'],
                    [h.div, {}, rabid.event_checkin.renderCheckinEditor(event_id)]
                ]
            );
        } else if (checkins.length > 0) {
            gridRows.push(
                [h.div, {class: 'card-detail-row'},
                    [h.div, {}, 'Checked in:'],
                    [h.div, {},
                        `(${checkins.length}) ` +
                        checkins.map(c => c.was_staff ? `${shortName(c)} (staff)` : shortName(c)).join(', ')
                    ]
                ]
            );
        }
        }   // end !is_catch_all attendance block
        
        // Cash collected row (only show if > 0)
        if (event.total_cash_collected && event.total_cash_collected > 0) {
            gridRows.push(
                [h.div, {class: 'card-detail-row'},
                    [h.div, {}, 'Cash collected:'],
                    [h.div, {}, `$${event.total_cash_collected.toFixed(2)}`]
                ]
            );
        }
        
        // Notes render as their OWN prose block BELOW the labelled grid, with no
        // "Notes:" label - a multi-line note (or a markdown list) looks wonky forced
        // into the labelled-row layout.
        const notesBlock = (!opts.hideNotes && event.notes && event.notes.trim())
            ? [h.div, {class: 'lm-markdown card-notes mt-2'}, this.fieldsByName.notes.render(event.notes)]
            : undefined;

        // `bare` (the detail page): drop the card box so the details flow directly
        // under the page title - no visual fence between the title and its content,
        // so the title-row Edit affordance reads as editing exactly this.  Editing
        // itself is up on the title row (see renderEventDetail), not here.
        return [h.div, {class: opts.bare ? '' : 'card-summary'},
            headerElements.length ? [h.div, {class: 'card-header'}, ...headerElements] : undefined,
            [h.div, {class: 'card-details-grid'}, ...gridRows],
            notesBlock,
        ];
    }
}

// A system-managed datetime: stamped on insert, never shown in the edit form.
class ManagedDateTimeField extends DateTimeField {
    override isVisible(): boolean { return false; }
}

// A volunteer-id set programmatically (here: confirmed_by), never shown in the form.
class HiddenVolunteerRefField extends IntegerField {
    override isVisible(): boolean { return false; }
}

// --------------------------------------------------------------------------------
// --- EventRetrospective ---------------------------------------------------------
// --------------------------------------------------------------------------------
//
// Volunteer feedback on how an event went - "what worked, what didn't".  Primarily
// a markdown note, optionally ANONYMOUS (then the author is not recorded, and is
// cleared if it had been): we want candid feedback, including criticism.  ANY
// logged-in volunteer can add one; the author (when recorded) or a host edits/deletes.

// Is the current viewer a host/admin?  Gates hosts-only retrospectives.
function retroViewerIsHost(): boolean {
    const c = security.current();
    return !!(c && (c.system || c.roles.has('host') || c.roles.has('admin')));
}

// Edit permission: a host/admin, or the recorded author of a non-anonymous entry.
const retroEdit: security.Permission = security.or(
    hostOrAdmin,
    (a: any) => {
        const r = a.record as EventRetrospective | undefined;
        return r?.created_by != null && a.ctx.actorId === r.created_by;
    });

export interface EventRetrospective {
    event_retrospective_id: number;
    event_id: number;
    feedback: string;
    is_anonymous: boolnum;
    // Restrict viewing to hosts/admins (sensitive feedback).  Orthogonal to
    // is_anonymous - you can be anonymous AND hosts-only, or either alone.
    host_only: boolnum;
    created_by?: number;
    created_time?: string;
}
export type EventRetrospectiveOpt = Partial<EventRetrospective>;

export class EventRetrospectiveTable extends Table<EventRetrospective> {
    constructor() {
        super('event_retrospective', [
            new PrimaryKeyField('event_retrospective_id', {}),
            new ForeignKeyField('event_id', 'event', 'event_id', {indexed: true, edit: security.never}),
            new MarkdownField('feedback', {default: '', prompt: "How did it go? What worked, what didn't?"}),
            new CheckboxField('is_anonymous', {default: 0, prompt: 'Post anonymously'}),
            new CheckboxField('host_only', {default: 0, prompt: 'Hosts only (hide from other volunteers)'}),
            // Managed: set from the actor on add (unless anonymous), cleared when an
            // entry becomes anonymous.  Never a form field.
            new VolunteerForeignKeyField('created_by', {nullable: true, edit: security.never}),
            new DateTimeField('created_time', {nullable: true, edit: security.never}),
        ]);
    }

    defaultFieldEdit: security.Permission = retroEdit;
    override get recordEdit(): security.Permission { return retroEdit; }
    override formTitle(_r: EventRetrospective): string { return 'Retrospective'; }

    @path
    get forEvent() {
        return this.prepare<EventRetrospective, {event_id: number}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM event_retrospective
/**/          WHERE event_id = :event_id
/**/          ORDER BY created_time, event_retrospective_id`);
    }

    private parseAnon(v: unknown): boolean {
        return v === 'on' || v === true || v === 1 || v === '1' || v === 'true';
    }

    // Add: ANY logged-in volunteer.  Anonymous -> no author recorded.
    @route(authenticated)
    newRetrospectiveDialog(event_id: number): Markup {
        const f = this.fieldsByName;
        return action.renderParamForm(
            [f.feedback, f.is_anonymous, f.host_only], {} as Partial<EventRetrospective>,
            {
                title: 'Add retrospective', submitLabel: 'Post',
                hidden: {event_id},
                dispatch: {onsubmit:
                    'event.preventDefault(); tx`rabid.event_retrospective.addRetrospective(${getFormJSON(event.target)})`'},
            });
    }

    @routeMutation(authenticated)
    addRetrospective(args: {event_id?: string|number, feedback?: string,
                            is_anonymous?: unknown, host_only?: unknown}): Markup {
        const event_id = Number(args?.event_id);
        if(!Number.isInteger(event_id) || !event_id) throw new Error('Missing event');
        const feedback = (args.feedback ?? '').trim();
        if(!feedback) throw new Error('Please enter some feedback');
        const anon = this.parseAnon(args.is_anonymous);
        this.insert({
            event_id, feedback, is_anonymous: anon ? 1 : 0,
            host_only: this.parseAnon(args.host_only) ? 1 : 0,
            created_by: anon ? null : (security.current()?.actorId ?? null),
            created_time: date.temporalToSqliteDateTime(date.orgNow()),
        } as EventRetrospectiveOpt);
        return {action: 'reload', targets: ['.' + this.shapeKey('event_id', event_id)]} as unknown as Markup;
    }

    @route(authenticated)
    editRetrospectiveDialog(event_retrospective_id: number): Markup {
        const r = this.getById(event_retrospective_id);
        if(!this.canEditRecord(r)) throw new Error('Not permitted to edit this retrospective');
        const f = this.fieldsByName;
        return action.renderParamForm(
            [f.feedback, f.is_anonymous, f.host_only],
            {feedback: r.feedback, is_anonymous: r.is_anonymous,
             host_only: r.host_only} as Partial<EventRetrospective>,
            {
                title: 'Edit retrospective', submitLabel: 'Save',
                hidden: {event_retrospective_id},
                dispatch: {onsubmit:
                    'event.preventDefault(); tx`rabid.event_retrospective.saveRetrospective(${getFormJSON(event.target)})`'},
            });
    }

    @routeMutation(authenticated)
    saveRetrospective(args: {event_retrospective_id?: string|number, feedback?: string,
                             is_anonymous?: unknown, host_only?: unknown}): Markup {
        const id = Number(args?.event_retrospective_id);
        const r = this.getById(id);
        if(!this.canEditRecord(r)) throw new Error('Not permitted to edit this retrospective');
        const feedback = (args.feedback ?? '').trim();
        if(!feedback) throw new Error('Please enter some feedback');
        const anon = this.parseAnon(args.is_anonymous);
        // created_by follows the box, both ways: anonymous -> cleared; non-anonymous
        // -> keep the original author if still recorded, else (un-anonymising, where
        // the original was cleared) attribute to the editor doing it.
        const created_by = anon ? null : (r.created_by ?? (security.current()?.actorId ?? null));
        this.updateNamedFields(id, ['feedback', 'is_anonymous', 'host_only', 'created_by'], {
            feedback, is_anonymous: anon ? 1 : 0,
            host_only: this.parseAnon(args.host_only) ? 1 : 0, created_by,
        } as Partial<EventRetrospective>);
        return {action: 'reload', targets: ['.' + this.rowKey(id)]} as unknown as Markup;
    }

    @routeMutation(authenticated)
    remove(id: number): Markup {
        const r = this.getById(id);
        if(!this.canEditRecord(r)) throw new Error('Not permitted to delete this retrospective');
        const event_id = r.event_id;
        this.delete(id);
        return {action: 'reload', targets: ['.' + this.shapeKey('event_id', event_id)]} as unknown as Markup;
    }

    @route(authenticated)
    renderRowById(id: number): Markup {
        const r = this.getById(id);
        // A hosts-only entry never renders for a non-host (defends the reload path).
        if(r.host_only && !retroViewerIsHost()) return undefined as unknown as Markup;
        return this.renderRow(r);
    }
    renderRow(r: EventRetrospective): Markup {
        const id = r.event_retrospective_id;
        // LIVE on the row key: another actor's edit to this entry propagates here
        // (the section watches the shape key, for add/remove).
        const props = liveReloadableProps([this.rowKey(id)], `rabid.event_retrospective.renderRowById(${id})`);
        const canEdit = this.canEditRecord(r);
        const anon = !!r.is_anonymous || r.created_by == null;
        const author: Markup = anon
            ? [h.span, {class: 'fst-italic'}, 'Anonymous']
            : this.authorLink(r.created_by!);
        const when = r.created_time ? date.sqliteDateTimeToString(r.created_time) : '';
        return [h.div, {...props, class: props.class + ' mb-3', 'data-testid': `retro-${id}`},
            [h.div, {class: 'lm-markdown'}, this.fieldsByName.feedback.render(r.feedback)],
            [h.div, {class: 'text-muted small d-flex align-items-center gap-2'},
             [h.span, {}, '— ', author, when ? ` · ${when}` : '',
              r.host_only ? [h.span, {class: 'badge text-bg-warning ms-2'}, 'Hosts only'] : undefined],
             canEdit
                 ? action.actionMenu([
                     {label: 'Edit…', mode: {kind: 'modal', dialogUrl: `/rabid.event_retrospective.editRetrospectiveDialog(${id})`}},
                     {label: 'Delete', mode: {kind: 'confirm', message: 'Delete this retrospective?', expr: `rabid.event_retrospective.remove(${id})`}},
                   ], {ariaLabel: 'Retrospective actions'})
                 : undefined]];
    }
    private authorLink(volunteer_id: number): Markup {
        const v = security.runSystem(() => db().prepare<{name: string, short_name: string}, {id: number}>(
            'SELECT name, short_name FROM volunteer WHERE volunteer_id = :id').first({id: volunteer_id}));
        return v ? templates.pageLink(`/rabid.volunteer.detailPage(${volunteer_id})`, shortName(v)) : 'Someone';
    }
}

// --------------------------------------------------------------------------------
// --- EventCommitment ------------------------------------------------------------
// --------------------------------------------------------------------------------
//
// "I plan to come" - a volunteer signing up for an event ahead of time.  The
// actual showing-up is recorded separately as an EventCheckin (below): you can
// commit and not show (a no-show), or show without committing (a walk-in).

export interface EventCommitment {
    event_commitment_id: number;

    event_id: number;
    volunteer_id: number;

    requested_role: string;
    notes: string;

    // Driving information
    will_drive_supplies: boolnum;
    will_drive_passengers_count: number;

    // To allow for commit for partial event.
    start_time?: string;
    end_time?: string;
}

export type EventCommitmentOpt = Partial<EventCommitment>;

export class EventCommitmentTable extends Table<EventCommitment> {

    constructor() {
        super ('event_commitment', [
            new PrimaryKeyField('event_commitment_id', {}),
            new ForeignKeyField('event_id', 'event', 'event_id', {}, 'description'),
            new VolunteerForeignKeyField('volunteer_id', {}),
            new StringField('requested_role', {default:''}),
            new MarkdownField('notes', {default:''}),
            new BooleanField('will_drive_supplies', {default: 0}),
            new IntegerField('will_drive_passengers_count', {default: 0}),
            new DateTimeField('start_time', {nullable: true}),
            new DateTimeField('end_time', {nullable: true})
        ], [
            'CREATE INDEX IF NOT EXISTS event_commitment_by_event_id ON event_commitment(event_id);',
            'CREATE INDEX IF NOT EXISTS event_commitment_by_volunteer_id ON event_commitment(volunteer_id);',
        ])
    };

    @path
    get commitmentsForEvent() {
        return db().prepare<EventCommitment, {event_id: number}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM event_commitment
/**/          WHERE event_id = :event_id`);
    }

    @path
    get commitmentsForEventWithVolunteerName() {
        return db().prepare<(EventCommitment&MemberName), {event_id: number}>(block`
/**/   SELECT ${this.allFields}, volunteer.name AS volunteer_name,
/**/          volunteer.short_name AS volunteer_short_name
/**/          FROM event_commitment LEFT JOIN volunteer USING (volunteer_id)
/**/          WHERE event_id = :event_id
/**/          ORDER BY volunteer.name`);
    }

    // A commitment belongs to its volunteer (drives isSelf / self-edit gating),
    // like a check-in.
    ownerId(c: EventCommitment): number|undefined { return c.volunteer_id; }

    // ------------------------------------------------------------------------
    // --- Sign-up editor (the commitment UI) ----------------------------------
    // ------------------------------------------------------------------------
    //
    // Same interaction language as the check-in editor and the group member
    // editor: the signed-up names as a document phrase plus ONE ☰ holding every
    // sign-up verb.  "Sign me up" is the always-allowed self-signup; signing
    // OTHERS up (the recent-volunteer quick-adds and the picker) needs host/admin.

    // Can the current actor manage anyone's sign-up on this event (host/admin)?
    // Self sign-up / removal is allowed regardless and handled per-action.
    private canManageCommitments(): boolean {
        const ctx = security.current();
        if(!ctx || ctx.system) return true;
        return hostOrAdmin({ctx});
    }

    private hasCommitment(event_id: number, volunteer_id: number): boolean {
        return !!db().prepare<{n: number}, {event_id: number, volunteer_id: number}>(
            'SELECT 1 AS n FROM event_commitment WHERE event_id = :event_id AND volunteer_id = :volunteer_id')
            .first({event_id, volunteer_id});
    }

    // The sign-up fragments register this table's event fk key
    // (`-event_commitment-event_id-<eid>-`); inserts notify it via the
    // automatic emission, and the raw-SQL deletes below hand-record the same
    // keys (the escape hatch for writes that bypass the Table funnels).
    private reloadEditor(_event_id: number): Markup {
        return {action: 'reload'} as unknown as Markup;
    }

    // "Sign me up": commit the CURRENT actor.  Ungated (self-signup is always
    // allowed); idempotent (no-op if already signed up).
    @routeMutation(authenticated)   // self-signup: any logged-in volunteer signs themselves up
    commitSelf(event_id: number): Markup {
        const actorId = security.current()?.actorId;
        if(actorId === undefined) throw new Error('Not logged in as a volunteer');
        if(!this.hasCommitment(event_id, actorId))
            this.insert({event_id, volunteer_id: actorId, notes: ''});
        return this.reloadEditor(event_id);
    }

    // Quick-add: host/admin signs one named volunteer up (the recent-volunteer
    // menu shortcuts; the dialog's commit() funnels here too).  Positional, so it
    // can be an immediate menu action like uncommit.
    @routeMutation(hostOrAdmin)
    commitVolunteer(event_id: number, volunteer_id: number): Markup {
        if(!this.canManageCommitments())
            throw new Error('Not permitted to sign volunteers up for this event');
        if(!Number.isInteger(volunteer_id) || !volunteer_id)
            throw new Error('Please choose a volunteer');
        if(!this.hasCommitment(event_id, volunteer_id))
            this.insert({event_id, volunteer_id, notes: ''});
        return this.reloadEditor(event_id);
    }

    // "Sign someone up": host/admin signs another volunteer up (args from the
    // sign-up dialog's form - strings, like every bodyArgs form).
    @routeMutation(hostOrAdmin)
    commit(args: {event_id?: string|number, volunteer_id?: string|number}): Markup {
        const event_id = Number(args?.event_id);
        const volunteer_id = Number(args?.volunteer_id);
        if(!Number.isInteger(event_id) || !Number.isInteger(volunteer_id) || !volunteer_id)
            throw new Error('Please choose a volunteer');
        return this.commitVolunteer(event_id, volunteer_id);
    }

    // Remove a volunteer's sign-up.  Own always; anyone else's needs host/admin.
    // Immediate (picking the named item is deliberate, and re-adding is trivial).
    @routeMutation(security.or(hostOrAdmin, selfArg(args => Number(args[1]))))   // own removal, or host
    uncommit(event_id: number, volunteer_id: number): Markup {
        const actorId = security.current()?.actorId;
        if(!this.canManageCommitments() && actorId !== volunteer_id)
            throw new Error('Not permitted to remove this sign-up');
        db().execute<{event_id: number, volunteer_id: number}>(
            'DELETE FROM event_commitment WHERE event_id = :event_id AND volunteer_id = :volunteer_id',
            {event_id, volunteer_id});
        dirty.record([sel(this.tableKey()),
                      sel(this.fkKey('event_id', event_id)),
                      sel(this.fkKey('volunteer_id', volunteer_id))]);
        return this.reloadEditor(event_id);
    }

    // Clear the whole sign-up list (host/admin; confirm-gated - it's bulk).
    @routeMutation(hostOrAdmin)
    uncommitAll(event_id: number): Markup {
        if(!this.canManageCommitments())
            throw new Error('Not permitted to remove sign-ups for this event');
        db().execute<{event_id: number}>(
            'DELETE FROM event_commitment WHERE event_id = :event_id', {event_id});
        // Bulk delete: the affected volunteers aren't enumerated (no fragment
        // registers commitment volunteer keys today) - event + table keys only.
        dirty.record([sel(this.tableKey()), sel(this.fkKey('event_id', event_id))]);
        return this.reloadEditor(event_id);
    }

    // The sign-someone-up dialog: one volunteer picker, event id riding hidden.
    @route(hostOrAdmin)
    commitDialog(event_id: number): Markup {
        if(!this.canManageCommitments())
            throw new Error('Not permitted to sign volunteers up for this event');
        return action.renderParamForm(
            [new VolunteerForeignKeyField('volunteer_id', {})],
            {},
            {
                title: 'Sign a volunteer up',
                submitLabel: 'Sign up',
                hidden: {event_id},
                fieldContext: {ownerPath: 'rabid.event_commitment'},
                dispatch: {onsubmit:
                    'event.preventDefault(); tx`rabid.event_commitment.commit(${getFormJSON(event.target)})`'},
            });
    }

    // The reloadable sign-up fragment: the signed-up names + the one ☰.  Lives
    // inside the fragment so a sign-up reload regenerates it (the per-person
    // remove items and the recent quick-adds must track the roster).  Menu order
    // is ACTION-primary, not target-primary: all the adds, then all the removes.
    @route(authenticated)
    renderCommitmentEditor(event_id: number): Markup {
        const commitments = this.commitmentsForEventWithVolunteerName.all({event_id});
        const actorId = security.current()?.actorId;
        const canManage = this.canManageCommitments();
        const isCommitted = actorId !== undefined && commitments.some(c => c.volunteer_id === actorId);
        const committedIds = new Set(commitments.map(c => c.volunteer_id));
        // The roster is WHERE event_id, so register this table's event fk key.
        const props = reloadableProps([this.fkKey('event_id', event_id)],
            `rabid.event_commitment.renderCommitmentEditor(${event_id})`);

        const items: action.ActionMenuItem[] = [];
        // Add verbs: self-signup, then the recent-volunteer quick-adds, then the
        // catch-all picker for anyone not in the recent list.
        if(actorId !== undefined && !isCommitted)
            items.push({label: 'Sign me up',
                        mode: {kind: 'immediate', expr: `rabid.event_commitment.commitSelf(${event_id})`}});
        if(canManage) {
            for(const v of activeVolunteersWithin(30)
                    .filter(v => !committedIds.has(v.volunteer_id) && v.volunteer_id !== actorId))
                items.push({label: `Sign up ${shortName(v)}`,
                            mode: {kind: 'immediate',
                                   expr: `rabid.event_commitment.commitVolunteer(${event_id},${v.volunteer_id})`}});
            items.push({label: 'Sign someone up…',
                        mode: {kind: 'modal', dialogUrl: `/rabid.event_commitment.commitDialog(${event_id})`}});
        }
        // Remove verbs (own row always; others only with host/admin), grouped.
        const manageable = commitments.filter(c => canManage || c.volunteer_id === actorId);
        if(items.length > 0 && manageable.length > 0) items.push('divider');
        for(const c of manageable)
            items.push({label: c.volunteer_id === actorId ? 'Remove me' : `Remove ${memberShortName(c)}`,
                        mode: {kind: 'immediate',
                               expr: `rabid.event_commitment.uncommit(${event_id},${c.volunteer_id})`}});
        if(canManage && commitments.length >= 2)
            items.push({label: 'Remove everyone…',
                        mode: {kind: 'confirm',
                               expr: `rabid.event_commitment.uncommitAll(${event_id})`,
                               message: `Remove all ${commitments.length} sign-ups?`}});

        return [h.span, {...props, class: 'lm-name-list ' + props.class},
            commitments.length === 0
                ? [h.span, {class: 'text-muted small'}, 'nobody yet']
                : joinNames(commitments.map(c => this.renderCommitmentName(c))),
            items.length > 0
                ? [commitments.length > 0 ? ' ' : '', action.actionMenu(items, {ariaLabel: 'Sign-up actions'})]
                : undefined,
        ];
    }

    // One signed-up volunteer as inline text: short name, a quiet link to the volunteer page.
    renderCommitmentName(c: EventCommitment & MemberName): Markup {
        return [h.span, {class: 'lm-member', 'data-testid': `commitment-${c.volunteer_id}`},
            templates.pageLink(`/rabid.volunteer.detailPage(${c.volunteer_id})`, memberShortName(c))];
    }
}

// --------------------------------------------------------------------------------
// --- EventCheckin ---------------------------------------------------------------
// --------------------------------------------------------------------------------
//
// "I came" - a volunteer (or staff member) who actually showed up to an event.
// This is the primary way volunteer time is captured: a single check-in is far
// easier to get accurate than a full timesheet entry (it can be done
// retroactively, a host can check everyone in at once, and it gives the event
// page a real attendance list).  Hours come from the event's times; the optional
// start_time/end_time override them for partial attendance (NULL = "use the
// event's times").  was_staff snapshots the person's employment status AT
// check-in, because grant reporting needs point-in-time truth.

export interface EventCheckin {
    event_checkin_id: number;

    event_id: number;
    volunteer_id: number;

    // Snapshot of volunteer.is_staff at check-in time (so later employment
    // changes don't rewrite who counts as staff for past events).
    was_staff: boolnum;

    // Optional overrides of the event's times for partial attendance.  NULL
    // means "use the event's start_time/end_time" (the common case).
    start_time?: string;
    end_time?: string;

    // For volunteers whose hours must be vouched for (volunteer.volunteer_hours_
    // _need_confirmation): the host/admin who confirmed this check-in.  NULL =
    // unconfirmed.  Cleared automatically when a non-host edits the check-in.
    confirmed_by?: number | null;

    // Optional duration the volunteer actually contributed, in minutes.  This is
    // the simplified partial-attendance affordance for volunteers (and the host
    // posthumously recording "they were here ~90 min"): when set it is the
    // authoritative "how long", winning over the event window and any start/end
    // override, and it may exceed the event length (e.g. extra setup time).  NULL
    // means "use the event's times" (the common, default case).
    time_volunteered_minutes?: number;

    notes: string;

    // When the check-in record was created (managed, hidden from the form).
    created_time?: string;
}

export type EventCheckinOpt = Partial<EventCheckin>;

// A generic face/person outline for a checked-in volunteer with no photo, so every
// tile in the face grid is the same shape (Bootstrap Icons person-fill, MIT).
function faceOutlineSvg(): Markup {
    return ['svg', {viewBox: '0 0 16 16', fill: 'currentColor', width: '55%', height: '55%',
                    'aria-hidden': 'true'},
        ['path', {d: 'M3 14s-1 0-1-1 1-4 6-4 6 3 6 4-1 1-1 1zm5-6a3 3 0 1 0 0-6 3 3 0 0 0 0 6'}]];
}

export class EventCheckinTable extends Table<EventCheckin> {

    constructor() {
        super ('event_checkin', [
            new PrimaryKeyField('event_checkin_id', {}),
            new ForeignKeyField('event_id', 'event', 'event_id', {}, 'description'),
            new VolunteerForeignKeyField('volunteer_id', {}),
            new BooleanField('was_staff', {default: 0}),
            new DateTimeField('start_time', {nullable: true}),
            new DateTimeField('end_time', {nullable: true}),
            new IntegerField('time_volunteered_minutes', {nullable: true, prompt: 'Time volunteered (minutes)'}),
            // Host/admin who confirmed this check-in (community-service hours etc);
            // NULL = unconfirmed.  Hidden: set by the confirm action, cleared on a
            // non-host edit (see editCheckin), never edited in the form.
            new HiddenVolunteerRefField('confirmed_by', {nullable: true}),
            new MarkdownField('notes', {default: ''}),
            new ManagedDateTimeField('created_time', {nullable: true}),
        ], [
            // One check-in per volunteer per event.  (event_id-leading, so it
            // also serves the "recent events -> their check-ins" join in the
            // active-volunteer query.)
            'CREATE UNIQUE INDEX IF NOT EXISTS event_checkin_unique ON event_checkin(event_id, volunteer_id);',
            'CREATE INDEX IF NOT EXISTS event_checkin_by_volunteer_id ON event_checkin(volunteer_id);',
            // Partial index for the rare explicit arrival-time override: lets the
            // "active in last N days" query find override-recent check-ins without
            // scanning the table.  Most check-ins inherit the event time
            // (start_time NULL), so this index stays tiny.
            'CREATE INDEX IF NOT EXISTS event_checkin_by_start_time ON event_checkin(start_time) WHERE start_time IS NOT NULL;',
        ])
    };

    // A check-in belongs to its volunteer (drives isSelf), like a timesheet entry.
    ownerId(c: EventCheckin): number|undefined { return c.volunteer_id; }

    defaultFieldEdit: security.Permission = checkinSelfOrHost;
    override get recordEdit(): security.Permission { return checkinSelfOrHost; }

    // Stamp the creation time, and snapshot was_staff from the volunteer's
    // current employment status when the caller didn't set it explicitly.
    override insert<P extends Partial<EventCheckin>>(tuple: P): number {
        const withManaged: any = {created_time: date.currentSqliteDateTime(), ...tuple};
        if(withManaged.was_staff === undefined && withManaged.volunteer_id != null) {
            const v = security.runSystem(() =>
                db().prepare<{is_staff: boolnum}, {id: number}>(
                    'SELECT is_staff FROM volunteer WHERE volunteer_id = :id')
                    .first({id: withManaged.volunteer_id}));
            withManaged.was_staff = v?.is_staff ?? 0;
        }
        return super.insert(withManaged);
    }

    // A volunteer's check-ins, with the event name/times (for the volunteer page
    // and hours).  Most recent first by effective start.
    @path
    get checkinsForVolunteer() {
        return db().prepare<EventCheckin & {event_description: string|null,
                                            event_start_time: string|null, event_end_time: string|null},
                            {volunteer_id: number}>(block`
/**/   SELECT event_checkin.*, event.description AS event_description,
/**/          event.start_time AS event_start_time, event.end_time AS event_end_time
/**/          FROM event_checkin
/**/          LEFT JOIN event USING (event_id)
/**/          WHERE event_checkin.volunteer_id = :volunteer_id
/**/          ORDER BY COALESCE(event_checkin.start_time, event.start_time) DESC`);
    }

    // An event's check-ins, with the volunteer name.
    @path
    get checkinsForEvent() {
        return db().prepare<EventCheckin & MemberName, {event_id: number}>(block`
/**/   SELECT event_checkin.*, volunteer.name AS volunteer_name,
/**/          volunteer.short_name AS volunteer_short_name
/**/          FROM event_checkin
/**/          LEFT JOIN volunteer USING (volunteer_id)
/**/          WHERE event_checkin.event_id = :event_id
/**/          ORDER BY volunteer.name`);
    }

    // ------------------------------------------------------------------------
    // --- Check-in editor (the attendance UI) ---------------------------------
    // ------------------------------------------------------------------------
    //
    // Modelled on the group member editor's interaction language: the attendee
    // names as a document phrase ("Hazel, Bob (staff) and Carol") plus ONE ☰
    // holding every check-in verb.  "Check me in" is the always-allowed
    // self-signup (a volunteer org's dominant flow - I'll take that); checking
    // OTHERS in/out (the host's "check everyone in") needs host/admin.

    // Can the current actor manage anyone's check-in on this event (host/admin)?
    // Self check-in / check-out is allowed regardless and handled per-action.
    private canManageCheckins(): boolean {
        const ctx = security.current();
        if(!ctx || ctx.system) return true;
        return hostOrAdmin({ctx});
    }

    private hasCheckin(event_id: number, volunteer_id: number): boolean {
        return !!db().prepare<{n: number}, {event_id: number, volunteer_id: number}>(
            'SELECT 1 AS n FROM event_checkin WHERE event_id = :event_id AND volunteer_id = :volunteer_id')
            .first({event_id, volunteer_id});
    }

    // The check-in fragments register this table's event fk key, and the
    // volunteer's reconciled Time view registers its volunteer fk key
    // (volunteer_time.ts) - inserts/updates notify both via the automatic
    // emission, and the raw-SQL deletes below hand-record the same keys.
    private reloadEditor(_event_id: number, _volunteerIds: number[] = []): Markup {
        return {action: 'reload'} as unknown as Markup;
    }

    // "Check me in": sign the CURRENT actor in.  Ungated (self-signup is always
    // allowed); idempotent (no-op if already checked in).  insert() snapshots
    // was_staff from the volunteer's current is_staff.
    @routeMutation(authenticated)   // self-signup: any logged-in volunteer checks themselves in
    checkSelfIn(event_id: number): Markup {
        const actorId = security.current()?.actorId;
        if(actorId === undefined) throw new Error('Not logged in as a volunteer');
        if(!this.hasCheckin(event_id, actorId))
            this.insert({event_id, volunteer_id: actorId, notes: ''});
        return this.reloadEditor(event_id, [actorId]);
    }

    // Quick-add: host/admin checks one named volunteer in (the recent-volunteer
    // menu shortcuts; the dialog's checkIn() funnels here too).  Positional, so it
    // can be an immediate menu action like checkOut.
    @routeMutation(hostOrAdmin)
    checkInVolunteer(event_id: number, volunteer_id: number): Markup {
        if(!this.canManageCheckins())
            throw new Error('Not permitted to check volunteers into this event');
        if(!Number.isInteger(volunteer_id) || !volunteer_id)
            throw new Error('Please choose a volunteer');
        if(!this.hasCheckin(event_id, volunteer_id))
            this.insert({event_id, volunteer_id, notes: ''});
        return this.reloadEditor(event_id, [volunteer_id]);
    }

    // "Check someone in": host/admin checks another volunteer in (args from the
    // check-in dialog's form - strings, like every bodyArgs form).
    @routeMutation(hostOrAdmin)     // checking SOMEONE ELSE in
    checkIn(args: {event_id?: string|number, volunteer_id?: string|number}): Markup {
        const event_id = Number(args?.event_id);
        const volunteer_id = Number(args?.volunteer_id);
        if(!Number.isInteger(event_id) || !Number.isInteger(volunteer_id) || !volunteer_id)
            throw new Error('Please choose a volunteer');
        return this.checkInVolunteer(event_id, volunteer_id);
    }

    // Check a volunteer out (remove their check-in).  Own check-in always; anyone
    // else's needs host/admin.  Immediate (picking the named item is deliberate).
    @routeMutation(security.or(hostOrAdmin, selfArg(args => Number(args[1]))))   // own check-out, or host
    checkOut(event_id: number, volunteer_id: number): Markup {
        const actorId = security.current()?.actorId;
        if(!this.canManageCheckins() && actorId !== volunteer_id)
            throw new Error('Not permitted to check out this volunteer');
        db().execute<{event_id: number, volunteer_id: number}>(
            'DELETE FROM event_checkin WHERE event_id = :event_id AND volunteer_id = :volunteer_id',
            {event_id, volunteer_id});
        dirty.record([sel(this.tableKey()),
                      sel(this.fkKey('event_id', event_id)),
                      sel(this.fkKey('volunteer_id', volunteer_id))]);
        return this.reloadEditor(event_id, [volunteer_id]);
    }

    // Clear the whole attendance list (host/admin; confirm-gated - it's bulk).
    @routeMutation(hostOrAdmin)
    checkOutAll(event_id: number): Markup {
        if(!this.canManageCheckins())
            throw new Error('Not permitted to check out volunteers for this event');
        const vids = db().prepare<{volunteer_id: number}, {event_id: number}>(
            'SELECT volunteer_id FROM event_checkin WHERE event_id = :event_id')
            .all({event_id}).map(r => r.volunteer_id);
        db().execute<{event_id: number}>(
            'DELETE FROM event_checkin WHERE event_id = :event_id', {event_id});
        dirty.record([sel(this.tableKey()),
                      sel(this.fkKey('event_id', event_id)),
                      ...vids.map(v => sel(this.fkKey('volunteer_id', v)))]);
        return this.reloadEditor(event_id, vids);
    }

    // The check-someone-in dialog: one volunteer picker, event id riding hidden.
    @route(hostOrAdmin)
    checkInDialog(event_id: number): Markup {
        if(!this.canManageCheckins())
            throw new Error('Not permitted to check volunteers into this event');
        return action.renderParamForm(
            [new VolunteerForeignKeyField('volunteer_id', {})],
            {},
            {
                title: 'Check a volunteer in',
                submitLabel: 'Check in',
                hidden: {event_id},
                fieldContext: {ownerPath: 'rabid.event_checkin'},
                dispatch: {onsubmit:
                    'event.preventDefault(); tx`rabid.event_checkin.checkIn(${getFormJSON(event.target)})`'},
            });
    }

    // Edit one check-in's time overrides + notes (the less-common detailed flow).
    // Identity (event/volunteer) and the was_staff snapshot are NOT editable.
    // Own check-in always; anyone else's needs host/admin.
    private assertCanManageCheckin(c: EventCheckin): void {
        if(!this.canManageCheckins() && security.current()?.actorId !== c.volunteer_id)
            throw new Error('Not permitted to edit this check-in');
    }

    @route(authenticated)   // pk-keyed: the method's assertCanManageCheckin does self-or-host
    editCheckinDialog(event_checkin_id: number): Markup {
        const c = this.getById(event_checkin_id);
        this.assertCanManageCheckin(c);
        const v = security.runSystem(() =>
            db().prepare<{name: string, short_name: string}, {id: number}>(
                'SELECT name, short_name FROM volunteer WHERE volunteer_id = :id').first({id: c.volunteer_id}));
        const name = v ? shortName(v) : 'volunteer';
        return action.renderParamForm(
            [this.fieldsByName.start_time, this.fieldsByName.end_time,
             this.fieldsByName.time_volunteered_minutes, this.fieldsByName.notes],
            {start_time: c.start_time, end_time: c.end_time,
             time_volunteered_minutes: c.time_volunteered_minutes, notes: c.notes},
            {
                title: `Edit ${name}'s check-in`,
                submitLabel: 'Save',
                hidden: {event_checkin_id},
                dispatch: {onsubmit:
                    'event.preventDefault(); tx`rabid.event_checkin.editCheckin(${getFormJSON(event.target)})`'},
            });
    }

    @routeMutation(authenticated)   // pk-keyed: the method's assertCanManageCheckin does self-or-host
    editCheckin(args: {event_checkin_id?: string|number, start_time?: string, end_time?: string,
                       time_volunteered_minutes?: string|number, notes?: string}): Markup {
        const id = Number(args?.event_checkin_id);
        if(!Number.isInteger(id)) throw new Error('bad check-in id');
        const c = this.getById(id);
        this.assertCanManageCheckin(c);
        // Empty time inputs clear the override (revert to the event's times).
        const trim = (s?: string) => (s != null && String(s).trim() !== '') ? String(s) : null;
        // Empty time_volunteered clears it (revert to the whole-event default);
        // otherwise a non-negative whole number of minutes.
        const minutes = (() => {
            const raw = args.time_volunteered_minutes;
            if(raw == null || String(raw).trim() === '') return null;
            const n = Math.round(Number(raw));
            if(!Number.isFinite(n) || n < 0)
                throw new Error('Time volunteered must be a non-negative number of minutes');
            return n;
        })();
        this.update(id, {
            start_time: trim(args.start_time),
            end_time: trim(args.end_time),
            time_volunteered_minutes: minutes,
            notes: args.notes ?? '',
            // A non-host editing the hours invalidates any host confirmation.
            ...(this.canManageCheckins() ? {} : {confirmed_by: null}),
        } as Partial<EventCheckin>);
        return this.reloadEditor(c.event_id, [c.volunteer_id]);
    }

    // Host/admin confirms (or un-confirms) a volunteer's check-in hours, stamping
    // who vouched for them.  Reloads the check-in fragment + the volunteer's Time
    // fragment (where the confirm affordance lives).  Self cannot confirm.
    @routeMutation(hostOrAdmin)
    confirmCheckin(event_checkin_id: number): Markup {
        const c = this.getById(event_checkin_id);
        const actorId = security.current()?.actorId ?? null;
        this.update(event_checkin_id, {confirmed_by: actorId} as Partial<EventCheckin>);
        return this.reloadEditor(c.event_id, [c.volunteer_id]);
    }
    @routeMutation(hostOrAdmin)
    unconfirmCheckin(event_checkin_id: number): Markup {
        const c = this.getById(event_checkin_id);
        this.update(event_checkin_id, {confirmed_by: null} as Partial<EventCheckin>);
        return this.reloadEditor(c.event_id, [c.volunteer_id]);
    }

    // The reloadable attendance fragment: the attendee names + the one ☰.  Lives
    // inside the fragment so a check-in reload regenerates it (the per-person
    // check-out items must track the roster).
    // The check-in ☰ verbs (self check-in, host quick-adds + picker, per-person
    // check-out / edit, check-everyone-out).  Shared by the inline editor and the
    // face grid so both drive check-ins from the same menu.  (A helper, not a route.)
    checkinMenuItems(event_id: number, checkins: (EventCheckin & MemberName)[]): action.ActionMenuItem[] {
        const actorId = security.current()?.actorId;
        const canManage = this.canManageCheckins();
        const isCheckedIn = actorId !== undefined && checkins.some(c => c.volunteer_id === actorId);
        const checkedInIds = new Set(checkins.map(c => c.volunteer_id));
        const items: action.ActionMenuItem[] = [];
        // Add verbs: self check-in, then the recent-volunteer quick-adds, then the
        // catch-all picker for anyone not in the recent list.
        if(actorId !== undefined && !isCheckedIn)
            items.push({label: 'Check me in',
                        mode: {kind: 'immediate', expr: `rabid.event_checkin.checkSelfIn(${event_id})`}});
        if(canManage) {
            for(const v of activeVolunteersWithin(30)
                    .filter(v => !checkedInIds.has(v.volunteer_id) && v.volunteer_id !== actorId))
                items.push({label: `Check in ${shortName(v)}`,
                            mode: {kind: 'immediate',
                                   expr: `rabid.event_checkin.checkInVolunteer(${event_id},${v.volunteer_id})`}});
            items.push({label: 'Check someone in…',
                        mode: {kind: 'modal', dialogUrl: `/rabid.event_checkin.checkInDialog(${event_id})`}});
        }
        // Per-person verbs (own row always; others only with host/admin), ordered
        // ACTION-primary, not target-primary: all the check-outs, then all the
        // detailed edits (times/notes).
        const manageable = checkins.filter(c => canManage || c.volunteer_id === actorId);
        if(items.length > 0 && manageable.length > 0) items.push('divider');
        for(const c of manageable) {
            const self = c.volunteer_id === actorId;
            items.push({label: self ? 'Check me out' : `Check out ${memberShortName(c)}`,
                        mode: {kind: 'immediate',
                               expr: `rabid.event_checkin.checkOut(${event_id},${c.volunteer_id})`}});
        }
        for(const c of manageable) {
            const self = c.volunteer_id === actorId;
            items.push({label: self ? 'Edit my check-in…' : `Edit ${memberShortName(c)}'s check-in…`,
                        mode: {kind: 'modal',
                               dialogUrl: `/rabid.event_checkin.editCheckinDialog(${c.event_checkin_id})`}});
        }
        if(canManage && checkins.length >= 2)
            items.push({label: 'Check everyone out…',
                        mode: {kind: 'confirm',
                               expr: `rabid.event_checkin.checkOutAll(${event_id})`,
                               message: `Check out all ${checkins.length} volunteers?`}});
        return items;
    }

    // An event's check-ins with each volunteer's photo + short name, for the face
    // grid.  (A superset of checkinsForEvent - adds volunteer.photo.)
    @path
    get checkedInWithPhotos() {
        return db().prepare<EventCheckin & MemberName & {volunteer_photo: string|null}, {event_id: number}>(block`
/**/   SELECT event_checkin.*, volunteer.name AS volunteer_name,
/**/          volunteer.short_name AS volunteer_short_name, volunteer.photo AS volunteer_photo
/**/          FROM event_checkin LEFT JOIN volunteer USING (volunteer_id)
/**/          WHERE event_checkin.event_id = :event_id
/**/          ORDER BY volunteer.name`);
    }

    // "Who's here" as a face grid: each checked-in volunteer's photo (or a generic
    // face outline when they have none) with their short name beneath, so people
    // can match faces to names on a busy shift.  A responsive grid (tiles reflow to
    // the device width).  LIVE + shares the check-in ☰.
    @route(authenticated)
    renderCheckinGrid(event_id: number): Markup {
        const checkins = security.runSystem(() => this.checkedInWithPhotos.all({event_id}));
        const props = liveReloadableProps([this.fkKey('event_id', event_id)],
            `rabid.event_checkin.renderCheckinGrid(${event_id})`);
        const items = this.checkinMenuItems(event_id, checkins);
        return [h.div, {...props, id: 'volunteers'},
            [h.div, {class: 'lm-doc-section-head'},
             // "Volunteers here" (not just "Volunteers") to distinguish who's
             // actually present/checked in from "Signed up" (who committed).
             [h.h4, {class: 'lm-doc-section-label'}, 'Volunteers here'],
             items.length ? action.actionMenu(items, {ariaLabel: 'Check-in actions'}) : undefined],
            [h.div, {class: 'lm-subsection'},
             checkins.length === 0
                 ? [h.p, {class: 'text-muted small mb-0'}, 'No one checked in yet.']
                 : [h.div, {style: 'display:grid; grid-template-columns:repeat(auto-fill,minmax(84px,1fr)); gap:0.75rem;'},
                    checkins.map(c => this.renderFaceTile(c))]],
        ];
    }
    private renderFaceTile(c: EventCheckin & MemberName & {volunteer_photo: string|null}): Markup {
        const has = typeof c.volunteer_photo === 'string' && c.volunteer_photo !== '';
        const face = has
            ? rabid.photo.aspectImg(c.volunteer_photo!, 'square', 'thumb',
                {style: 'width:100%; aspect-ratio:1; object-fit:cover; border-radius:8px; display:block;'})
            : [h.div, {'aria-hidden': 'true',
                       style: 'width:100%; aspect-ratio:1; border-radius:8px; background:var(--bs-secondary-bg); '
                            + 'color:var(--bs-secondary-color); display:flex; align-items:center; justify-content:center;'},
               faceOutlineSvg()];
        return [h.a, {...templates.pageLinkProps(`/rabid.volunteer.detailPage(${c.volunteer_id})`),
                      class: 'text-decoration-none text-body text-center d-block',
                      'data-testid': `face-${c.volunteer_id}`},
            face,
            [h.div, {class: 'small text-truncate mt-1'}, memberShortName(c)],
            c.was_staff ? [h.div, {class: 'badge text-bg-light border', style: 'font-size:0.65rem;'}, 'staff'] : undefined];
    }

    @route(authenticated)
    renderCheckinEditor(event_id: number): Markup {
        const checkins = this.checkinsForEvent.all({event_id});
        // The roster is WHERE event_id, so register this table's event fk key.
        // LIVE: on event day several hosts check people in at once - the
        // roster tracks other actors' check-ins.
        const props = liveReloadableProps([this.fkKey('event_id', event_id)],
            `rabid.event_checkin.renderCheckinEditor(${event_id})`);
        const items = this.checkinMenuItems(event_id, checkins);

        return [h.span, {...props, class: 'lm-name-list ' + props.class},
            checkins.length === 0
                ? [h.span, {class: 'text-muted small'}, 'nobody yet']
                : joinNames(checkins.map(c => this.renderCheckinName(c))),
            items.length > 0
                ? [checkins.length > 0 ? ' ' : '', action.actionMenu(items, {ariaLabel: 'Check-in actions'})]
                : undefined,
        ];
    }

    // One attendee as inline text: short name (quiet link to the volunteer page),
    // staff marked (attendance mixes volunteers and staff).
    renderCheckinName(c: EventCheckin & MemberName): Markup {
        return [h.span, {class: 'lm-member', 'data-testid': `checkin-${c.volunteer_id}`},
            templates.pageLink(`/rabid.volunteer.detailPage(${c.volunteer_id})`, memberShortName(c)),
            c.was_staff ? [h.span, {class: 'text-muted small'}, ' (staff)'] : undefined];
    }
}

// "A", "A and B", "A, B and C" - a set of names as a document phrase.
function joinNames(parts: Markup[]): Markup[] {
    return parts.flatMap((p, i) =>
        i === 0 ? [p] : [i === parts.length - 1 ? ' and ' : ', ', p]);
}

//export const eventMetaData = new EventTable();

// export function insertEvent(event: EventOpt): number {
//     return db().insert<EventOpt, 'event_id'>('event', event, 'event_id');
// }

// export function updateEvent<T extends Partial<Event>>(event_id: number, fieldNames:Array<keyof T>, fields: T) {
//     return db().update<T>('event', 'event_id', fieldNames, event_id, fields);
// }

// export const selectEvent = ()=>db().prepare<Event, {event_id: number}>(block`
// /**/   SELECT ${eventMetaData.allFields}
// /**/          FROM event
// /**/          WHERE event_id = :event_id`);

// export function deleteEvent(event_id: number) {
//     db().execute<{event_id: number}>
//         ('DELETE FROM TABLE event WHERE event_id = :event_id', {event_id});
// }

