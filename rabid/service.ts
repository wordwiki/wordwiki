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

// TODO Add support for end of of day pickup VS regular pickup (maybe use enum for pickup?)
// TODO DIY vs regular?
// TODO Number of people served should default to 1 (and not be nullable)
// TODO Postal maybe should be renamed to indicate that it is a postal prefix?

export interface Service {
    service_id: number;

    time?: string;

    name: string;
    postal?: string;
    phone?: string;

    service_kind?: string;
    number_of_people_served?: number;

    will_pick_up?: number;

    notes?: string;
}

export type ServiceOpt = Partial<Service>;

export class ServiceTable extends Table<Service> {
    
    constructor() {
        super ('service', [
            new PrimaryKeyField('service_id', {}),
            new DateTimeField('time', {nullable: true}),
            new StringField('name', {}),
            new StringField('postal', {nullable: true}),
            new StringField('phone', {nullable: true}),
            new StringField('service_kind', {nullable: true}),
            new IntegerField('number_of_people_served', {nullable: true}),
            new BooleanField('will_pick_up', {nullable: true}),
            new StringField('notes', {nullable: true})
        ])
    };
}
export const serviceMetaData = new ServiceTable();

export const allDml = serviceMetaData.createDMLString();
