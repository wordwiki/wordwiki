// deno-lint-ignore-file no-unused-vars, no-explicit-any, require-await

import * as model from "./model.ts";
import {FieldVisitorI, Field, ScalarField, BooleanField, IntegerField, FloatField,
        StringField, IdField, PrimaryKeyField, RelationField, Schema} from "./model.ts";
import {unwrap, panic} from "../liminal/utils.ts";
import * as utils from "../liminal/utils.ts";
import {dictSchemaJson} from "../wordwiki/entry-schema.ts";
import { Assertion, AssertionPath, getAssertionPath, selectAssertionsForTopLevelFact, updateAssertion, compareAssertionsByOrderKey, compareAssertionsByRecentness } from "../wordwiki/schema.ts";
import * as schema from "../wordwiki/schema.ts";
import * as timestamp from "../liminal/timestamp.ts";
import {BEGINNING_OF_TIME, END_OF_TIME} from '../liminal/timestamp.ts';
import {assert} from '../liminal/utils.ts';
import * as orderkey from '../liminal/orderkey.ts';

export type Tag = string;

// - Get working first, then refactor.
// - write simple test stuff, probably also beaters, round trip MMO etc.
// - make API be nice.
// - figure out (client side) id allocator.  Also needs to support distributed
//   operation.   maybe add a nanoid to every fact.  Or pool of reserved ids for
//   remote - but hard to do with partitioning (can use a rename pass instead?)

// TODO

// Perhaps the versioned relation tree should be forced??

// /**
//  *
//  */
// export class VersionedRelationContainer {
//     readonly schema: RelationField;
//     readonly childRelations: Record<Tag,VersionedRelation>;

//     constructor(schema: RelationField) {
//         this.schema = schema;
//         this.childRelations = Object.fromEntries(
//             schema.relationFields.map(r=>[r.tag, new VersionedRelation(r, this)]));
//     }

// }


/*
  - would like typed access to the tree, including rich apis (meaning that
  we don't want to have the typed access by doing a copy of the tree).
  - don't want to use proxies
  - can take advantage of the relative immutability.
  - the shape below is wrong anyway for a multi-versioned tree.
  -
 */

// Maybe variant is universal?  --- PROBABLY!  --- CAN JUST BURY EVERYWHERE THEN!
// interface VariantTupleVerisonT extends TupleVersionT {
//     variant: string;
// }

// How does root work?
// - the mode-consistent way would be to have a root tuple id (for example 0),
//   and then normal model would work from there.
// - there would be versioned data for this root tuple.
// - the type and id would be fixed (by the schema).
// - we could just forbid tuples at this level (and have an empty tuple
//   at the top) so that we can have a more consistent model.
// - problem is with lifetimes, which we need to figure out in general.
// - specifically, we have decoupled child lifetimes from parent tuple lifetimes,
//   but how do we handle children/decendants if the parent is deleted/not present.
// - from a user perspective, deleting the parent should delete the children - which
//   means the parent lifetime would effect the children.
// - this means that usual tree access will need to be parameterized by when.
// - anyway, this also means that if we want to have a unified root model,
//   we probably want to make a record for it.
// - not a bad thing to have for a dictionary anyway.
// - not super bad for export.
// - probably add to ty/id path thing just for consistency.


// - how does visibility work with a locale view?
// - if there is no tuple in the current locale, then we don't see children.

type FilterConditionally<Source, Condition> = Pick<Source, {[K in keyof Source]: Source[K] extends Condition ? K : never}[keyof Source]>;

type ArrayElemType<T extends any[]> = T[number];

const k: number[] = [1,2,3];
type FFF = ArrayElemType<typeof k>;


//type TupleType<T extends {$tuples: any[]}> = T["$tuples"][0];
type TupleType<T extends {$tuples: any[]}> = ArrayElemType<T["$tuples"]>;

// type ChildRelationsType<T, F extends {[n:string]: NodeT[]}=FilterConditionally<Omit<T, '$tuples'>, NodeT[]>> = {
//     [Property in keyof F]: VersionedRelation<ArrayElemType<F[Property]>>
// };

// type ChildRelationsType<T> =
//     Pick<T, {[K in keyof T]: T[K] extends NodeT[] ? K : never}[keyof T]>;

// type ChildRelationsType<T> = {
//     [Property in keyof Pick<T, {[K in keyof T]: T[K] extends NodeT[] ? K : never}[keyof T]>]: VersionedRelation<T[Property] extends NodeT[] ? T[Property][number] : never>
// };



//     [Property in keyof T]: VersionedRelation<ArrayElemType<T[Property]>>
// };



// -------------------------------------------------------------------------------
// -------------------------------------------------------------------------------
// -------------------------------------------------------------------------------

export class VersionedDb {
    readonly tables: Map<Tag, VersionedTable> = new Map();

    mostRecentSourceDbTimestamp: number = BEGINNING_OF_TIME;
    mostRecentLocalTimestamp: number = BEGINNING_OF_TIME;
    proposedAssertions: Assertion[] = [];

    constructor(schemas: Schema[]) {
        schemas.forEach(s=>this.addTable(s));
    }

    reset() {
        //this.tables.forEach(t=>t.reset());
        throw new Error('not impl');
    }

    addTable(schema: Schema): VersionedTable {
        if(this.tables.has(schema.tag))
            throw new Error(`attempting to add schema with duplicate tag ${schema.tag}`);
        const versionedTable = new VersionedTable(schema);
        this.tables.set(schema.tag, versionedTable);
        return versionedTable;
    }

    applyServerAssertion(assertion: Assertion)  {
        const versionedTuple = this.getVersionedTupleByPath(getAssertionPath(assertion));
        throw new Error('apply server assertion not implemented yet');
    }

    // we cannot implement nextTime here because we don't neccisareily have the
    // whole db (incuding all tables) which particpate in one global time scheme.
    // nextTime(): number {
    //     return timestamp.nextTime(this.mostRecentLocalTimestamp);
    // }

    applyProposedAssertion(assertion: Assertion): Assertion|undefined  {
        // This is a bit problemattic - we can insert mulitple assertions at the
        // same timestamp - but we are not doing that now so leave this XXX TODO
        if(assertion.valid_from <= this.mostRecentLocalTimestamp)
            throw new Error(`Attempt to assert into the past - asserting at ${assertion.valid_from} most recent local timestamp is ${this.mostRecentLocalTimestamp} - ${assertion.valid_from - this.mostRecentLocalTimestamp} should be positive`);
        if(assertion.valid_to !== assertion.valid_from &&
            assertion.valid_to !== timestamp.END_OF_TIME)
            throw new Error('New assertions must either be true to the end of time, or be deletion tombstones');
        const versionedTuple = this.getVersionedTupleByPath(getAssertionPath(assertion));
        const updatedPrevAssertion = versionedTuple.applyProposedAssertion(assertion);
        this.mostRecentLocalTimestamp = assertion.valid_from;
        this.proposedAssertions.push(assertion);
        return updatedPrevAssertion;
    }

    takeProposedAssertions(): Assertion[] {
        try {
            return this.proposedAssertions;
        } finally {
            this.proposedAssertions = [];
        }
    }

    untrackedApplyAssertion(assertion: Assertion) {
        this.untrackedApplyAssertionByPath(getAssertionPath(assertion), assertion);
    }

    untrackedApplyAssertionByPath(path: [string, number][], assertion: Assertion) {
        const versionedTuple = this.getVersionedTupleByPath(path);
        versionedTuple.untrackedApplyAssertion(assertion);
        this.mostRecentLocalTimestamp = assertion.valid_from;
    }

    getTable(tag: string): VersionedTuple {
        return this.tables.get(tag) ?? panic('unable to find table', tag);
    }

    getTableByTag(tag: string): VersionedTable {
        return this.tables.get(tag) ?? panic('unable to find table with tag', tag);
    }

    getVersionedTupleById(tableTag:string, typeTag:string, id:number): VersionedTuple|undefined {
        return this.tables.get(tableTag)?.getVersionedTupleById(typeTag, id);
    }

    getVersionedTupleByPath(path: AssertionPath): VersionedTuple {
        //console.info('ROOT PATH is', path);

        // --- Find table hosting root tag
        const [ty, id] = path[0];
        if(id !== 0)
            throw new Error(`root elem in any table is always id 0 - path is ${JSON.stringify(path)}`);
        const table = this.tables.get(ty);
        if(!table)
            throw new Error(`could not find table with tag ${ty} in workspace, active tables are ${[...this.tables.keys()].join()}`);
        utils.assert(table.schema.tag === ty);

        // --- Recurse
        if(path.length === 1)
            return table;
        else
            return table.getVersionedTupleByPath(path, 1);
    }

    getVersionedTupleParentRelation(childTuplePath: AssertionPath): VersionedRelation {
        const parentTuple = this.getVersionedTupleByPath(schema.parentAssertionPath(childTuplePath));
        const parentRelationTag = childTuplePath[childTuplePath.length-1][0]
        const parentRelation = parentTuple?.childRelations?.[parentRelationTag];
        utils.assert(parentRelation.schema.tag === parentRelationTag);
        return parentRelation;
    }

    dump(): any {
        return [...this.tables.entries()].map(([tag, table])=>
            [tag, table.dump()]);
    }
}

/**
 *
 */
export class VersionedTuple/*<T extends NodeT>*/ {
    readonly id: number;
    readonly schema: RelationField;
    readonly tupleVersions: TupleVersion[] = [];
    readonly childRelations: Record<Tag,VersionedRelation>;
    //readonly childRelations: ChildRelationsType<NodeT>;
    //proposedNewTupleUnderEdit: TupleVersion|undefined = undefined;
    //#currentTuple: TupleVersion|undefined = undefined;
    //[name: string]: RelationField;

    constructor(schema: RelationField, id: number) {
        this.schema = schema;
        this.childRelations = Object.fromEntries(
            schema.relationFields.map(r=>[r.tag, new VersionedRelation(r, this)]));
        this.id = id;
    }

    reset() {
        throw new Error('not impl yet');
        //this.tupleVersions = [];
        //this.#currentTuple = undefined;
        //this.childRelations.forEach(r=>r.reset());
    }

    get mostRecentTuple(): TupleVersion|undefined {
        // Note: we are making use of the JS behaviour where out of bound index accesses return undefined.
        return this.tupleVersions[this.tupleVersions.length-1];
    }

    /**
     * In some ways of traversing the versioned tuple store we will never
     * ask for the most recent version of a tuple if that tuple has been
     * deleted (because it will have been filtered out at a higher level) -
     * this version of requiredMostRecentTuple avoid putting these 'deleted'
     * checks everywhere.
     */
    get requiredMostRecentTuple(): TupleVersion {
        // Note: we are making use of the JS behaviour where out of bound index accesses return undefined.
        const mostRecent = this.tupleVersions[this.tupleVersions.length-1]
        if(!mostRecent)
            throw new Error(`Missing required most recent tuple for ${this.schema.tag}.${this.id}`);
        return mostRecent;
    }

    get current(): TupleVersion|undefined {
        //return this.#currentTuple;
        return this.mostRecentTuple;
    }

    get currentAssertion(): Assertion|undefined {
        //return this.#currentTuple?.assertion;
        return this.current?.assertion;
    }

    // untrackedApplyAssertionByPath(path: [string, number][], assertion: Assertion, index: number=0) {
    //     const versionedTuple = this.getVersionedTupleByPath(path, index);
    //     versionedTuple.untrackedApplyAssertion(assertion);
    // }

    getVersionedTupleByPath(path: [string, number][], index:number): VersionedTuple {
        //console.info('PATH is', path, path[index], index, 'SELF is', this.schema.tag, 'child is', this.schema.relationFields.map(r=>r.tag), 'self type', utils.className(this));
        const [ty, id] = path[index];

        const versionedRelation = this.childRelations[ty];
        if(!versionedRelation) {
            throw new Error(`unexpected tag ${ty} as child of ${this.schema.tag} -- FIX ERROR NEED LOCUS ETC`);
        }
        utils.assert(versionedRelation.schema.tag === ty);

        let versionedTuple = versionedRelation.tuples.get(id);
         if(!versionedTuple) {
             versionedTuple = new VersionedTuple(versionedRelation.schema, id);
             versionedRelation.tuples.set(id, versionedTuple);
        }
        utils.assert(versionedTuple.schema.tag === ty);

        if(index+1 === path.length)
            return versionedTuple;
        else
            return versionedTuple.getVersionedTupleByPath(path, index+1);
    }

    forEachVersionedTuple(f: (r:VersionedTuple)=>void) {
        f(this);
        for(const v of Object.values(this.childRelations))
            v.forEachVersionedTuple(f);
    }

    findVersionedTuples(filter: (r:VersionedTuple)=>boolean): Array<VersionedTuple> {
        const collection: VersionedTuple[] = [];
        this.forEachVersionedTuple(t=>{
            if(filter(t))
                collection.push(t);
        });
        return collection;
    }

    findVersionedTupleById(id: number): VersionedTuple|undefined {
        let found: VersionedTuple|undefined;
        this.forEachVersionedTuple(t=>{
            if(t.id === id) {
                if(found !== undefined)
                    throw new Error(`multiple tuples found for id ${id}`);
                found = t;
            }
        });
        return found;
    }

    findRequiredVersionedTupleById(id: number): VersionedTuple {
        const tuple = this.findVersionedTupleById(id);
        if(tuple === undefined)
            throw new Error(`failed to find required versioned tuple for id ${id}`);
        return tuple;
    }

    findNonDeletedChildTuples(): VersionedTuple[] {
        const nonDeletedChildTuples: VersionedTuple[] = [];
        this.forEachVersionedTuple(t=>{
            if(t!==this && t.current?.isCurrent === true) {
                //console.info('Found non deleted child tuple', t, t.current, t.current?.isCurrent);
                nonDeletedChildTuples.push(t);
            }
        });
        return nonDeletedChildTuples;
    }

    untrackedApplyAssertion(assertion: Assertion) {
        const tuple = new TupleVersion(this, assertion);
        // TODO lots of validation here + index updating etc.
        const prevTuple = this.mostRecentTuple;

        if(prevTuple) {
            const prevAssertion = prevTuple.assertion;
            if(assertion.replaces_assertion_id !== prevAssertion.assertion_id)
                throw new Error(`FIX ERROR: replaces_assertion_id chain broken - ${JSON.stringify(prevAssertion)} TO ${JSON.stringify(tuple.assertion)}`);
            if(prevAssertion.valid_to) {
                // A successor normally starts exactly when its predecessor ends; a
                // LATER start is a valid-time gap, which is how a restore after a
                // delete looks (the tuple did not exist during the gap).
                if(assertion.valid_from < prevAssertion.valid_to) {
                    throw new Error(`FIX ERROR: valid_from chain broken - ${JSON.stringify(prevAssertion, undefined, 2)} TO ${JSON.stringify(assertion, undefined, 2)}`);
                }
            } else {
                // This is tricky - we should probably mute the valid_to on the previous
                //  most current tuple - but this complicates undo etc.  The fact that
                //  valid_to with a non-null value is also used for undo complicates things.
                if(prevTuple.assertion.valid_from <= tuple.assertion.valid_from) {
                    throw new Error(`FIX ERROR: time travel prolbem`);
                }
            }
        }

        this.tupleVersions.push(tuple);

        // if(tuple.isCurrent)
        //     this.#currentTuple = tuple;
    }

    applyProposedAssertion(assertion: Assertion): Assertion|undefined {

        const tuple = new TupleVersion(this, assertion);
        const prevTuple = this.mostRecentTuple;
        let updatedPrevAssertion: Assertion|undefined = undefined;

        const assertAtTime = assertion.valid_from;

        // --- New proposed assertions must be either valid till the end of time
        //     OR have valid_from === valid_to === assertAtTime (which
        //     is a tombstone).
        utils.assert(assertion.valid_to === timestamp.END_OF_TIME ||
            assertion.valid_to === assertion.valid_from);

        if(prevTuple) {
            const prevAssertion = prevTuple.assertion;

            console.info('applying proposed assertion',
                         JSON.stringify(assertion, undefined, 2), ' on top of ',
                         JSON.stringify(prevAssertion, undefined, 2));

            if(assertion.replaces_assertion_id !== prevAssertion.assertion_id)
                throw new Error(`FIX ERROR: replaces_assertion_id chain broken - ${JSON.stringify(prevAssertion)} TO ${JSON.stringify(tuple.assertion)}`);

            switch(true) {

                case prevAssertion.valid_to === timestamp.END_OF_TIME: {
                    // --- We are replacing a tuple that was valid to the end of time,
                    //     this is a normal update - set the valid_to of the
                    //     replaced assertion with the start time of the new
                    //     assertion.

                    if(!(assertAtTime > prevAssertion.valid_from)) {
                        throw new Error(`Attempt to assert a tuple in the past (3)`);
                    }

                    prevAssertion.valid_to = assertAtTime;
                    updatedPrevAssertion = prevAssertion;
                    break;
                }

                case prevAssertion.valid_to < assertAtTime: {
                    // --- Assertion we are replacing is deleted (closed valid_to in
                    //     our past), so our new assertion starts a new valid period
                    //     after a gap - this is a restore/undelete.  The replaced
                    //     assertion is already closed, so it needs no valid_to
                    //     update (updatedPrevAssertion stays undefined).
                    if(!(assertAtTime > prevAssertion.valid_from)) {
                        throw new Error(`Attempt to assert a tuple in the past (4)`);
                    }
                    break;
                }

                case prevAssertion.valid_to >= assertAtTime: {
                    // --- Tuple we are replacing has an end of life in our future
                    //     (and not the end of time), something is wrong.
                    throw new Error(`Attempt to assert a tuple in the past`);
                }

                case prevAssertion.valid_from >= assertAtTime: {
                    // --- Tuple we are replacing has an begin of life in our future
                    //     (and not the end of time), something is wrong.
                    throw new Error(`Attempt to assert a tuple in the past (2)`);
                }

                default: {
                    // --- Tuple we are replacing
                    throw new Error(`unexpected tuple assertion ${JSON.stringify(assertion)} OVER ${JSON.stringify(prevAssertion)}`);
                    //break;
                }
            }
        }

        this.tupleVersions.push(tuple);
        console.info('applied proposed assertion', assertion);

        // if(tuple.isCurrent)
        //     this.#currentTuple = tuple;

        return updatedPrevAssertion;
    }

    applyServerAssertion(assertion: Assertion) {

        // TODO MORE VALIDATION HERE.
        // TODO If already have same assertion as a proposed assertion,
        //      confirm they are the same and do minor touchups (time)

        const tuple = new TupleVersion(this, assertion);
        const prevTuple = this.mostRecentTuple;

        // TODO lots of validation here + index updating etc.
        // TODO update current.
        // TODO tie into speculative mechanism.

        if(prevTuple) {
            // nop

        }

        this.tupleVersions.push(tuple);
        console.info('applied proposed assertion', assertion);

        // if(tuple.isCurrent)
        //     this.#currentTuple = tuple;
    }



    // forEachVersionedTuple(f: (r:VersionedTuple)=>void) {
    //     f(this);
    //     super.forEachVersionedTuple(f);
    // }

    dump(): any {
        return {
            //type: this.schema.name,
            //id: this.id,
            versions: this.tupleVersions.map(a=>a.dump()),
            ...Object.fromEntries(Object.values(this.childRelations).map(c=>
                [c.schema.name, c.dump()]))
        };
    }
}

/**
 *
 */
export function isRootTupleId(tuple_id: number): boolean {
    return tuple_id === 0;
}

/**
 *
 */
export class VersionedTable extends VersionedTuple {
    constructor(schema: RelationField) {
        super(schema, 0);
    }

    getVersionedTupleById(typeTag:string, id:number): VersionedTuple|undefined {
        // TODO this is doing a search every time - the intent is to have an index XXX
        return this.findVersionedTupleById(id);
    }
}

/**
 *
 *
 * - need to handle views of the content based on time + variant
 * - ordering of view needs to also be time based.
 * - need to track local (uncommitted) insertions etc.
 */
export class VersionedRelation/*<T extends NodeT>*/ {
    readonly schema: RelationField;
    readonly parent: VersionedTuple;
    readonly tuples: Map<number,VersionedTuple/*<T>*/> = new Map();

    constructor(schema: RelationField, parent: VersionedTuple) {
        this.schema = schema;
        this.parent = parent;
    }

    forEachVersionedTuple(f: (r:VersionedTuple)=>void) {
        for(const v of this.tuples.values())
            v.forEachVersionedTuple(f);
    }

    dump(): any {
        return Object.fromEntries([...this.tuples.entries()].map(([id, child])=>
            [id, child.dump()]));
    }
}

/**
 *
 */
export class TupleVersion {
    readonly relation: VersionedTuple;
    readonly assertion: Assertion;

    #domainFields: Record<string,any>|undefined = undefined;
    #json: Record<string,any>|undefined = undefined;
    //#changeRegistrations

    constructor(relation: VersionedTuple, assertion: Assertion) {
        this.relation = relation;
        this.assertion = assertion;
    }

    get assertion_id(): number {
        return this.assertion.assertion_id;
    }

    get isCurrent(): boolean {
        return this.assertion.valid_to === timestamp.END_OF_TIME;
    }

    get domainFields(): Record<string,any> {
        // TODO: consider checking type of domain fields.
        // TODO: fix the 'as any' below
        // TODO: consider droppiong memoization of this because have toJSON (below)
        return this.#domainFields ??= Object.fromEntries(
            this.relation.schema.scalarFields.map(f=>[f.name, (this.assertion as any)[f.bind]]));
    }

    // This will have some time stuff added etc XXX TODO
    toJSON(): Record<string,any> {
        const schema = this.relation.schema;
        return this.#json ??= {
            ...this.domainFields,
        };
    }

    dump(): any {
        const a = this.assertion;
        return {
            ...(a.valid_from !== timestamp.BEGINNING_OF_TIME ?
                {valid_from: timestamp.formatTimestampAsUTCTime(a.valid_from)} : {}),
            ...(a.valid_to !== timestamp.END_OF_TIME ?
                {valid_to: timestamp.formatTimestampAsUTCTime(a.valid_to)} : {}),
            //id: this.relation.id,
            //ty: this.relation.schema.tag,
            ...this.domainFields,
        };
    }
}

export function compareVersionedTupleByRecentness(a: TupleVersion, b: TupleVersion): number {
    return compareAssertionsByRecentness(a.assertion, b.assertion);
}

export function compareVersionedTupleAssertionByOrderKey(a: TupleVersion, b: TupleVersion): number {
    return compareAssertionsByOrderKey(a.assertion, b.assertion);
}

/**
 *
 */
export abstract class VersionedTupleQuery {
    readonly src: VersionedTuple;
    readonly schema: RelationField;
    readonly tupleVersions: TupleVersion[];
    readonly childRelations: Record<Tag,VersionedRelationQuery> = {};
    #json: Record<string,any>|undefined = undefined;

    constructor(src: VersionedTuple) {
        this.src = src;
        this.schema = src.schema;
        this.tupleVersions = this.computeTuples();
        this.childRelations = this.computeChildRelations();
    }

    abstract computeTuples(): TupleVersion[];
    abstract computeChildRelations(): Record<Tag, VersionedRelationQuery>;

    get mostRecentTupleVersion(): TupleVersion|undefined {
        // Note: we are using the spec behaviour where out of bound [] refs === undefined.
        return this.tupleVersions[this.tupleVersions.length-1];
    }

    get historicalTupleVersions(): TupleVersion[] {
        //if(this.src.tupleVersions.length !== 1)
        //    console.info(`HAVE TUPLE VERSIONS ON`);
        return this.src.tupleVersions; //.filter(t=>t!==this.mostRecentTupleVersion);
    }

    toJSON(includeHistory: boolean = false): any {
        return this.#json ??= (()=>{
            // if(!this.mostRecentTupleVersion)
            //     return ['DELETED'];
            const schema = this.schema;
            const current = this.mostRecentTupleVersion;
            // TODO what about no most recent tuple version??? XXX  (deleted tuples prob!)
            const entityFields =
                this.mostRecentTupleVersion?.toJSON() ?? {};

                //(this.mostRecentTupleVersion ?? panic('no most recent tuple version')).toJSON();
            const controlFields = {};
            const childRelations = Object.fromEntries(schema.relationFields.map(r=>
                [r.name, this.childRelations[r.tag].toJSON(includeHistory)]));
            //console.info('CHILD RELATIONS', JSON.stringify(childRelations, undefined, 2));
            const json: any = {
                ...controlFields,
                ...entityFields
            };
            // const json: any = entityFields;
            if(includeHistory) {
                const historicalVersions = this.historicalTupleVersions.map(h=>h.toJSON());
                if(historicalVersions.length > 0)
                    json['history'] = historicalVersions;
            }
            if(schema.relationFields.length > 0)
                Object.assign(json, childRelations);

            return json;
        })();
    }

    dump(): any {
        return {
            //type: this.schema.name,
            //id: this.id,
            versions: this.tupleVersions.map(a=>a.dump()),
            ...Object.fromEntries(Object.values(this.childRelations).map(c=>
                [c.src.schema.name, c.dump()]))
        };
    }
}

/**
 *
 */
export class CurrentTupleQuery extends VersionedTupleQuery {
    declare childRelations: Record<Tag, CurrentRelationQuery>;

    constructor(src: VersionedTuple) {
        super(src);
    }

    // Note: we will probably switch VersionTuple to have a ordered by
    //       recentness query, in which case we should remove the sort from here.
    computeTuples(): TupleVersion[] {
        return this.src.tupleVersions.
            filter(tv=>tv.isCurrent).
            toSorted(compareVersionedTupleByRecentness);
    }

    computeChildRelations(): Record<Tag, VersionedRelationQuery> {
        return Object.fromEntries(Object.entries(this.src.childRelations).
                map(([tag,rel])=>
                    [tag, new CurrentRelationQuery(rel)]));
    }
}

/**
 *
 */
export abstract class VersionedRelationQuery {
    readonly src: VersionedRelation;
    readonly schema: RelationField;
    readonly tuplesById: Map<number,VersionedTupleQuery>;
    readonly tuples: VersionedTupleQuery[];

    constructor(src: VersionedRelation) {
        this.src = src;
        this.schema = src.schema;
        this.tuplesById = this.computeCurrentTuplesById();
        this.tuples = Array.from(this.tuplesById.values());
    }

    abstract computeCurrentTuplesById(): Map<number, VersionedTupleQuery>;

    toJSON(includeHistory: boolean = false): any {
        return Array.from(this.tuples).map(t=>t.toJSON(includeHistory));
    }

    dump(): any {
        return Object.fromEntries([...this.tuplesById.entries()].map(([id, child])=>
            [id, child.dump()]));
    }
}

/**
 *
 * TODO: hook up versioned parent.
 */
export class CurrentRelationQuery extends VersionedRelationQuery {
    declare tuplesById: Map<number,CurrentTupleQuery>;
    declare tuples: CurrentTupleQuery[];

    constructor(src: VersionedRelation) {
        super(src);
    }

    computeCurrentTuplesById(): Map<number, CurrentTupleQuery> {
        // TODO we are grabbing all src.tuples.entries() here - don't think
        //      that is removing deleted tuples (ie. behind a tombstone)
        //      src is a VersionedRelation
        // TODO need to know if current version of VersionedTuple is deleted -
        //      can tell because will have end date that is not end of time.

        const currentTupleQuerys = [...this.src.tuples.entries()]
            .filter(([id,tup]: [number, VersionedTuple]) => tup.current?.isCurrent)
            .map(([id,tup]: [number, VersionedTuple]): [number, CurrentTupleQuery]=>
                [id, new CurrentTupleQuery(tup)]);

        const currentTupleQuerysByRecentness =
            currentTupleQuerys.toSorted(([aId, aTup]: [number, CurrentTupleQuery], [bId, bTup]: [number, CurrentTupleQuery]) => {
                const aMostRecent = aTup.mostRecentTupleVersion;
                const bMostRecent = bTup.mostRecentTupleVersion;
                if(aMostRecent === undefined && bMostRecent === undefined) return 0;
                if(aMostRecent === undefined) return -1;
                if(bMostRecent === undefined) return 1;
                return compareVersionedTupleAssertionByOrderKey(aMostRecent, bMostRecent);
            });

        return new Map(currentTupleQuerysByRecentness);
    }
}

export function currentTuplesForVersionedRelation(relation: VersionedRelation): CurrentTupleQuery[] {
    return Array.from(new CurrentRelationQuery(relation).tuples);
}

// export function generateRelativeOrderKey(parent: VersionedRelation,
//                                          refTupleId: number): string {
//     const peers = currentTuplesForVersionedRelation(parent);
//     const refIndex = peers.findIndex(p=>p.src.id === refTupleId);
//     if(refIndex === -1)
//         throw new Error(`unable to find ref tuple with id ${refTupleId} for move operation`);
//     if(refIndex === 0)
//         throw new Error('aldready ab begining'); // XXX
//     const targetIndex = refIndex + offset;

//     const orderedTuplesById = new CurrentRelationQuery(parent).tuples;
//     const refTuple = orderedTuplesById.get(refTupleId);
//     if(refTuple===undefined)
//         throw new Error(`unable to find ref tuple with id ${refTupleId} when trying to compute before order key`);
//     let prev: CurrentTupleQuery|undefined = undefined;
//     for(let t of orderedTuplesById.values()) {
//         if(t.src.id === refTupleId) {
//             const before_key = prev?.mostRecentTupleVersion?.assertion?.order_key ?? orderkey.begin_string;
//             const after_key = refTuple.mostRecentTupleVersion?.assertion.order_key
//                 ?? panic('tuple is missing:: tuple_id is', refTupleId);
//             const result_key = orderkey.between(before_key, after_key);
//             console.info('generateBeforeOrderKey', {before_key, after_key, result_key});
//             return result_key;
//         }
//         prev = t;
//     }
//     throw new Error(`unable to find ref tuple with id ${refTupleId} when trying to compute before order key (2)`);
// }

export function generateBeforeOrderKey(parent: VersionedRelation,
                                       refTupleId: number): string {
    const orderedTuplesById = new CurrentRelationQuery(parent).tuplesById;
    const refTuple = orderedTuplesById.get(refTupleId);
    if(refTuple===undefined)
        throw new Error(`unable to find ref tuple with id ${refTupleId} when trying to compute before order key`);
    let prev: CurrentTupleQuery|undefined = undefined;
    for(const t of orderedTuplesById.values()) {
        if(t.src.id === refTupleId) {
            const before_key = prev?.mostRecentTupleVersion?.assertion?.order_key ?? orderkey.begin_string;
            const after_key = refTuple.mostRecentTupleVersion?.assertion.order_key
                ?? panic('tuple is missing:: tuple_id is', refTupleId);
            const result_key = orderkey.between(before_key, after_key);
            console.info('generateBeforeOrderKey', {before_key, after_key, result_key});
            return result_key;
        }
        prev = t;
    }
    throw new Error(`unable to find ref tuple with id ${refTupleId} when trying to compute before order key (2)`);
}

export function generateAfterOrderKey(parent: VersionedRelation,
                                      refTupleId: number): string {
    const orderedTuplesById = new CurrentRelationQuery(parent).tuplesById;
    const refTuple = orderedTuplesById.get(refTupleId);
    if(refTuple===undefined)
        throw new Error(`unable to find ref tuple with id ${refTupleId} when trying to compute after order key`);
    let prev: CurrentTupleQuery|undefined = undefined;
    for(const t of [...orderedTuplesById.values()].toReversed()) {
        if(t.src.id === refTupleId) {
            const before_key = prev?.mostRecentTupleVersion?.assertion?.order_key ?? orderkey.end_string;
            return orderkey.between(
                refTuple.mostRecentTupleVersion?.assertion.order_key
                    ?? panic('tuple is missing:: tuple_id is', refTupleId),
                before_key);
        }
        prev = t;
    }
    throw new Error(`unable to find ref tuple with id ${refTupleId} when trying to compute before order key (2)`);
}

export function generateAtEndOrderKey(parent: VersionedRelation): string {
    const childrenInOrder = Array.from(new CurrentRelationQuery(parent).tuplesById.values());
    const lastExistingChild = childrenInOrder[childrenInOrder.length-1];
    return lastExistingChild === undefined
        ? orderkey.new_range_start_string
        : orderkey.between(
            lastExistingChild.mostRecentTupleVersion?.assertion?.order_key,
            orderkey.end_string);
}

// /**
//  *
//  */
// export class VersionedDatabaseWorkspace extends VersionedRelationContainer {
//     declare schema: Schema;

//     //readonly factsById: Map<number, FactCollection> = new Map();

//     constructor(schema: Schema) {
//         super(schema);
//     }

//     apply(assertion: Assertion) {
//         // We want to be able to apply assertions at any depth, in any order.
//         // - Top level apply will lookup RelationField for ty (using index on schema),
//         //   and then traversal will walk/create nodes, then apply to fact.
//         // - top level is still a container even if we are only mirroring a single
//         //   record.
//         // const relationField = this.schema.relationsByTag[assertion.ty];
//         // if(!relationField)
//         //     throw new Error(`Failed to find relation with tag '${assertion.ty}' in schema ${this.schema.name}`);

//         return this.untrackedApplyAssertionByPath(getAssertionPath(assertion), assertion);
//     }

//     dump(): any {
//         return Object.fromEntries(Object.entries(this.childRelations).map(([id, child])=>
//             [id, child.dump()]));
//     }

//     // dump(): any {
//     //     return Object.values(this.childRelations).map(child=>({
//     //         type: child.schema.name: child.dump()}));
//     // }

// }


export function getAssertionsForEntry(entry_id: number): any {
    return selectAssertionsForTopLevelFact('dict').all({id1: entry_id});
}


export function jsonTest() {
    console.info('full load test');
    const dictSchema = model.Schema.parseSchemaFromCompactJson('dict', dictSchemaJson);

    const workspace = new VersionedDb([dictSchema]);
    const assertions = schema.selectAllAssertions('dict').all();
    assertions.forEach((a:Assertion)=>workspace.untrackedApplyAssertion(a));

    // Make a current query somehow.
    // TOO SLOW. add some more caching.
    for(let i=0; i<10; i++) {
        console.time('Make JSON');
        const current = new CurrentTupleQuery(workspace.getTableByTag('dct'));
        const currentJSON = current.toJSON();
        console.timeEnd('Make JSON');
    }
    //console.info(JSON.stringify(current.toJSON(), undefined, 2));
}


export function fullLoadTest() {
    console.info('full load test');
    const dictSchema = model.Schema.parseSchemaFromCompactJson('dict', dictSchemaJson);

    const workspace = new VersionedDb([dictSchema]);

    console.time('load all assertions');
    const assertions = schema.selectAllAssertions('dict').all();
    console.timeEnd('load all assertions');
    console.time('apply all assertions');
    assertions.forEach((a:Assertion)=>workspace.untrackedApplyAssertion(a));
    console.timeEnd('apply all assertions');

    // THAT WAS EASY!!!
    // NOW TRY TO QUERY!!! (find recent changes etc)
    // IDEALLY WOULD LIKE TO OVERLAY SOME TYPING!!!

    // TODO switch so top level is not a tuple, but a relation.
    const dictionaryTuple = workspace.getTableByTag('dct');
    const entriesRelation: VersionedRelation = dictionaryTuple.childRelations['ent'];


    // THIS IS AN ABSOLUTELY HORRIBLE SEARCH - FACTOR TO MAKE NICE.


    // Entry tuples is Map<number,VersionedTuple>
    const entryTuples = entriesRelation.tuples;
    console.info(`tuple count ${entryTuples.size}`);

    // Print all entries with a spelling that begins with 'matu'.
    // - 1 ms per linear (approx).    So super fasty.
    console.time('spelling search');
    for(let i=0; i<100; i++) {
        const matchingTuples = [...entryTuples.values()]
                                   .filter((t:VersionedTuple)=>{
                                       //console.info(t.schema.tag);
                                       const matches =
                                           [...t.childRelations['sp'].tuples.values()].filter(t=>
                                               t.currentAssertion?.attr1.startsWith('matu'));
                                       // if(matches.length > 0)
                                       //     console.info(matches.length);
                                       return false});
    }
    console.timeEnd('spelling search');







    /*
      - off a VersionedTuple,
      - re-api to make this nice, then maybe try for typing.
      - also think about current vs history.
      - no caching needed - will be plenty fast enough to do raw on each search.
      - then make some rendering for a lexeme, and make some searches etc.

      - how is this related to current view?


      - can't even know ordering without doing the currentRelationQuery.

      - try how fast using that.  If so, may provide another way forward - may
      be worth just making a JSON of tip each time?
      - is not one-per request - is one per update.
      - update freq is expected to be 1 per second etc etc.
      - try to make a JSON version of current with history, informed by schema.
      - this is generally useful anyway.
      - if prohibit modification, can attach to workspace tree, and mostly reuse,
      so can make very cost effective.
      - this identity chucked for a tree when any sub changes thing can allow for
      efficient caching as well (though don't want for now).

      SO: rethink is wanting nice JSON dumps of subtree/trees bound with

     */

    //console.info(`matching tuple count ${matchingTuples.length}`);

    console.info('end');
}





if (import.meta.main) {
    //fullLoadTest();
    jsonTest();
}
