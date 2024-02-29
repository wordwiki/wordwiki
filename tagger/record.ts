import {customAlphabet} from "../utils/nanoid.ts";

/**
 * 
 * https://zelark.github.io/nano-id-cc/
 *
 * Using this 52 char alphabet and a length of 20,
 *
 * At 1000 IDs per hour: ~2 billion years or 20,494T IDs needed, in
 * order to have a 1% probability of at least one collision.
 */
export const newId: ()=>string =
    customAlphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 20);

/**
 * Ids are strings from a very restricted character set.  We use the
 * 'en' collator to compare them, rather than the default locale
 * collator to get a consistent order.
 */
export const idCollator = Intl.Collator('en');

export type RecordValue = {[name: string]: Value};
export type Value = null|boolean|number|string|RecordValue[];


/**
 * Dumps a record as a json string - replacing non-empty arrays with
 * the array ['...']. 
 */
export function recordTopLevelDump(record: any): string {
    const shallow = Object.fromEntries(
        Object.entries(record).map(([name, value]) =>
            [name, Array.isArray(value) && value.length ? ['...'] : value]));
    return JSON.stringify(shallow);
}

export function getPrimaryKey(record:any, name:string): string {
    const value = record[name];
    if(value === undefined || value === null)
        throw new Error(`Failed to find required primary key field '${name}' in record '${recordTopLevelDump(record)}'`);
    if(typeof value !== 'string')
        throw new Error(`Expected field ${name} to be a string - it is a ${typeof value}`);
    return value;
}

export function getString(record:any, name:string): string {
    const value = record[name];
    if(value === undefined || value === null)
        throw new Error(`Failed to find required field '${name}' in record '${JSON.stringify(record)}'`);
    if(typeof value !== 'string')
        throw new Error(`Expected field ${name} to be a string - it is a ${typeof value}`);
    return value;
}

export function getOptionalString(record:any, name:string): string|undefined {
    const value = record[name];
    if(value === undefined || value === null)
        return undefined;
    if(typeof value !== 'string')
        throw new Error(`Expected field ${name} to be a string - it is a ${typeof value}`);
    return value;
}

export function getInteger(record:any, name:string): number {
    const value = record[name];
    if(value === undefined || value === null)
        throw new Error(`Failed to find required field '${name}' in record '${JSON.stringify(record)}'`);
    if(typeof value !== 'number')
        throw new Error(`Expected field ${name} to be a number - it is a ${typeof value}`);
    return value;
}

export function getRelation(record: any, name:string): RecordValue[] {
    const value = record[name];
    if(value === undefined || value === null)
        return [];
    if(!Array.isArray(value))
        throw new Error(`Expected field ${name} to be a array - it is a ${typeof value}`);
    // TODO: add typecheck that is Array of Objects
    return value as RecordValue[];
}
