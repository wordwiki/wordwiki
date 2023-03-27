import {CustomError} from "../utils/errors.ts";
import {typeof_extended} from "../utils/utils.ts";
import { DB, PreparedQuery, QueryParameter, QueryParameterSet } from "https://deno.land/x/sqlite/mod.ts";
import XRegExp from  'https://deno.land/x/xregexp/src/index.js';

/**
 * A field in a record.  subclassed by field type, including subrelation fields.
 */
export abstract class Field {
    parent: Field|undefined = undefined;
    
    constructor(public name: string) {
        if(!XRegExp.cache(`^[a-zA-Z][a-zA-Z0-9_]+`).test(name)) {
            throw new Error(`invalid field names '${name}' - field names must start with a letter, then be followed by letters, numbers and _`);
        }
    }
    
    abstract validate(locus: string, data: any): void;

    abstract schema_to_json(): any;

    abstract create_db_fields(): string[];
}

/**
 *
 */
export abstract class ScalarField extends Field {
    constructor(name: string, public optional: boolean) {
        super(name);
        this.optional = optional;
    }

    abstract json_value_typename(): string;
    abstract schema_typename(): string;
    abstract sql_typename(): string;

    /**
     * Validate a value against this schema node.
     *
     * If the value does not validate, throws a ValidationError
     */
    validate(locus: string, value: any) {
        if(value == null || value == undefined) {
            if(this.optional)
                return;
            else
                throw new ValidationError(locus, `missing required value for field: ${this.name}`);
        } else {
            return this.validate_required(locus, value);
        }
    }

    /**
     *
     */
    validate_required(locus: string, value: any) {
        let expected_typename = this.json_value_typename();
        let actual_typename = typeof_extended(value);
        if (actual_typename != expected_typename)
            throw new ValidationError(locus, `expected ${expected_typename} value - got value ${value} with type ${actual_typename}`);
    }

    /**
     * Returns this schema node in it's JSON serialization.
     */
    schema_to_json(): any {
        return this.build_schema_to_json(this.schema_typename(), null);
    }

    /**
     * Factoring of the common parts of the schema_to_json() method
     * to make per-type field implementations less bulky.
     */
    build_schema_to_json(typ: string, extra_fields: any): any {
        let json = { $type: this.schema_typename() } as any; // XXX fix typing
        if (this.optional)
            json.$optional = true;
        if (extra_fields)
            Object.assign(json, extra_fields)
        return json;
    }

    create_db_fields(): string[] {
        return [`${this.name} ${this.sql_typename()}${this.optional?'':' NOT NULL'}`];
    }
    
}

/**
 *
 */
export class StringField extends ScalarField {
    constructor(name: string, optional: boolean) {
        super(name, optional);
    }

    json_value_typename(): string { return 'string'; }
    schema_typename(): string { return 'string'; }
    sql_typename(): string { return 'TEXT'; }

    static parse_schema(locus: string, name: string, schema: any): StringField {
        
        const {$type, optional, ...field_schema} = schema;
        if($type !== 'string')
            throw new ValidationError(locus, `expected string type`);
        return new StringField(name, !!optional);
    }
}

/**
 *
 */
export class BooleanField extends ScalarField {
    constructor(name: string, optional: boolean) {
        super(name, optional);
    }

    json_value_typename(): string { return 'boolean'; }
    schema_typename(): string { return 'boolean'; }
    sql_typename(): string { return 'INTEGER'; } // sqlite has no bool type
    
    static parse_schema(locus: string, name: string, schema: any): BooleanField {
        // TODO: clean and refactor
        const {$type, optional, ...field_schema} = schema;
        if($type !== 'boolean')
            throw new ValidationError(locus, `expected boolean type`);
        return new BooleanField(name, !!optional);
    }
}

/**
 *
 */
export class IdField extends ScalarField {
    constructor(name: string) {
        super(name, false);
    }

    json_value_typename(): string { return 'string'; }
    schema_typename(): string { return 'id'; }
    sql_typename(): string { return 'TEXT'; }

    static parse_schema(locus: string, name: string, schema: any): StringField {
        const {$type, ...field_schema} = schema;
        if($type !== 'id')
            throw new ValidationError(locus, `expected id type`);
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

    static parse_schema(locus: string, name: string, schema: any): StringField {
        const {$type, ...field_schema} = schema;
        if($type !== 'primary_key')
            throw new ValidationError(locus, `expected id type`);
        return new PrimaryKeyField(name);
    }

    create_db_fields(): string[] {
        return [`${this.name} TEXT NOT NULL PRIMARY KEY`];
    }
}

export class RelationField extends Field {
    fields: Field[];
    fields_by_name: {[name: string]: Field};
    primary_key_field: PrimaryKeyField;
    non_relation_fields: Field[];
    relation_fields: RelationField[];
    parent_relations_: RelationField[]|undefined;
    insert_prepared_stmt_: PreparedQuery|undefined = undefined;

    constructor(name: string, fields: Field[]) {
        super(name);
        for(let f of fields) {
            if(f.parent) {
                throw new Error(`field ${f.name} already has a parent`);
            }
            f.parent = this;
        }
        this.fields = fields;

        // --- Compute various field partitions and indexes.
        this.fields_by_name = Object.fromEntries(fields.map(f=>[f.name, f]));
        this.non_relation_fields = this.fields.filter(f=>!(f instanceof RelationField));
        this.relation_fields = this.fields.filter(f=>f instanceof RelationField).map(f=>f as RelationField);
        let primary_key_fields = this.fields.filter(f=>f instanceof PrimaryKeyField).map(f=>f as PrimaryKeyField);
        if(primary_key_fields.length !==1)
            throw new Error(`each relation must have exactly one primary key field: ${this.name}`);
        this.primary_key_field = primary_key_fields[0];
        
    }

    get_parent_relations() {
        if(!this.parent_relations_) {
            let parent_relations = [];
            for(let p=this.parent; p; p=p.parent)
                parent_relations.push(p as RelationField);
            this.parent_relations_ = parent_relations;
        }
        return this.parent_relations_;
    }
    
    validate(locus: string, value: any) {
        if(!value) // XXX treating missing relation value as empty relation, TODO cleanup
            return;
        if (!Array.isArray(value))
            throw new ValidationError(locus, `relations must be arrays`);
        for(let elem of value) {
            this.validate_relation_member(locus, elem);
        }
    }

    validate_relation_member(locus: string, value: any) {
        const relation_locus = locus + '/' + this.name;
        for(const field of this.fields) {
            const field_value = value[field.name];
            field.validate(relation_locus, field_value);
        }
        for(const value_field_name of Object.keys(value)) {
            if(!Object.hasOwn(this.fields_by_name, value_field_name)) {
                throw new ValidationError(locus, `unknown field '${value_field_name}' in value for relation '${this.name}'`);
            }
        }
    }

    get_insert_prepared_stmt(db:DB): PreparedQuery {
        if(!this.insert_prepared_stmt_) {
            const stmt = `INSERT INTO ${this.name} (${
this.non_relation_fields.map(f=>f.name+', ').join('')
} ${
this.get_parent_relations().map(f=>f.primary_key_field.name+', ').join('')
} _position) VALUES (${
this.non_relation_fields.map(f=>'?, ').join('')
} ${
this.get_parent_relations().map(f=>'?, ').join('')
} ?)`;
            //console.info('stmt', stmt);
            this.insert_prepared_stmt_ = db.prepareQuery(stmt);
        }
        return this.insert_prepared_stmt_;
    }
    
    insert(db:DB, value: any, parent_pks: {[key: string]: string} = {}) {
        //console.info(parent_pks);

        let field_values = this.non_relation_fields.map(f=>value[f.name]);
        //console.info('insert into table', this.name, 'field_values', field_values);
        field_values.push(...Object.values(parent_pks));
        field_values.push(null);  // order
        this.get_insert_prepared_stmt(db).execute(field_values);

        let pk_name = this.primary_key_field.name;
        if(Object.hasOwn(parent_pks, pk_name))
            throw new Error(`A child relation cannot have the same pk name as a parent relation: ${pk_name}`);
        let parent_and_self_pks = Object.assign({}, parent_pks);
        parent_and_self_pks[pk_name] = value[pk_name];

        // Insert child relations.
        for(let relation_field of this.relation_fields) {
            let child_insts = value[relation_field.name];
            if(child_insts === undefined) // Missing child relations treated as empty.
                continue;
            if(!Array.isArray(child_insts))
                throw new Error('child relation fields must be arrays');
            for(let child_inst of child_insts) {
                relation_field.insert(db, child_inst, parent_and_self_pks);
            }
        }
    }
    
    /**
     *
     */
    create_db_tables(): string[] {
        // Note: field (and thereby also relation) names are restricted
        //       (earlier) to [a-zA-Z][a-zA-Z0-9_]+ so embedding them directly
        //       is this SQL string does not pose a query injection risk.

        let drop_table = `DROP TABLE IF EXISTS ${this.name};\n`
        
        let create_table = `CREATE TABLE ${this.name} (\n  ${
this.non_relation_fields.flatMap(f => f.create_db_fields()).join(',\n  ')},\n${
this.get_parent_relations().map(r => '  '+r.primary_key_field.name+' TEXT,\n').join('')
}  _position TEXT
) WITHOUT ROWID;\n`

        let parent_id_indexes = this.get_parent_relations().map(r=>`CREATE INDEX ${this.name}_${r.primary_key_field.name} ON ${this.name}(${r.primary_key_field.name})\n`);
        
        let child_create_tables = this.relation_fields.flatMap(r => r.create_db_tables());
        
        return [drop_table, create_table, parent_id_indexes, child_create_tables].flat();
    }

    create_db_fields(): string[] {
        throw new Error('internal error: create_db_fields should not be called on a RelationField');
    }
    
    /**
     * Returns this schema node in it's JSON serialization.
     */
    schema_to_json(): any {
        let json = {} as any; // fix typing
        json.$type = 'relation';
        for(const field of this.fields) {
            json[field.name] = field.schema_to_json();
        }
        return json;
    }
    
    static parse_schema(locus: string, name: string, schema: any): RelationField {
        const {$type, ...field_schema} = schema;
        if($type !== 'relation' && $type !== 'subrelation')
            throw new ValidationError(locus, `expected relation or subrelation type`);
        let fields: Field[] = [];
        //console.info("field_schema", typeof field_schema, field_schema, field_schema.part_of_speech);
        
        for(const field_name of Object.getOwnPropertyNames(field_schema)) {
            const field_body = field_schema[field_name];
            // TODO: locus is wrong here.
            fields.push(parse_field(locus, field_name, field_body));
        }

        return new RelationField(name, fields);
    }
}

export function parse_field(locus: string, name: string, schema: any): Field {
    const typ = schema.$type;
    switch(typ) {
        case 'relation':
            return RelationField.parse_schema(locus, name, schema);
        case 'id':
            return IdField.parse_schema(locus, name, schema);
        case 'primary_key':
            return PrimaryKeyField.parse_schema(locus, name, schema);
        case 'string':
            return StringField.parse_schema(locus, name, schema);
        case 'boolean':
            return BooleanField.parse_schema(locus, name, schema);
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
