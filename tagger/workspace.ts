import * as model from "./model.ts";
import {FieldVisitorI, Field, ScalarField, BooleanField, IntegerField, FloatField,
        StringField, IdField, PrimaryKeyField, RelationField, Schema} from "./model.ts";
import {unwrap, panic} from "../utils/utils.ts";
import * as utils from "../utils/utils.ts";
import {dictSchemaJson} from "./entry-schema.ts";
import { Assertion, AssertionPath, getAssertionPath, selectAssertionsForTopLevelFact, compareAssertionsByOrderKey, compareAssertionsByRecentness } from "./schema.ts";
import * as schema from "./schema.ts";
import * as timestamp from "../utils/timestamp.ts";
import {BEGINNING_OF_TIME, END_OF_TIME} from '../utils/timestamp.ts';
import {assert} from '../utils/utils.ts';
import * as view from './view.ts';
import * as orderkey from '../utils/orderkey.ts';
import { renderToStringViaLinkeDOM } from '../utils/markup.ts';
import {block} from "../utils/strings.ts";
import { rpc } from '../utils/rpc.ts';
import * as config from './config.ts';

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

let k: number[] = [1,2,3];
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



/*
  - how to load data?
  - it has to be part of the rpc mechanism, or have time smearage.
*/
export class RemoteDb {
    versionedDb: VersionedDb;
    pendingRequest: PendingRequest = new PendingRequest();
    requestInFlight: boolean = false;

    constructor(versionedDb: VersionedDb) {
        this.versionedDb = versionedDb;
    }
    
    // - does a larger RPC that:
    //  - pushed proposed assertions to server
    //  - with updates applied, runs the supplied (possibly nop) rpc
    //  - responds with:
    //     - all updates to server since last timestamp we have recieved from server
    //       (which we will have sent in the call)
    //  - can also respond with PANIC - meaning that the local changes could not
    //    be applied to DB, and we presenty don't have a cheap way to recover from
    //    this.  So, in the event of panic, we inform the user of the error and
    //    reload the page (will get fancier later).
    //  - just an RPC failure does not result in a panic - the db is still in
    //    sync, just failed to do the RPC.
    //  - only one of these in flight at a time, if the user code initiates
    //    a second rpc while one is in flight, it queues until the first one returns
    //    (lots of trickness otherwise which we don't want to deal with now).
    //  - rpc can also include a closure that runs on current before submitting
    //    remote.  Think more about this and make it more txey.
    //  - queue mechanism will submit NOP rpcs every 250ms if there are no user
    //    updates (to keep local db up to date).
    //  - non empty remote updates trigger a view refresh.
    //  - can also add closure that run locally before or after rpc (and
    //    are in queue).
    //  - there is still some time travel here:
    //     - we are (on every interaction) pushing all local updates to server,
    //       and getting all updates from server.
    //     - so the client is always a bit behind server, and has proposed changes
    //       it is sending.
    //     - so code using the workspace will be running on a non-tip version.
    //     - long term we should be doing stuff about that - but pretty much we
    //       are only editing for now, and anything more serious runs as a proper
    //       db tx on the server - so not an issue.

    // - think about data faulting as well.
    // - also rpc collapsing (which also helps with data faulting)
    // - rpc collapsing could reduce our queue depth to max 1 pending.

    // - having a queue depth of 1 

    // - rpc's can be db queries - somehow want to take rpc results and send
    //   the data only if we don't have it etc.
    // - for starts, we can always send.

    // - how does fault work:

    /**
     *
     */
    async loadTopLevelFact(tableName: string, fact_id: number): Promise<any> {
        // Need to understand this return value.
        // - Can we live without this for now ???
        //   - Can we just load a page, then save the whole page at the end,
        //     and not bother with all this joy?  (as a zero cut).
        //   - Then would not need rpc at all.
        //   - maybe????
        //   - will not be live edit either.
        //   - THIS IS AN ABSOLUTE WIN!!!!
        //   - JUST GET THE FRICKING EDITOR WORKING!!!!

        // Would really like a full dictionary load into core to make the queries
        // super easy.

        // Experiment with loading whole table into a workspace, then doing queries
        // against that!!!.
    }

    /**
     *
     */
    async rpc(rpcExprSegments: ReadonlyArray<string>, ...args: any[]): Promise<any> {
        
        // --- Replace ${} in this tagged template expr with arg
        //     references, and hoist the args into an arg {}.
        let rpcExpr = rpcExprSegments[0];
        const argsObj: Record<string, any> = {};
        args.forEach((argVal, i) => {
            const argName = `$arg${i}`;
            argsObj[argName] = argVal;
            rpcExpr += `(${argName})`;
            rpcExpr += rpcExprSegments[i+1];
        });

        // --- Queue up the request
        const rpcPromise = new Promise((resolve, reject) => {
            this.pendingRequest.addRpc(new Rpc(rpcExpr, argsObj, resolve, reject));
        });

        // --- If we don't have a request in flight - launch the request now
        if(!this.requestInFlight)
            this.invokePendingRequests();

        return rpcPromise;
    }

    // This will mean that manual RPCs will not have return values.
    // TODO any unplanned error paths result in an out of sync workspace -
    //      need to reload in these cases to recover. XXX XXX
    async invokePendingRequests(): Promise<void> {

        // --- If there is already an active request in flight, do nothing, we
        //     will be triggered when the in flight request returns.
        if(!this.requestInFlight)
            return;
        
        // --- Take all changes to the workspace since our last request returned
        //     XXX NOTE: yes, this means that user changes can time travel ahead
        //     of RPCs.  This will do for now, but needs to be fixed.  We have
        //     a much more sophisticated model in mind - but need a working
        //     system this week ... (and we hardly use RPCs anyway).
        const proposedAssertions = this.versionedDb.takeProposedAssertions();
        const pendingRpcs = this.pendingRequest.rpcs;

        // --- If we have nothing to do, return
        //     (a nop RPC is used for our periodic sync requests)
        if(proposedAssertions.length === 0 && pendingRpcs.length === 0)
            return;
            
        // The inflight stuff is broken here - how are we tracking the
        //  that we are in flight.
        
        // --- Request object will have all proposed assertions, followed by all rpcs
        const requestArgs = {
            lastUpdateTimestamp: this.versionedDb.mostRecentSourceDbTimestamp,
            proposedAssertions,
            rpcs: pendingRpcs.map(rpc=>({
                id: rpc.id,
                stmt: rpc.stmt,
                args: rpc.args,
            })),
        };

        // --- Make the request with expr as the URL and the
        //     args json as the post body.
        const httpRequest = new Request('/workspace-rpc-and-sync', {
            method: "POST",
            body: JSON.stringify(requestArgs)});

        const inFlightRequest = this.pendingRequest;
        this.requestInFlight = true;
        this.pendingRequest = new PendingRequest();
        const response = await fetch(httpRequest);
        try {
            console.info('RPC response', response);

            // --- If whole RPC failed, we are dead, for now just give error, need
            //     to resync client at this point - we are in an unknown state XXX
            //     XXX XXX XXX
            if(!response.ok) {
                let errorJson = undefined;
                try {
                    errorJson = await response.json();
                } catch (e) {
                    console.info('failed to read error json');
                }
                const errorMsg = `Workspace sync ${JSON.stringify(requestArgs)} failed - ${JSON.stringify(errorJson)}`;
                alert(errorMsg);
                throw new Error(errorMsg);
            }

            // --- On response we will line up RPC responses with our source RPCs and
            //     call the corresponding resolve/reject methods.
            const responseJson = await response.json();

            // --- Apply updates to workspace (we will be getting our own proposed
            //     updates back here, applyServerAssertion deals with that).
            const updates = responseJson.updates;
            for(const update of updates) {
                this.versionedDb.applyServerAssertion(update);
            }

            // --- Line up RPC responses with our source RPCs and
            //     call the corresponding resolve/reject methods.
            const rpcResponses = responseJson.rpcReponses;
            if(!rpcResponses)
                throw new Error(`RPC response missing`);
            for(const rpc of inFlightRequest.rpcs) {
                if(!Object.hasOwn(rpcResponses, rpc.id))
                    throw new Error(`RPC response missing response #${rpc.id}`);
                const rpcResponse = responseJson.rpcResponses[rpc.id];
                if(Object.hasOwn(rpcResponse, 'error'))
                    rpc.reject(rpcResponse.error);
                else if(Object.hasOwn(rpcResponse, 'ok'))
                    rpc.resolve(rpcResponse.ok);
                else
                    throw new Error(`malformed RPC response`);
            }
        } finally {
            this.requestInFlight = false;
        }

        // --- Recurse (via a promise so no stack growth) in case we have
        //     new requests pending.
        return this.invokePendingRequests();
    }

        // Add ourselves to the list of promises that will be resolved when
        // the pendingRequest resolves.

        // If there is no activeRequest, trigger the pendingRequest.

    // ALSO: When active request resolves, it will fire the pending request if
    //       one is waiting.
    // ALSO: a timer that will queue a NOP rpc if there has not been a request
    //       issued in 200ms (to get a sync pump)

    // COMPLICATION: what time does the RPC happen at?
    // - for just an edit system, it is fine to be just pumping changes back and forth.
    // - for just a single RPC, it is good that the RPC has all the edits applied
    //   before the RPC is fired (they are parameters to the RPC) and it is good
    //   that the changes made by the RPC are always pumped back as part of the RPC.

    // - simplest implementation is that each RPC does a full sync before and after.
    // - BUT: RPCs can be slightly delayed (while waiting for prev to complete) - so
    //   this means that if we push all user edits, we will be pushing user edits
    //   made after the RPC has been issued.
    // - the issue with anything else is that the state tracking gets really hard,
    //   and we are barely using RPCs anyway (and we need to ship in 2 weeks,
    //   so just accept what is easy to code)
    // - so pending request contains a sequence of rpcs, and syncs all user changes
    //   then runs all rpcs in sequence, then returns all results.
    // - the weakness to this scheme is that local edits (mostly user edits) get
    //   to timetravel from the futuer to occur before a pending RPC.
    // - we can forbid use changes if there is a pending RPC???
    // - anyway does not matter.
}

/**
 *
 */
export class PendingRequest {
    rpcs: Rpc[] = [];

    addRpc(rpc: Rpc) {
        this.rpcs.push(rpc);
    }
}

/**
 *
 */
export class Rpc {
    static nextRpcId = 1;
    id: number;
    constructor(public stmt: string, public args: Record<string, any>,
                public resolve: (r:any)=>void, public reject: (r:any)=>void) {
        this.id = Rpc.nextRpcId++;
    }
}

interface WorksplaceRpc {
    id: number,
    stmt: string,
    args: Record<string, any>,
}

export interface WorkspaceRpcAndSyncRequest {
    proposedAssertions: Assertion[],
    rpcs: WorksplaceRpc[],
}


export async function workspaceRpcAndSync(request: WorkspaceRpcAndSyncRequest): Promise<any> {
    (Array.isArray(request?.proposedAssertions) && Array.isArray(request?.rpcs))
        || panic('malformed worksplace rpc and sync request');

    // --- 

    
    // // --- Top level of root scope is active routes
    // const routes = allRoutes();
    // let rootScope = routes;

    // // --- If we have URL search parameters, push them as a scope
    // if(Object.keys(searchParams).length > 0)
    //     rootScope = Object.assign(Object.create(rootScope), searchParams);

    // // --- If the query request body is a {}, then it is form parms or
    // //     a json {} - push on scope.
    // rootScope = Object.assign(Object.create(rootScope), bodyParms);

    // console.info('about to eval', jsExprSrc, 'with root scope ',
    //              utils.getAllPropertyNames(rootScope));

    // let result = null;
    // try {
    //     result = evalJsExprSrc(rootScope, jsExprSrc);
    //     while(result instanceof Promise)
    //         result = await result;
    // } catch(e) {
    //     // TODO more fiddling here.
    //     console.info('request failed', e);
    //     return server.jsonResponse({error: String(e)}, 400)
    // }

    // if(typeof result === 'string')
    //     return server.htmlResponse(result);
    // else if(markup.isElemMarkup(result) && Array.isArray(result) && result[0] === 'html') // this squigs me - but is is soooo convenient!
    //     return server.htmlResponse(markup.renderToStringViaLinkeDOM(result));
    // else
    //     return server.jsonResponse(result);
}

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

    async persistProposedAssertions() {
        
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
    
    applyProposedAssertion(assertion: Assertion)  {
        const versionedTuple = this.getVersionedTupleByPath(getAssertionPath(assertion));
        const assertAtTime = timestamp.nextTime(this.mostRecentLocalTimestamp);
        versionedTuple.applyProposedAssertion(assertAtTime, assertion);
        this.mostRecentLocalTimestamp = assertAtTime;
        this.proposedAssertions.push(assertion);
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
    #currentTuple: TupleVersion|undefined = undefined;
    //[name: string]: RelationField;
    
    constructor(schema: RelationField, id: number) {
        this.schema = schema;
        this.childRelations = Object.fromEntries(
            schema.relationFields.map(r=>[r.tag, new VersionedRelation(r, this)]));
        this.id = id;
    }

    
    get current(): TupleVersion|undefined {
        return this.#currentTuple;
    }

    get currentAssertion(): Assertion|undefined {
        return this.#currentTuple?.assertion;
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
            throw new Error(`unexpected tag ${ty} -- FIX ERROR NEED LOCUS ETC`);
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
    
    untrackedApplyAssertion(assertion: Assertion) {
        const tuple = new TupleVersion(this, assertion);
        // TODO lots of validation here + index updating etc.
        const mostRecentTuple = this.mostRecentTuple;

        if(mostRecentTuple) {
            if(mostRecentTuple.assertion.valid_to) {
                if(tuple.assertion.valid_from !== mostRecentTuple.assertion.valid_to) {
                    throw new Error(`FIX ERROR: valid_from chain broken`);
                }
            } else {
                // This is tricky - we should probably mute the valid_to on the previous
                //  most current tuple - but this complicates undo etc.  The fact that
                //  valid_to with a non-null value is also used for undo complicates things.
                if(mostRecentTuple.assertion.valid_from <= tuple.assertion.valid_from) {
                    throw new Error(`FIX ERROR: time travel prolbem`);
                }
            }
        }
        
        this.tupleVersions.push(tuple);
        
        if(tuple.isCurrent)
            this.#currentTuple = tuple;
    }

    applyProposedAssertion(assertAtTime: number, assertion: Assertion) {

        const tuple = new TupleVersion(this, assertion);
        const mostRecentTuple = this.mostRecentTuple;

        assertion.valid_from = assertAtTime;

        
        // TODO lots of validation here + index updating etc.
        // TODO update current.
        // TODO tie into speculative mechanism.

        if(mostRecentTuple) {
            
        }

        this.tupleVersions.push(tuple);
        console.info('applied proposed assertion', assertion);
        
        if(tuple.isCurrent)
            this.#currentTuple = tuple;
    }

    applyServerAssertion(assertion: Assertion) {

        // TODO MORE VALIDATION HERE.
        // TODO If already have same assertion as a proposed assertion,
        //      confirm they are the same and do minor touchups (time)
        
        const tuple = new TupleVersion(this, assertion);
        const mostRecentTuple = this.mostRecentTuple;

        // TODO lots of validation here + index updating etc.
        // TODO update current.
        // TODO tie into speculative mechanism.

        if(mostRecentTuple) {
            
        }

        this.tupleVersions.push(tuple);
        console.info('applied proposed assertion', assertion);
        
        if(tuple.isCurrent)
            this.#currentTuple = tuple;
    }

    get mostRecentTuple() {
        // Note: we are making use of the JS behaviour where out of bound index accesses return undefined.
        return this.tupleVersions[this.tupleVersions.length-1];
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
        return this.tupleVersions.slice(0, -1);
    }

    toJSON(): any {
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
            const historicalVersions = this.historicalTupleVersions.map(h=>h.toJSON());
            const childRelations = Object.fromEntries(schema.relationFields.map(r=>
                [r.name, this.childRelations[r.tag].toJSON()]));
            //console.info('CHILD RELATIONS', JSON.stringify(childRelations, undefined, 2));
            const json: any = {
                ...controlFields,
                ...entityFields
            };
            // const json: any = entityFields;
            if(historicalVersions.length > 0)
                json['history'] = historicalVersions;
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
    readonly tuples: Map<number,VersionedTupleQuery>;
    
    constructor(src: VersionedRelation) {
        this.src = src;
        this.schema = src.schema;
        this.tuples = this.computeTuples();
    }

    abstract computeTuples(): Map<number, VersionedTupleQuery>;

    toJSON(): any {
        return Array.from(this.tuples.values()).map(t=>t.toJSON());
    }
                               
    dump(): any {
        return Object.fromEntries([...this.tuples.entries()].map(([id, child])=>
            [id, child.dump()]));
    }
}
    
/**
 *
 * TODO: hook up versioned parent.
 */
export class CurrentRelationQuery extends VersionedRelationQuery {
    declare tuples: Map<number,CurrentTupleQuery>;
    
    constructor(src: VersionedRelation) {
        super(src);
    }

    computeTuples(): Map<number, CurrentTupleQuery> {
        const currentTupleQuerys = [...this.src.tuples.entries()].
            map(([id,tup]: [number, VersionedTuple]): [number, CurrentTupleQuery]=>
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

export function generateBeforeOrderKey(parent: VersionedRelation,
                                       refTupleId: number): string {
    const orderedTuplesById = new CurrentRelationQuery(parent).tuples;
    const refTuple = orderedTuplesById.get(refTupleId);
    if(refTuple===undefined)
        throw new Error(`unable to find ref tuple with id ${refTupleId} when trying to compute before order key`);
    let prev: CurrentTupleQuery|undefined = undefined;
    for(let t of orderedTuplesById.values()) {
        if(t.src.id === refTupleId) {
            const before_key = prev?.mostRecentTupleVersion?.assertion?.order_key ?? orderkey.begin_string;
            return orderkey.between(
                before_key,
                refTuple.mostRecentTupleVersion?.assertion.order_key
                    ?? panic('tuple is missing:: tuple_id is', refTupleId));
        }
        prev = t;
    }
    throw new Error(`unable to find ref tuple with id ${refTupleId} when trying to compute before order key (2)`);
}

export function generateAfterOrderKey(parent: VersionedRelation,
                                      refTupleId: number): string {
    const orderedTuplesById = new CurrentRelationQuery(parent).tuples;
    const refTuple = orderedTuplesById.get(refTupleId);
    if(refTuple===undefined)
        throw new Error(`unable to find ref tuple with id ${refTupleId} when trying to compute after order key`);
    let prev: CurrentTupleQuery|undefined = undefined;
    for(let t of [...orderedTuplesById.values()].toReversed()) {
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


/**
 * 9:45 Wed haircut
 */
// export function testRenderEntry(assertions: Assertion[]): any {
    
//     const dictSchema = model.Schema.parseSchemaFromCompactJson('dict', dictSchemaJson);

//     console.info('Sample entry assertions', assertions);

//     // --- Create an empty instance schema
//     const mmoDb = new VersionedDb([dictSchema]);
//     assertions.forEach(a=>mmoDb.untrackedApplyAssertionByPath(getAssertionPath(a), a));
//     //console.info('MMODB', JSON.stringify(mmoDb.dump(), undefined, 2));
    
//     // const mmoDb = new VersionedTuple/*<DictionaryNode>*/(dictSchema, 0);
//     // assertions.forEach(a=>mmoDb.untrackedApplyAssertionByPath(getAssertionPath(a), a));
//     // console.info('MMODB', JSON.stringify(mmoDb.dump(), undefined, 2));

//     //const entries = mmoDb.childRelations['en'];
//     //console.info('entries', entries);
    
//     // --- Navigate to definition
//     // let definition = mmoDb.findRequiredVersionedTupleById(992);
//     // console.info('definition', definition.dump());

//     const current = new CurrentTupleQuery(mmoDb.getTable('di'));
//     console.info('current view', JSON.stringify(current.dump(), undefined, 2));

//     const mmoView = view.schemaView(dictSchema);
//     const renderer = new view.Renderer(mmoView, 'root');
//     return renderer.renderTuple(current);
// }

/**
 *
 */
// export function test(entry_id: number=1000): any {
//     // --- Load the tuples for a dictionary entry.
//     const sampleEntryAssertions = selectAssertionsForTopLevelFact('dict').all({id1:entry_id});
//     return (
//         ['html', {},
//          ['head', {},
//           ['link', {href: '/resources/instance.css', rel:'stylesheet', type:'text/css'}],
//           /*['script', {src:'/scripts/tagger/page-editor.js'}]*/],
//          ['body', {},
//           testRenderEntry(sampleEntryAssertions)]]);
// }

/**
 *
 */
function clientRenderTest(entry_id: number): any {
    return (
        ['html', {},
         ['head', {},
          ['meta', {charset:"utf-8"}],
          ['meta', {name:"viewport", content:"width=device-width, initial-scale=1"}],
          ['title', {}, 'Wordwiki'],
          config.bootstrapCssLink,
          ['link', {href: '/resources/instance.css', rel:'stylesheet', type:'text/css'}],
          ['script', {}, block`
/**/           let imports = {};
/**/           let activeViews = undefined`],
          //['script', {src:'/scripts/tagger/instance.js', type: 'module'}],
          ['script', {type: 'module'}, block`
/**/           import * as workspace from '/scripts/tagger/workspace.js';
/**/           import * as view from '/scripts/tagger/view.js';
/**/
/**/           imports = Object.assign(
/**/                        {},
/**/                        view.exportToBrowser(),
/**/                        workspace.exportToBrowser());
/**/
/**/           activeViews = imports.activeViews();
/**/
/**/           document.addEventListener("DOMContentLoaded", (event) => {
/**/             console.log("DOM fully loaded and parsed");
/**/             view.run();
/**/             //workspace.renderSample(document.getElementById('root'))
/**/           });`
          ]
        ],
        
         ['body', {},
          
          ['div', {id: 'root'}, entry_id],

          config.bootstrapScriptTag,

         ] // body
         
        ]);

}


/**
 *
 */
function renderEntryListTest(): any {
    return (
        ['html', {},
         ['head', {},
          ['meta', {charset:"utf-8"}],
          ['meta', {name:"viewport", content:"width=device-width, initial-scale=1"}],
          ['title', {}, 'Wordwiki'],
          
          config.bootstrapCssLink,

          ['link', {href: '/resources/instance.css', rel:'stylesheet', type:'text/css'}],
          ['script', {}, block`
/**/           let imports = {};
/**/           let activeViews = undefined`],
          //['script', {src:'/scripts/tagger/instance.js', type: 'module'}],
          ['script', {type: 'module'}, block`
/**/           import * as workspace from '/scripts/tagger/workspace.js';
/**/           import * as view from '/scripts/tagger/view.js';
/**/
/**/           imports = Object.assign(
/**/                        {},
/**/                        view.exportToBrowser(),
/**/                        workspace.exportToBrowser());
/**/
/**/           activeViews = imports.activeViews();
/**/
/**/           document.addEventListener("DOMContentLoaded", (event) => {
/**/             console.log("DOM fully loaded and parsed");
/**/             //view.run();
/**/             //workspace.renderSample(document.getElementById('root'))
/**/           });`
          ]
        ],
        
         ['body', {},
          
          //['div', {id: 'root'}, entry_id],

          config.bootstrapScriptTag,

         ] // body
         
        ]);

}






// - Workspace needs to be global (per page)
// - Live views - which have a html id and a ??? also need to be global.
// - after a change, we (ideally incrementally - but for now just completely) rerender
//   all live views.
// - the RHS of the live views thing? Can be a ()=>CurrentTupleQuery[] for now.

//console.info('HI FROM INSTANCE!');

// export async function renderSample(root: Element) {
//     console.info('rendering sample');
//     root.innerHTML = 'POW!';

//     const entryId = 1000;
//     const assertions = await rpc`getAssertionsForEntry(${entryId})`;
//     console.info('Assertions', JSON.stringify(assertions, undefined, 2));

//     const rendered = testRenderEntry(assertions);

//     root.innerHTML = renderToStringViaLinkeDOM(rendered);
    
// }

export function getAssertionsForEntry(entry_id: number): any {
    return selectAssertionsForTopLevelFact('dict').all({id1: entry_id});
}

export const exportToBrowser = ()=> ({
});

export const routes = ()=> ({
    //instanceTest: test,
    clientRenderTest,
    renderEntryListTest,
    getAssertionsForEntry,
    //workplaceSync,
});


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
        const current = new CurrentTupleQuery(workspace.getTableByTag('di'));
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
    const dictionaryTuple = workspace.getTableByTag('di');
    const entriesRelation: VersionedRelation = dictionaryTuple.childRelations['en'];


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
