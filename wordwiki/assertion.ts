// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types
/**
 * The assertion table: the storage schema of the assertion meta-model (one
 * row = one immutable version of one fact - see assertion-model.md at the
 * repo root), with the path encode/decode machinery and the comparators the
 * versioned workspace (workspace.ts) is built on.
 *
 * The scanned-document world's tables live in scanned-document.ts;
 * createAllTables (both worlds' DML) is on wordwiki.ts.
 */
import * as utils from "../liminal/utils.ts";
import { db, assertDmlContainsAllFields } from "../liminal/db.ts";
import {block} from "../liminal/strings.ts";
import * as orderkey from '../liminal/orderkey.ts';
import * as timestamp from '../liminal/timestamp.ts';

// --------------------------------------------------------------------------------
// --- Assertion ------------------------------------------------------------------
// --------------------------------------------------------------------------------

// TODO: there needs to be multiple tables with this schema (we will load them
//       as SQLite attached databases.   - this will be a much nicer model
//       of working with multiple dictionaries than merging them into one
//       table.

// TODO: make assertion_id allocation scheme that clusters assertion_ids for
//       all assertions in a tree (made less important by the fact that most
//       of our DBs are small enough that they will end up entirely in RAM -
//       but still good to do)

/**
 *
 */
export interface Assertion {
    assertion_id: number;
    replaces_assertion_id?: number;

    /**
     * The timestamp at which this assertion was made.
     *
     * May choose to switch to 0 as beginning of time for less special
     * casing.
     */
    valid_from: number;

    /**
     * The timestamp at which this assertion was retracted (an edit if
     * a subsequent assertion with the same 'id' is made, or a delete if not)
     */
    valid_to: number;

    /**
     * The timestamp at which this assertion was published.
     *
     * TODO Think about null here (we have removed from valid_from modelling).
     */
    published_from?: number;

    /**
     * The timestamp at which the publish of this assertion was retracted
     * (either because it was deleted, or it was replaced with a newer publish)
     */
    published_to?: number;

    /**
     * Parent fact id (not assertion id).
     */
    //parent_id?: number,

    /**
     * Fact id
     */
    id: number;

    /**
     * Fact type
     */
    ty: string;

    /**
     * (Denormalized) Flattening of the ancestor and self ids and types.
     */
    ty0?: string;
    ty1?: string;
    id1?: number;
    ty2?: string;
    id2?: number;
    ty3?: string;
    id3?: number;
    ty4?: string;
    id4?: number;
    ty5?: string;
    id5?: number;

    /**
     * Fields for the assertion.  Interpreted as per ty.
     */
    attr1?: any;
    attr2?: any;
    attr3?: any;
    attr4?: any;
    attr5?: any;
    attr6?: any;
    attr7?: any;
    attr8?: any;
    attr9?: any;
    attr10?: any;
    attr11?: any;
    attr12?: any;
    attr13?: any;
    attr14?: any;
    attr15?: any;

    /**
     * User tags.
     */
    tags?: string;

    /**
     * Key used to order this assertion within its peers (same parent_id and ty).
     *
     * (see utils/order_key for more details)
     */
    order_key?: string;

    /**
     * Locale expression for which this assertion hosts.
     */
    variant?: string;

    /**
     * Locale expression for which this assertion hosts if this is an
     * assertion expressed in the target language.
     */
    target_variant?: string;

    /**
     * Expression of the level of confidence we have that this assertion is true.
     */
    confidence_expr?: string;

    /**
     * Notes on this assertion
     */
    note?: string;

    /**
     * Our present level of confidence (0-10) in this fact.
     *
     * This is critical because when gathering dictionary information, we
     * may collect an assertion 'I think "cat" had a secondary meaning ...',
     * or we may be collecting information from the public, without vetting.
     */
    //confidence?: number;
    //confidence_note?: string;

    /**
     * More thought here about approval, priorities, discussion etc.
     */
    change_by_username?: string;
    change_action?: string;
    change_arg?: string;
    change_note?: string;
}

export type AssertionPath = [string, number][];

/**
 *
 */
export function getAssertionPath(a: Assertion): AssertionPath {
    const path: [string, number][] = [];
    if(a.ty0==null) throw new Error(`Invalid assertion, missing ty0`);
    path.push([a.ty0, 0]);
    if(a.ty1==null || a.id1==null) return path;
    path.push([a.ty1, a.id1]);
    if(a.ty2==null || a.id2==null) return path;
    path.push([a.ty2, a.id2]);
    if(a.ty3==null || a.id3==null) return path;
    path.push([a.ty3, a.id3]);
    if(a.ty4==null || a.id4==null) return path;
    path.push([a.ty4, a.id4]);
    if(a.ty5==null || a.id5==null) return path;
    path.push([a.ty5, a.id5]);
    return path;
}

export function assertionPathToFields(p: AssertionPath): Pick<Assertion, 'ty0'|'ty1'|'id1'|'ty2'|'id2'|'ty3'|'id3'|'ty4'|'id4'|'ty5'|'id5'> {
    const a: ReturnType<typeof assertionPathToFields> = {};
    const l = p.length;
    if(l >= 1) {
        a.ty0 = p[0][0];
        utils.assert(p[0][1] === 0);
    }
    if(l >= 2) {
        a.ty1 = p[1][0];
        a.id1 = p[1][1];
    }
    if(l >= 3) {
        a.ty2 = p[2][0];
        a.id2 = p[2][1];
    }
    if(l >= 4) {
        a.ty3 = p[3][0];
        a.id3 = p[3][1];
    }
    if(l >= 5) {
        a.ty4 = p[4][0];
        a.id4 = p[4][1];
    }
    if(l >= 6) {
        a.ty5 = p[5][0];
        a.id5 = p[5][1];
    }
    if(l >= 14) {
        throw new Error('assertion path overflow!');
    }
    return a;
}

/**
 *
 */
export function parentAssertionPath(a: AssertionPath): AssertionPath {
    return a.slice(0, -1);
}


/**
 * Compares two Assertions by user defined order_key.
 *
 * When there are duplicate order keys (which occurs when not pre-filtering
 * by a particular time), provides stable results, and attempts to make
 * them as pleasant as possible - but they still will be a bit weird
 * if the item has been moved in the list.
 *
 * Handles null/undefined order_keys.
 */
export function compareAssertionsByOrderKey(a: Assertion, b: Assertion): number {
    return orderkey.compareOrderKeys(a.order_key, b.order_key) ||
        a.id - b.id ||               // if order keys same - next order by fact id
        a.valid_to - b.valid_to ||   // if facts ids are the same, next by assertion time
        a.assertion_id - b.assertion_id  // Finally by assertion_id (always unique)
}

/**
 * Compares to assertions based on how recently they were made.  For assertions
 * made at the same time, falls back to id, then assertion_id so always have
 * a stable sort.
 */
export function compareAssertionsByRecentness(a: Assertion, b: Assertion): number {
    return a.valid_from - b.valid_from ||
        a.id - b.id ||
        a.assertion_id - b.assertion_id;
}

export function getAssertionPathFields(a: Assertion): Pick<Assertion, 'ty0'|'ty1'|'id1'|'ty2'|'id2'|'ty3'|'id3'|'ty4'|'id4'|'ty5'|'id5'> {
    return {
        ty0: a.ty0,
        ty1: a.ty1, id1: a.id1,
        ty2: a.ty2, id2: a.id2,
        ty3: a.ty3, id3: a.id3,
        ty4: a.ty4, id4: a.id4,
        ty5: a.ty5, id5: a.id5,
    };
}

export function copyAssertionPath(src: Assertion, target: Assertion): Assertion {
    target.ty0 = src.ty0;
    target.ty1 = src.ty1;
    target.id1 = src.id1;
    target.ty2 = src.ty2;
    target.id2 = src.id2;
    target.ty3 = src.ty3;
    target.id3 = src.id3;
    target.ty4 = src.ty4;
    target.id4 = src.id4;
    target.ty5 = src.ty5;
    target.id5 = src.id5;
    return target;
}

export function getAssertionTypeN(a: Assertion, n: number): string|undefined {
    switch(n) {
        case 0: return a.ty0;
        case 1: return a.ty1;
        case 2: return a.ty2;
        case 3: return a.ty3;
        case 4: return a.ty4;
        case 5: return a.ty5;
        default: return undefined;
    }
}

export function getAssertionIdN(a: Assertion, n: number): number|undefined {
    switch(n) {
        case 0: return 0; // id0 is the root of a table and always 0
        case 1: return a.id1;
        case 2: return a.id2;
        case 3: return a.id3;
        case 4: return a.id4;
        case 5: return a.id5;
        default: return undefined;
    }
}

export type AssertionPartial = Partial<Assertion>;
export const assertionFieldNames: Array<keyof Assertion> = [
    "assertion_id",
    "replaces_assertion_id",

    "valid_from", "valid_to",
    "published_from", "published_to",

    "id", "ty",

    "ty0",
    "ty1", "id1",
    "ty2", "id2",
    "ty3", "id3",
    "ty4", "id4",
    "ty5", "id5",

    "attr1", "attr2", "attr3", "attr4", "attr5", "attr6", "attr7", "attr8",
    "attr9", "attr10", "attr11", "attr12", "attr13", "attr14", "attr15",

    "tags",

    "order_key", "variant", "target_variant", "confidence_expr",

    "note",

    "change_by_username", "change_action", "change_arg", "change_note",
    ];


export const createAssertionDml = (tableName:string)=>block`
/**/   CREATE TABLE IF NOT EXISTS ${tableName}(
/**/       assertion_id INTEGER PRIMARY KEY ASC,
/**/
/**/       replaces_assertion_id INTEGER,
/**/
/**/       valid_from INTEGER NOT NULL,
/**/       valid_to INTEGER NOT NULL,
/**/
/**/       published_from INTEGER,
/**/       published_to INTEGER,
/**/
/**/       id INTEGER NOT NULL,
/**/       ty TEXT NOT NULL,
/**/
/**/       ty0 TEXT NOT NULL,
/**/       ty1 TEXT,
/**/       id1 INTEGER,
/**/       ty2 TEXT,
/**/       id2 INTEGER,
/**/       ty3 TEXT,
/**/       id3 INTEGER,
/**/       ty4 TEXT,
/**/       id4 INTEGER,
/**/       ty5 TEXT,
/**/       id5 INTEGER,
/**/
/**/       attr1,
/**/       attr2,
/**/       attr3,
/**/       attr4,
/**/       attr5,
/**/       attr6,
/**/       attr7,
/**/       attr8,
/**/       attr9,
/**/       attr10,
/**/       attr11,
/**/       attr12,
/**/       attr13,
/**/       attr14,
/**/       attr15,
/**/
/**/       tags TEXT,
/**/
/**/       order_key TEXT,
/**/
/**/       variant TEXT,
/**/       target_variant TEXT,
/**/       confidence_expr TEXT,
/**/
/**/       note TEXT,
/**/
/**/       change_by_username TEXT,
/**/       change_action TEXT,
/**/       change_arg TEXT,
/**/       change_note TEXT);
/**/
/**/   CREATE INDEX IF NOT EXISTS ${tableName}_valid_from ON ${tableName}(valid_from);
/**/   CREATE INDEX IF NOT EXISTS ${tableName}_valid_to ON ${tableName}(valid_to) WHERE valid_to != ${timestamp.END_OF_TIME};
/**/
/**/   -- One CURRENT (END_OF_TIME) version per fact: the db-level backstop for
/**/   -- the workspace's version-chain invariant.  (These partial indexes used
/**/   -- to say 'valid_to = NULL', which never matches in SQLite - on a db that
/**/   -- already has the old empty indexes, drop them to get the fixed ones.)
/**/   CREATE UNIQUE INDEX IF NOT EXISTS current_${tableName}_by_id_ty ON ${tableName}(id, ty) WHERE valid_to = ${timestamp.END_OF_TIME};
/**/
/**/   CREATE INDEX IF NOT EXISTS ${tableName}_ty1 ON ${tableName}(ty1);
/**/   CREATE INDEX IF NOT EXISTS ${tableName}_ty2 ON ${tableName}(ty2);
/**/   CREATE INDEX IF NOT EXISTS ${tableName}_ty3 ON ${tableName}(ty3);
/**/   CREATE INDEX IF NOT EXISTS ${tableName}_ty4 ON ${tableName}(ty4);
/**/   CREATE INDEX IF NOT EXISTS ${tableName}_ty5 ON ${tableName}(ty5);
/**/
/**/   CREATE INDEX IF NOT EXISTS ${tableName}_by_id_ty1 ON ${tableName}(id1, ty1);
/**/   CREATE INDEX IF NOT EXISTS ${tableName}_by_id_ty2 ON ${tableName}(id2, ty2);
/**/   CREATE INDEX IF NOT EXISTS ${tableName}_by_id_ty3 ON ${tableName}(id3, ty3);
/**/   CREATE INDEX IF NOT EXISTS ${tableName}_by_id_ty4 ON ${tableName}(id4, ty4);
/**/   CREATE INDEX IF NOT EXISTS ${tableName}_by_id_ty5 ON ${tableName}(id5, ty5);
/**/
/**/   CREATE INDEX IF NOT EXISTS current_${tableName}_by_id_ty1 ON ${tableName}(id1, ty1) WHERE valid_to = ${timestamp.END_OF_TIME};
/**/   CREATE INDEX IF NOT EXISTS current_${tableName}_by_id_ty2 ON ${tableName}(id2, ty2) WHERE valid_to = ${timestamp.END_OF_TIME};
/**/   CREATE INDEX IF NOT EXISTS current_${tableName}_by_id_ty3 ON ${tableName}(id3, ty3) WHERE valid_to = ${timestamp.END_OF_TIME};
/**/   CREATE INDEX IF NOT EXISTS current_${tableName}_by_id_ty4 ON ${tableName}(id4, ty4) WHERE valid_to = ${timestamp.END_OF_TIME};
/**/   CREATE INDEX IF NOT EXISTS current_${tableName}_by_id_ty5 ON ${tableName}(id5, ty5) WHERE valid_to = ${timestamp.END_OF_TIME};
/**/
/**/ -- NEED SOME MODEL CHANGE SO CAN INDEX LATEST PUBLISHED XXX TODO XXX TODO
/**/
/**/ --  CREATE INDEX IF NOT EXISTS published_${tableName}_by_id_ty1 ON ${tableName}(id1, ty1) WHERE published_from IS NOT NULL AND published_to IS NOT NULL;
/**/ --  CREATE INDEX IF NOT EXISTS published_${tableName}_by_id_ty2 ON ${tableName}(id2, ty2) WHERE published_from IS NOT NULL AND published_to IS NOT NULL;
/**/ --  CREATE INDEX IF NOT EXISTS published_${tableName}_by_id_ty3 ON ${tableName}(id3, ty3) WHERE published_from IS NOT NULL AND published_to IS NOT NULL;
/**/ --  CREATE INDEX IF NOT EXISTS published_${tableName}_by_id_ty4 ON ${tableName}(id4, ty4) WHERE published_from IS NOT NULL AND published_to IS NOT NULL;
/**/ --  CREATE INDEX IF NOT EXISTS published_${tableName}_by_id_ty5 ON ${tableName}(id5, ty5) WHERE published_from IS NOT NULL AND published_to IS NOT NULL;
/**/
/**/   -- CREATE INDEX IF NOT EXISTS published_locale1_${tableName}_by_id_ty1 ON ${tableName}(id1, ty1) WHERE published_from IS NOT NULL AND published_to IS NOT NULL AND is_locale1 = 1;
/**/   -- CREATE INDEX IF NOT EXISTS published_locale1_${tableName}_by_id_ty2 ON ${tableName}(id2, ty2) WHERE published_from IS NOT NULL AND published_to IS NOT NULL AND is_locale1 = 1;
/**/   -- CREATE INDEX IF NOT EXISTS published_locale1_${tableName}_by_id_ty3 ON ${tableName}(id3, ty3) WHERE published_from IS NOT NULL AND published_to IS NOT NULL AND is_locale1 = 1;
/**/   -- CREATE INDEX IF NOT EXISTS published_locale1_${tableName}_by_id_ty4 ON ${tableName}(id4, ty4) WHERE published_from IS NOT NULL AND published_to IS NOT NULL AND is_locale1 = 1;
/**/   -- CREATE INDEX IF NOT EXISTS published_locale1_${tableName}_by_id_ty5 ON ${tableName}(id5, ty5) WHERE published_from IS NOT NULL AND published_to IS NOT NULL AND is_locale1 = 1;
/**/   `;


assertDmlContainsAllFields(createAssertionDml('__test__'), assertionFieldNames);

export const selectAssertionsForTopLevelFact = (tableName: string)=>db().prepare<Assertion, {id1: number}>(block`
/**/   SELECT ${assertionFieldNames.join()}
/**/          FROM ${tableName}
/**/          WHERE id1 = :id1
/**/          ORDER BY valid_from, id`);

export const selectAllAssertions = (tableName: string)=>db().prepare<Assertion>(block`
/**/   SELECT ${assertionFieldNames.join()}
/**/          FROM ${tableName}
/**/          ORDER BY valid_from, id`);

export const selectCurrentAssertionsByType = (tableName: string)=>db().prepare<Assertion, {ty: number}>(block`
/**/   SELECT ${assertionFieldNames.join()}
/**/          FROM ${tableName}
/**/          WHERE ty = :ty AND
/**/                published_to = 9007199254740991 OR
/**/                valid_to = 9007199254740991`);

export function updateAssertion<T extends Partial<Assertion>>(tableName: string, assertion_id: number,fieldNames:Array<keyof T>, fields: T) {
    return db().update<T>(tableName, 'assertion_id', fieldNames, assertion_id, fields);
}

//const highestValueTo = (tableName: string)=>

/**
 * Returns the highest timestamp in a table.
 *
 * The two aggregate queries, exported so assertion_test.ts can pin their
 * EXPLAIN QUERY PLAN: both must be answered from their covering indexes
 * (valid_from, and the partial valid_to != END_OF_TIME index - whose
 * predicate the second query matches EXACTLY; rewriting it as
 * `valid_to < END_OF_TIME` loses the index).  A schema change that broke
 * this would silently degrade a query we may soon run per page view to a
 * full scan of the assertion table.
 */
export const highestTimestampQueries = (tableName: string) => [
    `SELECT MAX(valid_from) AS ts FROM ${tableName}`,
    `SELECT MAX(valid_to) AS ts FROM ${tableName} WHERE valid_to != ${timestamp.END_OF_TIME}`,
];

export function highestTimestamp(tableName: string): number {
    const [maxValidFromSql, maxValidToSql] = highestTimestampQueries(tableName);
    const maxValidFrom = db().prepare<{ts: number|null}, {}>(maxValidFromSql).required({}).ts;
    const maxValidTo = db().prepare<{ts: number|null}, {}>(maxValidToSql).required({}).ts;
    return Math.max(maxValidTo ?? timestamp.BEGINNING_OF_TIME,
                    maxValidFrom ?? timestamp.BEGINNING_OF_TIME);
}

