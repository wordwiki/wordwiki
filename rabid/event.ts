// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types

import * as utils from "../liminal/utils.ts";
import {unwrap} from "../liminal/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath, formatDateTime, formatTime, formatDate } from "../liminal/db.ts";
import { Table, TableView, TableRenderer, Field, PrimaryKeyField, ForeignKeyField, BooleanField, StringField, EnumField, IntegerField, FloatingPointField, DateTimeField } from "../liminal/table.ts";
import {block} from "../liminal/strings.ts";
import {serializeAs, setSerialized, path} from "../liminal/serializable.ts";
import { faker } from "@faker-js/faker";
import {Markup, h} from "../liminal/markup.ts";

export const routes = ()=> ({
});

// --------------------------------------------------------------------------------
// --- Event ----------------------------------------------------------------------
// --------------------------------------------------------------------------------

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
            new StringField('location_description', {}),
            new StringField('location_url', {}),
            new BooleanField('is_remote_event', {default: 0}),
            new BooleanField('volunteer_only', {default: 0}),
            new DateTimeField('shop_load_time', {nullable: true}),
            new DateTimeField('setup_time', {nullable: true}),
            new DateTimeField('start_time', {nullable: true}),
            new DateTimeField('end_time', {nullable: true}),
            new FloatingPointField('total_cash_collected', {default: 0}),
            new StringField('notes', {})
        ],[
            'CREATE INDEX IF NOT EXISTS event_by_start_time ON event(start_time);'
        ])
    };

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

    renderUpcomingEvents(): Markup {
        // --- Query all events in the next 6 weeks, including all events today.

        // --- Render as a ul with the body given by renderEventSummary
        
        // Calculate date range
        const today = new Date();
        today.setHours(0, 0, 0, 0); // Start of today
        
        const sixWeeksFromNow = new Date(today);
        sixWeeksFromNow.setDate(sixWeeksFromNow.getDate() + 42); // 6 weeks = 42 days
        
        // Format dates for SQLite (YYYY-MM-DD HH:MM:SS)
        const startDate = today.toISOString().replace('T', ' ').slice(0, 19);
        const endDate = sixWeeksFromNow.toISOString().replace('T', ' ').slice(0, 19);
        
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
        
        // Group events by week for better organization
        const eventsByWeek = new Map<string, Event[]>();
        
        for (const event of upcomingEvents) {
            if (!event.start_time) continue;
            
            const eventDate = new Date(event.start_time);
            const weekStart = new Date(eventDate);
            weekStart.setDate(eventDate.getDate() - eventDate.getDay()); // Start of week (Sunday)
            const weekKey = weekStart.toISOString().split('T')[0];
            
            if (!eventsByWeek.has(weekKey)) {
                eventsByWeek.set(weekKey, []);
            }
            eventsByWeek.get(weekKey)!.push(event);
        }
        
        // Build the markup
        const sections: Markup[] = [];
        
        for (const [weekStart, events] of eventsByWeek) {
            const weekDate = new Date(weekStart);
            const weekEndDate = new Date(weekDate);
            weekEndDate.setDate(weekEndDate.getDate() + 6);
            
            // Week header
            sections.push([h.h3, {class: 'week-header'}, 
                `Week of ${formatDate(weekStart)} - ${formatDate(weekEndDate.toISOString())}`
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
    renderEventSummary(event_id: number): Markup {
        
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
        
        // Build time summary
        const timeParts: string[] = [];
        if (event.start_time) {
            timeParts.push(formatDateTime(event.start_time));
            if (event.end_time) {
                timeParts.push(` - ${formatTime(event.end_time)}`);
            }
        }
        
        // Build the event summary markup
        const headerElements: Markup[] = [];
        
        // Event name as link to detail page
        headerElements.push(
            [h.a, {href: `/event.renderEventDetail(${event_id})`, class: 'card-title'}, 
                [h.strong, {}, event.description || 'Untitled Event']
            ]
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
                    [h.div, {}, formatTime(event.shop_load_time)]
                ]
            );
        }
        if (event.setup_time) {
            gridRows.push(
                [h.div, {class: 'card-detail-row'},
                    [h.div, {}, 'Setup:'],
                    [h.div, {}, formatTime(event.setup_time)]
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

