// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types

import * as fs from "https://deno.land/std@0.195.0/fs/mod.ts";

import * as utils from "../tabula/utils.ts";
import {unwrap} from "../tabula/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "../tabula/db.ts";
import { Field, PrimaryKeyField, ForeignKeyField, BooleanField, StringField, EnumField, IntegerField, FloatingPointField, DateTimeField } from "../tabula/table.ts";
import * as content from "../tabula/content-store.ts";
import {exists as fileExists} from "std/fs/mod.ts"
import {block} from "../tabula/strings.ts";
import * as orderkey from '../tabula/orderkey.ts';
import * as timestamp from '../tabula/timestamp.ts';
//import * as schema from './schema.ts';

import * as volunteer from './volunteer.ts';
import * as event from './event.ts';
import * as service from './service.ts';
import * as sale from './sale.ts';
import {Rabid} from './rabid.ts';

// --------------------------------------------------------------------------------
// --- Volunteer -----------------------------------------------------------------------
// --------------------------------------------------------------------------------


function createFakeVolunteerData(rabid: Rabid) {
    const volunteer = rabid.volunteer;

    volunteer.insert({
        name: 'David Ziegler',
        email: 'dz@entropy.org',
        phone:'416-803-2526',
        permissions: '',
        deleted: 0});

    volunteer.insert({
        name: 'Zach Fowler',
        email: 'zach94@hotmail.com',
        phone: '519-833-9283',
        permissions: '',
        deleted: 0});
}

function createFakeSaturdayEvent(rabid: Rabid, date: string) {
    rabid.event.insert({
        description: "Saturday in Victoria Park",
        location_description: "Behind 79 Joseph Street",
        location_url: "",
        event_kind: 'public',
        start_time: date+' 10:00:00',
        end_time: date+'15:00:00',
        on_location_setup_time: date+' 09:30:00',
        volunteer_only: 0,
        is_visible_on_website: 1,
    });
}

function createFakeEvents(rabid: Rabid) {
    createFakeSaturdayEvent(rabid, '2025-05-17');
    createFakeSaturdayEvent(rabid, '2025-05-24');
    createFakeSaturdayEvent(rabid, '2025-05-31');
}

function createFakeEventCommitments(rabid: Rabid) {
    const volunteers = rabid.volunteer.volunteersByName.all();
    const events = rabid.event.allEvents.all();
    if(volunteers.length < 2)
        throw new Error('Must be at least 2 volunteers');
    if(events.length < 2)
        throw new Error('Must be at least 2 events');

    
    for(const event of events) {
        for(const volunteer of volunteers) {
            rabid.event_commitment.insert({
                event_id: event.event_id,
                volunteer_id: volunteer.volunteer_id,
            });
        }
    }

    console.info('COMMITMENTS');
    console.info(rabid.event_commitment.commitmentsForEventWithVolunteerName.all());
    console.info('--');

    
}

// --------------------------------------------------------------------------------
// --------------------------------------------------------------------------------
// --------------------------------------------------------------------------------

function createAllTables() {
}


function destroyAllAndFillWithFakeData(rabid: Rabid) {
    console.info("*** DESTROYING ALL AND FILLING WITH FAKE DATA ***");
    Db.deleteDb(defaultDbPath);
    //schema.createAllTables();

    rabid.tables.forEach(table=>{
        console.info(`--- creating ${table.name}`);
        db().executeStatements(table.createDMLString());
    });

    createFakeVolunteerData(rabid);
    createFakeEvents(rabid);
    createFakeEventCommitments(rabid);

    console.info(rabid.volunteer.volunteersByName.all());

    //volunteer.updateVolunteer(1, ['name', 'email'], {name: 'DAVID', email: 'dz@mudchicken.com'});

    //console.info(volunteer.selectVolunteersByName().all({}));
    
}

function main(args: string[]) {
    const cmd = args[0];
    switch(cmd) {
        case 'destroy_all_and_fill_with_fake_data':
            destroyAllAndFillWithFakeData(new Rabid());
            break;
        default:
            console.info('BAD COMMAND!');
            break;
    }
}

if (import.meta.main)
    main(Deno.args);
