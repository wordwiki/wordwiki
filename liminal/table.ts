import {Markup} from '../liminal/markup.ts';
import * as strings from '../liminal/strings.ts';
import * as utils from '../liminal/utils.ts';
import {unwrap} from '../liminal/utils.ts';
import {block} from "../liminal/strings.ts";
import {serialize, serializeAny} from "../liminal/serializable.ts";

import { db, Db, PreparedQuery, QueryClosure, RowObject, QueryParameterSet, assertDmlContainsAllFields, boolnum, defaultDbPath } from "../liminal/db.ts";
import * as action from "./action.ts";
import * as security from "./security.ts";

export type Tuple = Record<string, any>;

/**
 *
 * Note: there is not near 
 */
export class Table<T extends Tuple> {
    
    pkField: PrimaryKeyField;
    pkName: string;
    fieldsByName: Record<string, Field>;
    fieldNames: string[];
    allFields: string;
    
    constructor(public name: string, public fields: Field[], public extraDML: string[]=[]) {
        this.pkField = unwrap(
            this.fields.filter(f=>f instanceof PrimaryKeyField)[0],
            'missing primary key field');
        this.pkName = this.pkField.name;
        this.fieldsByName = Object.fromEntries(this.fields.map(field=>[field.name, field]));
        this.fieldNames = Object.keys(this.fieldsByName);
        this.allFields = this.fieldNames.join(',');
    }

    toString(): string {
        return serializeAny(this);
    }
    
    greet() {
        console.info('hello');
        return 7;
    }
    
    // ---------------------------------------------------------------------------
    // --- Default Queries -------------------------------------------------------
    // ---------------------------------------------------------------------------
    
    getById(id: number): T {
        //console.info("getById", id);
        return this.prepare<T, {id: number}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM ${this.name}
/**/          WHERE ${this.pkName} = :id`).required({id});
    }

    // ---------------------------------------------------------------------------
    // --- Field-level read security ---------------------------------------------
    // ---------------------------------------------------------------------------

    // Override per table: the volunteer this record "belongs to" (drives isSelf).
    ownerId(_record: T): number|undefined { return undefined; }

    // View/edit permission for fields that don't declare one.  Permissive by
    // default, so field-level security is opt-in per table (set these + per-field
    // `view`/`edit`).
    defaultFieldView: security.Permission = security.anyone;
    defaultFieldEdit: security.Permission = security.anyone;

    fieldView(field: Field): security.Permission { return field.options.view ?? this.defaultFieldView; }
    fieldEdit(field: Field): security.Permission { return field.options.edit ?? this.defaultFieldEdit; }

    private accessFor(record?: T): security.Access {
        const ctx = security.current() ?? {actorId: undefined, roles: new Set<string>()};
        return {ctx, record, ownerId: record ? this.ownerId(record) : undefined};
    }

    canView(field: Field, record?: T): boolean {
        const ctx = security.current();
        if(!ctx || ctx.system) return true;
        return this.fieldView(field)(this.accessFor(record));
    }

    // edit ⊆ view: you can never edit a field you can't see.
    canEdit(field: Field, record?: T): boolean {
        const ctx = security.current();
        if(!ctx || ctx.system) return true;
        const a = this.accessFor(record);
        return this.fieldView(field)(a) && this.fieldEdit(field)(a);
    }

    // ---------------------------------------------------------------------------
    // --- Record-level edit security ----------------------------------------------
    // ---------------------------------------------------------------------------

    // Row-level edit permission: may this actor edit this record AT ALL?  The
    // field-level checks above refine WHICH fields; this gates WHETHER the record
    // presents an edit affordance (pencil / tap-to-edit) and accepts
    // renderForm/saveForm.  A getter defaulting to defaultFieldEdit, so a table
    // that only declares its field default gets the matching row rule - but
    // security-sensitive tables should declare it explicitly (see VolunteerTable).
    get recordEdit(): security.Permission { return this.defaultFieldEdit; }

    canEditRecord(record: T): boolean {
        const ctx = security.current();
        if(!ctx || ctx.system) return true;
        return this.recordEdit(this.accessFor(record));
    }

    // Prepare a query *tagged with this table*, so its results are checked against
    // the current actor's field-view permissions.  Table-owned queries (getById,
    // the @path query getters) go through here.
    prepare<O extends RowObject={}, P extends QueryParameterSet={}>(sql: string): PreparedQuery<O,P> {
        const pq = db().prepare<O,P>(sql);
        pq.guard = (cols, rows) => this.guardResult(cols, rows as Tuple[]);
        return pq;
    }

    // Throw if any result row carries a column (that is one of this table's fields)
    // the current actor may not view.  No-op outside a request (system context).
    guardResult(columnNames: string[], rows: Tuple[]): void {
        const ctx = security.current();
        if(!ctx || ctx.system) return;
        for(const col of columnNames) {
            const field = this.fieldsByName[col];
            if(!field) continue;                     // computed column etc. - unprotected
            const view = this.fieldView(field);
            if(view === security.anyone) continue;   // fast path: public field
            for(const row of rows) {
                if(!view({ctx, record: row, ownerId: this.ownerId(row as T)})) {
                    // Redactable fields are hidden in place ('***'); others throw
                    // (the accidental-leak backstop).
                    if(field.options.redact)
                        row[col] = security.REDACTED;
                    else
                        throw new security.ReadPermissionError(this.name, col);
                }
            }
        }
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

    // A standard "edit" button for one row: opens the modal editor with this row's
    // edit form.  Same wiring the default TableRenderer row uses, factored so
    // hand-coded views can drop in an edit button without repeating the modal/hx
    // details at every call site.
    editButton(id: number, label: string = 'Edit'): Markup {
        return ['button', editButtonProps(`${this}.renderForm(${this}.getById(${id}))`), label];
    }

    // The icon-only variant of editButton: a ghosted pencil, the standard
    // affordance marker for an editable surface (see editableItemProps).  Still
    // a real <button> (keyboard/screen-reader users get the same path), just
    // quieter than a text button - so it can sit on every editable item without
    // turning the page into a wall of buttons.
    editPencil(id: number): Markup {
        return ['button', {...editButtonProps(`${this}.renderForm(${this}.getById(${id}))`),
                           class: 'edit lm-edit-pencil', type: 'button',
                           'aria-label': 'Edit'},
                pencilIcon()];
    }

    // Title for a record's edit dialog (lifted into the modal's fixed header by
    // showModalEditor, native-edit-sheet style: say WHAT is being edited).
    // Default: the record's 'name' column when the table has a non-empty one,
    // else the table name.  Override per table for better titles.
    formTitle(record: T): string {
        const name = (record as Record<string, unknown>)['name'];
        return `Edit ${typeof name === 'string' && name ? name : this.name}`;
    }

    // Props for a record rendered as a whole-surface-tappable list item: the
    // standard "editable surface" presentation.  Combines:
    //   - reloadableItemProps (an edit save re-renders just this item);
    //   - Bootstrap list-group classes (hover tint on desktop) + .lm-editable
    //     (cursor, pressed tint on touch - styles in resources/liminal.css);
    //   - a click handler that delegates anywhere-on-the-surface clicks to the
    //     item's contained edit/pencil button (lmEditableClick in
    //     resources/liminal-scripts.js declines clicks on inner links/buttons,
    //     text-selection drags, and nested editable surfaces).
    // The item should contain an editPencil(id) - it is both the visible cue
    // that the surface is editable and the delegation target.
    editableItemProps(id: number|undefined, reloadURL: string, extraProps: Record<string, string>={}): Record<string, string> {
        const props = this.reloadableItemProps(id, reloadURL, extraProps);
        props.class = 'list-group-item list-group-item-action lm-item lm-editable ' + props.class;
        props.onclick = 'lmEditableClick(event)';
        return props;
    }
    
    // // ---------------------------------------------------------------------------
    // // --- Table Rendering -------------------------------------------------------
    // // ---------------------------------------------------------------------------

    // /**
    //  * Hook to allow replacing the default table renderer with a subclass.
    //  *
    //  * TODO: add options like whether is editable, or subset of fields.
    //  */
    // tableRenderer(fields: Field[]|undefined = undefined, options: TableRendererOptions={}): TableRenderer<T> {
    //     return new TableRenderer(this, fields ?? this.fields, options);        
    // }
    
    // /**
    //  * INCONSISTENT INSTANTIATION OF TABLE RENDERER XXX XXX A BIT TRICKY.
    //  * RELATED PROBLEM: configuration of table renderer also needs to flow throw to editForm invocation
    //  * in tableRenderer.
    //  * ALSO HAS SECURITY IMPLICATIONS.
    //  * possibly unify into declared on table view/security profiles (perhaps not on fields, but names on tables).
    //  */
    // renderTable(tuples: T[]): Markup {
    //     return this.tableRenderer().renderTable(tuples);
    // }

    // /**
    //  * Convenience function for single row re-render.
    //  */
    // renderRow(row: T): Markup {
    //     return this.tableRenderer().renderRow(row);
    // }
    
    // /**
    //  * Convenience function for single row re-render.
    //  */
    // renderRowById(rowId: number): Markup {
    //     return this.renderRow(this.getById(rowId));
    // }

    // ----------------------------------------------------------------------------
    // --- Default Edit Forms -----------------------------------------------------
    // ----------------------------------------------------------------------------
    
    /**
     * Default rendering of an edit form.
     *
     * Record editing is just an action whose parameters are the row's columns,
     * so it is expressed through the generic renderParamForm (the same machinery
     * a search dialog or any other parameterised action uses).  Two things are
     * record-specific, and are passed as hidden parameters:
     *
     *  - the primary key, so saveForm knows which row to update;
     *  - a 'before-<field>' snapshot of every editable field.  This is our
     *    lock-free edit-conflict protection: parseInput only writes a field whose
     *    submitted value differs from its snapshot, so two editors who change
     *    different fields of the same row do not clobber each other.  Carrying
     *    these as hidden params (rather than emitting them from renderInput) keeps
     *    them out of the non-record param case.
     */
    renderForm(record: T, onsubmit?: string): Markup {
        // Row-level gate (the save side has its own in parseForm): don't even
        // generate an edit form for a record the actor may not edit.
        if(!this.canEditRecord(record))
            throw new Error(`Not permitted to edit this ${this.name}`);

        onsubmit ??= 'tx`'+this+'.saveForm(${getFormJSON(event.target)})`';

        // Only fields the actor may edit become inputs.  Since edit ⊆ view, a
        // field that was redacted in the fetched record (one the actor can't see)
        // is also not editable, so its (sentinel) value never reaches an input or
        // a before-value - it simply isn't in the form, and can't be clobbered.
        const editableFields = this.fields.filter(f => f.isVisible() && this.canEdit(f, record));

        const hidden: Record<string, any> = {};
        const pk = record[this.pkName];
        if(pk !== undefined && pk !== null)
            hidden[this.pkName] = pk;
        for(const f of editableFields)
            hidden['before-'+f.name] = f.toFormValue(record[f.name]);

        // The serialized route path of this table (e.g. 'rabid.event_commitment'),
        // so foreign-key fields can build their remote picker route.  Falls back to
        // undefined (inline option lists) if this table isn't on the dispatch tree.
        let ownerPath: string|undefined;
        try { ownerPath = serializeAny(this); } catch(_e) { ownerPath = undefined; }

        return action.renderParamForm(editableFields, record, {
            title: this.formTitle(record),
            submitLabel: 'Save',
            hidden,
            fieldContext: { ownerPath },
            dispatch: {id: 'edit-form', onsubmit: 'event.preventDefault(); '+onsubmit},
        });
    }

    // Type-ahead option source for a foreign-key field on this table, reachable as
    // a route (e.g. rabid.event_commitment.fieldPickerOptions('volunteer_id',
    // queryArgs)).  We resolve the FK by its declared field name and use the
    // field's own (target table, columns) - trusted server constants - so the
    // client never supplies raw SQL identifiers; only the search term `q` and the
    // (validated) field name come from the request.
    fieldPickerOptions(fieldName: string, args: {q?: string}): Array<{id: any, label: any}> {
        const field = this.fieldsByName[fieldName];
        if(!(field instanceof ForeignKeyField))
            throw new Error(`Field '${fieldName}' on table '${this.name}' is not a foreign key`);
        return field.loadOptions(String(args?.q ?? ''), 50);
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

        // --- Server-side required-field validation.  HTML5 'required' is only a
        //     client-side hint, so we enforce it here as well (a non-browser or
        //     crafted request bypasses the browser check).  A visible required
        //     field is violated when it is being set to an empty value, or - when
        //     inserting a new record (no primary key) - when it is absent entirely.
        //     On update, required fields the user did not change keep their
        //     existing value and so are not checked.
        const isInsert = primaryKey === undefined;
        const isEmptyValue = (v: any) => v === null || v === undefined || v === '';
        const missingRequired = this.fields.filter(field =>
            field.isVisible() && field.isInputRequired() &&
            (field.name in changedFieldValues
                ? isEmptyValue(changedFieldValues[field.name])
                : isInsert));
        if(missingRequired.length > 0)
            throw new Error(`Please provide a value for: ${missingRequired.map(f => f.prompt).join(', ')}`);

        // --- Server-side edit-permission check (write-side counterpart to the
        //     read guard).  renderForm only renders inputs for editable fields, but
        //     a crafted POST could include any field - so reject changed fields the
        //     actor may not edit.  We load the existing record (as a system op, to
        //     get the true owner for isSelf) to evaluate ownership.
        const existing = primaryKey !== undefined
            ? security.runSystem(() => this.getById(primaryKey))
            : undefined;
        // Row-level gate first: a crafted POST against a record the actor may
        // not edit at all fails here, before the per-field refinement.  (The
        // insert path has no existing record to gate - field-level checks and a
        // future recordInsert declaration cover it.)
        if(existing && !this.canEditRecord(existing))
            throw new Error(`Not permitted to edit this ${this.name}`);
        const notEditable = Object.keys(changedFieldValues).filter(name => {
            const field = this.fieldsByName[name];
            return field && !this.canEdit(field, existing);
        });
        if(notEditable.length > 0)
            throw new Error(`Not permitted to edit: ${notEditable.map(n => this.fieldsByName[n].prompt).join(', ')}`);

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

    permissions?: any,

    // Field-level security (see liminal/security.ts).  `view` gates reading the
    // field (enforced at the query layer + render); `edit` gates writing it.
    // Unset falls back to the table's defaults.
    view?: security.Permission,
    edit?: security.Permission,

    // When the actor can't `view` this field: if `redact` is set the value is
    // replaced with the REDACTED sentinel (shown as '***') instead of throwing.
    // Use for fields that may legitimately appear in a list of mixed visibility
    // (e.g. a phone a volunteer chose not to share).
    redact?: boolean,
}

export const PublicViewable = Object.freeze({});

export interface FieldStyle {
    width?: number,
    height?: number,
    cssClasses?: string,
    cssInlineStyle?: string,
}

/**
 * Optional context passed to Field.renderInput by the record editor.  Currently
 * carries the serialized route path of the owning table (e.g.
 * 'rabid.event_commitment'), which a ForeignKeyField uses to build the route its
 * remote type-ahead picker queries.
 */
export interface FieldRenderContext {
    ownerPath?: string,
}

/**
 *
 */
export class Field {
    prompt: string;
    
    constructor(public name: string, public options: FieldOptions) {
        this.prompt = options.prompt ?? strings.capitalize(name.replaceAll('_', ' '));
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

    /**
     * The string form of a stored value as it appears in this field's form input
     * (and, crucially, its matching `before-<name>` hidden snapshot).  Defaults to
     * the value unchanged; fields whose input uses a different representation than
     * the stored value (e.g. DateTimeField's datetime-local) override this so the
     * input value and the before-value match exactly - otherwise the field looks
     * "changed" on every save even when the user didn't touch it.
     */
    toFormValue(value: any): any {
        return value;
    }

    renderInput(value: any, _ctx?: FieldRenderContext): Markup {
        throw new Error(`renderInput not implemented on ${this.constructor.name}`);
    }

    parseInput(form: Record<string, string>, fieldsOut: Tuple) {
        if(form[this.name] !== undefined && form['before-'+this.name] !== undefined
            && form[this.name] !== form['before-'+this.name]) {
            let parsed = this.parseSimpleInput(form[this.name]);
            // A non-nullable field must never become NULL: an empty input falls
            // back to the field's default (e.g. 0 for a numeric `default: 0`).
            // Text fields parse '' to '' (not null), so they keep the empty
            // string and are unaffected by this.
            if(parsed == null && !this.options.nullable && this.options.default !== undefined)
                parsed = this.options.default;
            fieldsOut[this.name] = parsed;
        }
    }

    parseSimpleInput(value: string): any {
        throw new Error(`parseSimpleInput not implemented on ${this.constructor.name}`);
    }

    /**
     * Whether the form input should be marked HTML5 `required`.
     *
     * A field is required only when a value genuinely must be supplied: it is
     * neither nullable (NULL is a meaningful "missing" state) nor has a default
     * (a default - e.g. '' for an optional text field - means the system already
     * supplies a fallback).  Note this is a UX requirement, not a DB-integrity
     * one: an empty text input already submits '' which satisfies TEXT NOT NULL.
     */
    isInputRequired(): boolean {
        return !this.options.nullable && this.options.default === undefined;
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

    render(value: any): Markup {
        return value ? 'Yes' : 'No';
    }

    // Rendered as a Yes/No <select> rather than a checkbox: a checkbox submits
    // nothing when unchecked, which would defeat the before-value change
    // detection (you could never turn a true back to false).  A select always
    // submits its value.  A boolean is effectively a two-value enum.
    renderInput(value: any): Markup {
        const current = value ? '1' : '0';
        return [
            ['div', {'class':'col-12'},
             ['label', {for:'input-'+this.name, class:'form-label'}, this.prompt],
             ['select', {class:'form-control', name:this.name, id:'input-'+this.name},
              ['option', {value:'0', ...(current==='0'?{selected:''}:{})}, 'No'],
              ['option', {value:'1', ...(current==='1'?{selected:''}:{})}, 'Yes'],
             ]
            ] // div
        ];
    }

    parseSimpleInput(value: string): any {
        return (value === '1' || value === 'true') ? 1 : 0;
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
             ['input', Object.assign({type:'text', class:'form-control', name:this.name, id:'input-'+this.name, value: value ?? ''},
                                     this.isInputRequired() ? {required: ''} : {})]
            ] // div
            // Note: the 'before-<name>' snapshot used for edit-conflict detection
            // is supplied by the record editor as a hidden parameter (see
            // Table.renderForm), not emitted here - so it never appears when a
            // field is used as a plain action parameter (e.g. a search box).
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

    // Show the human label for the stored key (e.g. 'moved' -> 'Moved').
    render(value: any): Markup {
        return value == null ? '' : (this.choices[value] ?? value);
    }

    renderInput(value: any): Markup {
        return [
            ['div', {'class':'col-12'},
             ['label', {for:'input-'+this.name, class:'form-label'}, this.prompt],
             ['select', Object.assign({name: this.name, id: `input-${this.name}`, class: 'form-control'},
                                      this.isInputRequired() ? {required: ''} : {}),
              // A blank option for nullable enums so the value can be cleared.
              this.options.nullable
                  ? ['option', {value: '', ...((value==null||value==='')?{selected:''}:{})}, '']
                  : undefined,
              // Choices come from this.choices (key -> label), NOT this.options
              // (which is the FieldOptions bag).
              Object.entries(this.choices).map(([k,v])=>
                  ['option',
                   {value: k, ...(value===k?{selected:''}:{})}, v])
             ]
            ] // div
            // before-<name> snapshot is supplied as a hidden param by the record
            // editor (Table.renderForm), not emitted here.
        ];
    }

    parseSimpleInput(value: string): any {
        // Enum values are stored as TEXT keys; an empty selection clears a
        // nullable enum.
        return value === '' ? null : value;
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
        return [
            ['div', {'class':'col-12'},
             ['label', {for:'input-'+this.name, class:'form-label'}, this.prompt],
             ['input', Object.assign({type:'number', step:'1', class:'form-control', name:this.name, id:'input-'+this.name, value: value ?? ''},
                                     this.isInputRequired() ? {required: ''} : {})]
            ] // div
        ];
    }

    parseSimpleInput(value: string): any {
        return value === '' ? null : utils.parseIntOrError(value);
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
        return [
            ['div', {'class':'col-12'},
             ['label', {for:'input-'+this.name, class:'form-label'}, this.prompt],
             // step="any" allows decimal values in the browser's number input.
             ['input', Object.assign({type:'number', step:'any', class:'form-control', name:this.name, id:'input-'+this.name, value: value ?? ''},
                                     this.isInputRequired() ? {required: ''} : {})]
            ] // div
        ];
    }

    parseSimpleInput(value: string): any {
        if(value === '') return null;
        const n = Number(value);
        if(Number.isNaN(n))
            throw new Error(`Invalid number for field '${this.name}': '${value}'`);
        return n;
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


    render(value: any): Markup {
        // TODO may choose to render with AM/PM or such.
        return value;
    }

    // Stored as SQLite 'YYYY-MM-DD HH:MM:SS'; an <input type=datetime-local>
    // value is 'YYYY-MM-DDTHH:MM:SS' (a 'T' in place of the space).  We convert
    // here so both the input value and its before-<name> snapshot use the input
    // form and thus compare equal when the user hasn't changed the field.
    toFormValue(value: any): any {
        if(value == null || value === '') return '';
        return String(value).replace(' ', 'T');
    }

    renderInput(value: any): Markup {
        return [
            ['div', {'class':'col-12'},
             ['label', {for:'input-'+this.name, class:'form-label'}, this.prompt],
             ['input', Object.assign({type:'datetime-local', step:'1', class:'form-control',
                                      name:this.name, id:'input-'+this.name, value: this.toFormValue(value)},
                                     this.isInputRequired() ? {required: ''} : {})]
            ] // div
            // before-<name> snapshot is supplied as a hidden param by the record
            // editor (Table.renderForm), not emitted here.
        ];
    }

    parseSimpleInput(value: string): any {
        if (!value) return null;

        // Accept the datetime-local form with or without seconds, and normalize
        // back to SQLite 'YYYY-MM-DD HH:MM:SS' (seconds default to 00).
        const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
        if (!match) {
            throw new Error(`Invalid date format. Expected format like "2026-02-19T09:32", got "${value}"`);
        }
        
        const [, year, month, day, hour, minute, second] = match;
        return `${year}-${month}-${day} ${hour}:${minute}:${second ?? '00'}`;
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
    // labelField is the column in the target table to show in the dropdown (e.g.
    // 'name' or 'description').  It defaults to the target's id column, which is
    // only useful as a fallback - real foreign keys should pass a human-readable
    // column.  target_table/target_field_name/labelField are developer-supplied
    // constants (never user input), so it is safe to interpolate them into SQL.
    constructor(name: string, public target_table: string, public target_field_name: string,
                options: FieldOptions = {}, public labelField: string = target_field_name) {
        super(name, options);
    }

    // createDMLCore(): string {
    //     return `FOREIGN KEY(${this.name}) REFERENCES ${this.target_table}(${this.target_field_name})`;
    // }

    // Load selectable (id, label) rows from the target table.  `q` filters by a
    // word-prefix on the label (leading-space trick: matches the term at the
    // start of any word; '' returns everything); results are capped at `limit`.
    // Used for both the inline option list and remote (type-ahead) loading.
    loadOptions(q: string = '', limit: number = 1000): Array<{id: any, label: any}> {
        return db().all<{id: any, label: any}, {q: string, limit: number}>(block`
/**/   SELECT ${this.target_field_name} AS id, ${this.labelField} AS label
/**/          FROM ${this.target_table}
/**/          WHERE :q = '' OR (' ' || ${this.labelField}) LIKE '% ' || :q || '%'
/**/          ORDER BY label
/**/          LIMIT :limit`, {q, limit});
    }

    // The label for a single id - for display, and for the currently-selected
    // option of a remote picker (which doesn't ship the whole option list).
    loadLabel(value: any): any {
        if(value == null) return null;
        const row = db().first<{label: any}>(
            block`SELECT ${this.labelField} AS label FROM ${this.target_table} WHERE ${this.target_field_name} = :id`,
            {id: value});
        return row ? row.label : value;
    }

    render(value: any): Markup {
        // Show the target row's label rather than the raw id.
        const label = this.loadLabel(value);
        return label == null ? '' : label;
    }

    renderInput(value: any, ctx?: FieldRenderContext): Markup {
        const blankOption = this.options.nullable
            ? ['option', {value:'', ...(value==null?{selected:''}:{})}, '']
            : undefined;

        // ts-picker -> enhanced into a filterable Tom Select on the client.
        const selectAttrs: Record<string, any> =
            {name:this.name, id:'input-'+this.name, class:'form-control ts-picker'};

        let optionEls: Markup;
        if(ctx?.ownerPath) {
            // Remote mode: we know the owning table's route path, so ship only the
            // currently-selected option and a data-load-url the client picker
            // queries as the user types - large target tables aren't fully shipped.
            const label = this.loadLabel(value);
            optionEls = value == null ? [] : [['option', {value, selected:''}, label]];
            selectAttrs['data-load-url'] =
                `/${ctx.ownerPath}.fieldPickerOptions('${this.name}',queryArgs)`;
        } else {
            // Fallback: list all options inline (used when there is no route path,
            // e.g. a table not reachable on the dispatch tree).
            optionEls = this.loadOptions().map(o =>
                ['option', {value: o.id, ...(String(value)===String(o.id)?{selected:''}:{})}, o.label]);
        }

        return [
            ['div', {'class':'col-12'},
             ['label', {for:'input-'+this.name, class:'form-label'}, this.prompt],
             ['select', Object.assign(selectAttrs, this.isInputRequired() ? {required: ''} : {}),
              blankOption,
              optionEls
             ]
            ] // div
        ];
    }

    // parseSimpleInput is inherited from IntegerField (foreign keys are integer
    // ids): '' -> null, otherwise parseIntOrError.

    createDMLExtraLines(): string[] {
        //return [`FOREIGN KEY(${this.name}) REFERENCES ${this.target_table}(${this.target_field_name})`];
        return [];
    }
}

// Note: the old TableEditForm class has been folded into Table.renderForm, which
// now builds the edit form through the generic action.renderParamForm (record
// editing being one instance of "an action with a parameter list").

interface TableRendererOptions {
    editable?: boolean,
}

/**
 *
 * - If the configured table renderer is attached somewhere to the dispatch tree, it will
 *   have a URL, and can have methods called on it (and can be part of expressions that
 *   reference multiple things - for example a table and a result query).
 * - but where to put this?
 * - probably hanging off VolunteerTable along with the queries.
 * - constructing a new each time is so theap, that is fine.
 * - expr
 */
export class TableRenderer<T extends Tuple> {

    constructor(public table: Table<T>, public fields: Field[], public options: TableRendererOptions = {}) {
    }

    // TODO Probably add [serialize] impl to serialized depending on table, fields and options being serializable.
    // Works for now because we are setSerialized() on on all our TableRenderers.

    
    toString(): string {
        return serializeAny(this);
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
             ['button', editButtonProps(`${this.table}.renderForm(${this.table}.getById(${rowid}))`), 'EDIT']];

        const rowProps = this.table.reloadableItemProps(rowid, `${this}.renderRowById(${rowid})`);
        return ['tr', rowProps,
                this.fields.map(f=>this.renderFieldCell(f, row[f.name])),
                editRow
               ];
    }

    /**
     * Convenience function for single row re-render.
     */
    renderRowById(rowId: number): Markup {
        return this.renderRow(this.table.getById(rowId));
    }

    renderFieldCell(field: Field, value: any): Markup {
        return ['td', {}, this.renderFieldContent(field, value)];
    }

    renderFieldContent(field: Field, value: any): Markup {
        return renderFieldValue(field, value);
    }
}

// Render a (possibly redacted) field value for display.  A REDACTED value shows a
// muted '***' with a hint - so the viewer knows the data is hidden (not absent)
// and that a host can look it up; otherwise the field's normal render() is used.
// Hand-coded views use this for fields that may be redacted.
export function renderFieldValue(field: Field, value: any): Markup {
    if(security.isRedacted(value))
        return ['span', {class: 'text-muted', title: 'Hidden — ask a host to look this up'}, '***'];
    return field.render(value);
}

export class TableView<T extends Tuple> {
    constructor(public tableRenderer: TableRenderer<T>, public query: QueryClosure<T>) {
    }

    [serialize]() {
        return `new TableView(${this.tableRenderer}, ${this.query}`;
    }

    render() {
        return this.tableRenderer.renderTable(this.query.all());
    }

    /**
     * Convenience function for single row re-render.
     */
    renderRowById(rowId: number): Markup {
        return this.tableRenderer.renderRow(this.tableRenderer.table.getById(rowId));
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

// Props for a record rendered as a plain *navigable* list item - the counterpart
// of editableItemProps for rows the viewer may NOT edit (see Table.canEditRecord).
// The whole row is a link (render it on an 'a' tag) to e.g. the record's detail
// page; pair it with navChevron() so the two row species are self-describing
// (pencil = tap edits, chevron = tap drills in).  Note: an <a> row cannot nest
// other links (invalid HTML), so inner values render as plain text.
// Same htmx page-nav attrs as an app pageLink (assumes the app's page template
// swaps #content - the convention shared by rabid and wordwiki).
export function navigableItemProps(href: string): Record<string, string> {
    return {
        href,
        class: 'list-group-item list-group-item-action lm-item',
        'hx-boost': 'true', 'hx-target': '#content', 'hx-swap': 'innerHTML show:window:top',
    };
}

// The "drills in" marker for a navigable list item (the affordance counterpart
// of the editable surface's pencil).
export function navChevron(): Markup {
    return ['span', {class: 'lm-nav-chevron', 'aria-hidden': 'true'}, '›'];
}

// The pencil glyph used by editPencil (Bootstrap Icons "pencil", MIT).  Inlined
// as markup (rather than an icon font/css dependency) so it renders anywhere
// our markup does, sized by .lm-edit-pencil svg in liminal.css.
export function pencilIcon(): Markup {
    return ['svg', {viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true'},
            ['path', {d: 'M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325'}]];
}
