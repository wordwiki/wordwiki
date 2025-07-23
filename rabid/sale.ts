// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types

import * as utils from "../liminal/utils.ts";
import {unwrap} from "../liminal/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "../liminal/db.ts";
import { Table, Field, PrimaryKeyField, ForeignKeyField, BooleanField, StringField, EnumField, IntegerField, FloatingPointField, DateTimeField } from "../liminal/table.ts";
import {block} from "../liminal/strings.ts";

// --------------------------------------------------------------------------------
// --- Sale -----------------------------------------------------------------------
// --------------------------------------------------------------------------------

export const sale_kind_enum: Record<string, string> = {
    'bike': 'Bike',
    'free-bike': 'Free Adult Bike',
    'free-kids-bike': 'Free Kids Bike',
    'parts': 'Parts',
    'other': 'Other',
};

export const payment_method_enum: Record<string, string> = {
    'cash': 'Cash',
    'square': 'Square',
    'etransfer': 'Etransfer',
    'other': 'Other',
};

export interface Sale {
    sale_id: number;
    sale_time: string;
    sale_kind: string;
    sale_recorded_by: number;
    description: string;
    amount: number;
    payment_method: string;
    notes?: string;
}

export type SaleOpt = Partial<Sale>;

export class SaleTable extends Table<Sale> {
    
    constructor() {
        super ('bike_sale', [
            new PrimaryKeyField('sale_id', {}),
            new DateTimeField('sale_time', {}),
            new EnumField('sale_kind', sale_kind_enum, {}),
            new ForeignKeyField('sale_recorded_by', 'volunteer', 'volunteer_id', {indexed: true, unique: true}),
            new StringField('description', {}),
            new FloatingPointField('amount', {}),
            new EnumField('payment_method', payment_method_enum, {default: 'cash'}),
            new StringField('notes', {nullable: true})
        ])
    };
}
export const saleMetaData = new SaleTable();

export const allDml = saleMetaData.createDMLString();

