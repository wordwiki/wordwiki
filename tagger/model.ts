import {CustomError} from "../utils/errors.ts";
import {typeof_extended} from "../utils/utils.ts";
import * as utils from "../utils/utils.ts";
import {panic, assert, assertNever} from "../utils/utils.ts";
//import { DB, PreparedQuery, QueryParameter, QueryParameterSet } from "https://deno.land/x/sqlite/mod.ts";
//import { PreparedQueryCache } from "./dbutils.ts";
//import * as dbutils from "./dbutils.ts";
import * as orderkey from '../utils/orderkey.ts';
import * as timestamp from '../utils/timestamp.ts';
//import { longestIncreasingSequenceUsingCompareFn } from '../utils/longest-increasing-sequence.js';
import {RecordValue, Value, getPrimaryKey, getString, getOptionalString, idCollator } from './record.ts';

export enum FieldKind {
    Model=0,
    Order=1,
    Versioning=2,
    ParentRelation=3,
}

export interface Style {
    $prompt?: string,
    $style?: string,
}

export function validateStyle(locus:string, style: any): Style {
    return {
        $prompt: validateOptionalStringProperty(locus, '$prompt', style.$prompt),
        $style: validateOptionalStringProperty(locus, '$style', style.$style), 
    };
}

function validateOptionalStringProperty(locus: string, name: string, value: any): string {
    if(!(value === undefined || typeof value === 'string'))
        throw new ValidationError(locus, `invalid optional attr '${name}'- expected optional string - got ${JSON.stringify(value)} of type ${typeof value}`);
    return value;
}

/**
 *
 */
export interface FieldVisitorI<A,R> {
    visitBooleanField(f: BooleanField, a: A): R;
    visitIntegerField(f: IntegerField, a: A): R;
    visitFloatField(f: FloatField, a: A): R;
    visitStringField(f: StringField, a: A): R;
    visitVariantField(f: VariantField, a: A): R;
    visitIdField(f: IdField, a: A): R;
    visitPrimaryKeyField(f: PrimaryKeyField, a: A): R;
    visitRelationField(f: RelationField, a: A): R;
    visitSchema(f: Schema, a: A): R;
}

/**
 *
 */
export class DataVisitor implements FieldVisitorI<any,void> {
    visitField(f:Field, v:any) {}
    visitBooleanField(f: BooleanField, v: any) { this.visitField(f, v); }
    visitIntegerField(f: IntegerField, v: any) { this.visitField(f, v); }
    visitFloatField(f: FloatField, v: any) { this.visitField(f, v); }
    visitStringField(f: StringField, v: any) { this.visitField(f, v); }
    visitVariantField(f: VariantField, v: any) { this.visitField(f, v); }
    visitIdField(f: IdField, v: any) { this.visitField(f, v); }
    visitPrimaryKeyField(f: PrimaryKeyField, v: any) { this.visitField(f, v); }
    visitRelationField(relationField: RelationField, v: any) {
        relationField.modelFields.forEach(f=>f.accept(this, v[f.name]));
    }
    visitSchema(schema: Schema, v: any) {
        schema.modelFields.forEach(f=>f.accept(this, v[f.name]));
    }
}

/*
  - The bulk of the render behavior is on relation fields, and is driven by
    the configuration on relation fields.
    - regular fields may have a lot of configuration as well.
    - are recursive renerer.
    - parent informs rendering of child.
    - the style configuration is type specific - and can probably be part
    of the model.
    - don't want to smear the rendering on the fields.
 */

/**
 * A field in a record.  subclassed by field type, including subrelation
 * fields.
 */
export abstract class Field {
    // Field names must start with a (ASCII) alphabet character or underscore, to
    // be followed by alphabet numbers and underscores.
    static FieldNameRegex = new RegExp(`^[a-zA-Z_][a-zA-Z0-9_]*$`);

    // The user defined data model is augmented with implementation
    // defined fields to support things like order, versioning and
    // efficient tree queries.  These fields are not (usually) visible
    // to external users, but making them real fields in the model
    // simplifies a lot of things.  These 'synthetic' fields are
    // marked with a kind that drives things like when they are
    // serialized.
    kind: FieldKind = FieldKind.Model;
    
    // Automatically set when a field is added to a relation.
    parentRelation: RelationField|undefined = undefined;
    colIdx: number = -1;
    
    constructor(public name: string, public style: Style) {
        if(!Field.FieldNameRegex.test(name)) {
            throw new Error(`invalid field names '${name}' - field names must start with a letter, then be followed by letters, numbers and _`);
        }
    }

    abstract accept<A,R>(v: FieldVisitorI<A,R>, a: A): R;

    setKind(kind:FieldKind): this {
        this.kind = kind;
        return this;
    }

    /**
     * Validates a value against this schema node.  Throws a
     * ValidationError if not valid.
     */
    abstract validateValue(locus: string, data: Value, opts: ValidateOpts): void;

    /**
     * Converts this schema object to our compact JSON representation.
     */
    abstract schemaToCompactJson(): any;

    /**
     * Returns SQLite field declaration lines to declare this field
     * (that are inserted in a CREATE TABLE statement).
     *
     * Multiple declaration lines are allowed so that complex fields
     * can be flattened into multiple (or no) simple fields.
     */
    getDbFieldNames(): string[] { return [this.name]; }
    abstract createDbFields(versioned: boolean): string[];

    // abstract renderAsTomlValueString(): string {
    // }
    
    /*abstract*/ makeRandomChange() {
    }
}

export interface ValidateOpts {
    expectOrder: boolean,
    expectVersioning: boolean,
}

/**
 * Optional base class for ScalarFields.
 *
 * Code should not depend on scalar fields extending this base - it
 * exists solely as a optional convenience for select scalar field
 * implementers.
 */
export abstract class ScalarField extends Field {
    constructor(name: string, public bind: string, public optional: boolean, style: Style={}) {
        super(name, style);
    }

    abstract jsTypename(): string;
    abstract schemaTypename(): string;
    abstract sqlTypename(): string;

    /**
     * Validate a value against this schema node.
     *
     * If the value does not validate, throws a ValidationError
     *
     * The default implementation handles null values and dispatches
     * to validateRequiredValue for non null values.
     */
    validateValue(locus: string, value: Value, opts: ValidateOpts) {
        if(value == null || value == undefined) {
            if(this.optional)
                return;
            else
                throw new ValidationError(locus, `missing required value for field: ${this.name}`);
        } else {
            return this.validateRequiredValue(locus, value);
        }
    }

    /**
     * Validate a non-null value against this schema node.
     *
     * The default implemenation uses (extended) JS typenames, but subclasses will
     * often implement more sophisticated behavior.
     */
    validateRequiredValue(locus: string, value: Value) {
        const expectedTypename = this.jsTypename();
        const actualTypename = typeof_extended(value);
        if (actualTypename != expectedTypename)
            throw new ValidationError(locus, `expected ${expectedTypename} value - got value ${value} with type ${actualTypename}`);
    }

    /**
     * Serialize this schema node to the compact JSON representation.
     */
    schemaToCompactJson(): any {
        return this.buildSchemaToCompactJson(this.schemaTypename(), null);
    }

    /**
     * Factoring of the common parts of the schemaToCompactJson() method
     * to make per-type field implementations less bulky.
     */
    buildSchemaToCompactJson(typ: string, extraFields: any): any {
        const json = { $type: this.schemaTypename() } as any; // XXX fix typing
        this.bind && (json.$bind = this.bind);
        this.optional && (json.$optional = true);
        extraFields && Object.assign(json, extraFields);
        return json;
    }

    
    createDbFields(versioned: boolean): string[] {
        return [`${this.name} ${this.sqlTypename()}${this.optional?'':' NOT NULL'}`];
    }

    static parseSchemaValidate(locus:string, name:string, schema:any, $type:string, bind:string,  $style:Style, extra: any, expect_type: string) {
        if($type !== expect_type)
            throw new ValidationError(locus, `Expected schema field type ${expect_type} got field type ${$type}`);
        if($style)
            validateStyle(locus, $style);
        if(Object.getOwnPropertyNames(extra).length !== 0)
            throw new ValidationError(locus, `Unexpected properties in schema node of type ${$type}: ${Object.getOwnPropertyNames(extra)}`);
    }
}

/**
 * Boolean Field
 */
export class BooleanField extends ScalarField {
    constructor(name: string, bind: string, optional: boolean, style: Style={}) {
        super(name, bind, optional, style);
    }

    accept<A,R>(v: FieldVisitorI<A,R>, a: A): R { return v.visitBooleanField(this, a); }
    
    jsTypename(): string { return 'boolean'; }
    schemaTypename(): string { return 'boolean'; }
    // sqlite has no bool type - one has to use 0/1 instead
    sqlTypename(): string { return 'INTEGER'; }
    
    static parseSchemaFromCompactJson(locus: string, name: string, schema: any): BooleanField {
        const {$type, $bind, $style, $optional, ...extra} = schema;
        ScalarField.parseSchemaValidate(locus, name, schema, $type, $bind, $style, extra, 'boolean');
        return new BooleanField(name, $bind, !!$optional);
    }
}

/**
 * Integer Field
 *
 * We are restricting our Integer fields values to be between
 * Number.MAX_MIN_INTEGER (2^53-1) and Number.MIN_SAFE_INTEGER
 * -(2^53-1) because that is the range of integers that can be
 * processed by JS (and serialized as JSON) without being silently
 * altered.
 *
 * We will add BigInt fields if we need larger integers.
 */
export class IntegerField extends ScalarField {
    constructor(name: string, bind: string, optional: boolean=false, style: Style={}) {
        super(name, bind, optional, style);
    }

    accept<A,R>(v: FieldVisitorI<A,R>, a: A): R { return v.visitIntegerField(this, a); }
    
    jsTypename(): string { return 'number'; }
    schemaTypename(): string { return 'integer'; }
    sqlTypename(): string { return 'INTEGER'; }

    validateRequiredValue(locus: string, value: Value) {
        super.validateRequiredValue(locus, value);
        if(typeof value !== 'number')
            throw new ValidationError(locus, `Expected number - got ${value}`);
        if(Math.trunc(value) !== value)
            throw new ValidationError(locus, `Integer value required for ${locus} - got ${value} with a fractional component`);
        if(value > Number.MAX_SAFE_INTEGER)
            throw new ValidationError(locus, `Integer value to big for field ${locus} - got ${value}`);
        if(value < Number.MIN_SAFE_INTEGER)
            throw new ValidationError(locus, `Integer value to small for field ${locus} - got ${value}`);
    }

    static parseSchemaFromCompactJson(locus: string, name: string, schema: any): IntegerField {
        const {$type, $bind, $style, $optional, ...extra} = schema;
        ScalarField.parseSchemaValidate(locus, name, schema, $type, $bind, $style, extra, 'integer');
        return new IntegerField(name, $bind, !!$optional);
    }
}

/**
 * An field that can contain a IEEE 754 binary64 floating point
 * number (AKA 'double').
 *
 * We ban NaN and +/- Infinity for now because they are not supported
 * by JSON.  We could easily encode these in JSON as strings, and
 * fixup on load, but we presently don't need post-load fixup pass,
 * and would like to avoid one.
 */
export class FloatField extends ScalarField {
    constructor(name: string, bind: string, optional: boolean, style: Style={}) {
        super(name, bind, optional, style);
    }

    accept<A,R>(v: FieldVisitorI<A,R>, a: A): R { return v.visitFloatField(this, a); }
    
    jsTypename(): string { return 'number'; }
    schemaTypename(): string { return 'float'; }
    sqlTypename(): string { return 'REAL'; }

    /**
     * We ban NaN and +/- Infinity because they are not supported
     * by JSON.
     * 
     * (If we find a need to support them, we can extend our JSON
     * serializer/deserializer to represent them as string values, and
     * remove this restriction)
     */
    validateRequiredValue(locus: string, value: Value) {
        super.validateRequiredValue(locus, value);
        if(!Number.isFinite(value))
            throw new ValidationError(locus, `NaN and Inf float values not allowed - ${locus}`);
    }
    
    static parseSchemaFromCompactJson(locus: string, name: string, schema: any): FloatField {
        const {$type, $bind, $style, $optional, ...extra} = schema;
        ScalarField.parseSchemaValidate(locus, name, schema, $type, $bind, $style, extra, 'float');
        return new FloatField(name, $bind, !!$optional);
    }
}

enum StringFormat {
    Text = 1,
    MultilineText = 2,
    Markdown = 3,
    JSON = 4,
    HTML = 5,
    Template = 6,
    Id = 7,
}

/**
 * Variable length unicode string.
 *
 * TODO: add a format field (shortText, multilineText, markdown, json, html etc)
 */
export class StringField extends ScalarField {
    constructor(name: string, bind: string, optional: boolean, public format:StringFormat = StringFormat.Text, style: Style={}) {
        super(name, bind, optional, style);
    }

    accept<A,R>(v: FieldVisitorI<A,R>, a: A): R { return v.visitStringField(this, a); }
    
    jsTypename(): string { return 'string'; }
    schemaTypename(): string { return 'string'; }
    sqlTypename(): string { return 'TEXT'; }

    static parseSchemaFromCompactJson(locus: string, name: string, schema: any): StringField {
        const {$type, $bind, $style, $optional, ...extra} = schema;
        ScalarField.parseSchemaValidate(locus, name, schema, $type, $bind, $style, extra, 'string');
        return new StringField(name, $bind, !!$optional);
    }
}

/**
 * Variant Field
 *
 * 
 */
export class VariantField extends StringField {
    constructor(name: string, bind: string, optional: boolean, style: Style={}) {
        super(name, bind, optional, StringFormat.Text, style);
    }

    accept<A,R>(v: FieldVisitorI<A,R>, a: A): R { return v.visitVariantField(this, a); }
    
    jsTypename(): string { return 'string'; }
    schemaTypename(): string { return 'variant'; }
    sqlTypename(): string { return 'TEXT'; }

    static parseSchemaFromCompactJson(locus: string, name: string, schema: any): VariantField {
        const {$type, $bind, $style, $optional, ...extra} = schema;
        ScalarField.parseSchemaValidate(locus, name, schema, $type, $bind, $style, extra, 'variant');
        return new VariantField(name, $bind, !!$optional);
    }
}

/**
 * ID field.
 *
 * This system uses NanoIds (an alternative globally unique id system) for all ids.
 *
 * Furthermore, we restrict the alphabet used to serialized ids to [a-zA-Z].
 */
export class IdField extends ScalarField {
    static IdRegex = new RegExp(`^[a-zA-Z]+`);

    constructor(name: string, bind: string, optional: boolean=false, style: Style={}) {
        super(name, bind, optional, style);
    }

    accept<A,R>(v: FieldVisitorI<A,R>, a: A): R { return v.visitIdField(this, a); }
    
    jsTypename(): string { return 'string'; }
    schemaTypename(): string { return 'id'; }
    sqlTypename(): string { return 'TEXT'; }

    validateRequiredValue(locus: string, value: Value) {
        super.validateRequiredValue(locus, value);
        const valueStr = value as string;
        if(valueStr === '')
            throw new ValidationError(locus, `The empty string is not a valid id`);
        if(!IdField.IdRegex.test(valueStr))
            throw new ValidationError(locus, `Id may only contain the characters a-z and A-Z - ${valueStr}`);
    }
    
    static parseSchemaFromCompactJson(locus: string, name: string, schema: any): IdField {
        const {$type, $bind, $style, ...extra} = schema;
        ScalarField.parseSchemaValidate(locus, name, schema, $type, $bind, $style, extra, 'id');
        return new IdField(name, $bind);
    }
}

/**
 *
 */
export class PrimaryKeyField extends IdField {
    constructor(name: string, bind:string="id", style: Style={}) {
        super(name, bind, false, style);
    }

    accept<A,R>(v: FieldVisitorI<A,R>, a: A): R { return v.visitPrimaryKeyField(this, a); }

    schemaTypename(): string { return 'primary_key'; }
    
    createDbFields(versioned: boolean): string[] {
        return [`${this.name} TEXT NOT NULL${versioned?'':' PRIMARY KEY'}`];
    }

    static parseSchemaFromCompactJson(locus: string, name: string, schema: any): PrimaryKeyField {
        const {$type, $bind, $style, ...extra} = schema;
        ScalarField.parseSchemaValidate(locus, name, schema, $type, $bind, $style, extra, 'primary_key');
        return new PrimaryKeyField(name, $bind);
    }
}

/**
 *
 */
export class RelationField extends Field {
    fields: Field[] = [];

    // TODO: Probably move the calc of these to resolve()
    #fieldsByName: {[name: string]: Field}|undefined = undefined;
    #primaryKeyField: PrimaryKeyField|undefined = undefined;
    #nonRelationFields: Field[]|undefined = undefined;
    #scalarFields: ScalarField[]|undefined = undefined;
    #relationFields: RelationField[]|undefined = undefined;
    #ancestorRelations_: RelationField[]|undefined;
    #schema_: Schema|undefined;
    #descendantAndSelfRelations_: RelationField[]|undefined;
    #descendantAndSelfRelationsByTag: Record<string, RelationField>|undefined = undefined;
    #primaryKeyColIndex_: number|undefined;
    #syntheticFieldsColIndex_: number|undefined;
    #parentFieldsColIndex_: number|undefined;

    constructor(name: string, public tag: string, public modelFields: Field[], style: Style={}) {
        super(name, style);
    }

    accept<A,R>(v: FieldVisitorI<A,R>, a: A): R { return v.visitRelationField(this, a); }
    
    resolve() {

        if(this.isForced())
            throw new ValidationError(
                this.name, `internal error: can't resolve after RelationField is forced`);

        // Add the synthetic fields that are used to support ordering, versioning and
        // heirarchy queries.
        this.fields = [
            ...this.modelFields,
            // new StringField('_order', true).setKind(FieldKind.Order),
            // new IntegerField('_valid_from').setKind(FieldKind.Versioning),
            // new IntegerField('_valid_to', true).setKind(FieldKind.Versioning),
            // // - All the following fields sholud move to a separate table, and
            // //   be shared by the entire TX (the id would be a TXid).  This TX
            // //   table would also contain a list of the tables that were effected
            // //   by the TX, so could lookup all the deltas that were part of the TX.
            // // - A lot of the change detail stuff can be further put into anothe
            // //   table to make truely optional.
            // //new IntegerField('_txid', true).setKind(FieldKind.Versioning),
            // new StringField('_confidence', true).setKind(FieldKind.Versioning),
            // new StringField('_confidence_note', true).setKind(FieldKind.Versioning),
            // new IdField('_change_by_user_id', true).setKind(FieldKind.Versioning),
            // new StringField('_change_reason', true).setKind(FieldKind.Versioning),
            // new StringField('_change_arg', true).setKind(FieldKind.Versioning),
            // // Note: if you add a field after change_node, also adjust
            // // parentFieldsColIndex accessor (THIS IS VERY BAD XXX)
            // new StringField('_change_note', true).setKind(FieldKind.Versioning),
            // ...this.ancestorRelations.map(
            //     r=>new IdField(r.primaryKeyField.name).setKind(FieldKind.ParentRelation)),
            ];

        // Because we sometimes make schemas with the versioning fields elided,
        // versioning fields must be at the end of the schema (followed by ParentRelation fields)
        // const firstVersionFieldIndex = this.fields.findIndex(f=>f.kind === FieldKind.Versioning)
        // if(firstVersionFieldIndex === -1)
        //     throw new Error('internal error: no versioning fields?');
        // if(this.fields.slice(firstVersionFieldIndex).filter(
        //     f=>!(f.kind === FieldKind.Versioning || f.kind === FieldKind.ParentRelation)).length !== 0)
        //     throw new Error('internal error: versioning fields must be at end of schema');

        // Set parent on all fields, and assign db column indexes.
        for(const f of this.fields) {
            if(f.parentRelation)
                throw new Error(`field ${f.name} cannot be child of relation ${this.name} - is already a child of relation ${f.parentRelation.name}`);
            f.parentRelation = this;
        }

        // Assign colIds
        this.nonRelationFields.reduce((nextColIdx, field) =>
            (field.colIdx = nextColIdx, nextColIdx+1), 0);
        
        // Recurse
        this.relationFields.forEach(r=>r.resolve());
    }

    isForced(): boolean {
      return !!this.#fieldsByName||
            !!this.#primaryKeyField||
            !!this.#nonRelationFields||
            !!this.#scalarFields||
            !!this.#relationFields||
            !!this.#ancestorRelations_||
            !!this.#schema_||
            !!this.#descendantAndSelfRelations_||
            !!this.#primaryKeyColIndex_;
    }
    
    get fieldsByName(): {[name: string]: Field} {
        return this.#fieldsByName??=Object.fromEntries(this.fields.map(f=>[f.name, f]));
    }

    get nonRelationFields(): Field[] {
        return this.#nonRelationFields??=this.fields.filter(f=>!(f instanceof RelationField));
    }

    get scalarFields(): ScalarField[] {
        return this.#scalarFields??=
            this.fields.filter(f=>f instanceof ScalarField).map(f=>f as ScalarField);
    }
    
    get relationFields(): RelationField[] {
        return this.#relationFields??=
            this.fields.filter(f=>f instanceof RelationField).map(f=>f as RelationField);
    }

    get primaryKeyField(): PrimaryKeyField {
        return this.#primaryKeyField??=(()=>{
            const primaryKeyFields = this.fields.filter(f=>f instanceof PrimaryKeyField).map(f=>f as PrimaryKeyField);
            if(primaryKeyFields.length !==1)
                throw new Error(`each relation must have exactly one primary key field: ${this.name}`);
            return primaryKeyFields[0];
        })();
    }

    get parentIdColIndex(): number|undefined {
        if(this.parentRelation) {
            const cols = this.nonRelationFields;
            const parentIdColIndex = cols.length-1;
            if(cols[parentIdColIndex].name !== this.parentRelation.primaryKeyField.name)
                throw new Error(`internal error: parent id field inconsistency ${cols[parentIdColIndex].name} != ${this.parentRelation.primaryKeyField.name} on ${this.name}`);
            return parentIdColIndex;
        } else {
            return undefined;
        }
    }

    get primaryKeyColIndex(): number {
        return this.#primaryKeyColIndex_??=(()=>{
            const cols = this.nonRelationFields;
            const primaryKeyColIndex = cols.indexOf(this.primaryKeyField);
            if(primaryKeyColIndex === -1)
                throw new Error('WTF: no primary key!');
            return primaryKeyColIndex;
        })();
    }

    get syntheticFieldsColIndex(): number {
        return this.#syntheticFieldsColIndex_??=(()=>{
            const cols = this.nonRelationFields;
            const orderColIndex = cols.findIndex(f=>f.name === '_order');
            if(orderColIndex === -1)
                throw new Error('WTF: no _order key!');
            return orderColIndex;
        })();
    }

    get parentFieldsColIndex(): number {
        return this.#parentFieldsColIndex_??=(()=>{
            const cols = this.nonRelationFields;
            // VERY VERY BAD XXXX FIX THIS HACK!!!  (using _change_note like this -
            // there is no possible way this will not bite me).   I am doing this
            // because this whole synthenci field thing will be replaced soon anyway.
            const lastSyntheticColIndex = this.nonRelationFields.findIndex(f=>f.name === '_change_note');
            if(lastSyntheticColIndex === -1)
                throw new Error('WTF: no _change_index key!');
            return lastSyntheticColIndex+1;
        })();
    }

    get orderColIndex(): number { return this.syntheticFieldsColIndex; }

    get validFromColIndex(): number { return this.syntheticFieldsColIndex+1; }
    get validToColIndex(): number { return this.syntheticFieldsColIndex+2; }
    
    get ancestorRelations():RelationField[] {
        return this.#ancestorRelations_??=
            this.parentRelation?[...this.parentRelation.ancestorRelations,this.parentRelation]:[];
    }

    get schema(): Schema {
        return this.#schema_??= (()=>{
            if(this instanceof Schema)
                return this;
            else
                return (this.parentRelation ?? panic('no schema found')).schema;
        })();
    }

    get descendantAndSelfRelations(): RelationField[] {
        return this.#descendantAndSelfRelations_ ??= [this, ...this.descendantRelations];
    }

    get descendantRelations(): RelationField[] {
        return ([] as RelationField[]).concat(
            ...this.relationFields.map(r=>r.descendantAndSelfRelations));
    }

    get descendantAndSelfRelationsByTag(): Record<string, RelationField> {
        // Note: we are already validating tag uniqueness across the whole
        //       schema, so no need to check here as well.
        return this.#descendantAndSelfRelationsByTag??=
            Object.fromEntries(this.descendantAndSelfRelations.map(r=>[r.tag, r]));
    }
        
    validateSchema(locus: string) {
        if(this.fields.length !== Object.getOwnPropertyNames(this.fieldsByName).length) {
            throw new ValidationError(locus,
                                      `non unique field names in expanded schema: ${this.fields.map(f=>f.name).join(',')}`);
        }
        this.relationFields.forEach(r=>r.validateSchema(locus + '/' + this.name));
    }
    
    validateValue(locus: string, value: Value, opts: ValidateOpts) {
        // A missing child relation (Array) field is treated as an empty child relation.
        if(value === undefined)
            value = [];
        
        if (!Array.isArray(value))
            throw new ValidationError(locus, `relations must be arrays got ${typeof value}`);
        for(const elem of value) {
            this.validateRelationMember(locus, elem, opts);
        }
    }

    validateRelationMember(locus: string, value: RecordValue, opts: ValidateOpts) {
        // Want option to load/validate order and versioning fields.  Will need to pass thoug
        const relationLocus = locus + '/' + this.name;
        for(const field of this.fields) {
            switch(field.kind) {
                case FieldKind.Versioning:
                    if(!opts.expectVersioning) continue; else break;
                case FieldKind.Order:
                    if(!opts.expectOrder) continue; else break;
                case FieldKind.ParentRelation:
                    continue;
                default:
                    break;
            }
            const fieldValue = value[field.name];
            field.validateValue(relationLocus, fieldValue, opts);
        }
        for(const valueFieldName of Object.keys(value)) {
            if(!Object.hasOwn(this.fieldsByName, valueFieldName)) {
                throw new ValidationError(locus, `unknown field '${valueFieldName}' in value for relation '${this.name}'`);
            }
        }
    }

    getDbFieldNames(): string[] { return []; }
    createDbFields(versioned: boolean): string[] {
        return [];
    }
    
    /**
     * Returns this schema node in it's JSON serialization.
     */
    schemaToCompactJson(): any {
        const json = {} as any; // fix typing
        json.$type = 'relation';
        json.$tag = this.tag;
        for(const field of this.fields) {
            json[field.name] = field.schemaToCompactJson();
        }
        return json;
    }
    
    static parseSchemaFromCompactJson(locus: string, name: string, schemaJson: any): RelationField {
        const {$type, $tag, $prompt, $style, ...field_schema} = schemaJson;
        if($type !== 'relation')
            throw new ValidationError(locus, `expected relation type got $type ${$type}`);
        if(typeof $tag !== 'string')
            throw new ValidationError(locus, `missing required $tag on relation ${name}`);

        // We are presently allowing $prompt to be specified as top level instead
        // of in $style - not sure we should have this shortcut?
        const style = { $prompt, $style };
        
        // TODO: locus needs asjusting here
        const fields = Object.entries(field_schema).map(([field_name, field_body]) =>
            parse_field(locus, field_name, field_body));

        const schema = new RelationField(name, $tag, fields, style);

        return schema;
    }
}

export function parse_field(locus: string, name: string, schema: any): Field {
    const typ = schema.$type;
    switch(typ) {
        case 'relation':
            return RelationField.parseSchemaFromCompactJson(locus, name, schema);
        case 'id':
            return IdField.parseSchemaFromCompactJson(locus, name, schema);
        case 'primary_key':
            return PrimaryKeyField.parseSchemaFromCompactJson(locus, name, schema);
        case 'string':
            return StringField.parseSchemaFromCompactJson(locus, name, schema);
        case 'variant':
            return VariantField.parseSchemaFromCompactJson(locus, name, schema);
        case 'integer':
            return IntegerField.parseSchemaFromCompactJson(locus, name, schema);
        case 'float':
            return FloatField.parseSchemaFromCompactJson(locus, name, schema);            
        case 'boolean':
            return BooleanField.parseSchemaFromCompactJson(locus, name, schema);
        default:
            throw new ValidationError(locus, `unknown field type ${schema.$type}`);
    }
}

/**
 *
 *
 */
/*
  - TODO: add top level resolve/validate
  - TODO: add check for unique tags in there.
 */
export class Schema extends RelationField {
    #relationsByName: Record<string,RelationField>|undefined = undefined;
    #relationsByTag: Record<string,RelationField>|undefined = undefined;
    
    constructor(name: string, tag: string, public rootRelations: RelationField[]) {
        super(name, tag, rootRelations, {});
    }

    accept<A,R>(v: FieldVisitorI<A,R>, a: A): R { return v.visitSchema(this, a); }

    resolveAndValidate(locus: string) {
        this.resolve();
        this.validateSchema(locus);
    }
    
    get relationsByName(): Record<string,RelationField> {
        return this.#relationsByName??=(()=>{
            const duplicateNames =
                utils.duplicateItems(this.descendantAndSelfRelations.map(r=>r.name));
            if(duplicateNames.size > 0)
                throw new Error(`Duplicate field names in schema ${this.name} - ${duplicateNames}`);
            return Object.fromEntries(this.descendantAndSelfRelations.map(r=>[r.name, r]));
         })();
    }

    get relationsByTag(): Record<string,RelationField> {
        return this.#relationsByTag??=(()=>{
            const duplicateTags =
                utils.duplicateItems(this.descendantAndSelfRelations.map(r=>r.tag));
            if(duplicateTags.size > 0)
                throw new Error(`Duplicate field tags in schema ${this.tag} - ${duplicateTags}`);
            return Object.fromEntries(this.descendantAndSelfRelations.map(r=>[r.tag, r]));
        })();
    }
        
    static parseSchemaFromCompactJson(locus: string, schemaJson: any): Schema {
        const {$type, $name, $tag, ...field_schema} = schemaJson;
        if($type !== 'schema')
            throw new ValidationError(locus, `expected schema type got $type ${$type}`);
        if(typeof $name !== 'string')
            throw new ValidationError(locus, `missing required $name on schema ${name}`);
        if(typeof $tag !== 'string')
            throw new ValidationError(locus, `missing required $tag on schema ${name}`);
        
        //console.info('field_schema', field_schema);
        const rootRelations = Object.entries(field_schema).map(([field_name, field_body]:[string,any]) => {
            if(field_body?.$type !== 'relation')
                throw new ValidationError(locus, `all top level items in a schema must be relations - item named ${field_name} is not a relation`);
            return RelationField.parseSchemaFromCompactJson(locus, field_name, field_body);
        });
        
        const schema = new Schema($name, $tag, rootRelations);
        schema.resolveAndValidate(locus);
        return schema;
    }
}


/**
 * Thrown by validate methods to report a validation error.
 */
export class ValidationError extends CustomError {
    constructor(locus: string, message: string) {
        super(`${locus}: ${message}`);
    }
}


