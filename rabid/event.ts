// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types

import * as utils from "../tabula/utils.ts";
import {unwrap} from "../tabula/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "../tabula/db.ts";
import { Table, Field, PrimaryKeyField, ForeignKeyField, BooleanField, StringField, EnumField, IntegerField, FloatingPointField, DateTimeField } from "../tabula/table.ts";
import {block} from "../tabula/strings.ts";

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

    description: string;

    location_description: string;
    location_url: string;

    event_kind: string;
    
    shop_load_time?: string;
    on_location_setup_time?: string;

    start_time?: string;
    end_time?: string;

    volunteer_only: boolnum;
    
    is_visible_on_website: boolnum;
}

export type EventOpt = Partial<Event>;

export class EventTable extends Table<Event> {
    
    constructor() {
        super ('event', [
            new PrimaryKeyField('event_id', {}),
            new StringField('description', {}),
            new StringField('location_description', {}),
            new StringField('location_url', {}),
            new EnumField('event_kind', event_kind_enum, {}),
            new DateTimeField('shop_load_time', {nullable: true}),
            new DateTimeField('on_location_setup_time', {nullable: true}),
            new DateTimeField('start_time', {nullable: true}),
            new DateTimeField('end_time', {nullable: true}),
            new BooleanField('volunteer_only', {nullable: true}),
            new BooleanField('is_visible_on_website', {nullable: true})
        ])
    };

    allEvents(): Event[] {
        return db().prepare<Event, {}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM event
/**/          ORDER BY start_time`).all();
    }
}
export const eventMetaData = new EventTable();

export function insertEvent(event: EventOpt): number {
    return db().insert<EventOpt, 'event_id'>('event', event, 'event_id');
}

export function updateEvent<T extends Partial<Event>>(event_id: number, fieldNames:Array<keyof T>, fields: T) {
    return db().update<T>('event', 'event_id', fieldNames, event_id, fields);
}

export const selectEvent = ()=>db().prepare<Event, {event_id: number}>(block`
/**/   SELECT ${eventMetaData.allFields}
/**/          FROM event
/**/          WHERE event_id = :event_id`);

export function deleteEvent(event_id: number) {
    db().execute<{event_id: number}>
        ('DELETE FROM TABLE event WHERE event_id = :event_id', {event_id});
}

// --------------------------------------------------------------------------------
// --- EventCommitment -------------------------------------------------------------
// --------------------------------------------------------------------------------

export interface EventCommitment {
    event_commitment_id: number;

    event_id: number;
    volunteer_id: number;

    requested_role: string;
    notes: string;

    // Driving information
    will_drive_from_shop: boolnum;
    will_move_supplies: boolnum;
    number_of_passengers: number;

    // To allow for commit for partial event.
    start_time?: string;
    end_time?: string;
}

export type EventCommitmentOpt = Partial<EventCommitment>;

export class EventCommitmentTable extends Table<EventCommitment> {
    
    constructor() {
        super ('event_commitment', [
            new PrimaryKeyField('event_commitment_id', {}),
            new ForeignKeyField('event_id', "event", "event_id", {}),
            new ForeignKeyField('volunteer_id', "volunteer", "volunteer_id", {}),
            new StringField('requested_role', {default:''}),
            new StringField('notes', {default:''}),
            new BooleanField('will_drive_from_shop', {default: 0}),
            new BooleanField('will_move_supplies', {default: 0}),
            new IntegerField('number_of_passengers', {default: 0}),
            new DateTimeField('start_time', {nullable: true}),
            new DateTimeField('end_time', {nullable: true})
        ], [
            'CREATE INDEX IF NOT EXISTS event_commitment_by_event_id ON event_commitment(event_id);',
            'CREATE INDEX IF NOT EXISTS event_commitment_by_volunteer_id ON event_commitment(volunteer_id);',            
        ])
    };

    getCommitmentsForEvent(event_id: number): EventCommitment[] {
        return db().prepare<EventCommitment, {event_id: number}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM event_commitment
/**/          WHERE event_id = :event_id`).all({event_id});
    }

    getCommitmentsForEventWithVolunteerName(event_id: number): (EventCommitment&{volunteer_name: string})[] {
        return db().prepare<(EventCommitment&{volunteer_name: string}), {event_id: number}>(block`
/**/   SELECT ${this.allFields}, volunteer.name AS volunteer_name
/**/          FROM event_commitment LEFT JOIN volunteer USING (volunteer_id)
/**/          WHERE event_id = :event_id`).all({event_id});
    }
}
export const eventCommitmentMetaData = new EventCommitmentTable();

export const allDml =
    eventMetaData.createDMLString() +
    eventCommitmentMetaData.createDMLString();

