// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types

import * as fs from "https://deno.land/std@0.195.0/fs/mod.ts";

import * as utils from "../liminal/utils.ts";
import {unwrap} from "../liminal/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "../liminal/db.ts";
import { Table, Field, PrimaryKeyField, ForeignKeyField, BooleanField, StringField, EnumField, IntegerField, FloatingPointField, DateTimeField } from "../liminal/table.ts";
import * as content from "../liminal/content-store.ts";
import {exists as fileExists} from "std/fs/mod.ts"
import {block} from "../liminal/strings.ts";
import * as orderkey from '../liminal/orderkey.ts';
import * as timestamp from '../liminal/timestamp.ts';

export const routes = ()=> ({
});

// --------------------------------------------------------------------------------
// --- Service --------------------------------------------------------------------
// --------------------------------------------------------------------------------

export const service_kind_enum: Record<string, string> = {
    'diy': 'DIY',
    'full': 'We Repair',
    'adult-learn': 'Adult Learn to Ride',
    'kid-learn': 'Kid Learn to Ride',
    'vocational': 'Vocational Training',
    'other': 'Other',
};

export interface Service {
    service_id: number;

    // Nullable because Can do service outside of an event.
    event_id?: number;

    client_name: string;
    client_postal?: string;
    client_phone?: string;
    client_number_of_people_served: number;

    service_kind: string;
    service_description: string;
    service_check_in_time?: string;
    service_done: boolnum;
    // Will often be quite a bit after service is complete so should not
    // be used to compute total service time.  For example will be closed
    // when the customer
    service_record_closed_time?: string;

    will_pick_up: boolnum;
    scheduled_pick_up_time?: string;
    pick_up_done: boolnum;

    work_start_time?: string;
    work_end_time?: string;
    work_stand_id?: number;

    notes?: string;
}

export type ServiceOpt = Partial<Service>;

export class ServiceTable extends Table<Service> {
    
    constructor() {
        super ('service', [
            new PrimaryKeyField('service_id', {}),
            new ForeignKeyField('event_id', "event", "event_id", {indexed: true, nullable: true}),
            
            new StringField('client_name', {}),
            new StringField('client_postal', {nullable: true}),
            new StringField('client_phone', {nullable: true}),
            new IntegerField('client_number_of_people_served', {default: 1}),
            
            new EnumField('service_kind', service_kind_enum, {default: 'diy'}),
            new StringField('service_description', {}),
            new DateTimeField('service_check_in_time', {nullable: true}),
            new BooleanField('service_done', {default: 0}),
            new DateTimeField('service_record_closed_time', {nullable: true}),
            
            new BooleanField('will_pick_up', {default: 0}),
            new DateTimeField('scheduled_pick_up_time', {nullable: true}),
            new BooleanField('pick_up_done', {default: 0}),
            
            new DateTimeField('work_start_time', {nullable: true}),
            new DateTimeField('work_end_time', {nullable: true}),
            new IntegerField('work_stand_id', {nullable: true}),
            
            new StringField('notes', {nullable: true})
        ])
    };
}
export const serviceMetaData = new ServiceTable();

export const allDml = serviceMetaData.createDMLString();
