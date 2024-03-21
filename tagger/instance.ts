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


/**
 *
 */
export abstract class FieldInst {
    constructor(public field: Field) {
    }

    abstract accept<A,R>(v: FieldInstVisitorI<A,R>, a: A): R;
}

/**
 *
 */
export class RelationFieldInst extends FieldInst {
    declare field: RelationField;
    
    constructor(field: RelationField, public fieldInst: FieldInst[]) {
        super(field);
        //field.fields.map(new FieldVisitor<never,FieldInst>
    }
    
    accept<A,R>(v: FieldInstVisitorI<A,R>, a: A): R { return v.visitRelationFieldInst(this, a); }
}

/**
 *
 */
export abstract class ScalarFieldInstBase extends FieldInst {
    declare field: ScalarFieldBase;
    constructor(field: ScalarFieldBase) { super(field); }
}

/**
 *
 */
export class BooleanFieldInst extends ScalarFieldInstBase {
    declare field: BooleanField;
    constructor(field: BooleanField) { super(field); }
    accept<A,R>(v: FieldInstVisitorI<A,R>, a: A): R { return v.visitBooleanFieldInst(this, a); }
}

/**
 *
 */
export class IntegerFieldInst extends ScalarFieldInstBase {
    declare field: IntegerField;
    constructor(field: IntegerField) { super(field); }
    accept<A,R>(v: FieldInstVisitorI<A,R>, a: A): R { return v.visitIntegerFieldInst(this, a); }
}

/**
 *
 */
export class FloatFieldInst extends ScalarFieldInstBase {
    declare field: FloatField;
    constructor(field: FloatField) { super(field); }
    accept<A,R>(v: FieldInstVisitorI<A,R>, a: A): R { return v.visitFloatFieldInst(this, a); }
}

/**
 *
 */
export class StringFieldInst extends ScalarFieldInstBase {
    declare field: StringField;
    constructor(field: StringField) { super(field); }
    accept<A,R>(v: FieldInstVisitorI<A,R>, a: A): R { return v.visitStringFieldInst(this, a); }
}

/**
 *
 */
export class IdFieldInst extends ScalarFieldInstBase {
    declare field: IdField;
    constructor(field: IdField) { super(field); }
    accept<A,R>(v: FieldInstVisitorI<A,R>, a: A): R { return v.visitIdFieldInst(this, a); }
}

/**
 *
 */
export class PrimaryKeyFieldInst extends ScalarFieldInstBase {
    declare field: PrimaryKeyField;
    constructor(field: PrimaryKeyField) { super(field); }
    accept<A,R>(v: FieldInstVisitorI<A,R>, a: A): R { return v.visitPrimaryKeyFieldInst(this, a); }
}

/**
 *
 */
export class SchemaInst extends RelationFieldInst {
    declare field: Schema;
    relationInstForRelation: Map<RelationField, RelationFieldInst>;
    
    constructor(public schema: Schema, fieldInsts: FieldInst[]) {
        super(schema, fieldInsts);
        this.relationInstForRelation = new Map();
    }
    
    accept<A,R>(v: FieldInstVisitorI<A,R>, a: A): R { return v.visitSchemaInst(this, a); }

    getRelationInstByName(relationName: string): RelationFieldInst {
        return this.relationInstForRelation.get(
            this.schema.relationsByName[relationName] ?? panic('missing', relationName))
            ?? panic();
    }

    getRelationInstByTag(relationTag: string): RelationFieldInst {
        return this.relationInstForRelation.get(
            this.schema.relationsByTag[relationTag] ?? panic('missing', relationTag))
            ?? panic();
    }
}

/**
 *
 */
export interface FieldInstVisitorI<A,R> {
    visitBooleanFieldInst(f: BooleanFieldInst, a: A): R;
    visitIntegerFieldInst(f: IntegerFieldInst, a: A): R;
    visitFloatFieldInst(f: FloatFieldInst, a: A): R;
    visitStringFieldInst(f: StringFieldInst, a: A): R;
    visitIdFieldInst(f: IdFieldInst, a: A): R;
    visitPrimaryKeyFieldInst(f: PrimaryKeyFieldInst, a: A): R;
    visitRelationFieldInst(f: RelationFieldInst, a: A): R;
    visitSchemaInst(f: SchemaInst, a: A): R;
}

// /**
//  *
//  */
// export class DataVisitor implements FieldVisitorI<any,void> {
//     visitField(f:Field, v:any) {}
//     visitBooleanField(f: BooleanField, v: any) { this.visitField(f, v); }
//     visitIntegerField(f: IntegerField, v: any) { this.visitField(f, v); }
//     visitFloatField(f: FloatField, v: any) { this.visitField(f, v); }
//     visitStringField(f: StringField, v: any) { this.visitField(f, v); }
//     visitIdField(f: IdField, v: any) { this.visitField(f, v); }
//     visitPrimaryKeyField(f: PrimaryKeyField, v: any) { this.visitField(f, v); }
//     visitRelationField(relationField: RelationField, v: any) {
//         relationField.modelFields.forEach(f=>f.accept(this, v[f.name]));
//     }
//     visitSchema(schema: Schema, v: any) {
//         schema.modelFields.forEach(f=>f.accept(this, v[f.name]));
//     }
// }

/**
 *
 */
export class FieldToFieldInst implements FieldVisitorI<any,FieldInst> {
    visitBooleanField(f: BooleanField, v: any): FieldInst { return new BooleanFieldInst(f); }
    visitIntegerField(f: IntegerField, v: any): FieldInst { return new IntegerFieldInst(f); }
    visitFloatField(f: FloatField, v: any): FieldInst { return new FloatFieldInst(f); }
    visitStringField(f: StringField, v: any): FieldInst { return new StringFieldInst(f); }
    visitIdField(f: IdField, v: any): FieldInst { return new IdFieldInst(f); }
    visitPrimaryKeyField(f: PrimaryKeyField, v: any): FieldInst { return new PrimaryKeyFieldInst(f); }
    visitRelationField(f: RelationField, v: any): FieldInst {
        return new RelationFieldInst(f, f.fields.map(fieldToFieldInst));
    }
    visitSchema(f: Schema, v: any): FieldInst {
        return new SchemaInst(f, f.fields.map(fieldToFieldInst));
    }
}

export const fieldToFieldInstInst = new FieldToFieldInst();

export function fieldToFieldInst(f: Field): FieldInst {
    return f.accept(fieldToFieldInstInst, undefined);
}



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

/**
 *
 */
export class Container {
    readonly schema: RelationField;
    readonly children: Record<Tag,FactCollection> = {};

    constructor(schema: RelationField) {
        this.schema = schema;
    }

    applyAssertionByPath(path: [string, number][], assertion: Assertion, index: number=0) {
        const fact = this.getFactByPath(path);
        fact.applyAssertion(assertion);
    }

    getFactByPath(path: [string, number][], index: number=0): Fact {
        //console.info('PATH is', path, path[index], index);
        const [ty, id] = path[index];
        let relation = this.children[ty];
        if(!relation) {
            const childRelation = this.schema.relationFieldsByTag[ty];
            // TODO this is WRONG
            if(!childRelation)
                throw new Error(`unexpected tag ${ty} -- FIX ERROR NEED LOCUS ETC`);
            relation = new Fact(childRelation, id, ty);
            this.children[ty] = relation;
        }

        if(index+1 === path.length)
            return relation;
        else
            return relation.getFactByPath(path, index+1);
    }

    searchFacts(predicate: (f:Fact)=>boolean, collection: Fact[]=[]): Fact[] {
        return collection;
    }
}

export class Database extends Container {
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
        return Object.values(this.children).map(child=>({
            type: child.schema.name, members: child.dump()}));
    }
    
}

/**
 *
 */
export class Fact extends Container {
    readonly id: number;
    readonly ty: string;
    
    readonly assertions: AssertionNode[] = [];

    constructor(schema: RelationField, id: number, ty: string) {
        super(schema);
        this.id = id;
        this.ty = ty;
    }

    applyAssertion(assertion: Assertion) {
        // TODO lots of validation here.
        this.assertions.push(new AssertionNode(this, assertion));
    }

    dump(): any {
        return {
            type: this.schema.name,
            tag: this.ty,
            id: this.id,
            assertions: this.assertions.map(a=>a.dump()),
            children: Object.values(this.children).map(child=>({
                type: child.scheman
                    .name, members: child.dump()}))
        }
    }
}

/**
 *
 */
export class AssertionNode {
    readonly fact: Fact;
    readonly assertion: Assertion;
    
    #domainFields: Record<string,any>|undefined = undefined;
    //#changeRegistrations

    constructor(fact: Fact, assertion: Assertion) {
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

// Name is wrong.
export class FactCollection {
    readonly schema: RelationField;
    facts: Array<Fact> = [];

    constructor(schema: RelationField) {
        this.schema = schema;
    }
}

// TODO think about different kinds of scopes - list VS singleton value - singleton
//      value solves a lot of the problems with locale - most specific is chosen.
//      - also can have a simpler display interface (should be different anyway).
//      - also gives better data model properties (ie. entry has one spelling, at
//        least withing a given locale)

// TODO: think about root of tree.

// IMMEDIATE GOAL: get MMO loaded into this, and redump as JSON with a clean round
// trip.  Probably also make importer based on this.

// class Relation {
//     readonly schema: RelationField;
//     readonly parent?: Fact;
//     readonly facts: Array<Fact> = [];
//     readonly factsById: Map<number,Fact> = new Map();
//     // lots of local indexing.

//     constructor(schema: RelationField, parent: Fact|undefined) {
//         this.schema = schema;
//         this.parent = parent;
//     }
// }



//class 





    
//     #domainFields: Record<string,any>|undefined = undefined;
    
//     tuples: Array<Tuple> = [];
//     tuplesByFactId: Record<number, Array<Tuple>> = {};
//     lastUpdateTime: number = 0;
//     #current: Array<Tuple>|undefined = undefined;
//     // published (+ locale + changes after a time) should be done
//     // using a more general builder parameterization or qurey mech.
//     //#published : Array<Tuple>|undefined = undefined;
    
//     constructor(schema: RelationField, assertion: Assertion) {
//         this.schema = schema;
//         this.assertion = assertion;
//     }

//     locus(): string {
//         return 'LOCUS'; // TODO
//     }
    
//     resetMemoized() {
//         this.#current = undefined;
//         //this.#published = undefined;
//     }

//     // I think this is wrong anyway.
//     get current() {
//         return this.#current ??= this.tuples.filter(t=>t.isCurrent());
//     }

//     // This is the key - once this works, the rest is easy!
//     // Later: apply may be able to filter for a locale or published.
//     apply(assertion: Assertion) {
//         if(assertion.ty === this.schema.tag)
//             this.applyLocalAssertion(assertion);
//         else
//             this.applyChildAssertion(assertion);
//     }

//     applyLocalAssertion(assertion: Assertion) {
//         assert(assertion.ty === this.schema.tag);

//         // --- Sanity check: time must never go backwards (but we can get multiple
//         //     assertions at the same time - as long as they are against different facts)
//         if(this.lastUpdateTime > assertion.valid_from)
//             throw new Error(`${this.locus()}: attempt to go backwards in time - last update time is ${timestamp.formatTimestampAsUTCTime(this.lastUpdateTime)} attempting to apply update at time ${timestamp.formatTimestampAsUTCTime(assertion.valid_from)}`);

//         // --- Look up the sequence of tuples we already have for this fact id.
//         let tuplesForFactId = this.tuplesByFactId[assertion.id];
//         if(tuplesForFactId === undefined) {
//             tuplesForFactId = this.tuplesByFactId[assertion.id] = [];
//         }

//         // --- end time etc???
        

//         // --- Append tuple
//         // ??? ??? ??? ??? ???
//         // The structure seems wrong - there should be one top level relation
//         // tree - and the versioning is happening at the tuple level - we are
//         // presently coping the top level tree.
//         //tuplesForFactId.push(assertion);
//     }

//     applyChildAssertion(assertion: Assertion) {
//         // --- If this assertion applies to this versioned relation, validate
//         //     and append it.
//         // TODO - check that valid_from/valid_to etc are good.
//         if(true) {
//             this.tuples.push(new Tuple(this.schema, assertion));
//             // TODO TODO TODO TODO TODO
//             this.resetMemoized();
//         } else {
//             // Find parent 
//         }
//     }
    
//     // - Sometimes user want to read all tuples (full version history)
//     // - Sometimes user just wants to read tip (or some other version or diff etc).
//     // - Sometimes user asserts a new assertion and will get filed appropriatly and
//     //   efficiently.
//     // - 
    
// }


// class VersionedRelation {}

// class Tuple {
//     schema: RelationField;
//     assertion: Assertion;
//     children: Record<string, VersionedRelation> = {};
//     #domainFields: Record<string,any>|undefined = undefined;

//     constructor(schema: RelationField, assertion: Assertion) {
//         this.schema = schema;
//         this.assertion = assertion;
//     }

//     isCurrent() { return this.assertion.valid_to == null; }
// }


const sample = [
    { assertion_id: 1,
      fact_id: 1,
      valid_from: 0,
      valid_to: 99,
      ty: 'en',
      public_note: 'initial commit',
    },
    { assertion_id: 2,
      fact_id: 1,
      valid_from: 100,
      valid_to: 9999,
      ty: 'en',
      public_note: 'update!',
    },
    { assertion_id: 3,
      fact_id: 2,
      valid_from: 100,
      valid_to: 9999,
      ty: 'sp',
      parent_id: 1,
      ty1: 'en',
      id1: 1,
      ty2: 'sp',
      id2: 2,
      attr1: 'cat',
      locale: 'en'
    }
];

// These assertions are at paths.
// A path is the same as the denormalized flattening of ids and types.
// - a 'relation' is a set of assertions with the same path.
// - each relation also has child relations, which are one level deeper than
//   that relation (with that relation id as parent), parittioned into field names
//   by 'ty'.
// - recurse.






// class VersionedRelation {
//     schema: RelationField;
//     tuples: Array<Tuple> = [];
//     tuplesByFactId: Record<number, Array<Tuple>> = {};
//     lastUpdateTime: number = 0;
//     #current: Array<Tuple>|undefined = undefined;
//     // published (+ locale + changes after a time) should be done
//     // using a more general builder parameterization or qurey mech.
//     //#published : Array<Tuple>|undefined = undefined;
    
//     constructor(schema: RelationField) {
//         this.schema = schema;
//     }

//     locus(): string {
//         return 'LOCUS'; // TODO
//     }
    
//     resetMemoized() {
//         this.#current = undefined;
//         //this.#published = undefined;
//     }

//     // I think this is wrong anyway.
//     get current() {
//         return this.#current ??= this.tuples.filter(t=>t.isCurrent());
//     }

//     // This is the key - once this works, the rest is easy!
//     // Later: apply may be able to filter for a locale or published.
//     apply(assertion: Assertion) {
//         if(assertion.ty === this.schema.tag)
//             this.applyLocalAssertion(assertion);
//         else
//             this.applyChildAssertion(assertion);
//     }

//     applyLocalAssertion(assertion: Assertion) {
//         assert(assertion.ty === this.schema.tag);

//         // --- Sanity check: time must never go backwards (but we can get multiple
//         //     assertions at the same time - as long as they are against different facts)
//         if(this.lastUpdateTime > assertion.valid_from)
//             throw new Error(`${this.locus()}: attempt to go backwards in time - last update time is ${timestamp.formatTimestampAsUTCTime(this.lastUpdateTime)} attempting to apply update at time ${timestamp.formatTimestampAsUTCTime(assertion.valid_from)}`);

//         // --- Look up the sequence of tuples we already have for this fact id.
//         let tuplesForFactId = this.tuplesByFactId[assertion.id];
//         if(tuplesForFactId === undefined) {
//             tuplesForFactId = this.tuplesByFactId[assertion.id] = [];
//         }

//         // --- end time etc???


//         // --- Append tuple
//         // ??? ??? ??? ??? ???
//         // The structure seems wrong - there should be one top level relation
//         // tree - and the versioning is happening at the tuple level - we are
//         // presently coping the top level tree.
//         //tuplesForFactId.push(assertion);
//     }

//     applyChildAssertion(assertion: Assertion) {
//         // --- If this assertion applies to this versioned relation, validate
//         //     and append it.
//         // TODO - check that valid_from/valid_to etc are good.
//         if(true) {
//             this.tuples.push(new Tuple(this.schema, assertion));
//             // TODO TODO TODO TODO TODO
//             this.resetMemoized();
//         } else {
//             // Find parent 
//         }
//     }
    
//     // - Sometimes user want to read all tuples (full version history)
//     // - Sometimes user just wants to read tip (or some other version or diff etc).
//     // - Sometimes user asserts a new assertion and will get filed appropriatly and
//     //   efficiently.
//     // - 
    
// }

// class Tuple {
//     schema: RelationField;
//     assertion: Assertion;
//     children: Record<string, VersionedRelation> = {};
//     #domainFields: Record<string,any>|undefined = undefined;

//     constructor(schema: RelationField, assertion: Assertion) {
//         this.schema = schema;
//         this.assertion = assertion;
//     }

//     isCurrent() { return this.assertion.valid_to == null; }
// }














function test() {
    const dictSchema = model.Schema.parseSchemaFromCompactJson('dict', dictSchemaJson);

    // --- Load the tuples for a dictionary entry.
    const sampleEntryAssertions = selectAssertionsForTopLevelFact().all({id1:1000});
    //console.info('Sample entry assertions', sampleEntryAssertions);

    // --- Create an empty instance schema
    const mmoDb = new Database(dictSchema);
    sampleEntryAssertions.forEach(a=>mmoDb.apply(a));
    console.info(JSON.stringify(mmoDb.dump(), undefined, 2));

    // --- Navigate to pronunciation guide
    //let pronouciationGuide: Fact = mmoDb.searchFacts(f=>f.id===112);
    
    // --- Edit pronunciation guide
    
    // --- Add a second pronunciation guide

    // --- Persist this to disk!
    

    
    //fieldToFieldInstInst.accept(dictSchema);
}





if (import.meta.main)
    await test();
