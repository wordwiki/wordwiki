import * as utils from "../liminal/utils.ts";
import {unwrap} from "../liminal/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "../liminal/db.ts";
import { Field, PrimaryKeyField, ForeignKeyField, BooleanField, StringField, EnumField, IntegerField, FloatingPointField, DateTimeField } from "../liminal/table.ts";
import {block} from "../liminal/strings.ts";

import * as volunteer from './volunteer.ts';
import * as event from './event.ts';
import * as service from './service.ts';
import * as sale from './sale.ts';

// TODO: migrate this to rabid.


// --------------------------------------------------------------------------------
// --------------------------------------------------------------------------------
// --------------------------------------------------------------------------------

const allSchemaDml =
    //volunteer.allVolunteerDml +
    //event.allDml +
    service.allDml +
    sale.allDml;

export function createAllTables() {
    console.info('--- ALL SCHEMA DML');
    console.info(allSchemaDml);
    db().executeStatements(allSchemaDml);
    console.info('db created');
}

// --------------------------------------------------------------------------------
// --------------------------------------------------------------------------------
// --------------------------------------------------------------------------------

export function main(args: string[]) {
    const cmd = args[0];
    switch(cmd) {
        case 'createDb-no-no-no': // TODO REMOVE THIS ONCE WE ARE MORE STABLE (TOO DANGER!)
            console.info('DELETING DB');
            Db.deleteDb(defaultDbPath);
            createAllTables();
            break;
        default:
            console.info('BAD COMMAND!');
            break;
    }
}

if (import.meta.main)
    await main(Deno.args);
