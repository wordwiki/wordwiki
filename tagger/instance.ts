import * as model from "./model.ts";
import {FieldVisitorI, Field, ScalarFieldBase, BooleanField, IntegerField, FloatField,
        StringField, IdField, PrimaryKeyField, RelationField, Schema} from "./model.ts";
import {unwrap, panic} from "../utils/utils.ts";
import {dictSchemaJson} from "./entry-schema.ts";
import { Assertion, getAssertionPath, selectAssertionsForTopLevelFact } from "./schema.ts";
import * as timestamp from "../utils/timestamp.ts";
import {assert} from '../utils/utils.ts';

export type Tag = string;

// - Get working first, then refactor.
// - write simple test stuff, probably also beaters, round trip MMO etc.
// - make API be nice.
// - figure out (client side) id allocator.  Also needs to support distributed
//   operation.   maybe add a nanoid to every fact.  Or pool of reserved ids for
//   remote - but hard to do with partitioning (can use a rename pass instead?)

// TODO 



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
        const versionedRelation = this.getVersionedRelationByPath(path);
        versionedRelation.applyAssertion(assertion);
    }

    getVersionedRelationByPath(path: [string, number][], index: number=0): VersionedRelation {
        //console.info('PATH is', path, path[index], index);
        const [ty, id] = path[index];

        let versionedRelation = this.childRelations[ty];
        if(!versionedRelation) {
            const childRelationSchema = this.schema.relationFieldsByTag[ty];
            // TODO this is WRONG
            if(!childRelationSchema)
                throw new Error(`unexpected tag ${ty} -- FIX ERROR NEED LOCUS ETC`);
            versionedRelation = new VersionedRelation(childRelationSchema, id);
            this.childRelations[ty] = versionedRelation;
        }

        if(index+1 === path.length)
            return versionedRelation;
        else
            return versionedRelation.getVersionedRelationByPath(path, index+1);
    }

    forEachVersionedRelation(f: (r:VersionedRelation)=>void) {
        for(const v of Object.values(this.childRelations))
            v.forEachVersionedRelation(f);
    }
}

/**
 *
 */
export class VersionedRelation extends VersionedRelationContainer {
    readonly id: number;
    readonly tupleVersions: TupleVersion[] = [];
    #currentTuple: TupleVersion|undefined = undefined;

    constructor(schema: RelationField, id: number) {
        super(schema);
        this.id = id;
    }

    applyAssertion(assertion: Assertion) {
        // TODO lots of validation here + index updating etc.
        this.tupleVersions.push(new TupleVersion(this, assertion));
    }

    forEachVersionedRelation(f: (r:VersionedRelation)=>void) {
        f(this);
        super.forEachVersionedRelation(f);
    }
    
    dump(): any {
        return {
            type: this.schema.name,
            id: this.id,
            tupleVersions: this.tupleVersions.map(a=>a.dump()),
            childRelations: Object.values(this.childRelations).map(child=>({
                type: child.schema.name, members: child.dump()}))
        }
    }

    dumpVersions(): any {
        //return tupleVersions.map(v=>v.dump());
    }
}

/**
 *
 */
export class TupleVersion {
    readonly relation: VersionedRelation;
    readonly assertion: Assertion;
    
    #domainFields: Record<string,any>|undefined = undefined;
    //#changeRegistrations

    constructor(relation: VersionedRelation, assertion: Assertion) {
        this.relation = relation;
        this.assertion = assertion;
    }

    get isCurrent(): boolean {
        return this.assertion.valid_to === timestamp.END_TIME;
    }
    
    get domainFields(): Record<string,any> {
        // TODO: consider checking type of domain fields.
        // TODO: fix the 'as any' below
        return this.#domainFields ??= Object.fromEntries(
            this.relation.schema.scalarFields.map(f=>[f.name, (this.assertion as any)[f.bind]]));
    }

    dump(): any {
        const a = this.assertion;
        return {
            valid_from: timestamp.formatTimestampAsUTCTime(a.valid_from),
            valid_to: timestamp.formatTimestampAsUTCTime(a.valid_to),
            id: this.relation.id,
            ty: this.relation.schema.tag,
            ...this.domainFields,
        };
    }

    
}

/**
 *
 */
export class VersionedDatabaseWorkspace extends VersionedRelationContainer {
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

        return this.applyAssertionByPath(getAssertionPath(assertion), assertion);
    }

    dump(): any {
        return Object.values(this.childRelations).map(child=>({
            type: child.schema.name, members: child.dump()}));
    }
    
}


function test() {
    const dictSchema = model.Schema.parseSchemaFromCompactJson('dict', dictSchemaJson);

    // --- Load the tuples for a dictionary entry.
    const sampleEntryAssertions = selectAssertionsForTopLevelFact('dict').all({id1:1000});
    //console.info('Sample entry assertions', sampleEntryAssertions);

    // --- Create an empty instance schema
    const mmoDb = new VersionedDatabaseWorkspace(dictSchema);
    sampleEntryAssertions.forEach(a=>mmoDb.apply(a));
    console.info(JSON.stringify(mmoDb.dump(), undefined, 2));

    const entries = mmoDb.childRelations['en'];
    //console.info('entries', entries);
    

    
    // --- Navigate to pronunciation guide
    //let pronouciationGuide: VersionedTuple = mmoDb.searchVersionedTuples(f=>f.id===112);
    
    // --- Edit pronunciation guide
    
    // --- Add a second pronunciation guide

    // --- Persist this to disk!
    

    
    //fieldToFieldInstInst.accept(dictSchema);
}





if (import.meta.main)
    await test();
