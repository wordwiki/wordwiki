// deno-lint-ignore-file no-explicit-any
/**
 * The versioned workspace: an in-RAM mirror of an assertion table, shaped as
 * a tree of facts (see assertion-model.md at the repo root for the model).
 *
 *   VersionedDb                one workspace, holding one VersionedTable per
 *                              assertion table (today: just 'dct')
 *   VersionedTable             the tree root - a VersionedTuple with id 0 and
 *                              NO versions of its own; queries deliberately
 *                              treat it as an empty record.  Also keeps the
 *                              per-table fact-id index (ids are unique per
 *                              table, enforced at fact creation).
 *   VersionedTuple             one fact: its versions (TupleVersion[], oldest
 *                              first) and its child relations
 *   VersionedRelation          one child relation of a fact: its facts by id
 *   TupleVersion               one version of a fact = one Assertion row
 *
 * Mutation enters ONLY through the VersionedDb methods:
 *
 *   applyProposedAssertion     a live edit: validates and applies one new
 *                              assertion (see the ownership contract on the
 *                              method)
 *   untrackedApplyAssertion    the load-from-db path: applies an already-
 *                              persisted assertion, validating the chains
 *
 * The current view (deleted facts filtered, siblings ordered by order_key) is
 * computed by the query layer (CurrentTupleQuery / CurrentRelationQuery),
 * which is constructed per use and never mutates the workspace.
 */
import {RelationField, Schema} from "./model.ts";
import {panic} from "../liminal/utils.ts";
import * as utils from "../liminal/utils.ts";
import { Assertion, AssertionPath, getAssertionPath, parentAssertionPath,
         compareAssertionsByOrderKey, compareAssertionsByRecentness } from "./assertion.ts";
import * as timestamp from "../liminal/timestamp.ts";
import {BEGINNING_OF_TIME} from '../liminal/timestamp.ts';
import * as orderkey from '../liminal/orderkey.ts';

export type Tag = string;

// -------------------------------------------------------------------------------
// --- VersionedDb ----------------------------------------------------------------
// -------------------------------------------------------------------------------

export class VersionedDb {
    readonly tables: Map<Tag, VersionedTable> = new Map();

    // The most recent timestamp applied to this workspace.  Imposes a TOTAL
    // order on edits across the whole workspace - correct for a single
    // server, and the exact gate that will have to relax when offline forks
    // are merged (see assertion-model.md, design intent 4).  Also why two
    // assertions cannot share a timestamp (applyTransactions sidesteps this
    // by allocating a distinct server timestamp per tx group).
    mostRecentLocalTimestamp: number = BEGINNING_OF_TIME;

    // Every assertion_id ever applied to this workspace (load or live). An
    // assertion_id identifies one version for all time, so a repeat is
    // corruption - caught here, at the row it enters on, rather than at some
    // later derivation. (versioned-db-validate.ts re-states this, and the
    // tail/orphan invariants the incremental walk cannot see, independently.)
    readonly #seenAssertionIds = new Set<number>();

    constructor(schemas: Schema[]) {
        schemas.forEach(s=>this.addTable(s));
    }

    // Cheap per-assertion invariants checked on EVERY apply path.
    private _trackAssertion(assertion: Assertion) {
        if(!Number.isFinite(assertion.assertion_id))
            throw new Error(`assertion has no assertion_id: ${JSON.stringify(assertion)}`);
        if(this.#seenAssertionIds.has(assertion.assertion_id))
            throw new Error(`duplicate assertion_id ${assertion.assertion_id} - an assertion_id identifies one version for all time`);
        if(assertion.valid_from > assertion.valid_to)
            throw new Error(`assertion ${assertion.assertion_id} has valid_from ${assertion.valid_from} > valid_to ${assertion.valid_to}`);
        this.#seenAssertionIds.add(assertion.assertion_id);
    }

    addTable(schema: Schema): VersionedTable {
        if(this.tables.has(schema.tag))
            throw new Error(`attempting to add schema with duplicate tag ${schema.tag}`);
        const versionedTable = new VersionedTable(schema);
        this.tables.set(schema.tag, versionedTable);
        return versionedTable;
    }

    getTableByTag(tag: string): VersionedTable {
        return this.tables.get(tag) ?? panic('unable to find table with tag', tag);
    }

    /**
     * Apply one new (proposed) assertion.  Returns the predecessor assertion
     * if its valid_to was stamped (so the caller can persist that update), or
     * undefined when no predecessor update is needed (first version of a
     * fact, or a restore over an already-closed predecessor).
     *
     * OWNERSHIP CONTRACT: assertions handed to this method are owned by the
     * workspace from then on, and a previously-applied assertion is MUTATED
     * when a successor closes it (its valid_to is stamped - that same object
     * is the return value).  Callers that need an unaliased copy must clone
     * before applying.
     */
    applyProposedAssertion(assertion: Assertion): Assertion|undefined  {
        this._trackAssertion(assertion);
        if(assertion.valid_from <= this.mostRecentLocalTimestamp)
            throw new Error(`Attempt to assert into the past - asserting at ${assertion.valid_from} most recent local timestamp is ${this.mostRecentLocalTimestamp} - ${assertion.valid_from - this.mostRecentLocalTimestamp} should be positive`);
        if(assertion.valid_to !== assertion.valid_from &&
            assertion.valid_to !== timestamp.END_OF_TIME)
            throw new Error('New assertions must either be true to the end of time, or be deletion tombstones');
        const versionedTuple = this.getOrCreateVersionedTupleByPath(getAssertionPath(assertion));
        const updatedPrevAssertion = versionedTuple._applyProposedAssertion(assertion);
        this.mostRecentLocalTimestamp = assertion.valid_from;
        return updatedPrevAssertion;
    }

    /**
     * Apply an already-persisted assertion (the load-from-db path).
     *
     * PRECONDITION: each fact's versions must be applied in valid_from order
     * (the load queries say ORDER BY valid_from), and a fact's ancestors must
     * have had their first version applied before the fact's (guaranteed
     * because an ancestor is always asserted before its descendants).
     */
    untrackedApplyAssertion(assertion: Assertion) {
        this._trackAssertion(assertion);
        const versionedTuple = this.getOrCreateVersionedTupleByPath(getAssertionPath(assertion));
        versionedTuple._untrackedApplyAssertion(assertion);
        this.mostRecentLocalTimestamp = assertion.valid_from;
    }

    /**
     * Look up the fact at `path`.  Throws if any segment does not exist -
     * lookups never create (the apply paths use the get-or-create variant
     * below).
     */
    getVersionedTupleByPath(path: AssertionPath): VersionedTuple {
        const table = this.#tableForPath(path);
        if(path.length === 1)
            return table;
        return table._getVersionedTupleByPath(path, 1, undefined);
    }

    /**
     * Look up the fact at `path`, creating (empty) nodes for any missing
     * segments.  Apply-paths only: creation registers each new fact id in the
     * table's id index, which is where fact-id uniqueness is enforced.
     */
    getOrCreateVersionedTupleByPath(path: AssertionPath): VersionedTuple {
        const table = this.#tableForPath(path);
        if(path.length === 1)
            return table;
        return table._getVersionedTupleByPath(path, 1, table);
    }

    #tableForPath(path: AssertionPath): VersionedTable {
        const [ty, id] = path[0];
        if(id !== 0)
            throw new Error(`root elem in any table is always id 0 - path is ${JSON.stringify(path)}`);
        const table = this.tables.get(ty);
        if(!table)
            throw new Error(`could not find table with tag ${ty} in workspace, active tables are ${[...this.tables.keys()].join()}`);
        utils.assert(table.schema.tag === ty);
        return table;
    }

    getVersionedTupleParentRelation(childTuplePath: AssertionPath): VersionedRelation {
        const parentTuple = this.getVersionedTupleByPath(parentAssertionPath(childTuplePath));
        const parentRelationTag = childTuplePath[childTuplePath.length-1][0];
        return parentTuple.childRelations[parentRelationTag]
            ?? panic('no child relation with tag', `${parentRelationTag} on ${parentTuple.schema.tag}`);
    }

    dump(): any {
        return [...this.tables.entries()].map(([tag, table])=>
            [tag, table.dump()]);
    }
}

// -------------------------------------------------------------------------------
// --- VersionedTuple --------------------------------------------------------------
// -------------------------------------------------------------------------------

export class VersionedTuple {
    readonly id: number;
    readonly schema: RelationField;
    readonly tupleVersions: TupleVersion[] = [];
    readonly childRelations: Record<Tag,VersionedRelation>;

    constructor(schema: RelationField, id: number) {
        this.schema = schema;
        this.childRelations = Object.fromEntries(
            schema.relationFields.map(r=>[r.tag, new VersionedRelation(r, this)]));
        this.id = id;
    }

    /**
     * The most recent version of this fact - which may be a deletion
     * tombstone (check .isCurrent), and is undefined only for the table root
     * and not-yet-asserted facts.
     */
    get mostRecentTuple(): TupleVersion|undefined {
        return this.tupleVersions[this.tupleVersions.length-1];
    }

    /**
     * The most recent version's assertion.  NOTE despite the name this may be
     * a tombstone - callers that need a LIVE fact must check
     * mostRecentTuple.isCurrent (the current-view query layer does this for
     * you).
     */
    get currentAssertion(): Assertion|undefined {
        return this.mostRecentTuple?.assertion;
    }

    /**
     * Path-lookup recursion.  When `createInTable` is supplied (the apply
     * paths), missing segments are created and their fact ids registered in
     * the table's id index; otherwise a missing segment throws.
     */
    _getVersionedTupleByPath(path: [string, number][], index: number,
                             createInTable: VersionedTable|undefined): VersionedTuple {
        const [ty, id] = path[index];

        const versionedRelation = this.childRelations[ty];
        if(!versionedRelation)
            throw new Error(`no child relation with tag ${ty} on ${this.schema.tag} - path ${JSON.stringify(path)}`);
        utils.assert(versionedRelation.schema.tag === ty);

        let versionedTuple = versionedRelation.tuples.get(id);
        if(!versionedTuple) {
            if(!createInTable)
                throw new Error(`no fact ${ty}:${id} under ${this.schema.tag}:${this.id} - path ${JSON.stringify(path)}`);
            createInTable._assertNewFactId(ty, id);
            versionedTuple = new VersionedTuple(versionedRelation.schema, id);
            versionedRelation.tuples.set(id, versionedTuple);
            createInTable._registerTuple(versionedTuple);
        }
        utils.assert(versionedTuple.schema.tag === ty);

        if(index+1 === path.length)
            return versionedTuple;
        else
            return versionedTuple._getVersionedTupleByPath(path, index+1, createInTable);
    }

    forEachVersionedTuple(f: (r:VersionedTuple)=>void) {
        f(this);
        for(const v of Object.values(this.childRelations))
            v.forEachVersionedTuple(f);
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
            if(t!==this && t.mostRecentTuple?.isCurrent === true)
                nonDeletedChildTuples.push(t);
        });
        return nonDeletedChildTuples;
    }

    /**
     * Load-path apply (see VersionedDb.untrackedApplyAssertion for the
     * preconditions).  Internal: enter through the VersionedDb methods, which
     * carry the workspace-level validations and bookkeeping.
     */
    _untrackedApplyAssertion(assertion: Assertion) {
        const prevTuple = this.mostRecentTuple;
        if(prevTuple) {
            const prevAssertion = prevTuple.assertion;
            if(assertion.replaces_assertion_id !== prevAssertion.assertion_id)
                throw new Error(`replaces_assertion_id chain broken - ${JSON.stringify(prevAssertion)} TO ${JSON.stringify(assertion)}`);
            // A successor normally starts exactly when its predecessor ends; a
            // LATER start is a valid-time gap, which is how a restore after a
            // delete looks (the fact did not exist during the gap).
            if(assertion.valid_from < prevAssertion.valid_to)
                throw new Error(`valid_from chain broken - ${JSON.stringify(prevAssertion, undefined, 2)} TO ${JSON.stringify(assertion, undefined, 2)}`);
        }
        this.tupleVersions.push(new TupleVersion(this, assertion));
    }

    /**
     * Live-edit apply (see VersionedDb.applyProposedAssertion for the
     * validations and the ownership contract).  Internal: enter through the
     * VersionedDb methods.
     */
    _applyProposedAssertion(assertion: Assertion): Assertion|undefined {
        const prevTuple = this.mostRecentTuple;
        let updatedPrevAssertion: Assertion|undefined = undefined;
        const assertAtTime = assertion.valid_from;

        if(prevTuple) {
            const prevAssertion = prevTuple.assertion;

            if(assertion.replaces_assertion_id !== prevAssertion.assertion_id)
                throw new Error(`replaces_assertion_id chain broken - ${JSON.stringify(prevAssertion)} TO ${JSON.stringify(assertion)}`);
            if(!(assertAtTime > prevAssertion.valid_from))
                throw new Error(`Attempt to assert a tuple in the past`);

            if(prevAssertion.valid_to === timestamp.END_OF_TIME) {
                // Replacing the live version: a normal update.  Close the
                // predecessor at our start time (THE one in-place mutation in
                // the model - the caller persists the returned object).
                prevAssertion.valid_to = assertAtTime;
                updatedPrevAssertion = prevAssertion;
            } else if(prevAssertion.valid_to < assertAtTime) {
                // Predecessor is already closed in our past (deleted): this
                // is a restore/undelete starting a new valid period after the
                // gap.  No predecessor update needed.
            } else {
                // Predecessor's end-of-life is at/after our start (and not
                // END_OF_TIME): asserting into the past.
                throw new Error(`Attempt to assert a tuple in the past`);
            }
        }

        this.tupleVersions.push(new TupleVersion(this, assertion));
        return updatedPrevAssertion;
    }

    dump(): any {
        return {
            versions: this.tupleVersions.map(a=>a.dump()),
            ...Object.fromEntries(Object.values(this.childRelations).map(c=>
                [c.schema.name, c.dump()]))
        };
    }
}

// -------------------------------------------------------------------------------
// --- VersionedTable --------------------------------------------------------------
// -------------------------------------------------------------------------------

/**
 * The tree root for one assertion table: a VersionedTuple with id 0 that
 * never has versions of its own (queries treat it as an empty record - the
 * deliberate resolution of the "how does the root work" question).
 *
 * Also owns the per-table fact-id index: fact ids must be unique per table
 * (the editor addresses facts by id, and findVersionedTupleById assumes it),
 * enforced when a fact is first created.
 */
export class VersionedTable extends VersionedTuple {
    readonly #tuplesById = new Map<number, VersionedTuple>();

    constructor(schema: RelationField) {
        super(schema, 0);
    }

    /** O(1) fact lookup by id (undefined for the root and unknown ids). */
    getTupleById(id: number): VersionedTuple|undefined {
        return this.#tuplesById.get(id);
    }

    _assertNewFactId(ty: string, id: number) {
        const existing = this.#tuplesById.get(id);
        if(existing)
            throw new Error(`duplicate fact id ${id}: new ${ty} fact collides with existing ${existing.schema.tag} fact - fact ids must be unique per table`);
    }

    _registerTuple(tuple: VersionedTuple) {
        this.#tuplesById.set(tuple.id, tuple);
    }
}

// -------------------------------------------------------------------------------
// --- VersionedRelation ------------------------------------------------------------
// -------------------------------------------------------------------------------

export class VersionedRelation {
    readonly schema: RelationField;
    readonly parent: VersionedTuple;
    readonly tuples: Map<number,VersionedTuple> = new Map();

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

// -------------------------------------------------------------------------------
// --- TupleVersion -----------------------------------------------------------------
// -------------------------------------------------------------------------------

export class TupleVersion {
    readonly tuple: VersionedTuple;
    readonly assertion: Assertion;

    #domainFields: Record<string,any>|undefined = undefined;

    constructor(tuple: VersionedTuple, assertion: Assertion) {
        this.tuple = tuple;
        this.assertion = assertion;
    }

    get assertion_id(): number {
        return this.assertion.assertion_id;
    }

    get isCurrent(): boolean {
        return this.assertion.valid_to === timestamp.END_OF_TIME;
    }

    /** This version is the fact's currently-published truth (the public view -
     *  see publication-model.md). At most one version per fact is (I2), and it
     *  may not be the most recent (an approved value while a pending edit sits
     *  on top). */
    get isPublished(): boolean {
        return this.assertion.published_to === timestamp.END_OF_TIME;
    }

    // The version's domain values keyed by schema field NAME (the $bind
    // mapping applied).  Memoization is safe because the only field the
    // workspace ever mutates on an applied assertion is valid_to, which is
    // not a domain field (it would become a stale-cache bug if a schema ever
    // bound a field to 'valid_to').
    get domainFields(): Record<string,any> {
        return this.#domainFields ??= Object.fromEntries(
            this.tuple.schema.scalarFields.map(f=>[f.name, (this.assertion as any)[f.bind]]));
    }

    toJSON(): Record<string,any> {
        return {...this.domainFields};
    }

    dump(): any {
        const a = this.assertion;
        return {
            ...(a.valid_from !== timestamp.BEGINNING_OF_TIME ?
                {valid_from: timestamp.formatTimestampAsUTCTime(a.valid_from)} : {}),
            ...(a.valid_to !== timestamp.END_OF_TIME ?
                {valid_to: timestamp.formatTimestampAsUTCTime(a.valid_to)} : {}),
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

// -------------------------------------------------------------------------------
// --- The current view (query layer) ------------------------------------------------
// -------------------------------------------------------------------------------

export abstract class VersionedTupleQuery {
    readonly src: VersionedTuple;
    readonly schema: RelationField;
    readonly tupleVersions: TupleVersion[];
    readonly childRelations: Record<Tag,VersionedRelationQuery> = {};
    readonly #json: Record<string, any> = {};

    constructor(src: VersionedTuple) {
        this.src = src;
        this.schema = src.schema;
        this.tupleVersions = this.computeTuples();
        this.childRelations = this.computeChildRelations();
    }

    abstract computeTuples(): TupleVersion[];
    abstract computeChildRelations(): Record<Tag, VersionedRelationQuery>;

    get mostRecentTupleVersion(): TupleVersion|undefined {
        return this.tupleVersions[this.tupleVersions.length-1];
    }

    /** The PRIOR versions of this fact (every version except the one the
     *  query presents as most recent; all versions for a deleted fact). */
    get historicalTupleVersions(): TupleVersion[] {
        return this.src.tupleVersions.filter(tv => tv !== this.mostRecentTupleVersion);
    }

    toJSON(includeHistory: boolean = false): any {
        const cacheKey = includeHistory ? 'history' : 'plain';
        return this.#json[cacheKey] ??= (()=>{
            const schema = this.schema;
            // The table root (and a not-yet-asserted fact) has no versions:
            // present it as an empty record carrying only its child relations.
            const entityFields = this.mostRecentTupleVersion?.toJSON() ?? {};
            const childRelations = Object.fromEntries(schema.relationFields.map(r=>
                [r.name, this.childRelations[r.tag].toJSON(includeHistory)]));
            const json: any = {...entityFields};
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
            versions: this.tupleVersions.map(a=>a.dump()),
            ...Object.fromEntries(Object.values(this.childRelations).map(c=>
                [c.src.schema.name, c.dump()]))
        };
    }
}

export class CurrentTupleQuery extends VersionedTupleQuery {
    declare childRelations: Record<Tag, CurrentRelationQuery>;

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

export class CurrentRelationQuery extends VersionedRelationQuery {
    declare tuplesById: Map<number,CurrentTupleQuery>;
    declare tuples: CurrentTupleQuery[];

    computeCurrentTuplesById(): Map<number, CurrentTupleQuery> {
        // Live facts only, in user (order_key) order.  The non-null
        // assertions are safe: the filter guarantees a current version.
        const currentTupleQuerys = [...this.src.tuples.entries()]
            .filter(([_id, tup]) => tup.mostRecentTuple?.isCurrent)
            .map(([id, tup]): [number, CurrentTupleQuery] =>
                [id, new CurrentTupleQuery(tup)]);

        const inUserOrder =
            currentTupleQuerys.toSorted(([_aId, aTup], [_bId, bTup]) =>
                compareVersionedTupleAssertionByOrderKey(
                    aTup.mostRecentTupleVersion!, bTup.mostRecentTupleVersion!));

        return new Map(inUserOrder);
    }
}

// -------------------------------------------------------------------------------
// --- The PUBLISHED view (the public projection - publication-model.md) -------------
// -------------------------------------------------------------------------------
//
// Parallel to the Current* query: presents each fact's currently-PUBLISHED
// version (published_to === END_OF_TIME) instead of its valid-current version,
// and a fact appears only if it has one (so a published parent with a pending
// child shows the parent without the unapproved child; a pending edit shows the
// last approved value). The public site renders this, gated additionally by the
// entry's status (see WordWiki.publishedEntries).

export class PublishedTupleQuery extends VersionedTupleQuery {
    declare childRelations: Record<Tag, PublishedRelationQuery>;

    computeTuples(): TupleVersion[] {
        // The published-current version (at most one per fact, by I2).
        return this.src.tupleVersions.
            filter(tv => tv.isPublished).
            toSorted(compareVersionedTupleByRecentness);
    }

    computeChildRelations(): Record<Tag, VersionedRelationQuery> {
        return Object.fromEntries(Object.entries(this.src.childRelations).
                map(([tag,rel]) => [tag, new PublishedRelationQuery(rel)]));
    }
}

export class PublishedRelationQuery extends VersionedRelationQuery {
    declare tuplesById: Map<number,PublishedTupleQuery>;
    declare tuples: PublishedTupleQuery[];

    computeCurrentTuplesById(): Map<number, PublishedTupleQuery> {
        // Facts that HAVE a published-current version (which need NOT be the
        // most recent), in user (order_key) order of that published version.
        const queries = [...this.src.tuples.entries()]
            .filter(([_id, tup]) => tup.tupleVersions.some(tv => tv.isPublished))
            .map(([id, tup]): [number, PublishedTupleQuery] =>
                [id, new PublishedTupleQuery(tup)]);

        const inUserOrder =
            queries.toSorted(([_aId, aTup], [_bId, bTup]) =>
                compareVersionedTupleAssertionByOrderKey(
                    aTup.mostRecentTupleVersion!, bTup.mostRecentTupleVersion!));

        return new Map(inUserOrder);
    }
}

export function currentTuplesForVersionedRelation(relation: VersionedRelation): CurrentTupleQuery[] {
    return Array.from(new CurrentRelationQuery(relation).tuples);
}

// -------------------------------------------------------------------------------
// --- Order-key generation over a live relation --------------------------------------
// -------------------------------------------------------------------------------

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
                ?? panic('tuple is missing:: tuple_id is', String(refTupleId));
            return orderkey.between(before_key, after_key);
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
            const after_key = prev?.mostRecentTupleVersion?.assertion?.order_key ?? orderkey.end_string;
            return orderkey.between(
                refTuple.mostRecentTupleVersion?.assertion.order_key
                    ?? panic('tuple is missing:: tuple_id is', String(refTupleId)),
                after_key);
        }
        prev = t;
    }
    throw new Error(`unable to find ref tuple with id ${refTupleId} when trying to compute after order key (2)`);
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
