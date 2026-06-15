// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types

import * as utils from "../liminal/utils.ts";
import {unwrap} from "../liminal/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "../liminal/db.ts";
import * as date from "../liminal/date.ts";
import { Table, TableView, TableRenderer, Field, PrimaryKeyField, ForeignKeyField, BooleanField, StringField, MarkdownField, EnumField, IntegerField, FloatingPointField, DateTimeField, navChevron } from "../liminal/table.ts";
import {block} from "../liminal/strings.ts";
import {serializeAs, setSerialized, path} from "../liminal/serializable.ts";
import { faker } from "@faker-js/faker";
import {Markup, h} from "../liminal/markup.ts";
import * as security from "../liminal/security.ts";
import * as templates from './templates.ts';

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
    'shopTime': 'Shop Time',
};

export interface Event {
    event_id: number;
    event_kind: string;
    description: string;

    location_description: string;
    location_url: string;
    // Should be set to true for events that are not held at our shop
    is_remote_event: boolnum;

    volunteer_only: boolnum;

    shop_load_time?: string;
    setup_time?: string;

    start_time?: string;
    end_time?: string;

    total_cash_collected: number;

    notes: string;
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
            new DateTimeField('shop_load_time', {nullable: true}),
            new DateTimeField('setup_time', {nullable: true}),
            new DateTimeField('start_time', {nullable: true}),
            new DateTimeField('end_time', {nullable: true}),
            new FloatingPointField('total_cash_collected', {default: 0}),
            new MarkdownField('notes', {default: ''})
        ],[
            'CREATE INDEX IF NOT EXISTS event_by_start_time ON event(start_time);'
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

    // The top-level Events page body (dispatched from the navbar's /events).
    // For now just the full standard list; about to grow more structured
    // content (upcoming highlights, per-period summaries, etc).
    renderEventsPage(): Markup {
        return [h.div, {class: 'container py-3'},
            [h.h2, {}, 'Events'],
            this.renderEventList(this.allEvents.all()),
        ];
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

    eventBadges(e: Event): Markup {
        return [
            [h.span, {class: `card-badge event-${e.event_kind}`},
             event_kind_enum[e.event_kind] ?? e.event_kind],
            e.volunteer_only ? [h.span, {class: 'volunteer-only-badge'}, 'Volunteers only'] : undefined,
            e.is_remote_event ? [h.span, {class: 'remote-event-badge'}, 'Remote'] : undefined,
        ];
    }

    renderEventRow(e: Event): Markup {
        const id = e.event_id;
        const secondary = [this.timeRangeText(e), e.location_description].filter(Boolean).join(' · ');

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
    renderEventRowById(id: number): Markup {
        return this.renderEventRow(this.getById(id));
    }

    // ------------------------------------------------------------------------
    // --- Event detail page ---------------------------------------------------
    // ------------------------------------------------------------------------

    // The navigable destination for list rows: the summary card (time,
    // location, committed volunteers) under a header with the host-only pencil.
    detailPage(event_id: number): templates.Page {
        const e = this.getById(event_id);
        return templates.page(`${e.description || 'Event'} — Event`, this.renderEventDetail(event_id));
    }

    // Reloadable fragment (an edit save re-renders it).
    renderEventDetail(event_id: number): Markup {
        const e = this.getById(event_id);
        const props = this.reloadableItemProps(event_id, `rabid.event.renderEventDetail(${event_id})`);
        props.class = 'container py-3 ' + props.class;
        return [h.div, props,
            [h.div, {class: 'd-flex align-items-center gap-2 mb-3'},
             [h.h2, {class: 'mb-0'}, e.description || 'Untitled Event'],
             this.canEditRecord(e) ? this.editPencil(event_id) : undefined],
            this.renderEventSummary(event_id, {titleLink: false}),
        ];
    }

    renderUpcomingEvents(): Markup {
        // --- Query all events in the next 6 weeks, including all events today.

        // --- Render as a ul with the body given by renderEventSummary

        // All date math in org wall-clock time via Temporal (the previous
        // new Date()/toISOString() version computed its bounds and week labels
        // through UTC, shifting both by a day depending on the server's zone).
        const today = date.orgToday();
        const startDate = `${today.toString()} 00:00:00`;
        const endDate = `${today.add({days: 42}).toString()} 23:59:59`; // 6 weeks = 42 days

        // Query upcoming events
        const upcomingEvents = db().prepare<Event, {start_date: string, end_date: string}>(block`
            SELECT ${this.allFields}
            FROM event
            WHERE start_time >= :start_date
              AND start_time <= :end_date
            ORDER BY start_time`).all({start_date: startDate, end_date: endDate});

        if (upcomingEvents.length === 0) {
            return [h.div, {class: 'no-upcoming-events'},
                [h.p, {}, 'No upcoming events scheduled in the next 6 weeks.']
            ];
        }

        // Group events by week (Sunday-start; Temporal dayOfWeek is Mon=1..Sun=7)
        const eventsByWeek = new Map<string, Event[]>();

        for (const event of upcomingEvents) {
            if (!event.start_time) continue;

            const eventDay = date.sqliteDateToTemporal(date.extractDateFromDateTime(event.start_time));
            const weekStart = eventDay.subtract({days: eventDay.dayOfWeek % 7});
            const weekKey = weekStart.toString();

            if (!eventsByWeek.has(weekKey)) {
                eventsByWeek.set(weekKey, []);
            }
            eventsByWeek.get(weekKey)!.push(event);
        }

        // Build the markup
        const sections: Markup[] = [];

        for (const [weekKey, events] of eventsByWeek) {
            const weekStart = date.sqliteDateToTemporal(weekKey);
            const weekEnd = weekStart.add({days: 6});

            // Week header
            sections.push([h.h3, {class: 'week-header'},
                `Week of ${date.dateToString(weekStart)} - ${date.dateToString(weekEnd)}`
            ]);

            // Events for this week
            const eventItems = events.map(event =>
                [h.li, {class: 'event-item'}, this.renderEventSummary(event.event_id)]
            );

            sections.push([h.ul, {class: 'event-list'}, ...eventItems]);
        }

        return [h.div, {class: 'upcoming-events'},
            [h.h2, {}, 'Upcoming Events'],
            [h.p, {class: 'event-count'}, `${upcomingEvents.length} events scheduled in the next 6 weeks`],
            ...sections
        ];
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
    renderEventSummary(event_id: number, opts: {titleLink?: boolean} = {}): Markup {
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
        const commitments = db().prepare<{volunteer_name: string}, {event_id: number}>(block`
            SELECT volunteer.name AS volunteer_name
            FROM event_commitment
            LEFT JOIN volunteer USING (volunteer_id)
            WHERE event_id = :event_id
            ORDER BY volunteer.name`).all({event_id});

        // Get check-ins ("showed up") for this event.
        const checkins = db().prepare<{volunteer_name: string, was_staff: boolnum}, {event_id: number}>(block`
            SELECT volunteer.name AS volunteer_name, event_checkin.was_staff
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
        const title = [h.strong, {}, event.description || 'Untitled Event'];
        headerElements.push(
            titleLink
                ? [h.a, {...templates.pageLinkProps(`/rabid.event.detailPage(${event_id})`),
                         class: 'card-title'}, title]
                : [h.span, {class: 'card-title'}, title]
        );
        
        // Event kind badge
        if (event.event_kind) {
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

        // Remote indicator
        if (event.is_remote_event) {
            headerElements.push(' ');
            headerElements.push(
                [h.span, {class: 'remote-event-badge'}, '(Remote)']
            );
        }
        
        // Build grid rows for details
        const gridRows: Markup[] = [];
        
        // Time row
        if (timeParts.length > 0) {
            gridRows.push(
                [h.div, {class: 'card-detail-row'},
                    [h.div, {}, 'Time:'],
                    [h.div, {}, timeParts.join('')]
                ]
            );
        }
        
        // Location row
        if (event.location_description) {
            const locationValue: Markup[] = [];
            if (event.location_url) {
                locationValue.push(
                    [h.a, {href: event.location_url, target: '_blank', class: 'location-link'}, 
                        event.location_description
                    ]
                );
            } else {
                locationValue.push(event.location_description);
            }
            
            gridRows.push(
                [h.div, {class: 'card-detail-row'},
                    [h.div, {}, 'Location:'],
                    [h.div, {}, ...locationValue]
                ]
            );
        }
        
        // Special timing rows
        if (event.shop_load_time) {
            gridRows.push(
                [h.div, {class: 'card-detail-row'},
                    [h.div, {}, 'Shop load:'],
                    [h.div, {}, date.sqliteDateTimeToTimeString(event.shop_load_time)]
                ]
            );
        }
        if (event.setup_time) {
            gridRows.push(
                [h.div, {class: 'card-detail-row'},
                    [h.div, {}, 'Setup:'],
                    [h.div, {}, date.sqliteDateTimeToTimeString(event.setup_time)]
                ]
            );
        }
        
        // Signed-up row (commitments)
        if (commitments.length > 0) {
            gridRows.push(
                [h.div, {class: 'card-detail-row'},
                    [h.div, {}, 'Signed up:'],
                    [h.div, {},
                        `(${commitments.length}) ${commitments.map(c => c.volunteer_name).join(', ')}`
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

        // Checked-in row (actual attendance) - only shown once anyone has
        // checked in.  Staff are marked, since attendance mixes both.
        if (checkins.length > 0) {
            gridRows.push(
                [h.div, {class: 'card-detail-row'},
                    [h.div, {}, 'Checked in:'],
                    [h.div, {},
                        `(${checkins.length}) ` +
                        checkins.map(c => c.was_staff ? `${c.volunteer_name} (staff)` : c.volunteer_name).join(', ')
                    ]
                ]
            );
        }
        
        // Cash collected row (only show if > 0)
        if (event.total_cash_collected && event.total_cash_collected > 0) {
            gridRows.push(
                [h.div, {class: 'card-detail-row'},
                    [h.div, {}, 'Cash collected:'],
                    [h.div, {}, `$${event.total_cash_collected.toFixed(2)}`]
                ]
            );
        }
        
        // Notes row (only show if present)
        if (event.notes && event.notes.trim()) {
            gridRows.push(
                [h.div, {class: 'card-detail-row'},
                    [h.div, {}, 'Notes:'],
                    [h.div, {class: 'card-notes'}, this.fieldsByName.notes.render(event.notes)]
                ]
            );
        }
        
        return [h.div, {class: 'card-summary'}, 
            [h.div, {class: 'card-header'}, ...headerElements],
            [h.div, {class: 'card-details-grid'}, ...gridRows]
        ];
    }
}

// A system-managed datetime: stamped on insert, never shown in the edit form.
class ManagedDateTimeField extends DateTimeField {
    override isVisible(): boolean { return false; }
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
            new ForeignKeyField('volunteer_id', 'volunteer', 'volunteer_id', {}, 'name'),
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
        return db().prepare<(EventCommitment&{volunteer_name: string}), {event_id: number}>(block`
/**/   SELECT ${this.allFields}, volunteer.name AS volunteer_name
/**/          FROM event_commitment LEFT JOIN volunteer USING (volunteer_id)
/**/          WHERE event_id = :event_id`);
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

    notes: string;

    // When the check-in record was created (managed, hidden from the form).
    created_time?: string;
}

export type EventCheckinOpt = Partial<EventCheckin>;

export class EventCheckinTable extends Table<EventCheckin> {

    constructor() {
        super ('event_checkin', [
            new PrimaryKeyField('event_checkin_id', {}),
            new ForeignKeyField('event_id', 'event', 'event_id', {}, 'description'),
            new ForeignKeyField('volunteer_id', 'volunteer', 'volunteer_id', {}, 'name'),
            new BooleanField('was_staff', {default: 0}),
            new DateTimeField('start_time', {nullable: true}),
            new DateTimeField('end_time', {nullable: true}),
            new MarkdownField('notes', {default: ''}),
            new ManagedDateTimeField('created_time', {nullable: true}),
        ], [
            // One check-in per volunteer per event.
            'CREATE UNIQUE INDEX IF NOT EXISTS event_checkin_unique ON event_checkin(event_id, volunteer_id);',
            'CREATE INDEX IF NOT EXISTS event_checkin_by_volunteer_id ON event_checkin(volunteer_id);',
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
        return db().prepare<EventCheckin & {volunteer_name: string}, {event_id: number}>(block`
/**/   SELECT event_checkin.*, volunteer.name AS volunteer_name
/**/          FROM event_checkin
/**/          LEFT JOIN volunteer USING (volunteer_id)
/**/          WHERE event_checkin.event_id = :event_id
/**/          ORDER BY volunteer.name`);
    }

    // Event-attendance section for the volunteer detail page (sibling of the
    // timesheet section): the events this volunteer checked into, with hours.
    renderForVolunteer(volunteer_id: number): Markup {
        const checkins = this.checkinsForVolunteer.all({volunteer_id});
        if(checkins.length === 0)
            return [h.p, {class: 'text-muted'}, 'No event check-ins yet.'];
        const hoursOf = (c: EventCheckin & {event_start_time: string|null, event_end_time: string|null}) =>
            checkinHours(c.start_time ?? c.event_start_time, c.end_time ?? c.event_end_time);
        const totalHours = checkins.reduce((sum, c) => sum + hoursOf(c), 0);
        return [h.table, {class: 'table table-sm'},
            [h.tbody, {},
             [h.tr, {},
              [h.th, {}, 'Date'], [h.th, {}, 'Event'], [h.th, {class: 'text-end'}, 'Hours']],
             checkins.map(c => {
                 const eff = c.start_time ?? c.event_start_time;
                 const hrs = hoursOf(c);
                 return [h.tr, {},
                     [h.td, {}, eff ? date.sqliteDateTimeToDateString(eff) : '—'],
                     [h.td, {}, c.event_description
                         ? templates.pageLink(`/rabid.event.detailPage(${c.event_id})`, c.event_description)
                         : '—'],
                     [h.td, {class: 'text-end'}, hrs ? hrs.toFixed(1) : '—']];
             }),
             [h.tr, {},
              [h.td, {colspan: '2', class: 'text-end fw-bold'}, 'Total'],
              [h.td, {class: 'text-end fw-bold'}, totalHours.toFixed(1)]],
            ]];
    }
}

// Duration of a check-in in hours, given its effective start/end (0 if either
// is missing - e.g. an event with no times, or someone still checked in).
function checkinHours(start: string|null|undefined, end: string|null|undefined): number {
    if(!start || !end) return 0;
    return date.sqliteDateTimeToTemporal(end)
        .since(date.sqliteDateTimeToTemporal(start))
        .total({unit: 'hours'});
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

