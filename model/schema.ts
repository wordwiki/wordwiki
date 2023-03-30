import {CustomError} from "../utils/errors.ts";
import {typeof_extended} from "../utils/utils.ts";
import { DB, PreparedQuery, QueryParameter, QueryParameterSet } from "https://deno.land/x/sqlite/mod.ts";

type Record = {[name: string]: Value};
type Value = null|boolean|number|string|Record[];

/**
 * A field in a record.  subclassed by field type, including subrelation
 * fields.
 */
export abstract class Field {
    // Field names must start with a (ASCII) alphabet character, to
    // be followed by alphabet numbers and underscores.
    static FieldNameRegex = new RegExp(`^[a-zA-Z][a-zA-Z0-9_]+`);

    // Automatically set when a field is added to a relation.
    parent: Field|undefined = undefined;
    
    constructor(public name: string) {
        if(!Field.FieldNameRegex.test(name)) {
            throw new Error(`invalid field names '${name}' - field names must start with a letter, then be followed by letters, numbers and _`);
        }
    }

    /**
     * Validates a value against this schema node.  Throws a
     * ValidationError if not valid.
     */
    abstract validate(locus: string, data: Value): void;

    /**
     * Converts this schema object to our compact JSON representation.
     */
    abstract schemaToCompactJson(): any;

    /**
     * Returns SQLite field declaration lines (that are inserted in
     * a CREATE TABLE statement).
     *
     * Returns a list of declaration lines to allow complex fields to
     * be flattened into multiple (or no) simple fields.
     */
     abstract createDbFields(): string[];
}

/**
 * Optional base class for ScalarFields.
 *
 * Code should not depend on scalar fields extending this base - it
 * exists solely as a optional convenience for select scalar field
 * implementers.
 */
export abstract class ScalarFieldBase extends Field {
    constructor(name: string, public optional: boolean) {
        super(name);
        this.optional = optional;
    }

    abstract jsTypename(): string;
    abstract schemaTypename(): string;
    abstract sqlTypename(): string;

    /**
     * Validate a value against this schema node.
     *
     * If the value does not validate, throws a ValidationError
     */
    validate(locus: string, value: Value) {
        if(value == null || value == undefined) {
            if(this.optional)
                return;
            else
                throw new ValidationError(locus, `missing required value for field: ${this.name}`);
        } else {
            return this.validateRequired(locus, value);
        }
    }

    /**
     *
     */
    validateRequired(locus: string, value: Value) {
        const expectedTypename = this.jsTypename();
        const actualTypename = typeof_extended(value);
        if (actualTypename != expectedTypename)
            throw new ValidationError(locus, `expected ${expectedTypename} value - got value ${value} with type ${actualTypename}`);
    }

    /**
     * Returns this schema node in it's JSON serialization.
     */
    schemaToCompactJson(): any {
        return this.buildSchemaToCompactJson(this.schemaTypename(), null);
    }

    /**
     * Factoring of the common parts of the schema_to_json() method
     * to make per-type field implementations less bulky.
     */
    buildSchemaToCompactJson(typ: string, extraFields: any): any {
        const json = { $type: this.schemaTypename() } as any; // XXX fix typing
        if (this.optional)
            json.$optional = true;
        if (extraFields)
            Object.assign(json, extraFields)
        return json;
    }

    createDbFields(): string[] {
        return [`${this.name} ${this.sqlTypename()}${this.optional?'':' NOT NULL'}`];
    }

    static parseSchemaValidate(locus:string, name:string, schema:any, $type:string, extra: any, expect_type: string) {
        if($type !== expect_type)
            throw new ValidationError(locus, `Expected schema field type ${expect_type} got field type ${$type}`);
        if(Object.getOwnPropertyNames(extra).length !== 0)
            throw new ValidationError(locus, `Unexpected properties in schema node of type ${$type}: ${Object.getOwnPropertyNames(extra)}`);
    }
}

/**
 * Boolean Field
 */
export class BooleanField extends ScalarFieldBase {
    constructor(name: string, optional: boolean) {
        super(name, optional);
    }

    jsTypename(): string { return 'boolean'; }
    schemaTypename(): string { return 'boolean'; }
    // sqlite has no bool type - one has to use 0/1 instead
    sqlTypename(): string { return 'INTEGER'; }
    
    static parseSchemaFromCompactJson(locus: string, name: string, schema: any): BooleanField {
        const {$type, optional, ...extra} = schema;
        ScalarFieldBase.parseSchemaValidate(locus, name, schema, $type, extra, 'boolean');
        return new BooleanField(name, !!optional);
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
export class IntegerField extends ScalarFieldBase {
    constructor(name: string, optional: boolean) {
        super(name, optional);
    }

    jsTypename(): string { return 'number'; }
    schemaTypename(): string { return 'integer'; }
    sqlTypename(): string { return 'INTEGER'; }

    validateRequired(locus: string, value: Value) {
        super.validateRequired(locus, value);
        if(typeof value !== 'number')
            throw new ValidationError(locus, `Expected number - got ${value}`);
        if(Math.trunc(value) !== value)
            throw new ValidationError(locus, `Integer value required for ${locus} - got ${value} with a fractional component`);
        if(value > Number.MAX_SAFE_INTEGER)
            throw new ValidationError(locus, `Integer value to big for field ${locus} - got ${value}`);
        if(value < Number.MIN_SAFE_INTEGER)
            throw new ValidationError(locus, `Integer value to small for field ${locus} - got ${value}`);
    }

    static parseSchemaFromCompactJson(locus: string, name: string, schema: any): StringField {
        const {$type, optional, ...extra} = schema;
        ScalarFieldBase.parseSchemaValidate(locus, name, schema, $type, extra, 'integer');
        return new StringField(name, !!optional);
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
export class FloatField extends ScalarFieldBase {
    constructor(name: string, optional: boolean) {
        super(name, optional);
    }

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
    validateRequired(locus: string, value: Value) {
        super.validateRequired(locus, value);
        if(!Number.isFinite(value))
            throw new ValidationError(locus, `NaN and Inf float values not allowed - ${locus}`);
    }
    
    static parseSchemaFromCompactJson(locus: string, name: string, schema: any): StringField {
        const {$type, optional, ...extra} = schema;
        ScalarFieldBase.parseSchemaValidate(locus, name, schema, $type, extra, 'float');
        return new StringField(name, !!optional);
    }
}

/**
 * Variable length unicode string.
 */
export class StringField extends ScalarFieldBase {
    constructor(name: string, optional: boolean) {
        super(name, optional);
    }

    jsTypename(): string { return 'string'; }
    schemaTypename(): string { return 'string'; }
    sqlTypename(): string { return 'TEXT'; }

    static parseSchemaFromCompactJson(locus: string, name: string, schema: any): StringField {
        const {$type, optional, ...extra} = schema;
        ScalarFieldBase.parseSchemaValidate(locus, name, schema, $type, extra, 'string');
        return new StringField(name, !!optional);
    }
}

/**
 * Variable length text 'id' (ids are arbitrary non-empty unicode strings).
 */
export class IdField extends ScalarFieldBase {
    constructor(name: string) {
        super(name, false);
    }

    jsTypename(): string { return 'string'; }
    schemaTypename(): string { return 'id'; }
    sqlTypename(): string { return 'TEXT'; }

    validateRequired(locus: string, value: Value) {
        super.validateRequired(locus, value);
        if(value === '')
            throw new ValidationError(locus, `The empty string is not a valid id - ${locus}`);
    }
    
    static parseSchemaFromCompactJson(locus: string, name: string, schema: any): StringField {
        const {$type, ...extra} = schema;
        ScalarFieldBase.parseSchemaValidate(locus, name, schema, $type, extra, 'id');
        return new IdField(name);
    }
}

/**
 *
 */
export class PrimaryKeyField extends IdField {
    constructor(name: string) {
        super(name);
    }

    schemaTypename(): string { return 'primary_key'; }
    
    createDbFields(): string[] {
        return [`${this.name} TEXT NOT NULL PRIMARY KEY`];
    }

    static parseSchemaFromCompactJson(locus: string, name: string, schema: any): StringField {
        const {$type, ...extra} = schema;
        ScalarFieldBase.parseSchemaValidate(locus, name, schema, $type, extra, 'primary_key');
        return new PrimaryKeyField(name);
    }
}

/**
 *
 */
export class RelationField extends Field {
    fields: Field[];
    fieldsByName: {[name: string]: Field};
    primaryKeyField: PrimaryKeyField;
    nonRelationFields: Field[];
    relationFields: RelationField[];
    parentRelations_: RelationField[]|undefined;
    // Note: holding the PreparedQuery here is creepy - it
    //       is dependent on the DB it was created with FIX XXX.
    //       Maybe we should lean into this and have a DB inst at the top
    //       of the schema?
    insertPreparedStmt_: PreparedQuery|undefined = undefined;
    getByIdPreparedStmt_: PreparedQuery|undefined = undefined;
    fieldNamesIncludingSynthetics_: string[]|undefined = undefined;

    constructor(name: string, fields: Field[]) {
        super(name);
        for(const f of fields) {
            if(f.parent) {
                throw new Error(`field ${f.name} already has a parent`);
            }
            f.parent = this;
        }
        this.fields = fields;

        // --- Compute various field partitions and indexes.
        this.fieldsByName = Object.fromEntries(fields.map(f=>[f.name, f]));
        this.nonRelationFields = this.fields.filter(f=>!(f instanceof RelationField));
        this.relationFields = this.fields.filter(f=>f instanceof RelationField).map(f=>f as RelationField);
        const primaryKeyFields = this.fields.filter(f=>f instanceof PrimaryKeyField).map(f=>f as PrimaryKeyField);
        if(primaryKeyFields.length !==1)
            throw new Error(`each relation must have exactly one primary key field: ${this.name}`);
        this.primaryKeyField = primaryKeyFields[0];

    }

    get parentRelations() {
        // Computed lazily because of dependency on parent.
        if(!this.parentRelations_) {
            const parentRelations = [];
            for(let p=this.parent; p; p=p.parent)
                parentRelations.push(p as RelationField);
            this.parentRelations_ = parentRelations;
        }
        return this.parentRelations_;
    }

    get fieldNamesIncludingSynthetics() {
        // This is computed lazily because it depends on parentRelations.
        if(!this.fieldNamesIncludingSynthetics_) 
            this.fieldNamesIncludingSynthetics_ = [
                ...this.nonRelationFields.map(f=>f.name),
                ...this.parentRelations.map(r=>r.primaryKeyField.name),
                '_order'];
        return this.fieldNamesIncludingSynthetics_;
    }
        
    validate(locus: string, value: Value) {
        if(!value) // XXX treating missing relation value as empty relation, TODO cleanup
            return;
        if (!Array.isArray(value))
            throw new ValidationError(locus, `relations must be arrays`);
        for(const elem of value) {
            this.validateRelationMember(locus, elem);
        }
    }

    validateRelationMember(locus: string, value: Record) {
        const relationLocus = locus + '/' + this.name;
        for(const field of this.fields) {
            const fieldValue = value[field.name];
            field.validate(relationLocus, fieldValue);
        }
        for(const valueFieldName of Object.keys(value)) {
            if(!Object.hasOwn(this.fieldsByName, valueFieldName)) {
                throw new ValidationError(locus, `unknown field '${valueFieldName}' in value for relation '${this.name}'`);
            }
        }
    }

    getByIdPreparedStmt(db:DB): PreparedQuery {
        if(!this.getByIdPreparedStmt_) {
            //let field_names = this.fields
            // Compute field names including 
            this.getByIdPreparedStmt_ = db.prepareQuery(
                `SELECT * FROM ${this.name} WHERE ${this.primaryKeyField.name} = ?`);
        }
        return this.getByIdPreparedStmt_;
    }
    
    // Currently shallow get only - later add deep get.
    getById(db:DB, id:string): Record|undefined {
        const matches = this.getByIdPreparedStmt(db).all([id]);
        if(matches.length > 1)
            throw new Error(`internal error: got more than one result when fetching from ${this.name} table by id ${id} - this should not be possible`);
        if(!matches.length)
            return undefined;
        const match = matches[0];
        if(match.length !== this.fields.length + this.parentRelations.length + 1)
            throw new Error(`internal error: unexpected number of fields when fetching from ${this.name}`);
        return undefined;
    }
    
    getInsertPreparedStmt(db:DB): PreparedQuery {
        if(!this.insertPreparedStmt_) {
            const fieldNames = this.fieldNamesIncludingSynthetics.join(', ');
            const valuePlaceholders = this.fieldNamesIncludingSynthetics.map(f=>'?').join(', ');
            const stmt = `INSERT INTO ${this.name} (${fieldNames}) VALUES (${valuePlaceholders})`;
            this.insertPreparedStmt_ = db.prepareQuery(stmt);
        }
        return this.insertPreparedStmt_;
    }

    insert(db:DB, value: any, parent_pks: {[key: string]: string} = {}) {
        //console.info(parent_pks);

        const fieldValues = [
            ...this.nonRelationFields.map(f=>value[f.name]),
            ...Object.values(parent_pks),
            null]; // order
        this.getInsertPreparedStmt(db).execute(fieldValues);

        const pkName = this.primaryKeyField.name;
        if(Object.hasOwn(parent_pks, pkName))
            throw new Error(`A child relation cannot have the same pk name as a parent relation: ${pkName}`);
        const parentAndSelfPks = Object.assign({}, parent_pks);
        parentAndSelfPks[pkName] = value[pkName];

        // Insert child relations.
        for(const relationField of this.relationFields) {
            const childInsts = value[relationField.name];
            if(childInsts === undefined) // Missing child relations treated as empty.
                continue;
            if(!Array.isArray(childInsts))
                throw new Error('child relation fields must be arrays');
            for(const childInst of childInsts) {
                relationField.insert(db, childInst, parentAndSelfPks);
            }
        }
    }


    /*
      
     */
    updateFrom(db:DB, from: Record, to: Record) {
        
    }
    
    update(db:DB, value: Record) {
        // - Update only requres id of tuple + updated fields.
        // - Cannot update parent ids (or self id)
        // - Later versions will be able to post a whole tree - but do the
        //   local only version.
        // - a layer above this also takes a before value, and computes
        //   changed fields from that, reads the existing record and verifys
        //   before values then calls this update.
    }
    
    /**
     *
     */
    createDbTables(): string[] {
        // Note: field (and thereby also relation) names are restricted
        //       (earlier) to [a-zA-Z][a-zA-Z0-9_]+ so embedding them directly
        //       is this SQL string does not pose a query injection risk.

        const dropTable = `DROP TABLE IF EXISTS ${this.name};\n`

        const userFields = this.nonRelationFields.flatMap(f => f.createDbFields());
        const parentRelationFields = this.parentRelations.map(r => r.primaryKeyField.name+' TEXT');
        const orderFields = ['_order TEXT'];
        const allFields = [...userFields, ...parentRelationFields, ...orderFields];
        
        const createTable =
            `CREATE TABLE ${this.name} (\n  ${allFields.join(',\n  ')}) WITHOUT ROWID;\n`

        const parentIdIndexes = this.parentRelations.map(r=>
            `CREATE INDEX ${this.name}_${r.primaryKeyField.name} ON ${this.name}(${r.primaryKeyField.name})\n`);
        
        const childCreateTables = this.relationFields.flatMap(r => r.createDbTables());
        
        return [dropTable, createTable, ...parentIdIndexes, ...childCreateTables];
    }

    createDbFields(): string[] {
        throw new Error('internal error: createDbFields should not be called on a RelationField');
    }
    
    /**
     * Returns this schema node in it's JSON serialization.
     */
    schemaToCompactJson(): any {
        const json = {} as any; // fix typing
        json.$type = 'relation';
        for(const field of this.fields) {
            json[field.name] = field.schemaToCompactJson();
        }
        return json;
    }
    
    static parseSchemaFromCompactJson(locus: string, name: string, schema: any): RelationField {
        const {$type, ...field_schema} = schema;
        if($type !== 'relation' && $type !== 'subrelation')
            throw new ValidationError(locus, `expected relation or subrelation type`);

        // TODO: locus needs asjusting here
        const fields = Object.entries(field_schema).map(([field_name, field_body]) =>
            parse_field(locus, field_name, field_body));

        return new RelationField(name, fields);
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
        case 'boolean':
            return BooleanField.parseSchemaFromCompactJson(locus, name, schema);
        default:
            throw new ValidationError(locus, `unknown field type ${schema.$type}`);
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
