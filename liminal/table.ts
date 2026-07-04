import {Markup} from '../liminal/markup.ts';
import {markdownToMarkup} from './markdown.ts';
import * as strings from '../liminal/strings.ts';
import * as utils from '../liminal/utils.ts';
import {unwrap} from '../liminal/utils.ts';
import {block} from "../liminal/strings.ts";
import {serialize, serializeAny} from "../liminal/serializable.ts";

import { db, Db, PreparedQuery, QueryClosure, RowObject, QueryParameterSet, assertDmlContainsAllFields, boolnum, defaultDbPath } from "../liminal/db.ts";
import * as action from "./action.ts";
import * as dirty from "./dirty.ts";
import * as security from "./security.ts";
import {route, routeMutation, authenticated} from "./security.ts";
import * as date from "./date.ts";
import * as timestamp from "./timestamp.ts";

export type Tuple = Record<string, any>;

/**
 * An ordered set of named Fields: the schema of one record-shaped value,
 * independent of any database table.  Table layers persistence (DML, queries,
 * field security) on top; FieldSet alone describes PAGE-QUERY objects - a
 * page's filter/paging state carried as one {}-literal argument in its route
 * expression (e.g. wordwiki.changes({to_time:..., restrict_to_user:'djz'})),
 * so the page is a pure function of its URL: bookmarkable, refreshable,
 * shareable.  The same Fields that describe the value also GENERATE its edit
 * dialog (action.renderParamForm) - one schema mechanism for both.
 *
 * A FieldSet is deliberately a codec for exactly ONE {} value - it knows
 * nothing about routes or URLs.  Callers compose the rendered literal into
 * route expressions themselves (`${R}.page(${fs.literal(q)})`), the same way
 * every other route argument is composed; a page can carry several
 * independently-parameterized sections, each with its own FieldSet and its
 * own {} argument.
 *
 * The full page-state pattern (this codec + the auto-generated filter
 * dialog + navigation-vs-replacement + anchor stamping) is documented in
 * liminal/page-state.md; worked examples in wordwiki/change-feed.ts and
 * wordwiki/activity-report.ts.
 */
export class FieldSet {

    fieldsByName: Record<string, Field>;
    fieldNames: string[];
    allFields: string;

    constructor(public name: string, public fields: Field[]) {
        this.fieldsByName = Object.fromEntries(this.fields.map(field=>[field.name, field]));
        this.fieldNames = Object.keys(this.fieldsByName);
        this.allFields = this.fieldNames.join(',');
    }

    /**
     * Parse a form postback into the CHANGED field values: each field writes
     * itself only when its submitted value differs from its 'before-<name>'
     * snapshot (the lock-free edit-conflict protection - see Table.renderForm).
     * The record-edit parse; a query dialog wants parseFormValues instead.
     */
    parseFormChanges(form: Record<string, string>): Tuple {
        const changedFieldValues: Tuple = {};
        this.fields.forEach(field=>field.parseInput(form, changedFieldValues));
        const unexpectedFields = Array.from(
            new Set(Object.keys(changedFieldValues)).difference(new Set(this.fields.map(f=>f.name))));
        if(unexpectedFields.length > 0)
            throw new Error(`On form postback, we got unexpected fields ${unexpectedFields.join()}`);
        return changedFieldValues;
    }

    /**
     * Parse a form postback as one COMPLETE value: every field's posted input,
     * with absent/empty falling back to the field's default (or null).  The
     * query-dialog parse - a record edit writes only what changed, but a query
     * dialog's submitted state IS the new value.
     */
    parseFormValues(form: Record<string, any>): Tuple {
        const out: Tuple = {};
        for(const f of this.fields) {
            const raw = form[f.name];
            out[f.name] = (raw === undefined || raw === null || raw === '')
                ? (f.options.default ?? null)
                : f.parseSimpleInput(String(raw));
        }
        return out;
    }

    /**
     * Normalize one {}-literal value as evaluated from a route expression:
     * unknown keys are rejected, each present value is type-checked/coerced by
     * its field (fromLiteral), and absent/null fields take the field's default
     * (or null).  Route arguments are user-typeable, so this is the guard.
     */
    normalize(q: Record<string, any> | undefined | null): Tuple {
        const src = q ?? {};
        if(typeof src !== 'object' || Array.isArray(src))
            throw new Error(`${this.name}: expected a {} argument`);
        const unknown = Object.keys(src).filter(k => !(k in this.fieldsByName));
        if(unknown.length > 0)
            throw new Error(`${this.name}: unknown fields ${unknown.join(', ')}`);
        const out: Tuple = {};
        for(const f of this.fields) {
            const v = src[f.name];
            out[f.name] = (v === undefined || v === null)
                ? (f.options.default ?? null)
                : f.fromLiteral(v);
        }
        return out;
    }

    /**
     * Render one value as a canonical {}-literal route-expression argument:
     * declaration order, null and default-valued fields omitted (so the common
     * views get the shortest - and equal views equal - URLs), strings quoted
     * for the route grammar.  The inverse of normalize.
     */
    literal(q: Tuple): string {
        const parts: string[] = [];
        for(const f of this.fields) {
            const v = q[f.name];
            if(v === undefined || v === null) continue;
            if(f.options.default !== undefined && v === f.options.default) continue;
            parts.push(`${f.name}:${literalValue(v)}`);
        }
        return `{${parts.join(',')}}`;
    }
}

/** One primitive as a route-expression literal.  JSON string quoting is a
 *  subset of the route grammar (acorn), so strings just JSON-encode. */
function literalValue(v: any): string {
    switch(typeof v) {
        case 'number':
            if(!Number.isFinite(v)) throw new Error(`non-finite number in route literal`);
            return String(v);
        case 'boolean': return String(v);
        case 'string': return JSON.stringify(v);
        default: throw new Error(`cannot render a ${typeof v} as a route literal`);
    }
}

/**
 *
 * Note: there is not near
 */
export class Table<T extends Tuple> extends FieldSet {

    pkField: PrimaryKeyField;
    pkName: string;

    constructor(name: string, fields: Field[], public extraDML: string[]=[]) {
        super(name, fields);
        this.pkField = unwrap(
            this.fields.filter(f=>f instanceof PrimaryKeyField)[0],
            'missing primary key field');
        this.pkName = this.pkField.name;
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
    
    @route(authenticated)
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

    // Every write funnels its dirty-key emission through dirtyKeysFor +
    // dirty.record (see the Dependency keys section below and dirty.ts).
    // Emission is gated on an installed collector, so scripts / seeding /
    // direct table calls in tests pay nothing (not even the before-row read).

    insert<P extends Partial<T>>(tuple: P): number {
        const id = db().insert<P, string>(this.name, tuple, this.pkName);
        if(dirty.isCollecting())
            dirty.record(this.dirtyKeysFor('insert', id, undefined, tuple as Record<string, unknown>));
        return id;
    }

    update<P extends Partial<T>>(id: number, fields: P) {
        // Delegates so updateNamedFields is the single update funnel (both
        // for subclass override chains and for dirty-key emission).
        this.updateNamedFields(id, Object.keys(fields) as Array<keyof P>, fields);
    }

    updateNamedFields<P extends Partial<T>>(id: number, fieldNames:Array<keyof P>, fields: P) {
        if(dirty.isCollecting() && fieldNames.length > 0) {
            // The row's current fk values name the parents whose lists this
            // row is in; changed fk values additionally name the parent the
            // row is joining.  Read pre-write, unguarded (emission needs the
            // true values; a raw read skips the field-permission guard and,
            // unlike getById, doesn't throw on a nonexistent id - db().update
            // silently no-ops there and so do we).
            const before = this.rawRowById(id);
            if(before !== undefined) {
                const changed: Record<string, unknown> = {};
                for(const n of fieldNames) changed[String(n)] = (fields as Tuple)[String(n)];
                dirty.record(this.dirtyKeysFor('update', id, before, changed));
            }
        }
        db().update<P>(this.name, this.pkName, fieldNames, id, fields);
    }

    /**
     * Delete one row by pk, with automatic dirty-key emission (the before-row
     * names the parents whose lists lose a member).  Deliberately NOT @route'd
     * - strict routeterp keeps it unreachable as a URL; deletion routes are
     * declared per table with their own permission checks and call this.
     */
    delete(id: number): void {
        const before = dirty.isCollecting() ? this.rawRowById(id) : undefined;
        db().execute(`DELETE FROM ${this.name} WHERE ${this.pkName} = :id`, {id});
        if(before !== undefined)
            dirty.record(this.dirtyKeysFor('delete', id, before, undefined));
    }

    // The row as stored, WITHOUT the field-permission guard (Table.prepare's
    // guardResult) - for internal use where true column values are needed
    // (dirty-key emission).  undefined when the row doesn't exist.
    protected rawRowById(id: number): Record<string, unknown>|undefined {
        return db().first<Record<string, unknown>>(
            `SELECT ${this.allFields} FROM ${this.name} WHERE ${this.pkName} = :id`, {id});
    }

    // ---------------------------------------------------------------------------
    // ---------------------------------------------------------------------------
    // ---------------------------------------------------------------------------
    
    // ------------------------------------------------------------------------
    // --- Dependency keys ----------------------------------------------------
    // ------------------------------------------------------------------------
    //
    // The dependency-key vocabulary: the classes fragments REGISTER under and
    // the keys mutations NOTIFY on (class form; '.'+key - see sel() - is the
    // selector/target form):
    //
    //   -table-                     whole table - any subset that is not a pk
    //                               or single-fk select (whole renders,
    //                               aggregates)
    //   -table-<pk>-                one row
    //   -table-<fkname>-<v>-        the rows WHERE fkname = v (a nested list)
    //   -table-<fkname>-<v>-shape-  the SHAPE of that subset - membership and
    //                               order only, not member content
    //   -table-shape-               the whole table's shape
    //
    // Registration rule: a fragment registers the FINEST key(s) sufficient
    // for what it renders, and only on pages whose own buttons can change the
    // data (this machinery reflects a page's own edits back into the page -
    // it is not a live-update system; see reloadableProps).  A DELEGATING
    // list wrapper - one whose member rows are themselves nested
    // self-refreshing fragments - registers the SHAPE key instead of the
    // content key, so member-content edits refresh only the member's own
    // fragment.  (A list ORDERED BY member content - e.g. name - has shape
    // that depends on content: shape-keying it needs the order column
    // declared in shapeFields, which wins little; leave those content-keyed.)
    // Emission rule: every write notifies ALL levels (dirtyKeysFor) - readers
    // control their refresh cost by registering precisely, writers just tell
    // the truth.  Keys are opaque strings everywhere but here; hand-minted
    // keys (e.g. polymorphic owners) remain legal.

    tableKey(): string { return `-${this.name}-`; }

    rowKey(id: number): string { return `-${this.name}-${id}-`; }

    /** Key for the subset WHERE fkName = v.  fkName must be a declared
     *  ForeignKeyField on this table, so a typo throws at render time instead
     *  of minting a key that nothing will ever notify. */
    fkKey(fkName: string, v: number): string {
        const field = this.fieldsByName[fkName];
        if(!(field instanceof ForeignKeyField))
            throw new Error(`Field '${fkName}' on table '${this.name}' is not a declared foreign key`);
        return `-${this.name}-${fkName}-${v}-`;
    }

    /** Shape key for the subset WHERE fkName = v: notified only when the
     *  subset's membership or order may have changed (insert, delete, the fk
     *  value changing, or a shapeFields column changing) - NOT on member-
     *  content edits.  Registered by delegating list wrappers. */
    shapeKey(fkName: string, v: number): string {
        return this.fkKey(fkName, v) + 'shape-';
    }

    /** The whole table's shape key (see shapeKey). */
    tableShapeKey(): string { return `-${this.name}-shape-`; }

    /**
     * The columns whose change means a subset's SHAPE (membership/order)
     * changed, beyond the always-shape events (insert / delete / fk change):
     * by convention the framework's ordering column and the soft-delete flag,
     * where declared.  Override where a table's list queries order or filter
     * membership by something else.
     */
    get shapeFields(): string[] {
        return ['order_key', 'deleted'].filter(c => c in this.fieldsByName);
    }

    /**
     * The dirty keys (SELECTOR form) a write to row `pk` notifies.  Content
     * keys: the whole-table key, the row key, and one fk key per declared
     * foreign key - from the before-row's values always (the parents whose
     * subsets contain this row), plus from `changedFields` (the parent a row
     * joins when an fk changes).  Shape keys per the emission rules: inserts
     * and deletes always change shape; an update changes shape when it moves
     * the row between fk subsets (old AND new value's shape keys) or touches
     * a shapeFields column (all before-fk shape keys + the table shape key).
     * `kind` 'all' is the speculation superset (speculatedSaveTargets):
     * every key the write COULD emit, derivable from the record at render
     * time - over-speculation is free, the hybrid protocol only renders
     * sections for keys actually emitted.
     *
     * Shared by the automatic DML emission (insert / updateNamedFields /
     * delete) and the edit form's speculation defaults - one source of truth
     * for what a write says.
     */
    dirtyKeysFor(kind: 'insert'|'update'|'delete'|'all',
                 pk: number|undefined,
                 beforeRow: Record<string, unknown>|undefined,
                 changedFields: Record<string, unknown>|undefined): string[] {
        const keys = [sel(this.tableKey())];
        const add = (key: string) => { if(!keys.includes(key)) keys.push(key); };
        // fk values are integers; tolerate numeric strings (form-ish sources)
        // and skip null/undefined/empty.
        const fkVal = (src: Record<string, unknown>|undefined, name: string): number|string|undefined => {
            const v = src?.[name];
            return (typeof v === 'number' || (typeof v === 'string' && v !== '')) ? v : undefined;
        };

        if(pk !== undefined && pk !== null)
            keys.push(sel(this.rowKey(pk)));

        // --- Content fk keys (all subsets containing / receiving the row).
        for(const f of this.fields) {
            if(!(f instanceof ForeignKeyField)) continue;
            for(const src of [beforeRow, changedFields]) {
                const v = fkVal(src, f.name);
                if(v !== undefined) add(sel(`-${this.name}-${f.name}-${v}-`));
            }
        }

        // --- Shape keys.
        const shapeFieldChanged = changedFields !== undefined
            && this.shapeFields.some(c => c in changedFields);
        const alwaysShape = kind === 'insert' || kind === 'delete' || kind === 'all';
        for(const f of this.fields) {
            if(!(f instanceof ForeignKeyField)) continue;
            const before = fkVal(beforeRow, f.name);
            const after = fkVal(changedFields, f.name);
            const fkMoved = kind === 'update' && after !== undefined && after !== before;
            if(alwaysShape || shapeFieldChanged || fkMoved) {
                for(const v of [before, after])
                    if(v !== undefined) add(sel(`-${this.name}-${f.name}-${v}-shape-`));
            }
        }
        if(alwaysShape || shapeFieldChanged)
            add(sel(this.tableShapeKey()));

        return keys;
    }

    /** Props for a reloadable fragment registered under this table's row key
     *  (or, id-less, the whole-table key).  Rows register ONLY their row key
     *  (finest-sufficient) - a fragment whose query is WHERE fk=v should use
     *  reloadableProps with fkKey instead of the whole-table tag. */
    reloadableItemProps(id: number|undefined, reloadURL: string, extraProps: Record<string, string>={}): Record<string, string> {
        return reloadableProps(id ? [this.rowKey(id)] : [this.tableKey()], reloadURL, extraProps);
    }

    // A standard "edit" button for one row: opens the modal editor with this row's
    // edit form.  Same wiring the default TableRenderer row uses, factored so
    // hand-coded views can drop in an edit button without repeating the modal/hx
    // details at every call site.
    editButton(id: number, label: string = 'Edit'): Markup {
        return ['button', editButtonProps(`${this}.renderForm(${this}.getById(${id}))`), label];
    }

    // The icon-only variant of editButton: a ghosted pencil, the ONLY edit
    // affordance on a list row or detail page (see detailItemProps).  A real
    // <button> (keyboard/screen-reader users get the same path), just quieter
    // than a text button - so it can sit on every editable item without
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

    // A short human label for one record - used by polymorphic owner backlinks
    // (volunteer_group / project render an OWNED row through its owner, so a
    // single source of truth needn't be denormalized).  Default: the 'name' or
    // 'title' column; override for tables that label differently (e.g. event ->
    // description).  Override may itself derive (an owned project's label comes
    // from ITS owner) - the derivation chains through recordLabel.
    recordLabel(record: T): string {
        const r = record as Record<string, unknown>;
        const v = r['name'] ?? r['title'];
        return (typeof v === 'string' && v) ? v : `${this.name} ${r[this.pkName] ?? ''}`.trim();
    }

    // Props for a record rendered as a whole-surface *navigable* list item -
    // THE standard list-row presentation: tap anywhere drills in to the
    // record's detail page; editing (when the viewer may) is ONLY via the
    // contained editPencil.  One species for every viewer, so what tapping a
    // row DOES never depends on permissions - the pencil just appears or not.
    // Rendered on a div (not an <a>), so the row can contain other interactive
    // elements (the pencil, a mailto email).  The delegation target is the
    // row's nav link: give the detail-page <a> class 'lm-nav-link'
    // (lmNavigableClick in resources/liminal-scripts.js clicks it, declining
    // clicks that belong to inner links/buttons or a text-selection drag).
    // Pair with navChevron(); reloadable tagging re-renders just this item
    // after an edit save.  (A table without a detail page would render an
    // inert row instead - reloadableItemProps + 'list-group-item lm-item' +
    // a conditional pencil - but every table currently has one.)
    detailItemProps(id: number|undefined, reloadURL: string, extraProps: Record<string, string>={}): Record<string, string> {
        const props = this.reloadableItemProps(id, reloadURL, extraProps);
        props.class = 'list-group-item list-group-item-action lm-item lm-navigable ' + props.class;
        props.onclick = 'lmNavigableClick(event)';
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
    @route(authenticated)
    renderForm(record: T, onsubmit?: string): Markup {
        // Row-level gate (the save side has its own in parseForm): don't even
        // generate an edit form for a record the actor may not edit.
        if(!this.canEditRecord(record))
            throw new Error(`Not permitted to edit this ${this.name}`);

        // Default dispatch: save via txd with the dirty set saveForm is
        // expected to return (speculatedSaveTargets), so the save and the
        // fragment refresh ride ONE round trip when the speculation holds; a
        // custom saveForm that dirties more just falls back to two-trip.
        onsubmit ??= 'txd('+JSON.stringify(this.speculatedSaveTargets(record))+')`'
            +this+'.saveForm(${getFormJSON(event.target)})`';

        // Only fields the actor may edit become inputs.  Since edit ⊆ view, a
        // field that was redacted in the fetched record (one the actor can't see)
        // is also not editable, so its (sentinel) value never reaches an input or
        // a before-value - it simply isn't in the form, and can't be clobbered.
        const editableFields = this.fields.filter(f => f.isVisible() && this.canEdit(f, record));

        const hidden: Record<string, any> = {};
        const pk = record[this.pkName];
        if(pk !== undefined && pk !== null)
            hidden[this.pkName] = pk;
        // For a NEW record (no pk) the before-snapshots are empty - on an insert
        // EVERY supplied value is a change.  This is what lets a "new" dialog be
        // rendered over a partial record (e.g. renderForm({project_id} as Task)
        // to preset the project): the prefilled input differs from its empty
        // snapshot, so parseInput includes it.  (Snapshotting the prefill would
        // silently DROP any value the user accepts unchanged.)
        const isNew = pk === undefined || pk === null;
        for(const f of editableFields)
            hidden['before-'+f.name] = isNew ? '' : f.toFormValue(record[f.name]);

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
    @route(authenticated)
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
        const changedFieldValues = this.parseFormChanges(form);

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

    // The dirty set saveForm is EXPECTED to emit for this record - the edit
    // form's speculation (see renderForm).  Derived from the same
    // dirtyKeysFor as the automatic DML emission ('all': the full superset
    // derivable from the record at render time, shape keys included - a
    // speculated-but-unemitted key never renders a section, so over-
    // speculating is free).  Keys emission adds that render time can't know
    // (a changed fk's new value, provenance stamps, the new row's pk) come
    // back as the swap response's reloadTargets and are pruned or reloaded
    // client-side - so the default rarely needs overriding.
    speculatedSaveTargets(record: T): string[] {
        const pk = record[this.pkName];
        return this.dirtyKeysFor('all', typeof pk === 'number' ? pk : undefined,
                                 record as Record<string, unknown>, undefined);
    }

    // No primary key in the form means INSERT (the "new record" dialog is the
    // record form rendered over an empty record); with one, UPDATE.  parseForm
    // (not parseFormWithPrimaryKey, which requires the pk) handles both.
    // No hand target list: the dirty keys are emitted automatically by the
    // insert/update funnels and merged into the response by rpcHandler.
    @routeMutation(authenticated)
    saveForm(form: Record<string, string>): Markup {
        const {primaryKey, changedFieldValues} = this.parseForm(form);
        if(primaryKey !== undefined)
            this.updateNamedFields(primaryKey, Object.keys(changedFieldValues), changedFieldValues as T);
        else
            this.insert(changedFieldValues as T);
        return {action:'reload'};
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

    // Per-field indexes for every field flagged `indexed: true` (a foreign key, or
    // any column hot reads filter/sort on).  Spliced into createDML(), so they run
    // wherever the table is created.  Composite/partial indexes still go in the
    // constructor's extraDML.  (Was a stub - `indexed: true` was silently a no-op.)
    createIndexesDML(): string[] {
        return this.fields.flatMap(f => f.createIndexDML(this.name));
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
    
    // DDL for a single-column index when the field is flagged `indexed: true`
    // (named ${table}_by_${col}).  Composite or partial indexes still go in the
    // table constructor's extraDML.
    createIndexDML(tableName: string): string[] {
        if(!this.options.indexed) return [];
        const kind = this.options.unique ? 'UNIQUE INDEX' : 'INDEX';
        return [`CREATE ${kind} IF NOT EXISTS ${tableName}_by_${this.name} ON ${tableName}(${this.name});`];
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
     * Validate/coerce a value that arrived as a ROUTE-EXPRESSION literal (see
     * FieldSet.normalize).  Route arguments are user-typeable text, so a field
     * must not trust the literal's type.  The base accepts any primitive;
     * typed fields override to enforce their type.
     */
    fromLiteral(v: any): any {
        if(v === null || ['string','number','boolean'].includes(typeof v)) return v;
        throw new Error(`${this.name}: expected a primitive, got ${typeof v}`);
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
 * A boolean rendered as an actual checkbox - for PARAMETER DIALOGS (search
 * filters etc.), not record edits: an unchecked checkbox submits nothing,
 * which would defeat the record editor's before-value change detection (use
 * BooleanField's Yes/No select there).  Dialog dispatch that reads the form
 * client-side (e.g. lmNavigateFormRoute) sees checkboxes as true/false.
 */
export class CheckboxField extends Field {
    constructor(name: string, options: FieldOptions = {}) {
        super(name, options);
    }

    dmlType(): string {
        return 'INTEGER';
    }

    render(value: any): Markup {
        return value ? 'Yes' : 'No';
    }

    renderInput(value: any): Markup {
        const checked = (value === true || value === 1 || value === '1' || value === 'true');
        return [
            ['div', {'class':'col-12'},
             ['div', {class:'form-check'},
              ['input', Object.assign({type:'checkbox', class:'form-check-input',
                                       name:this.name, id:'input-'+this.name},
                                      checked ? {checked:''} : {})],
              ['label', {for:'input-'+this.name, class:'form-check-label'}, this.prompt],
             ]
            ] // div
        ];
    }

    // A checkbox posts 'on' when checked and is absent when unchecked.
    parseSimpleInput(value: string): any {
        return value ? 1 : 0;
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

    override fromLiteral(v: any): any {
        if(typeof v !== 'string')
            throw new Error(`${this.name}: expected a string`);
        return v;
    }
}

/**
 * A markdown text field, for notes/descriptions everywhere: stored as plain
 * markdown TEXT, edited in a <textarea>, displayed through the safe
 * markdown->Markup translation (liminal/markdown.ts - raw HTML renders as
 * text, hostile URL schemes are refused; see that file's security story).
 */
export class MarkdownField extends StringField {
    override renderInput(value: any): Markup {
        return [
            ['div', {'class':'col-12'},
             ['label', {for:'input-'+this.name, class:'form-label'}, this.prompt],
             ['textarea', Object.assign({class:'form-control', name:this.name,
                                         id:'input-'+this.name, rows:'5'},
                                        this.isInputRequired() ? {required: ''} : {}),
              value ?? ''],
             // A quiet hint, not a manual: enough to signal markdown works.
             ['div', {class:'form-text'}, 'Markdown: **bold**, *italic*, - lists, [link](url)'],
            ]
        ];
    }

    override render(value: any): Markup {
        return markdownToMarkup(typeof value === 'string' ? value : undefined);
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

    override fromLiteral(v: any): any {
        if(typeof v !== 'string' || !(v in this.choices))
            throw new Error(`${this.name}: expected one of ${Object.keys(this.choices).join('|')}`);
        return v;
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

    override fromLiteral(v: any): any {
        if(typeof v !== 'number' || !Number.isSafeInteger(v))
            throw new Error(`${this.name}: expected an integer`);
        return v;
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
        // House style: "Jan 23, 2025, 2:30 PM".
        return date.sqliteDateTimeToString(value == null ? null : String(value));
    }

    // Stored as SQLite 'YYYY-MM-DD HH:MM:SS'; an <input type=datetime-local>
    // value is 'YYYY-MM-DDTHH:MM' (a 'T' in place of the space).  We edit at
    // MINUTE precision - nobody schedules a shop load to the second - so the
    // form value is truncated to minutes.  Both the input value and its
    // before-<name> snapshot go through this, so an untouched field compares
    // equal (and keeps its stored seconds: unchanged fields are not written).
    toFormValue(value: any): any {
        if(value == null || value === '') return '';
        return String(value).replace(' ', 'T').slice(0, 16);
    }

    renderInput(value: any): Markup {
        return [
            ['div', {'class':'col-12'},
             ['label', {for:'input-'+this.name, class:'form-label'}, this.prompt],
             ['input', Object.assign({type:'datetime-local', class:'form-control',
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
 * A date WITHOUT a time of day (join date, archived-on, ...), stored as
 * SQLite 'YYYY-MM-DD'.  Distinct from DateTimeField so day-granularity facts
 * get a date picker (not a datetime picker with meaningless time noise) and
 * render as "Jan 23, 2025".
 */
export class DateField extends Field {
    constructor(name: string, options: FieldOptions = {}) {
        super(name, options);
    }

    dmlType(): string {
        return 'TEXT';
    }

    render(value: any): Markup {
        return date.sqliteDateToString(value == null ? null : String(value));
    }

    // <input type=date> uses 'YYYY-MM-DD' directly - same as storage.
    toFormValue(value: any): any {
        return value == null ? '' : String(value);
    }

    renderInput(value: any): Markup {
        return [
            ['div', {'class':'col-12'},
             ['label', {for:'input-'+this.name, class:'form-label'}, this.prompt],
             ['input', Object.assign({type:'date', class:'form-control',
                                      name:this.name, id:'input-'+this.name, value: this.toFormValue(value)},
                                     this.isInputRequired() ? {required: ''} : {})]
            ] // div
        ];
    }

    parseSimpleInput(value: string): any {
        if (!value) return null;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
            throw new Error(`Invalid date format. Expected "YYYY-MM-DD", got "${value}"`);
        return value;
    }
}

/**
 * A point in db time: the field VALUE is a raw hybrid-logical-clock timestamp
 * NUMBER (liminal/timestamp.ts - the versioned stores' pervasive clock), but
 * nobody should ever see or type the encoded value, so it is edited as a
 * datetime-local at minute precision and displayed as a local time.  Mainly
 * for page-query time ranges over a versioned store (a from/to filter).
 * The wall-time component is best-effort under HLC clock anomalies, like
 * every display of these timestamps.
 */
export class TimestampField extends Field {
    constructor(name: string, options: FieldOptions = {}) {
        super(name, options);
    }

    dmlType(): string {
        return 'INTEGER';
    }

    render(value: any): Markup {
        return value == null ? '' : timestamp.formatTimestampAsLocalTime(Number(value));
    }

    // The datetime-local representation (local time, minute precision).  Both
    // the input value and its before-<name> snapshot go through this, so an
    // untouched field compares equal (and keeps its sub-minute precision:
    // unchanged fields are not written).
    toFormValue(value: any): any {
        if(value == null || value === '') return '';
        const d = new Date(timestamp.extractTimeFromTimestamp(Number(value))*1000
                           + timestamp.LOCAL_EPOCH_START);
        const p = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`
             + `T${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    renderInput(value: any): Markup {
        return [
            ['div', {'class':'col-12'},
             ['label', {for:'input-'+this.name, class:'form-label'}, this.prompt],
             ['input', Object.assign({type:'datetime-local', class:'form-control',
                                      name:this.name, id:'input-'+this.name,
                                      value: this.toFormValue(value)},
                                     this.isInputRequired() ? {required: ''} : {})]
            ]
        ];
    }

    parseSimpleInput(value: string): any {
        if(!value) return null;
        // datetime-local values ('YYYY-MM-DDTHH:MM[:SS]') parse as LOCAL time,
        // matching the local rendering above.
        const ms = new Date(value).getTime();
        if(Number.isNaN(ms))
            throw new Error(`Invalid date format. Expected format like "2026-02-19T09:32", got "${value}"`);
        return timestamp.makeTimestamp(
            Math.floor((ms - timestamp.LOCAL_EPOCH_START)/1000), 0);
    }

    override fromLiteral(v: any): any {
        if(typeof v !== 'number' || !Number.isSafeInteger(v))
            throw new Error(`${this.name}: expected a timestamp number`);
        return v;
    }
}

/**
 * A photo stored by reference: the field VALUE is a content-store path string
 * ('content/photos/3ab/<sha256>.jpg' - see liminal/photo.ts), so it diffs,
 * snapshots (before-…) and saves exactly like any other string column.
 *
 * The input control is a hidden input carrying that path, plus a file picker
 * (accept="image/*": on a phone this offers BOTH the camera and the photo
 * library; on desktop, the file chooser) wired to lmPhotoFieldChange
 * (resources/liminal-scripts.js), which downscales/re-encodes client-side
 * (also stripping EXIF/GPS), uploads via the app's PhotoService route, and
 * sets the hidden input - so by the time the form is saved, the photo is
 * already content-addressed and the save is a plain string-field update.
 *
 * photoServicePath is the route path of the app's PhotoService instance
 * (e.g. 'rabid.photo') - a developer-supplied constant, like ForeignKeyField's
 * target table.
 */
export class ImageField extends StringField {
    constructor(name: string, public photoServicePath: string, options: FieldOptions = {}) {
        super(name, options);
    }

    private serveSrc(value: string, width: number): string {
        return `/${this.photoServicePath}.serve(${JSON.stringify(value)},${width})`;
    }

    render(value: any): Markup {
        if(typeof value !== 'string' || value === '') return '';
        return ['img', {src: this.serveSrc(value, 256), class: 'lm-photo-thumb',
                        loading: 'lazy', alt: ''}];
    }

    renderInput(value: any, _ctx?: FieldRenderContext): Markup {
        const current = typeof value === 'string' ? value : '';
        const has = current !== '';
        return [
            ['div', {'class': 'col-12'},
             ['label', {for: `photo-file-${this.name}`, class: 'form-label'}, this.prompt],
             // The actual field value (and what before-… snapshots): the path.
             ['input', {type: 'hidden', name: this.name, id: 'input-'+this.name, value: current}],
             ['img', {id: `photo-preview-${this.name}`,
                      class: 'lm-photo-preview' + (has ? '' : ' d-none'),
                      src: has ? this.serveSrc(current, 256) : '', alt: ''}],
             ['input', {type: 'file', accept: 'image/*', class: 'form-control',
                        id: `photo-file-${this.name}`,
                        onchange: `lmPhotoFieldChange(event, ${JSON.stringify(this.photoServicePath)}, ${JSON.stringify(this.name)})`}],
             ['div', {class: 'd-flex align-items-center gap-2 mt-1'},
              ['button', {type: 'button',
                          class: 'btn btn-outline-secondary btn-sm' + (has ? '' : ' d-none'),
                          id: `photo-remove-${this.name}`,
                          onclick: `lmPhotoFieldClear(${JSON.stringify(this.name)})`},
               'Remove photo'],
              ['span', {class: 'form-text m-0', id: `photo-status-${this.name}`}]],
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
    @route(authenticated)
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
    @route(authenticated)
    renderRowById(rowId: number): Markup {
        return this.tableRenderer.renderRow(this.tableRenderer.table.getById(rowId));
    }
}

// -------------------------------------------------------------------------------
// --- Form Rendering convenience functions --------------------------------------
// -------------------------------------------------------------------------------

/** Selector/target form of a dependency key: '-task-7-' -> '.-task-7-'. */
export function sel(key: string): string { return '.' + key; }

/**
 * Props for a reloadable fragment: register it under `keys` (dependency-key
 * class form - see Table.tableKey/rowKey/fkKey; hand-minted strings are legal
 * for cases the vocabulary can't express, e.g. polymorphic owners) and give
 * it its own re-render route.  Register the FINEST sufficient keys, and only
 * in contexts whose own buttons can change the data - a context that renders
 * a shared editable view read-only wraps it in class 'lm-read-only' instead,
 * which excludes everything under it from refresh participation (see
 * lmRefreshable in resources/liminal-scripts.js).
 */
export function reloadableProps(keys: string[], reloadURL: string, extraProps: Record<string, string>={}): Record<string, string> {
    return Object.assign({
        'hx-get': reloadURL,
        'hx-trigger':'reload', 'hx-swap': 'outerHTML',
        'class': keys.join(' '),
    },
                         extraProps);
}

/** Legacy escape-hatch form of reloadableProps for hand-named fragment types
 *  (polymorphic owners etc.); registers the id key when given, else the bare
 *  type key (finest-sufficient, like Table.reloadableItemProps). */
export function reloadableItemProps(type: string, id: number|undefined, reloadURL: string, extraProps: Record<string, string>={}): Record<string, string> {
    return reloadableProps(id ? [`-${type}-${id}-`] : [`-${type}-`], reloadURL, extraProps);
}

/**
 * reloadableProps for a LIVE fragment: additionally opts into the long-poll
 * liveness mechanism (class 'lm-live') - the page will watch this fragment's
 * dependency keys and re-render it when OTHER actors' mutations touch them
 * (see liminal.md and resources/liminal-scripts.js).  Keep this rare: it is
 * for the few genuinely shared surfaces (a task checklist worked by several
 * people, an event-day check-in roster), not a general live-update switch.
 * ('lm-live' rides the class list beside the keys - never pass a class via
 * extraProps here, it would overwrite both.)
 */
export function liveReloadableProps(keys: string[], reloadURL: string, extraProps: Record<string, string>={}): Record<string, string> {
    return reloadableProps([...keys, 'lm-live'], reloadURL, extraProps);
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

// The "drills in" marker for a navigable list item (Table.detailItemProps) -
// the affordance counterpart of the pencil: chevron = tap drills in,
// pencil = the viewer may also edit.
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
