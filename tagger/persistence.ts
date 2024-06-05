// // deno-lint-ignore-file no-unused-vars

// import {CustomError} from "../utils/errors.ts";
// import {typeof_extended} from "../utils/utils.ts";
// import * as utils from "../utils/utils.ts";
// import {panic, assert, assertNever} from "../utils/utils.ts";
// //import { DB /*, PreparedQuery, QueryParameter, QueryParameterSet*/ } from "https://deno.land/x/sqlite/mod.ts";

// import { Db, PreparedQuery } from "./db.ts";
// import { PreparedQueryCache } from "./dbutils.ts";
// import * as dbutils from "./dbutils.ts";
// import * as orderkey from '../utils/orderkey.ts';
// import * as timestamp from '../utils/timestamp.ts';
// //import { longestIncreasingSequenceUsingCompareFn } from '../utils/longest-increasing-sequence.js';
// import { Record, Value, getPrimaryKey, getString, getOptionalString, idCollator } from './record.ts';
// import * as schema from "./schema.ts";
// import { FieldKind, RelationField, ValidationError } from "./schema.ts";

// /**
//  * XXX TODO child relation map.
//  * XXX need to rename to something like: RelationDbDriver  Relation
//  * XXX consider renaming relationField???
//  * XXX ideally, don't have a connection between RelationField and this, tree
//  *     should live just here.
//  * XXX NEXT Build this tree.
//  *
//  */



// // export interface ValidateOpts {
// //     expectOrder: boolean,
// //     expectVersioning: boolean,
// // }

// export interface ReconstituteOpts {
//     includeVersionHistory?: boolean;
//     includeOrder?: boolean;
//     verbose?: boolean;
// }


// export function buildRelationSQLDriver(db: Db, relationField: RelationField): RelationSQLDriver {
//     return new RelationSQLDriver(db, relationField,
//                                  relationField.relationFields.map(r=>buildRelationSQLDriver(db, r)));
// }

// /**
//  *
//  */
// export class RelationSQLDriver {
//     name: string;

//     // Automatically set when a field is added to a relation.
//     // Note: synthetic fields are not model children, and thus do not have parent set.
//     parent: RelationSQLDriver|undefined = undefined;

//     #ancestorRelations_: RelationSQLDriver[]|undefined;
//     #descendantAndSelfRelations_: RelationSQLDriver[]|undefined;

//     #childRelationsByName: {[name:string]:RelationSQLDriver};

//     /**
//      * Putting a separate PreparedQueryCache on each relation makes
//      * the debugging dumps of the queries the system uses more readable.
//      */
//     #preparedQueryCache: PreparedQueryCache = new PreparedQueryCache();

//     constructor(public db: Db,
//                 public relationField: RelationField,
//                 public childRelations: RelationSQLDriver[]) {

//         this.name = relationField.name;

//         // Set parent on all children.
//         let nextDbColumnIndex = 0;
//         for(const f of childRelations) {
//             if(f.parent)
//                 throw new Error(`field ${f.name} cannot be child of relation ${this.name} - is already a child of relation ${f.parent.name}`);
//             f.parent = this;
//             if(f.db !== this.db)
//                 throw new Error('all relations in a RelationSQLDriver must have the same db');
//         }

//         this.#childRelationsByName = Object.fromEntries(childRelations.map(c=>[c.name, c]));
//     }

//     getChildRelationByName(name:string): RelationSQLDriver|undefined {
//         return this.#childRelationsByName[name];
//     }

//     getRequiredChildRelationByName(name:string): RelationSQLDriver {
//         const childRelation = this.getChildRelationByName(name);
//         if(!childRelation)
//             throw new Error(`relation '${this.name}' does not have a child relation '${name}'`);
//         return childRelation;
//     }

//    get descendantAndSelfRelations(): RelationSQLDriver[] {
//         return this.#descendantAndSelfRelations_ ??= [this, ...this.descendantRelations];
//     }

//     get descendantRelations(): RelationSQLDriver[] {
//         return ([] as RelationSQLDriver[]).concat(
//             ...this.childRelations.map(r=>r.descendantAndSelfRelations));
//     }

//     // BUG: we are using parentIdColIndex - and then derefing cols using that -
//     //      - (the child relation fields are messing up the ordering).
//     // non-relational field indexes correspond to col indexes - maybe just use those?
//     // TODO: I think I can do the async version of this by replacing map with
//     //       Array.fromAsync
//     // getById0(rootId:string, opts:ReconstituteOpts): Record|undefined {
//     //     const rootFieldName = this.relationField.primaryKeyField.name;
//     //     const allTuplesInTreeByRelation: Map<string, Map<string|undefined, any[][]>> =
//     //         new Map(this.relationField.descendantAndSelfRelations.map
//     //                 (relation=>{
//     //                     const partition = utils.groupToMap<string|undefined, any[]>(
//     //                         // TODO: replace * here with list of field names
//     //                         // (same for all variants - so factor!)
//     //                         // (ALSO needs to take into account whether this is a versioned
//     //                         //  table or not COMPLICATION!)
//     //                         // '*' will work for now (but not guaranteed by sqlite spec - just
//     //                         //  happens to).
//     //                         this.#preparedQueryCache.getPreparedQuery(
//     //                             this.db, `SELECT * FROM ${relation.name} WHERE ${rootFieldName} = ?`).all([rootId]),
//     //                         (tuple:any[])=>relation.parentIdColIndex?tuple[relation.parentIdColIndex]:undefined);
//     //                     return [relation.name, partition];
//     //                 }));

//     //     //console.info('allTuplesInTree', allTuplesInTreeByRelation);

//     //     const rootTuples =
//     //         this.reconstituteChildRelation(allTuplesInTreeByRelation, undefined, opts);

//     //     if(rootTuples.length>1)
//     //         throw new Error(`Expected a unique tuple for rootId ${this.name}::${rootId}`);

//     //     return rootTuples[0]??undefined;
//     // }

//     async getById(rootId:string, opts:ReconstituteOpts): Promise<Record|undefined> {
//         const rootFieldName = this.relationField.primaryKeyField.name;
//         const allTuplesInTreeByRelation: Map<string, Map<string|undefined, any[][]>> = new Map();

//         const descendantAndSelfRelations = this.relationField.descendantAndSelfRelations;
//         const tuplesForRelationsPromises:Promise<any>[] = [];
//         for(let i=0; i<descendantAndSelfRelations.length; i++) {
//             const relation = descendantAndSelfRelations[i];
//             tuplesForRelationsPromises.push((await this.#preparedQueryCache.getPreparedQuery(
//                 this.db, `SELECT * FROM ${relation.name} WHERE ${rootFieldName} = ?`)).all([rootId]));
//         }

//         const tuplesForRelations: any[] = await Promise.all(tuplesForRelationsPromises);

//         for(let i=0; i<descendantAndSelfRelations.length; i++) {
//             const relation = descendantAndSelfRelations[i];
//             const partition = utils.groupToMap<string|undefined, any[]>(
//                 // TODO: replace * here with list of field names
//                 // (same for all variants - so factor!)
//                 // (ALSO needs to take into account whether this is a versioned
//                 //  table or not COMPLICATION!)
//                 // '*' will work for now (but not guaranteed by sqlite spec - just
//                 //  happens to).
//                 tuplesForRelations[i], /*await this.#preparedQueryCache.getPreparedQuery(
//                     this.db, `SELECT * FROM ${relation.name} WHERE ${rootFieldName} = ?`).all([rootId]),*/
//                 (tuple:any[])=>relation.parentIdColIndex?tuple[relation.parentIdColIndex]:undefined);
//             allTuplesInTreeByRelation.set(relation.name, partition);
//         }
//         if(opts.verbose)
//             console.info('allTuplesInTree', allTuplesInTreeByRelation);

//         const rootTuples =
//             this.reconstituteChildRelation(allTuplesInTreeByRelation, undefined, opts);

//         if(opts.verbose)
//             console.info('rootTuples', rootTuples);

//         if(rootTuples.length>1)
//             throw new Error(`Expected a unique tuple for rootId ${this.name}::${rootId}`);

//         return rootTuples[0]??undefined;
//     }

//     /**
//      *
//      */
//     async getRoot(opts:ReconstituteOpts): Promise<Record> {
//         const roots = await this.getAll(opts);
//         switch(roots.length) {
//             case 0: throw new Error(`No root found for ${this.name}`);
//             case 1: return roots[0];
//             default: throw new Error(`Expected one root for ${this.name} - found ${roots.length}`);
//         }
//     }

//     /**
//      *
//      */
//     async getAll(opts:ReconstituteOpts): Promise<Record[]> {
//         const allTuplesInTreeByRelation: Map<string, Map<string|undefined, any[][]>> = new Map();
//         for(let relation of this.relationField.descendantAndSelfRelations) {
//             const partition = utils.groupToMap<string|undefined, any[]>(
//                 await (await this.#preparedQueryCache.getPreparedQuery(
//                     this.db, `SELECT * FROM ${relation.name}`)).all(),
//                 (tuple:any[])=>relation.parentIdColIndex?tuple[relation.parentIdColIndex]:undefined);
//             allTuplesInTreeByRelation.set(relation.name, partition);
//         }

//         return this.reconstituteChildRelation(allTuplesInTreeByRelation, undefined, opts);
//     }

//     /**
//      * Given an id list, return the corresponding records.
//      *
//      */
//     async getByIds(ids:string[], opts:ReconstituteOpts): Promise<Map<string, Record>> {
//         const rootFieldName = this.relationField.primaryKeyField.name;
//         const idsJson = JSON.stringify(ids);
//         const allTuplesInTreeByRelation = new Map<string, Map<string|undefined, any[][]>>();
//         for(const relation of this.relationField.descendantAndSelfRelations) {
//             const partition = utils.groupToMap<string|undefined, any[]>(
//                 await (await this.#preparedQueryCache.getPreparedQuery(
//                     this.db, `SELECT * FROM ${relation.name} WHERE ${rootFieldName} IN (SELECT value FROM json_each(?))`)).all([idsJson]),
//                 (tuple:any[])=>relation.parentIdColIndex?tuple[relation.parentIdColIndex]:undefined);
//             allTuplesInTreeByRelation.set(relation.name, partition);
//         }

//         const records = this.reconstituteChildRelation(allTuplesInTreeByRelation, undefined, opts);
//         const recordsById = new Map(records.map(
//             record=>[getPrimaryKey(record, this.relationField.primaryKeyField.name), record]));

//         // --- Get mad if we did not get one of the expected records.
//         ids.forEach(id=>{
//             if(!recordsById.has(id))
//                 throw new Error(`Record ${this.name}:${id} not found`);
//         });

//         // --- Get mad if there are unexpected records in the result set
//         //     (this should never happen - just a consistency check)
//         const requestIdSet = new Set(ids);
//         records.forEach(record=>{
//             const recordId = getPrimaryKey(record, this.relationField.primaryKeyField.name);
//             if(!requestIdSet.has(recordId))
//                 throw new Error(`internal error - read unexpected record in getByIds: ${this.name}:${recordId}`);
//         });

//         return recordsById;
//     }

//     reconstituteTree(allTuplesInTreeByRelation: Map<string, Map<string|undefined, any[][]>>,
//                      tuple: any[], opts:ReconstituteOpts): Record {

//         const id = tuple[this.relationField.primaryKeyColIndex] as string; // XXX FIX Typing

//         const record = this.reconstituteCurrentShallow(tuple, opts);
//         for(let childRelationField of this.childRelations)
//             record[childRelationField.name] = childRelationField.reconstituteChildRelation(
//                 allTuplesInTreeByRelation, id, opts);

//         return record
//     }

//     /**
//      *
//      */
//     reconstituteChildRelation(allTuplesInTreeByRelation: Map<string, Map<string|undefined, any[][]>>,
//                               parentId: string|undefined, opts:ReconstituteOpts): Record[] {


//         if(opts.verbose) {
//             console.info('allTuplesInTreeByRelation', allTuplesInTreeByRelation,
//                          'parentId', parentId);
//             console.info('this.name', this.name);
//             console.info(`allTuplesInTreeByRelation.get(${this.name})`,
//                          allTuplesInTreeByRelation.get(this.name));
//         }

//         let childRelationTuples: any[][];
//         if(parentId === undefined) {
//             childRelationTuples =
//                 Array.from((allTuplesInTreeByRelation.get(this.name)??new Map()).values()).flat();
//             if(opts.verbose)
//                 console.info('ROOT RELATION TUPLES', childRelationTuples);
//         } else {
//             childRelationTuples =
//                 allTuplesInTreeByRelation.get(this.name)?.get(parentId)??[];
//         }

//         if(opts.verbose && parentId === undefined) {
//             console.info('CHILD RELATION tUPELS for undefined parent', childRelationTuples);
//         }

//         if(opts.verbose)
//             console.info('childRelationTuples', childRelationTuples);
//         const orderedChildRelationTuples = childRelationTuples.toSorted((a:any[], b:any[]) =>
//             idCollator.compare(a[this.relationField.orderColIndex], b[this.relationField.orderColIndex]) ||
//             idCollator.compare(a[this.relationField.primaryKeyColIndex], b[this.relationField.primaryKeyColIndex]) ||
//             a[this.relationField.validFromColIndex]-b[this.relationField.validFromColIndex]);
//         if(opts.verbose)
//             console.info('orderedChildRelationTuples', orderedChildRelationTuples);

//         const childRelationTupleVersionsById:Map<string, any[][]> = utils.groupToMap(
//             orderedChildRelationTuples, r=>r[this.relationField.primaryKeyColIndex]);

//         return Array.from(childRelationTupleVersionsById.entries()).map(([id, versionTuples]) => {
//             // --- Barf if From/To don't backward chain in all the versions for an id
//             const finalValidTo = versionTuples.reduce(
//                 (prevTo:string|undefined, currentVersionTuple:any[]) => {
//                     if(prevTo !== undefined) {
//                         const currentFrom = currentVersionTuple[this.relationField.validFromColIndex];
//                         if(currentFrom !== prevTo)
//                             throw new ValidationError(`${this.name}:${id}`,
//                                                       `Version chain broken - from = ${currentFrom}, prevTo = ${prevTo}`);
//                     }
//                     return currentVersionTuple[this.relationField.validToColIndex];
//                 }, undefined);

//             // --- If finalValidTo is not null, then this tuple has been deleted.
//             const isDeleted = finalValidTo !== null;

//             // --- All tuples render as version list (including current)
//             const versionHistory = versionTuples.map(tuple=>
//                 this.reconstituteVersionShallow(tuple, opts));

//             // --- Final tuple is rendered as current version, tree recurses on current version
//             const currentChildTuple = versionTuples[versionTuples.length-1];
//             const record = this.reconstituteTree(allTuplesInTreeByRelation, currentChildTuple, opts);
//             if(opts.includeVersionHistory)
//                 record['_versions'] = versionHistory;
//             if(isDeleted)
//                 record['_deleted'] = isDeleted;

//             return record;
//         }).filter(record=>opts.includeVersionHistory || !record['_deleted']);
//     }

//     reconstituteFieldsShallow(tuple: any[], includeOrder: boolean, includeVersioning: boolean, opts:ReconstituteOpts): Record {
//         const record: Record = {};

//         for(let i=0; i<this.relationField.nonRelationFields.length; i++) {
//             const field = this.relationField.nonRelationFields[i];
//             let load: boolean;
//             switch(field.kind) {
//                 case FieldKind.Model: load=true; break;
//                 case FieldKind.Order: load=includeOrder; break;
//                 case FieldKind.Versioning: load=includeVersioning; break;
//                 case FieldKind.ParentRelation: load=true; break; // CHANGED
//                 default: assertNever(field.kind);
//             }
//             // TODO: this should dispatch though field to do validation, conversion etc. - not just assign XXX
//             // TODO: add options for whether to load versioning, order etc. TODO TODO
//             if(load)
//                 record[field.name] = tuple[i];
//         }

//         return record;
//     }

//     reconstituteCurrentShallow(tuple: any[], opts:ReconstituteOpts): Record {
//         const record = this.reconstituteFieldsShallow(tuple, !!opts.includeOrder, false, opts);
//         if(record[this.relationField.validToColIndex])
//             throw new Error('internal error: attempting to create a current tuple from the non-current tuple');
//         record['_source'] = tuple[this.relationField.validFromColIndex];
//         return record;
//     }

//     reconstituteVersionShallow(tuple: any[], opts:ReconstituteOpts): Record {
//         return this.reconstituteFieldsShallow(tuple, true, true, opts);
//     }

//     /**
//      *
//      */
//     // Because we do the TX stuff in here, this can not be the recursion point
//     //
//     // COMPLICATION: have to update the N materialized current versions in the same TX.
//     // COMPLICATION: somehow code to updating materialized versions needs to also fire when
//     //               approvals are done.  Can choose to worry about this separately.
//     // COMPLICATION: verify is in sync - and then stomp - if gets derailed, batch create the
//     //               materialized versions (also when lang rules change).

//     /**
//      *
//      */
//     async updateFromCurrentInNewTx(timestamp: number, updated: Record) {
//         await this.db.execute('BEGIN TRANSACTION;');
//         try {
//             await this.updateFromCurrent(timestamp, updated);
//             await this.db.execute('COMMIT;');
//         } catch(e) {
//             await this.db.execute('ROLLBACK TRANSACTION;');
//             throw e;
//         }
//     }

//     /**
//      *
//      *
//      */
//     async updateFromCurrent(timestamp: number, to: Record) {

//         // --- Extract id from supplied updated record
//         const rootFieldName = this.relationField.primaryKeyField.name;
//         const rootId = getPrimaryKey(to, rootFieldName);

//         // --- Read current version (in the current TX)
//         const from = await this.getById(rootId,
//                                         {includeVersionHistory:false, includeOrder: true});
//         if(!from)
//             throw new Error(`unable to find current version of record ${this.name}::${rootId}`);

//         // --- Extract parentPks from 'from'
//         const parentKeyNames = this.relationField.ancestorRelations.map(r=>r.primaryKeyField.name);
//         //console.info('parentKeyNames', parentKeyNames);
//         const parentKeyBaseColIndex = this.relationField.parentFieldsColIndex;
//         //console.info('parentKeyBaseColIndex', parentKeyBaseColIndex);
//         let parentPks = Object.fromEntries(
//             parentKeyNames.map((name, idx)=>[name, from[name] as string]));
//         //console.info('PARENT PKS', parentPks);
//         //console.info('FROM is', from);

//         // --- Update changed local fields.
//         this.update(timestamp, from, to, parentPks);
//     }


//     /**
//      *
//      *
//      * TODO: when called on a non-root record, the parentPks will not be
//      * initialized properly XXX XXX
//      */
//     async update(updateTimestamp: number, fromRoot: Record, toRoot: Record,
//            parentPks: {[key: string]: string}={}) {

//         //console.info('fromRoot', JSON.stringify(fromRoot, undefined, '  '));
//         //console.info('toRoot', JSON.stringify(toRoot, undefined, '  '));

//         // If _order not given in 'toRoot', default from 'fromRoot'.
//         // (we are presently allowing _order == null)
//         const to:Record = {
//             ...toRoot,
//             _order: toRoot._order ?? fromRoot._order ??
//                 panic("No _order in 'from' or 'to' in top level update") };

//         const from = fromRoot;

//         await this.updateLocalFields(updateTimestamp, from, to, parentPks);

//         // --- Make a version of the parentPks map with our PK added for inserting descendant
//         //     relations.
//         const pkName = this.relationField.primaryKeyField.name;
//         if(Object.hasOwn(parentPks, pkName))
//             throw new Error(`A child relation cannot have the same pk name as a parent relation: ${pkName}`);
//         const parentAndSelfPks = {...parentPks, [pkName]: getPrimaryKey(to, pkName)};
//         // --- Update child relations
//         this.childRelations.forEach(childRelation=>
//             childRelation.updateSet(
//                 updateTimestamp,
//                 from[childRelation.name] as Record[]|undefined??[],
//                 to[childRelation.name] as Record[]|undefined??[],
//                 parentAndSelfPks));
//     }

//     /**
//      *
//      */
//     async updateLocalFields(updateTimestamp: number, from: Record, to: Record,
//                       parentPks: {[key: string]: string}) {

//         const id = getPrimaryKey(from, this.relationField.primaryKeyField.name);

//         // --- Find local fields with changed values.
//         // XXX should do value access though getter on field.
//         const changedFields = this.relationField.nonRelationFields.filter(f=>
//             from[f.name] !== to[f.name]);

//         // --- If no changed fields, no local updates have been made - we are done.
//         if(changedFields.length === 0)
//             return;

//         // --- Confirm that there were no intervening updates between from
//         //     and to (later we will attempt to merge)
//         const fromValidFrom = to['_source'] as number ?? panic('missing _source');
//         if(fromValidFrom !== from['_source'])
//             throw new ValidationError('XXX locus', 'change conflict!!! XXX FIX MESSAGE');

//         const order = to['_order'] ?? panic('missing order');
//         const valid_to = to['_deleted'] ? updateTimestamp : null;

//         // --- Insert new version
//         // TODO: clean this up - rationalize along with insert!  THIS IS UGLY!
//         const fieldValues: any[] = [
//             ...this.relationField.fields.filter(f=>f.kind == FieldKind.Model && !(f instanceof RelationField)).
//                 map(f=>to[f.name]),
//             order,
//             updateTimestamp,    // _valid_from
//             valid_to, // _valid_to
//             null, // _confidence
//             null, // _confidence_note
//             null, // _change_by_user_id
//             null, // _change_reason
//             null, // _change_arg
//             "change_note", // _change_note
//             ...Object.values(parentPks) // TODO: these need to
//         ];
//         //console.info('KKK FIELD VALUES', fieldValues);
//         await (await this.getInsertPreparedStmt(true)).execute(fieldValues);

//         // --- Update _valid_to in 'from' version to be update timestamp
//         const to_valid_to = await (await this.#preparedQueryCache.getPreparedQuery(
//             this.db, `UPDATE ${this.name} SET _valid_to=? WHERE ${this.relationField.primaryKeyField.name} = ? AND _valid_from = ? RETURNING _valid_to`)).all(
//                 [updateTimestamp, id, fromValidFrom]);
//         assert(to_valid_to?.[0]?.[0] === updateTimestamp,
//                'failed to update from _valid_to timestamp');
//     }

//     /**
//      * updateRelation
//      *
//      * 'from' is the (JSON form) of the DB-tip set of tuples for this
//      *  relation field.  Fromious version information is available in the
//      *  '_versions' field (as is normal for this representation).
//      *
//      * 'to' is the new version of this relation proposed by the user.
//      * XXX talk about field diffs for 'updaed'
//      */
//     async updateSet(updateTimestamp: number,
//               fromRecords: Record[], toRecords: Record[],
//               parentPks: {[key: string]: string}={}) {

//         const pkName = this.relationField.primaryKeyField.name;

//         // Pairing:
//         // - to can add a new record - can tell from _source: -1.
//         // - from can add a new record - will have to be newer that timestamp that
//         //   to was loaded from.

//         // - delete does not remove record, just sets _deleted

//         // Pair from and to by id, and process pairwise.
//         // - it is an error if

//         const from = fromRecords;
//         const fromsById = new Map(from.map(r=>[getPrimaryKey(r, pkName), r]));

//         // Shallow copy 'to' records, recovering '_order' from 'fromsById' where
//         // there is a matching (by id) record.
//         const to: Record[] = toRecords.map(r=>({
//             ...r,
//             _order: fromsById.get(getPrimaryKey(r, pkName))?._order??null
//         }));

//         const toById = new Map(to.map(r=>[getPrimaryKey(r, pkName), r]));

//         // TODO shallow clone the to's adding the order from the matching
//         // _from.  This will allow easy sorting, inserting _order etc (which
//         // then travels to insert).  Top level does not need to update _order
//         // order does need to also be updated in normal update.  Top level
//         // is tricky case - either need to pre-read, or make version of update
//         // that does not update order (probably pre-read)

//         const fromIds = new Set(from.map(r=>getPrimaryKey(r, pkName)));
//         const toIds = new Set(to.map(r=>getPrimaryKey(r, pkName)));
//         const continuingIds = utils.intersection(fromIds, toIds);
//         const newIds = utils.difference(toIds, fromIds);
//         const missingIds = utils.difference(fromIds, toIds);

//         if(missingIds.size > 0) {
//             // Missing ids may be tuples that have been added since the to
//             // copy was read.  They also could be tuples that the client did
//             // not send back for some reason.  Later do some version magic to
//             // figure out what is going on - for now is OK to ignore.

//             // These will need to play into order calculations as well XXX
//             // maybe best to barf for now

//             // TODO Figure out how these play with order!!!
//             throw new ValidationError('XXX locus', 'change conflict type 2!!! XXX FIX MESSAGE');
//         }

//         // WHAT ABOUT DELETED AND ORDER:
//         // - we

//         // --- Compute _order changes (and _order for new records)
//         // WOULD LIKE RESULT TO BE IN TERMS OF to indexes.  (and if not
//         // convert to that).
//         // - those are the _orders that get to be preserved, the others
//         //   are replaced.
//         // - maybe just zero out the other orders.
//         // - rather than trying to evenly divide for now, just use between
//         //   repeatedly.

//         // WOULD LIKE SEQ TO BE IN TERMS OF toIds - so run against to[]
//         //
//         // -
//         // let longestIncreasingSequence = longestIncreasingSequenceUsingCompareFn(
//         //     toRecords.filter(r=>r._order);
//         // );
//         // pass 1: compute minimal list of 'to' records where the _order field
//         // is preserved.
//         // do this by sorting by _order field, then accepting all that are in
//         // that order.
//         // - from _order will be ordered.
//         // - A = given list of records (with order field)
//         // - B = same records, sorted by _order field
//         // - find LCS(A,B).  These get to keep their order field.
//         // - for all others, compute intermeidate orders.

//         // --- Insert new records
//         for(const newId of newIds) {
//             const newRecord = toById.get(newId) ?? panic();
//             // TODO add validFrom parameter (presently we are backdating to 0 - WRONG)
//             await this.insert(updateTimestamp, newRecord, true, null/*XXX FIX*/, parentPks);
//         }

//         // TODO: no modelling of deletion yet XXX

//         // --- Updated continuing records
//         for(const id of continuingIds) {
//             const from = fromsById.get(id) ?? panic();
//             const to = toById.get(id) ?? panic();
//             await this.update(updateTimestamp, from, to, parentPks);
//         }
//     }

//     // Undelete:
//     // - no such thing?
//     // - we need to keep the deleted records around (or will lose history)
//     // - we want to only delete when someone sends back a '_deleted' - to be careful.
//     // - if we don't have undelete, then a reviewer can't undo someone elses delete - this
//     //   seems bad.
//     // - delete is setting _valid_to without a followup tuple.
//     // - just adding a followup tuple is undelete.
//     // - this is not undelete in the trad sense - and falls naturally out of model.
//     // - will need represention in UI.

//     // Insertions:
//     // - have _source: -1  - means is new!

//     // Moving:
//     // - all records (including deleted) exist in an order.  _deleted need to keep _order maintained, or
//     //   will have problem with renumbering.
//     // - moves need to be represented in the history (ie the change to the _order field is part of the
//     //   history - this is similar to _deleted).
//     // - this is again pushing us towards these being real fields (but marked as internal).


//     // Renumbering:
//     // - if done while there are no offline forks, is not a change, and does not need to be logged.

//     // TODO: Needs to be altered to insert into versioned DB
//     // TODO: needs to also be altered to correspond to the N*2+1 versions (passing in same parms we are
//     //       passing in to create).   Insert will need same parms.
//     // TODO: Need to rethink this for incremental update (can't make versions for each set of fields -
//     // TODO: move prepared stmt map to
//     // TODO: maybe make a wrapper for db that hodls prepared stmts. (just by string)


//     // TODO: THIS IS WRONG
//     // - needs to give different stmts for versioned or non-versioned tables.
//     // - missing parent fields
//     // - the global colid scheme is gross an unweildy!!! FIX FIX
//     //
//     // - if returned list of fields, then we could use these to load from the JSON.
//     // - we could use the parent fields to load from parents.
//     // getInsertPreparedStmt_OFF(db:DB, versioned: boolean): PreparedQuery {
//     //     return this.#preparedQueryCache.getNamedPreparedQuery(db, versioned?'insert':'insertNonVersioned', ()=>{
//     //         const dbFieldNames = this.relationField.fields.flatMap(f=>f.getDbFieldNames());
//     //         const queryStr = `INSERT INTO ${this.name} (${dbFieldNames.join(', ')}) VALUES (${dbFieldNames.map(f=>'?').join(',')})`;
//     //         console.info('INSERT STMT' ,queryStr);
//     //         return queryStr;
//     //     });
//     // }

//     async getInsertPreparedStmt(versioned: boolean): Promise<PreparedQuery> {
//         return this.#preparedQueryCache.getNamedPreparedQuery(this.db, versioned?'insert':'insertNonVersioned', ()=>{
//             // TODO: add versioned.
//             const insertFieldNames = this.relationField.nonRelationFields.map(f=>f.name);
//             const queryStr = `INSERT INTO ${this.name} (${insertFieldNames.join(', ')}) VALUES (${insertFieldNames.map(f=>'?').join(',')})`;
//             console.info(`INSERT STMT for ${utils.className(this)}` ,queryStr);
//             return queryStr;
//         });
//     }

//     async insert(timestamp: number, value: any, versioned: boolean=true, order: string|null=null, parentPks: {[key: string]: string} = {}) {
//         //console.info(parentPks);

//         // Default order to middle of range.
//         order ??= '0.5';

//         //this.getInsertPreparedStmt(this.db, versioned);

//         // TODO: clean this up - use new dbFields model.
//         // XXX FIX FIX FIX XXX
//         // ISSUE confused about connection between db field names and fields!
//         // NEXT - GET THIS WORKING!!!
//         // WHAT about db field names vs JSON field names?
//         // ??? WANT TO USE SAME NAMING FOR JSON/TOML - get rid of multi-field thing.
//         // ??? model is a bit confused.
//         // ??? different views use diffeent fields.
//         // ??? probably switch to map of name->col that correspnds to the query (also
//         //     handles multi version better).
//         const fieldValues:any[] = [
//             ...this.relationField.fields.filter(f=>f.kind == FieldKind.Model && !(f instanceof RelationField)).
//                 map(f=>value[f.name]),
//             order,
//             timestamp,    // _valid_from
//             null, // _valid_to
//             null, // _confidence
//             null, // _confidence_note
//             null, // _change_by_user_id
//             null, // _change_reason
//             null, // _change_arg
//             null, // _change_note
//             ...Object.values(parentPks)
//         ];

//         //console.info('FIELD VALUES', fieldValues, fieldValues.length);
//         try {
//             await (await this.getInsertPreparedStmt(versioned)).execute(fieldValues);
//         } catch(e) {

//             console.info(`SPLAT FIELD VALUES for ${utils.className(this)}`, fieldValues, fieldValues.length);
//             throw e;
//         }

//         // --- Make a version of the parentPks map with our PK added for inserting descendant
//         //     relations.
//         const pkName = this.relationField.primaryKeyField.name;
//         if(Object.hasOwn(parentPks, pkName))
//             throw new Error(`A child relation cannot have the same pk name as a parent relation: ${pkName}`);
//         const parentAndSelfPks = {...parentPks, [pkName]: value[pkName]};

//         // --- Insert child relations.
//         for(const relationField of this.childRelations) {
//             // --- Get JSON version of child insts
//             const childInsts = value[relationField.name];

//             // --- Missing child insts treated as empty
//             if(childInsts === undefined)
//                 continue;

//             // --- If child inst field is present, it must be an array.
//             if(!Array.isArray(childInsts))
//                 throw new Error('non-empty child relation fields must be arrays');

//             // --- Compute initial order keys for child insts, and insert instances with
//             //     corresponding order keys.
//             //     TODO: revisit whether we should parallelize the await below.
//             const orderKeys = orderkey.initial(childInsts.length);
//             for(let i=0; i<childInsts.length; i++)
//                 await relationField.insert(timestamp, childInsts[i], versioned, orderKeys[i], parentAndSelfPks);
//         }
//     }

//     /**
//      * Returns the highest (or 0) valid_from or valid_to time in this relation
//      * or any child relation.
//      *
//      * Read at system startup, and used as a floor for new timestamps.
//      *
//      * _valid_from and _valid_to are not indexed at present ... may choose to
//      * index.
//      */
//     async maxTime(): Promise<number> {
//         // TODO cleanup typing (remove cast) XXX
//         const max_valid_from:number = (await (await this.#preparedQueryCache.getPreparedQuery(
//             this.db, `SELECT MAX(_valid_from) FROM ${this.name}`)).first())?.[0] as number|undefined??0;
//         //console.info('MAX_VALID_FROM', max_valid_from);
//         const max_valid_to = (await (await this.#preparedQueryCache.getPreparedQuery(
//             this.db, `SELECT MAX(_valid_to) FROM ${this.name}`)).first())?.[0] as number|undefined??0;
//         //console.info('MAX_VALID_TO', max_valid_to);

//         return Math.max(max_valid_from,
//                            max_valid_to,
//                            ...await Promise.all(this.childRelations.map(r=>r.maxTime())));
//     }

//     /*

//      */
//     updateFrom(from: Record, to: Record) {
//         throw new Error('not implemented');
//     }

//     // update(db:DB, value: Record) {
//     //     // - Update only requres id of tuple + to fields.
//     //     // - Cannot update parent ids (or self id)
//     //     // - Later versions will be able to post a whole tree - but do the
//     //     //   local only version.
//     //     // - a layer above this also takes a before value, and computes
//     //     //   changed fields from that, reads the existing record and verifys
//     //     //   before values then calls this update.
//     // }
//     makeRandomChange() {
//         // A random change to a relationField is inserting a new tuple or
//         // deleting an existing tuple.  The caller would have called ...
//         // XXX needs to take the JSON representation corresponding to
//         //     this field as input.
//         // XXX MORE THINKING NEEDED
//         throw new Error('makeRandomChange not implemented');
//     }

//     async createDbTables(prefix: string, versioned: boolean) {
//         const createSchemaDml = this.getCreateDML(prefix, versioned);
//         for(const dml of createSchemaDml) {
//             console.info(dml);
//             await this.db.execute(dml);
//         }
//     }

//     /**
//      *
//      */
//     getCreateDML(prefix: string, versioned: boolean): string[] {
//         // Note: field (and thereby also relation) names are restricted
//         //       (earlier) to [a-zA-Z][a-zA-Z0-9_]+ so embedding them directly
//         //       is this SQL string does not pose a query injection risk.

//         const tableName = prefix+this.name;

//         const dropTable = `DROP TABLE IF EXISTS ${tableName};\n`

//         const fieldDecls = this.relationField.fields.flatMap(f => f.createDbFields(versioned));
//         //console.info('USER FIELDS', fieldDecls);

//         // TODO: add ability to leave out versoning fields. NEXT NEXT NEXT
//         if(!versioned)
//             throw new Error('XXX ability to generate non versioned SQL schema is busted');

//         const constraints: string[] = [];
//         if (versioned) {
//             constraints.push(`CONSTRAINT ww_primary_key PRIMARY KEY(${this.relationField.primaryKeyField.name}, _valid_from)`);
//         }

//         const createTable =
//             `CREATE TABLE ${tableName} (\n  ${fieldDecls.concat(constraints).join(',\n  ')}) STRICT;\n`

//         const ancestorIdIndexes = this.relationField.ancestorRelations.map(r=>
//             `CREATE INDEX ${tableName}_${r.primaryKeyField.name} ON ${tableName}(${r.primaryKeyField.name})\n`);

//         const childCreateTables = this.childRelations.flatMap(r => r.getCreateDML(prefix, versioned));

//         return [dropTable, createTable, ...ancestorIdIndexes, ...childCreateTables];
//     }
// }
