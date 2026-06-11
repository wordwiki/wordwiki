/**
 * Random utility functions.
 */

/**
 * The builting JS typeof operator returns one of "undefined",
 * "boolean", "number", "bigint", "string", "symbol", "function", or
 * "object".
 *
 * Arrays and null are both returned as "object", which in common use
 * cases (like processing JSON) requires awkward special casing.
 *
 * typeof_extended returns the same values as stock typeof, except
 * arrays are reported as 'array' and nulls are reported as 'null'.
 *
 * Typeof Ref: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/typeof
 */

export type WrapperType<T> =
    T extends string
    ? String
    : T extends number
    ? Number
    : T extends boolean
    ? Boolean
    : T;

export type PrimitiveType<T> =
    T extends String
    ? string
    : T extends Number
    ? number
    : T extends Boolean
    ? boolean
    : T;

type TypeofExtendedEnum =
    "undefined" | "boolean" | "number" | "bigint" | "string" | "symbol" |
    "function" | "object" | "null" | "array";

export function typeof_extended(v: any): TypeofExtendedEnum {
    const t = typeof v;
    if (t !== "object")
        return t;
    if (v === null)
        return "null";
    if (Array.isArray(v))
        return "array";
    return "object";
}

export function isPromise(v: any): boolean {
    // v != null first: typeof null is 'object', and null.then throws.
    // Functions with a .then are thenables too (Promises/A+).
    return v != null && (typeof v === 'object' || typeof v === 'function') &&
        typeof v.then === 'function';
}

export function isAssignableFrom(targetCls: any, valueCls: any): boolean {
    return targetCls === valueCls ||
        (valueCls != null && valueCls.prototype instanceof targetCls);
}

const ObjectLiteralPrototype = Object.getPrototypeOf({});

export function isObjectLiteral(v: any): boolean {
    // v !== null matters: typeof null is 'object', and getPrototypeOf(null)
    // throws - and this gets called on things like request.body, which can
    // legitimately be null.
    return typeof v === 'object' && v !== null &&
        Object.getPrototypeOf(v) === ObjectLiteralPrototype;
}

/**
 * A debug/error-message label for a value's class.  Total: never throws
 * (it is mostly called while BUILDING an error message, where a secondary
 * throw would eat the real diagnostic).
 */
export function className(v: any): string {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    return Object.getPrototypeOf(v)?.constructor?.name ?? '(no class)';
}

/**
 * Throws a panic exception with the supplied message, typed as 'never'.
 *
 * Typing the throw as 'never' allows us to use it in expression
 * contexts, which is handy sometimes.  For example:
 *
 * const rover = litter.get("Rover") ?? panic("can't find rover");
 *
 * (and 'rover' will have the inferred type 'Puppy' - instead of 'Puppy|undefined',
 * because the ?? arm ate the 'undefined' case and turned into 'never').
 */
export function panic(message: string = 'panic', detail: any=undefined): never {
    if(detail !== undefined)
        throw new Error(`Panic: ${message} - ${stringifyForError(detail)}`);
    else
        throw new Error(`Panic: ${message}`);
}

export function unwrap<T>(v: T|null|undefined, message: string = 'panic'): T {
    if(v === null || v === undefined)
        throw new Error (`Unexpected null or undefined: ${message}`);
    return v;
}

export function unwrapWithDetail<T>(v: T|null|undefined, message: string, detail: any): T {
    if(v === null || v === undefined)
        throw new Error (`${message} - ${stringifyForError(detail)}`);
    return v;
}

// JSON.stringify that never throws (circular details etc): panic/unwrap are
// error paths, and an error path that itself explodes eats the diagnostic.
function stringifyForError(detail: any): string {
    try {
        return JSON.stringify(detail) ?? String(detail);
    } catch {
        return String(detail);
    }
}

/**
 * A typescript typesystem hack to allow for exhaustiveness checking of
 * switch statements against a discriminated union.
 *
 * See: http://www.typescriptlang.org/docs/handbook/advanced-types.html#exhaustiveness-checking
 */
export function assertNever (x: never): never {
  throw new Error ('Unexpected object: ' + x);
}

/**
 *
 */
export function assert(condition: any, msg?: string): asserts condition {
  if (!condition)
      throw new /*Assertion*/Error(msg ? ('assertion failed: '+msg) : ('assertion failed'))
}

/**
 * Wrapper for parseInt that throws an exception on parse failure
 * (rather than returning NaN).
 *
 * Strict: the whole string must be a base-10 integer.  (Bare parseInt
 * silently accepted trailing garbage and other bases: '12abc' -> 12,
 * '12.9' -> 12, '0x10' -> 16 - bad news for ids arriving in forms/urls.)
 */
export function parseIntOrError(s: string): number {
    if(!/^[+-]?\d+$/.test(s))
        throw new Error(`Failed to parse ${s} as an integer`);
    return parseInt(s, 10);
}

/**
 * Partitions an array by key as defined by a supplied keyfn.
 *
 * The order of the items in the source array is preserved per
 * partition.
 *
 * This can be replaced with this new JS lib function once it is
 * widely available:
 * 
 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/groupToMap
 */
export function groupToMap<K,V>(items: V[], keyfn: (i:V)=>K): Map<K,V[]> {
    const partitions = new Map<K,V[]>();
    for(const item of items) {
        const key = keyfn(item);
        const existing_partition = partitions.get(key);
        if(existing_partition) {
            existing_partition.push(item);
        } else {
            partitions.set(key, [item]);
        }
    }
    return partitions;
}

/**
 * Partitions an array by key as defined by a supplied keyfn.
 *
 * The keyfn can return multiple keys per item.  Duplicate keys
 * returned by the keyfn are removed.
 *
 * The order of the items in the source array is preserved per
 * partition.
 */
export function multi_partition_by<K,V>(items: V[], keyfn: (i:V)=>K[]): Map<K,V[]> {
    const partitions = new Map<K,V[]>();
    for(const item of items) {
        const keys = [...new Set(keyfn(item))];
        for(const key of keys) {
            const existing_partition = partitions.get(key);
            if(existing_partition) {
                existing_partition.push(item);
            } else {
                partitions.set(key, [item]);
            }
        }
    }
    return partitions;
}

/**
 * Fetches a key from a Map, creating and persisting a key value using a factory if
 * there was no existing entry in the map.
 *
 * Like defaultdict in python.
 */
export function getOrCreate<K,V>(map: Map<K,V>, key: K, factory: (k:K)=>V): V {
    if(map.has(key)) {
        return map.get(key) as V;
    } else {
        const created = factory(key);
        map.set(key, created);
        return created;
    }
}


/**
 * Return a set of all elems that are either 'a' or 'b'.
 * Note: native version is coming soon.
 */
export function union<T>(a: Set<T>, b: Set<T>): Set<T> {
    return new Set([...a, ...b]);
}

/**
 * Return a set of all elems that in both 'a' and 'b'.
 * Note: native version is coming soon.
 *
 * TODO: change so iters over smaller set.
 * TODO: probably should use a loop rather than '.filter'.
 */
export function intersection<T>(a: Set<T>, b: Set<T>): Set<T> {
    return new Set(Array.from(a).filter(e=>b.has(e)));
}

/**
 * Return a set of all elems that are in 'a', but not in 'b'.
 *
 * TODO: change so iters over smaller set.
 * Note: native version is coming soon.
 */
export function difference<T>(a: Set<T>, b: Set<T>): Set<T> {
    return new Set(Array.from(a).filter(e=>!b.has(e)));
}

/**
 *
 */
export function duplicateItems<T>(items: T[]): Set<T> {
    const uniqueItems: Set<T> = new Set();
    const dups: Set<T> = new Set();
    for(const item of items) {
        if(uniqueItems.has(item))
            dups.add(item);
        else
            uniqueItems.add(item);
    }
    return dups;
}

/**
 * Returns all enumerable string property keys of an object (ignoring symbol keys),
 * including inherited enumerable properties.
 *
 * This is just repackaging 'for in' (as opposed to 'for of') - but
 * giving an explicit name to it's (often unexpected, almost always
 * unwanted) behaviour for use in those rare situations where that behaviour
 * is what we actually want.
 */
export function getAllPropertyNames(o: Object): string[] {
    const allPropertyNames: string[] = [];
    for(const propertyName in o)
        allPropertyNames.push(propertyName);
    return allPropertyNames;
}

/**
 * Returns array of numbers from 'from' up to 'to' (exclusive of 'to');
 */
export function range(from: number, to: number): number[] {
    const out: number[] = [];
    for(let i=from; i<to; i++)
        out.push(i);
    return out;
}

export function repeat<T>(f: ()=>T, n: number): T[] {
    const out: T[] = [];
    for(let i=0; i<n; i++)
        out.push(f());
    return out;
    
}

// checks if a value is an instance of any JS class by verifying it's an
// object with a constructor that's not Object or Array.
export function isClassInstance(value: any): boolean {
    return typeof value === 'object' && 
           value !== null && 
           value.constructor && 
           value.constructor !== Object && 
           value.constructor !== Array;
}

export function isEqualsUint8Array (a: Uint8Array, b: Uint8Array): boolean {
    if (a.length != b.length)
        return false;
    const len = a.length;
    for (let i=0; i<len; i++)
        if (a[i] !== b[i])
            return false;
    return true;
}
