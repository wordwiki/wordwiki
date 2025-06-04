// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types

import * as fs from "https://deno.land/std@0.195.0/fs/mod.ts";

import * as utils from "../tabula/utils.ts";
import {unwrap} from "../tabula/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "../tabula/db.ts";
import { Table, Field, PrimaryKeyField, ForeignKeyField, BooleanField, StringField, EnumField, IntegerField, FloatingPointField, DateTimeField } from "../tabula/table.ts";
import * as content from "../tabula/content-store.ts";
import {exists as fileExists} from "std/fs/mod.ts"
import {block} from "../tabula/strings.ts";
import * as orderkey from '../tabula/orderkey.ts';
import * as timestamp from '../tabula/timestamp.ts';

export const routes = ()=> ({
});

// --------------------------------------------------------------------------------
// --- Service --------------------------------------------------------------------
// --------------------------------------------------------------------------------

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
