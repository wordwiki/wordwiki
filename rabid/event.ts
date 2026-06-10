// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types

import * as utils from "../liminal/utils.ts";
import {unwrap} from "../liminal/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "../liminal/db.ts";
import * as date from "../liminal/date.ts";
import { Table, TableView, TableRenderer, Field, PrimaryKeyField, ForeignKeyField, BooleanField, StringField, EnumField, IntegerField, FloatingPointField, DateTimeField, navigableItemProps, navChevron } from "../liminal/table.ts";
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
            new StringField('notes', {default: ''})
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

        if(this.canEditRecord(e)) {
            const item = this.editableItemProps(id, `rabid.event.renderEventRowById(${id})`);
            return [h.div, {...item, 'data-testid': `event-row-${id}`},
                [h.div, {class: 'lm-item-body'},
                 [h.div, {class: 'lm-item-primary'},
                  templates.pageLink(`/rabid.event.detailPage(${id})`, e.description || 'Untitled Event'),
                  this.eventBadges(e)],
                 [h.div, {class: 'lm-item-secondary'}, secondary]],
                this.editPencil(id),
            ];
        }

        return [h.a, {...navigableItemProps(`/rabid.event.detailPage(${id})`),
                      'data-testid': `event-row-${id}`},
            [h.div, {class: 'lm-item-body'},
             [h.div, {class: 'lm-item-primary'}, e.description || 'Untitled Event', this.eventBadges(e)],
             [h.div, {class: 'lm-item-secondary'}, secondary]],
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
        
        // Get commitments for this event
        const commitments = db().prepare<{volunteer_name: string}, {event_id: number}>(block`
            SELECT volunteer.name AS volunteer_name
            FROM event_commitment 
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
        
        // Volunteer row
        if (commitments.length > 0) {
            gridRows.push(
                [h.div, {class: 'card-detail-row'},
                    [h.div, {}, 'Volunteers:'],
                    [h.div, {}, 
                        `(${commitments.length}) ${commitments.map(c => c.volunteer_name).join(', ')}`
                    ]
                ]
            );
        } else {
            gridRows.push(
                [h.div, {class: 'card-detail-row'},
                    [h.div, {}, 'Volunteers:'],
                    [h.div, {class: 'card-empty-value'}, 
                        [h.em, {}, 'No volunteers signed up yet']
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
                    [h.div, {class: 'card-notes'}, event.notes]
                ]
            );
        }
        
        return [h.div, {class: 'card-summary'}, 
            [h.div, {class: 'card-header'}, ...headerElements],
            [h.div, {class: 'card-details-grid'}, ...gridRows]
        ];
    }
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

