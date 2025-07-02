// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types

import * as utils from "../liminal/utils.ts";
import {unwrap} from "../liminal/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "../liminal/db.ts";
import { Table, Field, PrimaryKeyField, ForeignKeyField, BooleanField, StringField, EnumField, IntegerField, FloatingPointField, DateTimeField } from "../liminal/table.ts";
import {block} from "../liminal/strings.ts";

// --------------------------------------------------------------------------------
// --- Bike Sale ------------------------------------------------------------------
// --------------------------------------------------------------------------------

// TODO Change to be generic sale + more support for free.
// USE enum for sale kind (to support arbitrary bike VS other kinds of sales).

export interface BikeSale {
    bike_sale_id: number;

    bike_description: string;
    is_kids_bike: number;
    amount: number;
    payment_method: string;
    notes?: string;
}

export type BikeSaleOpt = Partial<BikeSale>;

export class BikeSaleTable extends Table<BikeSale> {
    
    constructor() {
        super ('bike_sale', [
            new PrimaryKeyField('bike_sale_id', {}),
            new StringField('bike_description', {}),
            new BooleanField('is_kids_bike', {}),
            new FloatingPointField('amount', {}),
            new StringField('payment_method', {}),
            new StringField('notes', {nullable: true})
        ])
    };
}
export const bikeSaleMetaData = new BikeSaleTable();

export const allDml = bikeSaleMetaData.createDMLString();

