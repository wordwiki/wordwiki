import {Markup} from '../tabula/markup.ts';
import * as strings from '../tabula/strings.ts';
import * as utils from '../tabula/utils.ts';
import {unwrap} from '../tabula/utils.ts';
import {block} from "../tabula/strings.ts";

import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "../tabula/db.ts";

export type Tuple = Record<string, any>;

/**
 *
 * Note: there is not near 
 */
export class Table<T extends Tuple> {
    
    pkField: PrimaryKeyField;
    pkName: string;
    fieldNames: string[];
    allFields: string;
    url: string;
    
    constructor(public name: string, public fields: Field[], public extraDML: string[]=[]) {
        this.pkField = unwrap(
            this.fields.filter(f=>f instanceof PrimaryKeyField)[0],
            'missing primary key field');
        this.pkName = this.pkField.name;
        this.fieldNames = this.fields.map(field=>field.name);
        this.allFields = this.fieldNames.join(',');
        this.url = `/rabid/${this.name}`;
    }

    greet() {
        console.info('hello');
        return 7;
    }
    
    // ---------------------------------------------------------------------------
    // --- Default Queries -------------------------------------------------------
    // ---------------------------------------------------------------------------
    
    getById(id: number): T {
        console.info("getById", id);
        return db().prepare<T, {id: number}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM ${this.name}
/**/          WHERE ${this.pkName} = :id`).required({id});
    }

    getIdForRow(row: T): number {
        const id = row[this.pkName];
        if(typeof id !== 'number')
            throw new Error(`Failed to get row id for row in ${this.name}`);
        return id;
    }
    
    // ---------------------------------------------------------------------------
    // --- Default Update Methods ------------------------------------------------
    // ---------------------------------------------------------------------------

    insert<P extends Partial<T>>(tuple: P): number {
        return db().insert<P, string>(this.name, tuple, this.pkName);
    }

    update<P extends Partial<T>>(id: number, fields: P) {
        const fieldNames:Array<keyof P> = Object.keys(fields);
        db().update<P>(this.name, this.pkName, fieldNames, id, fields);
    }

    updateNamedFields<P extends Partial<T>>(id: number, fieldNames:Array<keyof P>, fields: P) {
        db().update<P>(this.name, this.pkName, fieldNames, id, fields);
    }

    // ---------------------------------------------------------------------------
    // ---------------------------------------------------------------------------
    // ---------------------------------------------------------------------------
    
    reloadableItemProps(id: number|undefined, reloadURL: string, extraProps: Record<string, string>={}): Record<string, string> {
        return Object.assign({
            'hx-get': reloadURL,
            'hx-trigger':'reload', 'hx-swap': 'outerHTML',
            'class': `-${this.name}-` + (id ? ` -${this.name}-${id}-` : ''),
            //onclick: 'clickContainedButton(event.currentTarget)'},
        },
                             extraProps);
    }
    
    // ---------------------------------------------------------------------------
    // --- Table Rendering -------------------------------------------------------
    // ---------------------------------------------------------------------------

    /**
     * Hook to allow replacing the default table renderer with a subclass.
     *
     * TODO: add options like whether is editable, or subset of fields.
     */
    tableRenderer(): TableRenderer<T> {
        return new TableRenderer(this, this.fields);        
    }
    
    /**
     *
     */
    renderTable(tuples: T[]): Markup {
        return this.tableRenderer().renderTable(tuples);
    }

    /**
     * Convenience function for single row re-render.
     */
    renderRow(row: T): Markup {
        return this.tableRenderer().renderRow(row);
    }
    
    /**
     * Convenience function for single row re-render.
     */
    renderRowById(rowId: number): Markup {
        return this.renderRow(this.getById(rowId));
    }

    // ----------------------------------------------------------------------------
    // --- Default Edit Forms -----------------------------------------------------
    // ----------------------------------------------------------------------------
    
    /**
     * Default rendering of a form.
     *
     * For more customization subclass EditForm and call directly.
     */
    renderForm(record: T, onsubmit?: string): Markup {
        onsubmit ??= 'tx`'+this.url+'.saveForm(${getFormJSON(event.target)})`'
        return new TableEditForm(this, this.fields, onsubmit).render(record);
    }
    
    /**
     * When fields render to a html form each field will contribute one or more named
     * fields to the form, and usually also hidden fields with before values.
     *
     * When we parse fields from a form, this is deparsed back to one typed value per
     * changed field.
     *
     * The results of parseForm will never contain fields that are not in the field list.
     *
     * If there is a primary key, it is returned separately (it never changes, so would
     * not normally be in the result set, but we do need it).
     */
    parseForm(form: Record<string, string>): ParsedForm {
        const changedFieldValues: Tuple = {};
        this.fields.forEach(field=>field.parseInput(form, changedFieldValues));
        const unexpectedFields = Array.from(
            new Set(Object.keys(changedFieldValues)).difference(new Set(this.fields.map(f=>f.name))));
        if(unexpectedFields.length > 0)
            throw new Error(`On form postback, we got unexpected fields ${unexpectedFields.join()}`);

        const primaryKeyValue = form[this.pkName];
        const primaryKey = primaryKeyValue ? utils.parseIntOrError(primaryKeyValue) : undefined;
        
        return { primaryKey, changedFieldValues };
    }

    parseFormWithPrimaryKey(form: Record<string, string>): ParsedFormWithPrimaryKey {
        const {primaryKey, changedFieldValues} = this.parseForm(form);
        if(!primaryKey)
            throw new Error('Missing required primary key');
        return {primaryKey, changedFieldValues};
    }

    saveForm(form: Record<string, string>): Markup {
        const {primaryKey, changedFieldValues} = this.parseFormWithPrimaryKey(form);
        if(primaryKey) {
            this.updateNamedFields(primaryKey, Object.keys(changedFieldValues), changedFieldValues as T);
            return {action:'reload', targets:[`.-${this.name}-${primaryKey}-`]};
        } else {
            console.info('inserting new user', changedFieldValues);
            const newPrimaryKey = this.insert(changedFieldValues as T);
            console.info('new user primary key is', newPrimaryKey);
            return {action:'reload', targets:[`.-${this.name}-`]};
        }
    }

    
    // ----------------------------------------------------------------------------
    // --- Default DML generation from metadata -----------------------------------
    // ----------------------------------------------------------------------------
    
    createDMLString(): string {
        return this.createDML().map(s=>s+'\n').join('');
    }
    
    createDML(): string[] {
        return [this.createTableDML(), ...this.createIndexesDML(), ...this.extraDML, '\n'];
    }
    
    createTableDML(): string {

        const createFieldsDMLStatements =
            this.fields.flatMap(field=>field.createDML());
        
        const createFieldsDML =
            createFieldsDMLStatements.map(s=>'    '+s).join(',\n')+'\n';
        
        return `CREATE TABLE IF NOT EXISTS ${this.name}(\n${createFieldsDML});\n`;
    }

    // TODO this is not done yet!!!
    createIndexesDML(): string[] {
        const createIndexesDMLStatements =
            this.fields.filter(f=>f.options.indexed).flatMap(f=>f.createIndexDML(this.name));
        //return createIndexesDMLStatements.map(s=>s+';\n');
        return [];
    }
}

interface ParsedForm {
    primaryKey: number|undefined,
    changedFieldValues: Tuple,
}

interface ParsedFormWithPrimaryKey {
    primaryKey: number,
    changedFieldValues: Tuple,
}

export interface FieldOptions {
    nullable?: boolean,
    indexed?: boolean;
    unique?: boolean;

    default?: any;
    
    /**
     * Set to indicate that should not be rendered by default
     * in generic data renders (use for things like
     * password_salt/password_hash).
     */
    secret?: boolean,

    style?: FieldStyle,

    prompt?: string,
}

export interface FieldStyle {
    width?: number,
    height?: number,
    cssClasses?: string,
    cssInlineStyle?: string,
}

/**
 *
 */
export class Field {
    prompt: string;
    
    constructor(public name: string, public options: FieldOptions) {
        this.prompt = options.prompt ?? strings.capitalize(name);
    }

    // Returns the SQLite DML to create this field.
    createDML(): string[] {
        return [this.createDMLCore()+this.dmlOptions(), ...this.createDMLExtraLines()];
    }

    dmlOptions(): string {
        return (this.options.default !== undefined ? ' DEFAULT '+JSON.stringify(this.options.default) : '')
            + (this.options.nullable ? '': ' NOT NULL');
    }
    
    // Types that need complicated 'NOT NULL' DML should override
    // createDML() instead.
    createDMLCore(): string {
        return `${this.name} ${this.dmlType()}`;
    }
    
    dmlType(): string {
        throw new Error(`dmlType not implemented on ${this.constructor.name}`);
    }

    createDMLExtraLines(): string[] {
        return [];
    }
    
    createIndexDML(tableName: string): string[] {
        const indexes:string[] = [];
        if(this.options.indexed) {
            indexes.push(`CREATE ${this.options.unique?'UNIQUE ':''}INDEX IF NOT EXISTS ON ${tableName}(${this.name})`);
        }

        return indexes;
    }
    
    render(value: any): Markup {
        return value;
    }
    
    renderInput(value: any): Markup {
        throw new Error(`renderInput not implemented on ${this.constructor.name}`);
    }

    parseInput(form: Record<string, string>, fieldsOut: Tuple) {
        if(form[this.name] !== undefined && form['before-'+this.name] !== undefined
            && form[this.name] !== form['before-'+this.name])
            fieldsOut[this.name] = this.parseSimpleInput(form[this.name]);
    }

    parseSimpleInput(value: string): any {
        throw new Error(`parseSimpleInput not implemented on ${this.constructor.name}`);
    }
    
    // Set for fields that have no user-visible presentation to suppress
    // prompts etc.  Presently used for PrimaryKeyField.
    isVisible(): boolean {
        return true;
    }
}

/**
 *
 */
export class BooleanField extends Field {
    constructor(name: string, options: FieldOptions = {}) {
        super(name, options);
    }

    dmlType(): string {
        return 'INTEGER';
    }
    
    renderInput(value: any): Markup {
        //throw new Error('TODO implement me');
        return "BOOLEAN";
    }
}

/**
 *
 * TODO: consider adding a validation regex.
  * (is supported in browser via the pattern= attr + can do on server)
 */
export class StringField extends Field {
    constructor(name: string, options: FieldOptions = {}) {
        super(name, options);
    }

    dmlType(): string {
        return 'TEXT';
    }
    
    renderInput(value: any): Markup {
        return [
            ['div', {'class':'col-12'},
             ['label', {for:'input-'+this.name, class:'form-label'}, this.prompt],
             ['input', {type:'text', class:'form-control', name:this.name, id:'input-'+this.name,
                        value: value ?? '', required: ''}],
             ['input', {type:'hidden', name:'before-'+this.name, value: value}]
            ] // div
        ];
    }

    parseSimpleInput(value: string): any {
        return value;
    }
}

/**
 *
 */
export class PhoneField extends StringField {
    constructor(name: string, options: FieldOptions = {}) {
        super(name, options);
    }

    render(v: any): Markup {
        return v ? ['a', {href:`tel:${v}`, target:'_blank'}, v] : '';
    }
    
    // renderInput(value: any): Markup {
    //     throw new Error('TODO implement me');
    // }
}

/**
 *
 */
export class EmailField extends StringField {
    constructor(name: string, options: FieldOptions = {}) {
        super(name, options);
    }

    render(v: any): Markup {
        return v ? ['a', {href:`mailto:${v}`, target:'_blank'}, v] : '';
    }
    
    // renderInput(value: any): Markup {
    //     throw new Error('TODO implement me');
    // }
}

/**
 *
 */
export class SecretField extends StringField {
    constructor(name: string, options: FieldOptions = {}) {
        super(name, Object.assign({secret: true}, options));
    }

    render(v: any): Markup {
        return '***';  // no secrets for you!
    }
    
    renderInput(value: any): Markup {
        throw new Error('Attempt to render a form control on a secret field');
    }

    isVisible(): boolean {
        return false;
    }
}

/**
 *
 */
export class EnumField extends Field {
    constructor(name: string, public choices: Record<string, string>, options: FieldOptions = {}) {
        super(name, options);
    }

    dmlType(): string {
        return 'TEXT';
    }
    
    renderInput(value: any): Markup {
        return [
            ['div', {'class':'col-12'},
             ['label', {for:'input-'+this.name, class:'form-label'}, this.prompt],
             //['input', {type:'text', class:'form-control', name:this.name, id:'input-'+this.name,
             //           value: value ?? '', required: ''}],
             ['select', {type: 'text', placeholder: this.prompt,
                         id: `input-${this.name}`,
                         class: 'form-control'},
              Object.entries(this.options).map(([k,v])=>
                  ['option',
                   {value: k, ...(value===k?{selected:''}:{})}, v])
             ],
             ['input', {type:'hidden', name:'before-'+this.name, value: value}]
            ] // div
        ];
    }
}

/**
 *
 */
export class IntegerField extends Field {
    constructor(name: string, options: FieldOptions = {}) {
        super(name, options);
    }

    dmlType(): string {
        return 'INTEGER';
    }
    
    renderInput(value: any): Markup {
        throw new Error('TODO implement me');
    }
}

/**
 *
 */
export class FloatingPointField extends Field {
    constructor(name: string, options: FieldOptions = {}) {
        super(name, options);
    }

    dmlType(): string {
        return 'REAL';
    }
    
    renderInput(value: any): Markup {
        throw new Error('TODO implement me');
    }
}

/**
 *
 */
export class DateTimeField extends Field {
    constructor(name: string, options: FieldOptions = {}) {
        super(name, options);
    }

    dmlType(): string {
        return 'TEXT';
    }

    // BAD RENDERING
    renderInput(value: any): Markup {
        return [
            ['div', {'class':'col-12'},
             ['label', {for:'input-'+this.name, class:'form-label'}, this.prompt],
             ['input', {type:'text', class:'form-control', name:this.name, id:'input-'+this.name,
                        value: value ?? '', required: ''}],
             ['input', {type:'hidden', name:'before-'+this.name, value: value}]
            ] // div
        ];
    }
}

/**
 *
 */
export class PrimaryKeyField extends IntegerField {
    constructor(name: string, options: FieldOptions = {}) {
        super(name, options);
    }

    createDMLCore(): string {
        return `${this.name} INTEGER PRIMARY KEY ASC`;
    }

    renderInput(value: any): Markup {
        // Note: an 'undefined' primary key is represented as a lack of the hidden field.
        return [
            value ? ['input', {type:'hidden', name:this.name, id:'input-'+this.name,
                               value:value??''}]: []];
    }

    isVisible(): boolean {
        return false;
    }
}

/**
 *
 *
 */
export class ForeignKeyField extends IntegerField {
    constructor(name: string, public target_table: string, public target_field_name: string, options: FieldOptions = {}) {
        super(name, options);
    }

    // createDMLCore(): string {
    //     return `FOREIGN KEY(${this.name}) REFERENCES ${this.target_table}(${this.target_field_name})`;
    // }
    
    renderInput(value: any): Markup {
        throw new Error('TODO implement me');
    }

    createDMLExtraLines(): string[] {
        //return [`FOREIGN KEY(${this.name}) REFERENCES ${this.target_table}(${this.target_field_name})`];
        return [];
    }
}


/**
 * Generic form rendering.
 * 
 * Slightly customizable though overriding, but the intent is that
 * we will use hand-written forms for complex cases.
 */
export class TableEditForm<T extends Tuple> {

    constructor(public table: Table<T>, public fields: Array<Field>, public onsubmit: string) {
    }

    render(record: Tuple): Markup {
        return (
            ['form', {class:'row g-3',
                      id: 'edit-form',
                      onsubmit: 'event.preventDefault(); '+this.onsubmit},

             // --- Render fields
             this.fields.map(field=>[
                 this.renderInput(field, record[field.name])
             ]),

             // -- Save Button
             ['div', {class:'col-12'},
              ['button', {type:'submit', class:'btn btn-primary'}, 'Save']],
             
            ] // form
        );
    }

    // Override point for subclasses of EditForm that want to
    // do custom rendering for one field etc.
    renderInput(field: Field, value: any): Markup {
        return field.renderInput(value);
    }
}

/**
 *
 */
export class TableRenderer<T extends Tuple> {

    constructor(public table: Table<T>, public fields: Field[], public editable:boolean=true) {
        // TODO change so can nicely specify subset of fields to render.
    }

    renderTable(rows: Array<T>): Markup {
        return [
            ['table', {'class': 'table'},
             ['tbody', {},
              this.renderHeaderRow(),
              this.renderRows(rows),
             ] // tbody
            ] // table
        ];
    }

    
    renderRows(rows: Array<T>): Markup {
        return rows.map(row=>this.renderRow(row));
    }
    
    renderHeaderRow(): Markup {
        return ['tr', {}, this.fields.map(f=>this.renderHeaderCell(f))];
    }

    renderHeaderCell(field: Field): Markup {
        return ['th', {}, this.renderHeaderContent(field)];
    }

    renderHeaderContent(field: Field): Markup {
        return field.prompt;
    }

    renderRow(row: T): Markup {
        const rowid = this.table.getIdForRow(row);

        const editRow = 
            ['td', {},
             ['button', editButtonProps(`${this.table.url}.renderForm(${this.table.name}.getById(${rowid}))`), 'EDIT']];

        const rowProps = this.table.reloadableItemProps(rowid, `${this.table.url}.renderRowById(${rowid})`);
        return ['tr', rowProps,
                this.fields.map(f=>this.renderFieldCell(f, row[f.name])),
                editRow
               ];
    }

    renderFieldCell(field: Field, value: any): Markup {
        return ['td', {}, this.renderFieldContent(field, value)];
    }

    renderFieldContent(field: Field, value: any): Markup {
        return field.render(value);
    }
}

// -------------------------------------------------------------------------------
// --- Form Rendering convenience functions --------------------------------------
// -------------------------------------------------------------------------------

export function reloadableItemProps(type: string, id: number|undefined, reloadURL: string, extraProps: Record<string, string>={}): Record<string, string> {
    return Object.assign({
        'hx-get': reloadURL,
        'hx-trigger':'reload', 'hx-swap': 'outerHTML',
        'class': `-${type}-` + (id ? ` -${type}-${id}-` : ''),
        //onclick: 'clickContainedButton(event.currentTarget)'},
    },
                         extraProps);
}

export function editButtonProps(editFormURL: string): Record<string, string> {
    return {
        'class': 'edit',
        'hx-trigger':'click',
        'hx-get': editFormURL,
        'hx-target': '#modalEditorBody',
        'hx-swap': 'innerHTML',
        'hx-on::after-request': "showModalEditor()"
    };
}
