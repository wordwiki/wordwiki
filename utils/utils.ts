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

// export type TypeName<T> = T extends string
//     ? "string"
//     : T extends number
//     ? "number"
//     : T extends boolean
//     ? "boolean"
//     : T extends undefined
//     ? "undefined"
//     : T extends Function
//     ? "function"
//     : "object";


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
    return typeof v === 'object' && typeof v.then === 'function';
}

export function isAssignableFrom(targetCls: any, valueCls: any): boolean {
    return targetCls === valueCls ||
        valueCls.prototype instanceof targetCls;
}

const ObjectLiteralPrototype = Object.getPrototypeOf({});

export function isObjectLiteral(v: any): boolean {
    return typeof v === 'object' && Object.getPrototypeOf(v) === ObjectLiteralPrototype;
}

export function className(v: any): string {
    return Object.getPrototypeOf(v)?.constructor?.name;
}

/* 
 * Checks whether a value is an ES6 class (or something pretending
 * sufficiently hard to be an ES6 class).
 *
 * A ES6 class is a Function, with a prototype, and that prototype has a 
 * 'constructor' property that refers back to the Function.
 */
// export function isES6Class (v: any) {
//   return typeof (v) === 'function' && v.prototype && v.prototype.constructor && v.prototype.constructor == v;
// }

// /**
//  * Arrow functions are the only functions that have a 'undefined' prototype, so
//  * this is how we distinguish them from types.
//  */
// export function isArrowFunction (v: any): v is Function {
//     return typeof v == 'function' && v.prototype === undefined;
// };

// /**
//  * Determines whether obj has the named own property.
//  *
//  * 'obj.hasOwnProperty (propName)' is not, in general, correct,
//  * because the obj or any of its prototypes can define an override for
//  * hasOwnProperty.
//  *
//  * 'Object.prototype.hasOwnProperty.call (obj, propName)' - the
//  * usual workaround - is ugly - thus this wrapper function.
//  *
//  * Sadly, we can't call this 'hasOwnProperty' - or we are overriding
//  * 'hasOwnProperty' on the exports object - which could cause random
//  * screwyness + makes flow mad.
//  */
// export function hasOwnProp (obj: Object, propName: string|Symbol) {
//     return Object.prototype.hasOwnProperty.call (obj, propName);
// };


// // Returns class name for objects, or undefined it it cannot find a class name.
// // Uses non-standard Function.name property, so will not always work, but can be used
// // to make debugging dumps nicer in those environments where it does work.
// export function typeName (v:any): string {
//     var typeStr = typeof (v);
//     switch (typeStr) {
//         case 'function':
//             return (v as Function).name;
//         case 'object':
//             if (v === null)
//                 return 'null';
//             var proto = Object.getPrototypeOf (v)||v['__proto__'];
//             if (!proto)
//                 return 'object';
//             var construct = proto['constructor'];
//             if (!construct)
//                 return 'object';
//             return construct.name;
//         case 'undefined':
//             return 'undefined';
//         default:
//             return typeStr;
//     }
// }

// export function stringCompare (a:string, b:string) {
//     if (a < b)
//         return -1;
//     else if (a > b)
//         return 1;
//     else
//         return 0;
// }

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
        throw new Error(`Panic: ${message} - ${JSON.stringify(detail)}`);
    else
        throw new Error(`Panic: ${message}`);
}

// export function panic(message: string = 'panic'): never {
//     throw new Error (`Panic: ${message}`);
// }

export function unwrap<T>(v: T|null|undefined, message: string = 'panic'): T {
    if(v === null || v === undefined)
        throw new Error (`Unexpected null or undefined: ${message}`);
    return v;
}

export function unwrapWithDetail<T>(v: T|null|undefined, message: string, detail: any): T {
    if(v === null || v === undefined)
        throw new Error (`${message} - ${JSON.stringify(detail)}`);
    return v;
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
 * A decorator that, when applied to a getter, caches the getter result until
 * the (global) invalidateCache is called.
 */
// export function lazy<T> (target: Object, key: string, descriptor: TypedPropertyDescriptor<T>) :TypedPropertyDescriptor<T> {

//   const memoizedResults = new WeakMap<Object, T>();
  
//   // --- Memoizing getter that wraps original getter.
//   function cachingGetter () {
//       let self:T = this as T;
//       // --- If we have cached this property computation, return it from the cache,
//       //     otherwise compute it and cache it.
//       //     A slightly odd factoring so that we only have to do the .get() when
//       //     cached result is present as long as the result is not 'undefined'.
//       let cachedValue = memoizedResults.get(self);
//       if(cachedValue === undefined && !memoizedResults.has(self)) {
//           let value = descriptor.get.call (self);
//           memoizedResults.set(self, value);
//           return value;
//       } else {
//           return cachedValue;
//       }
//   }

//   // --- Return descriptor that uses cachingGetter rather than original getter
//   return {get: cachingGetter, enumerable: false, configurable: true};
// }

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

// export function reference_longest_increasing_sequence<T>(v: T[], cmp: (T,T)=>number): number[] {
//     switch(v.length) {
//         case 0: return [];
//         case 1: return [0];
//         default: {
            
//         }
            
//     }
// }

/**
 * use Arrays.fromAsync instead
 */
// export async function collectAsyncIterable<T>(i: AsyncIterable<T>): Promise<T[]> {
//     const out: T[] = [];
//     for await (const v of i) {
//         out.push(v);
//     }
//     return out;
// }        

/**
 * Returns array of numbers from 'from' up to 'to' (exclusive of 'to');
 */
export function range(from: number, to: number): number[] {
    const out = [];
    for(let i=from; i<to; i++)
        out.push(i);
    return out;
}

export function repeat<T>(f: ()=>T, n: number): T[] {
    const out = [];
    for(let i=0; i<n; i++)
        out.push(f());
    return out;
    
}
