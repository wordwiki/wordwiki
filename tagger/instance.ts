// 13*3 inches for skinnys = 39 inches
// 20 inches tall = 59 inches total
// 22+35 = 57 inches   

import * as model from "./model.ts";
import {FieldVisitorI, Field, ScalarFieldBase, BooleanField, IntegerField, FloatField,
        StringField, IdField, PrimaryKeyField, RelationField, Schema} from "./model.ts";
import {unwrap, panic} from "../utils/utils.ts";
import {dictSchemaJson} from "./entry-schema.ts";
import { Assertion, getAssertionPath, selectAssertionsForTopLevelFact } from "./schema.ts";
import * as timestamp from "../utils/timestamp.ts";
import {assert} from '../utils/utils.ts';

// Thur Apr 25, Virtual, 9:40
// - The set of regular fields is fixed (from the assertion db record, as mapped
//   by schema).
// - The set of child relation fields is not fixed (and is defined in the schema).
// - so we are dynamic anyway.
// - could choose to make all fields dynamic.
// - in which case, it may be wise to mirror the whole schema like we have done
//   for view (rather than having a dynamic structure).
// - 
// export class Instance {
//     schema: RelationField;
// }



// - Once a relation exists, the 'fields' all exist.  They have FieldInst[] members
//   that correspond 1-1 with scalar field members (and have refs back to the field)
// - these fields might be null (if allowed for by the schema)
// - this means that field insts will get a value field.

// - a relation field will also always exist.
// - and it will have a reference to the corresponding field type.
// - but we need to model the list some other way.
// - fields should be in an {}
// - relation fields would have the realation field object + an array of {}'s

// - what names to use for fields on this obj?  assertion names or application
//   names?
// - these should probably be raw DB tuples (possibly stripped of redundancy
//   when sent to client).
// - can bind properties on the relation for access (and tracking).
// - so mostly want tree of relations.
// - en[0]
// -   sense[0] { part-of-speech: noun }
// -     - example[0] { text: 'she ate the cat' }
// -         - text[0] ...
// -     - example[1] 
// -   sense[1] { part-of-speech: verb }
//
// - type this!!!
// - figure out the relation to view!!!

// - inst per tuple is the model
// - fields are in a {} - literal from DB (sometimes stripped)
// - child relations are in a {}, as name: relation pairs.  The relation contains a list
//   of tuple objects which have the

export type Tag = string;

// - Name is wrong.
// - Probably should be 'relation' - but is really a nested relation.
// - Array<Fact> will get fancier.
// - Move and rename container to be ajacent to Fact.
// - Get working first, then refactor.
// - write simple test stuff, probably also beaters, round trip MMO etc.
// - make API be nice.
// - figure out (client side) id allocator.  Also needs to support distributed
//   operation.   maybe add a nanoid to every fact.  Or pool of reserved ids for
//   remote - but hard to do with partitioning (can use a rename pass instead?)

/**
 *
 */
export class VersionedRelationContainer {
    readonly schema: RelationField;
    readonly childRelations: Record<Tag,VersionedRelation> = {};

    constructor(schema: RelationField) {
        this.schema = schema;
    }

    applyAssertionByPath(path: [string, number][], assertion: Assertion, index: number=0) {
        const fact = this.getVersionedTupleByPath(path);
        fact.applyAssertion(assertion);
    }

    getVersionedTupleByPath(path: [string, number][], index: number=0): VersionedTuple {
        //console.info('PATH is', path, path[index], index);
        const [ty, id] = path[index];

        let versionedRelation = this.childRelations[ty];
        if(!versionedRelation) {
            const childRelationSchema = this.schema.relationFieldsByTag[ty];
            // TODO this is WRONG
            if(!childRelationSchema)
                throw new Error(`unexpected tag ${ty} -- FIX ERROR NEED LOCUS ETC`);
            versionedRelation =
                new VersionedRelation(childRelationSchema,
                                      [new VersionedTuple(childRelationSchema, id, ty)]);
            this.childRelations[ty] = versionedRelation;
        }

        throw new Error('not done');
        // if(index+1 === path.length)
        //     return versionedRelation;
        // else
        //     return versionedRelation.getVersionedTupleByPath(path, index+1);
    }

    // searchVersionedTuples(predicate: (f:VersionedTuple)=>boolean, collection: VersionedTuple[]=[]): VersionedTuple[] {
    //     return collection;
    // }
}

/**
 *
 */
export class VersionedRelation {
    readonly schema: RelationField;
    readonly versionedTuples: Array<VersionedTuple>;

    constructor(schema: RelationField, versionedTuples: Array<VersionedTuple>=[]) {
        this.schema = schema;
        this.versionedTuples = versionedTuples;
    }

    dump(): any {
        throw new Error('not impl yet');
    }
}

/**
 *
 * - maybe renamed to VersionedTuple
 * - AssertionNode -> TupleVersion
 * - FactCollection -> VersionedRelation
 * - chidren (via container) are partitioned by tag - and each is a collection
 *   of Facts corresponding to one child relation.
 */
export class VersionedTuple extends VersionedRelationContainer {
    readonly id: number;
    readonly ty: string;
    
    readonly tupleVersions: TupleVersion[] = [];

    constructor(schema: RelationField, id: number, ty: string) {
        super(schema);
        this.id = id;
        this.ty = ty;
    }

    applyAssertion(assertion: Assertion) {
        // TODO lots of validation here + index updating etc.
        this.tupleVersions.push(new TupleVersion(this, assertion));
    }

    dump(): any {
        return {
            type: this.schema.name,
            tag: this.ty,
            id: this.id,
            tupleVersions: this.tupleVersions.map(a=>a.dump()),
            childRelations: Object.values(this.childRelations).map(child=>({
                type: child.schema.name, members: child.dump()}))
        }
    }
}

/**
 *
 */
export class TupleVersion {
    readonly fact: VersionedTuple;
    readonly assertion: Assertion;
    
    #domainFields: Record<string,any>|undefined = undefined;
    //#changeRegistrations

    constructor(fact: VersionedTuple, assertion: Assertion) {
        this.fact = fact;
        this.assertion = assertion;
    }

    get domainFields(): Record<string,any> {
        // TODO: consider checking type of domain fields.
        // TODO: fix the 'as any' below
        return this.#domainFields ??= Object.fromEntries(
            this.fact.schema.scalarFields.map(f=>[f.name, (this.assertion as any)[f.bind]]));
    }

    dump(): any {
        const a = this.assertion;
        return {
            valid_from: timestamp.formatTimestampAsUTCTime(a.valid_from),
            valid_to: timestamp.formatTimestampAsUTCTime(a.valid_to),
            id: this.fact.id,
            ty: this.fact.ty,
            ...this.domainFields,
        };
    }    
}

/**
 *
 */
export class Database extends VersionedRelationContainer {
    declare schema: Schema;
    
    //readonly factsById: Map<number, FactCollection> = new Map();
    
    constructor(schema: Schema) {
        super(schema);
    }

    apply(assertion: Assertion) {
        // We want to be able to apply assertions at any depth, in any order.
        // - Top level apply will lookup RelationField for ty (using index on schema),
        //   and then traversal will walk/create nodes, then apply to fact.
        // - top level is still a container even if we are only mirroring a single
        //   record.
        // const relationField = this.schema.relationsByTag[assertion.ty];
        // if(!relationField)
        //     throw new Error(`Failed to find relation with tag '${assertion.ty}' in schema ${this.schema.name}`);

        //return this.applyAssertionByPath(getAssertionPath(assertion), assertion);
        throw new Error('not mpl yet');
    }

    dump(): any {
        return Object.values(this.childRelations).map(child=>({
            type: child.schema.name, members: child.dump()}));
    }
    
}





function test() {
    const dictSchema = model.Schema.parseSchemaFromCompactJson('dict', dictSchemaJson);

    // --- Load the tuples for a dictionary entry.
    //const sampleEntryAssertions = selectAssertionsForTopLevelVersionedTuple().all({id1:1000});
    //console.info('Sample entry assertions', sampleEntryAssertions);

    // --- Create an empty instance schema
    const mmoDb = new Database(dictSchema);
    //sampleEntryAssertions.forEach(a=>mmoDb.apply(a));
    console.info(JSON.stringify(mmoDb.dump(), undefined, 2));

    // --- Navigate to pronunciation guide
    //let pronouciationGuide: VersionedTuple = mmoDb.searchVersionedTuples(f=>f.id===112);
    
    // --- Edit pronunciation guide
    
    // --- Add a second pronunciation guide

    // --- Persist this to disk!
    

    
    //fieldToFieldInstInst.accept(dictSchema);
}





if (import.meta.main)
    await test();
