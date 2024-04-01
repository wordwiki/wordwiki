import * as model from "./model.ts";
import {FieldVisitorI, Field, ScalarFieldBase, BooleanField, IntegerField, FloatField,
        StringField, VariantField, IdField, PrimaryKeyField, RelationField, Schema} from "./model.ts";
import {Assertion} from './schema.ts';
import {unwrap, panic} from "../utils/utils.ts";
import {Markup} from '../utils/markup.ts';
import {CurrentTupleQuery, CurrentRelationQuery, TupleVersion} from './workspace.ts';
import * as utils from '../utils/utils.ts';
import * as strings from '../utils/strings.ts';

// export function buildView(schema: Schema): SchemaView {
//     // return new RelationSQLDriver(db, relationField,
//     //                              relationField.relationFields.map(r=>buildRelationSQLDriver(db, r)));
//     throw new Error();
// }

/**
 *
 */
export abstract class View {

    prompt: string|undefined;
    
    constructor(public field: Field) {
        this.prompt = field.style.$prompt ?? strings.capitalize(field.name).replaceAll('_', ' ');
    }

    abstract accept<A,R>(v: ViewVisitorI<A,R>, a: A): R;
}

/**
 *
 */
export abstract class ScalarViewBase extends View {
    declare field: ScalarFieldBase;
    constructor(field: ScalarFieldBase) { super(field); }
}

/**
 *
 */
export class BooleanView extends ScalarViewBase {
    declare field: BooleanField;
    constructor(field: BooleanField) { super(field); }
    accept<A,R>(v: ViewVisitorI<A,R>, a: A): R { return v.visitBooleanView(this, a); }
}

/**
 *
 */
export class IntegerView extends ScalarViewBase {
    declare field: IntegerField;
    constructor(field: IntegerField) { super(field); }
    accept<A,R>(v: ViewVisitorI<A,R>, a: A): R { return v.visitIntegerView(this, a); }
}

/**
 *
 */
export class FloatView extends ScalarViewBase {
    declare field: FloatField;
    constructor(field: FloatField) { super(field); }
    accept<A,R>(v: ViewVisitorI<A,R>, a: A): R { return v.visitFloatView(this, a); }
}

/**
 *
 */
export class StringView extends ScalarViewBase {
    declare field: StringField;
    constructor(field: StringField) { super(field); }
    accept<A,R>(v: ViewVisitorI<A,R>, a: A): R { return v.visitStringView(this, a); }
}

/**
 *
 */
export class VariantView extends StringView {
    declare field: VariantField;
    constructor(field: VariantField) { super(field); }
    accept<A,R>(v: ViewVisitorI<A,R>, a: A): R { return v.visitVariantView(this, a); }
}

/**
 *
 */
export class IdView extends ScalarViewBase {
    declare field: IdField;
    constructor(field: IdField) { super(field); }
    accept<A,R>(v: ViewVisitorI<A,R>, a: A): R { return v.visitIdView(this, a); }
}

/**
 *
 */
export class PrimaryKeyView extends ScalarViewBase {
    declare field: PrimaryKeyField;
    constructor(field: PrimaryKeyField) { super(field); }
    accept<A,R>(v: ViewVisitorI<A,R>, a: A): R { return v.visitPrimaryKeyView(this, a); }
}

/**
 *
 */
export class RelationView extends View {
    declare field: RelationField;
    #nonRelationViews: View[]|undefined = undefined;
    #scalarViews: ScalarViewBase[]|undefined = undefined;
    #userScalarViews: ScalarViewBase[]|undefined = undefined;
    #relationViews: RelationView[]|undefined = undefined;
    #relationViewsByTag: Record<string, RelationView>|undefined = undefined;
    //#ancestorRelations_: RelationView[]|undefined;
    #descendantAndSelfRelationViews_: RelationView[]|undefined;

    constructor(field: RelationField, public views: View[]) {
        super(field);
        //field.fields.map(new FieldVisitor<never,View>
    }

    accept<A,R>(v: ViewVisitorI<A,R>, a: A): R { return v.visitRelationView(this, a); }

    get nonRelationViews(): View[] {
        return this.#nonRelationViews??=this.views.filter(f=>!(f instanceof RelationView));
    }

    get scalarViews(): ScalarViewBase[] {
        return this.#scalarViews??=
            this.views.filter(f=>f instanceof ScalarViewBase).map(f=>f as ScalarViewBase);
    }

    get userScalarViews(): ScalarViewBase[] {
        return this.#scalarViews??=
            this.scalarViews.filter(f=>!(f instanceof PrimaryKeyView));
    }
    
    get relationViews(): RelationView[] {
        return this.#relationViews??=
            this.views.filter(f=>f instanceof RelationView).map(f=>f as RelationView);
    }

    get relationViewsByTag(): Record<string, RelationView> {
        // Note: we are already validating tag uniqueness across the whole
        //       schema, so no need to check here as well.
        return this.#relationViewsByTag??=
            Object.fromEntries(this.relationViews.map(r=>[r.field.tag, r]));
    }

    get descendantAndSelfRelationViews(): RelationView[] {
        return this.#descendantAndSelfRelationViews_ ??= [this, ...this.descendantRelationViews];
    }

    get descendantRelationViews(): RelationView[] {
        return ([] as RelationView[]).concat(
            ...this.relationViews.map(r=>r.descendantAndSelfRelationViews));
    }
    
    // get relationViewForRelation(): Map<RelationView, RelationView> {
    //     return this.#relationViewForRelation = (()=>{
    //         return new Map();
    //     })();
    // }

    // getRelationViewByName(relationName: string): RelationView {
    //     return this.relationViewForRelation.get(
    //         this.schema.relationsByName[relationName] ?? panic('missing', relationName))
    //         ?? panic();
    // }

    // getRelationViewByTag(relationTag: string): RelationView {
    //     return this.relationViewForRelation.get(
    //         this.schema.relationsByTag[relationTag] ?? panic('missing', relationTag))
    //         ?? panic();
    // }

}

/**
 *
 */
export class SchemaView extends RelationView {
    declare field: Schema;
    #relationViewForRelation: Map<RelationField, RelationView>|undefined = undefined;
    
    constructor(public schema: Schema, views: View[]) {
        super(schema, views);
    }
    
    accept<A,R>(v: ViewVisitorI<A,R>, a: A): R { return v.visitSchemaView(this, a); }

    get relationViewForRelation(): Map<RelationField, RelationView> {
        return this.#relationViewForRelation ??=
            new Map(this.descendantAndSelfRelationViews.map(v=>[v.field, v]));
    }
}

/**
 *
 */
export interface ViewVisitorI<A,R> {
    visitBooleanView(f: BooleanView, a: A): R;
    visitIntegerView(f: IntegerView, a: A): R;
    visitFloatView(f: FloatView, a: A): R;
    visitStringView(f: StringView, a: A): R;
    visitVariantView(f: VariantView, a: A): R;
    visitIdView(f: IdView, a: A): R;
    visitPrimaryKeyView(f: PrimaryKeyView, a: A): R;
    visitRelationView(f: RelationView, a: A): R;
    visitSchemaView(f: SchemaView, a: A): R;
}

/**
 *
 * Need multiple versions of render visitor.
 */
export class RenderVisitor implements ViewVisitorI<any,Markup> {
    
    visitView(f: View, v: any): Markup {
        // TODO this will be an exception later.
        return `[[Unrendered field kind ${utils.className(f)}]]`;
    }
    
    visitBooleanView(f: BooleanView, v: any): Markup {
        return this.visitView(f, v);
    }
    
    visitIntegerView(f: IntegerView, v: any): Markup {
        return this.visitView(f, v);
    }
    
    visitFloatView(f: FloatView, v: any): Markup {
        return this.visitView(f, v);
    }
    
    visitStringView(f: StringView, v: any): Markup {
        return this.visitView(f, v);
    }

    visitVariantView(f: VariantView, v: any): Markup {
        return this.visitView(f, v);
    }
    
    visitIdView(f: IdView, v: any): Markup {
        return this.visitView(f, v);
    }
    
    visitPrimaryKeyView(f: PrimaryKeyView, v: any) {
        return this.visitView(f, v);
    }
    
    visitRelationView(r: RelationView, v: CurrentRelationQuery): Markup {
        //r.modelFields.forEach(f=>f.accept(this, v[f.name]));
    }
    
    visitSchemaView(schema: SchemaView, v: any): Markup {
        return this.visitRelationView(schema, v);
    }
}

// export function renderRelation(r: CurrentRelationQuery): Markup {
//     const id=`relation-${r.schema.name}-${r.src.parent?.id ?? 0}`;
//     return (
//         ['table', {class: 'relation relation-${r.src.schema.name}', id},
//          [...r.tuples.values()].map(t=>
//              ['tr', {},
//               ['th', {}, t.schema.name],
//               //tv.schema.[lookup view for schema].map()
//              ])
//         ]);
// }

// For example, called on a dictionary entry (or root)
// What is a nice rendering?
/**
 * Tuple is rendered as a table with two options:
 * - show history - multi-rows with one per history item.
 * - edit mode - editor for current item (with prev value
 *   shown in history if history is open)
 * - later, may add more control of what items are displayed
 *   in history.
 * - no labels on fields for now (dictionary entries are simple enough).
 */
// - history should have a different font/weight etc - but need to
//   be in same table for layout.
// - editing of current uses same table (also for layout)
// - nested tuples are separate tables.
// - COMPLICATION: multiple tuples in a relation should be on one table (will
//   look ragged otherwise).
// - this will force the prompts into the table.
// - so use a colspan to embed the child items table in the parent table.
// - so the scope of render needs to be larger that a single tuple.
// - the scope of the entity that is rendered is a relation (recursively)


// XXX Also need to refactor this to allow rendering starting at any subtree.
//     (for post change rerender).


/**
 * 
 *
 *
 */
export class TupleEditor {
    constructor(public renderRootId: string, public tuple_id: number, public assertion: Assertion) {
    }
}

let currentlyOpenTupleEditor: TupleEditor|undefined = undefined;

// function isTupleUnderEdit(renderRootId: string, tuple_id: number): boolean {
//     return currentlyOpenTupleEditor !== undefined &&
//         currentlyOpenTupleEditor.renderRootId === renderRootId &&
//         currentlyOpenTupleEditor.tuple_id === tuple_id;
// }

function getCurrentlyOpenTupleEditorForTupleId(renderRootId: string, tuple_id: number): TupleEditor|undefined {
    return (currentlyOpenTupleEditor !== undefined &&
        currentlyOpenTupleEditor.renderRootId === renderRootId &&
        currentlyOpenTupleEditor.tuple_id === tuple_id)
        ? currentlyOpenTupleEditor
        : undefined;
}

export function beginFieldEdit(renderRootId: string, tuple_id: number) {
    console.info('begin field edit', renderRootId, tuple_id);
    if(currentlyOpenTupleEditor) {
        alert('A field editor is already open');
        return;
    }

    // NEXT populate assertion better!
    // CReating the assertion is a job for the global workspace.
    const new_assertion: Assertion = ({} as Assertion);
    currentlyOpenTupleEditor = new TupleEditor(renderRootId, tuple_id, new_assertion);

    // Re-render the tuple with the now open tuple editor
    // - we can use the global workspace to find the tuple by tuple_id ???
    // - figure out how this works for the first tuple in a relation (but sounds
    //   patchable)
}


export class Renderer {
    // CURRENTLY EDTIING TUPLE HERE IS PROBABLY BAD (MEANS THESE INSTS HAVE MEANINGFULL STATE)
    // PROBABLY WANT ONE EDITOR OPEN AT A TIME - SO BETTER IF IS GLOBAL STATE (using the renderRootId).
    
    //currentlyEditingTuple: TupleVersion|undefined = undefined;
    
    constructor(public viewTree: SchemaView, public renderRootId: string) {
    }

    renderRelation(r: CurrentRelationQuery): Markup {
        const schema = r.schema;
        const view = this.viewTree.relationViewForRelation.get(schema)
            ?? panic('unable find relation view for relation', schema.name);
        return (
            // This table has the number of cols in the schema for 'r'
            ['table', {class: `relation relation-${schema.name}`},
             [...r.tuples.values()].map(t=>this.renderTuple(t))
            ]);
    }

    renderTuple(r: CurrentTupleQuery): Markup {
        const schema = r.schema;
        const view = this.viewTree.relationViewForRelation.get(schema)
            ?? panic('unable find relation view for relation', schema.name);
        const isHistoryOpen = true;
        const currentlyOpenTupleEditor = getCurrentlyOpenTupleEditorForTupleId(this.renderRootId, r.src.id);

        return [
            // --- If this tuple a proposed new tuple under edit, render the editor
            currentlyOpenTupleEditor && this.renderTupleEditor(r, currentlyOpenTupleEditor),

            // --- Render prompt and curent values
            //     (later, support this line being replaced with an open editor)
            this.renderCurrentTupleRow(r),

            // --- If history is open for this tuple, render history rows
            isHistoryOpen ? [
                r.historicalTupleVersions.map(h=>
                    ['tr', {},
                     ['td', {}],  // Empty header col
                     view.userScalarViews.map(v=>this.renderScalarCell(r, v, h, true)),
                     ['td', {class: 'tuple-menu'}, this.renderSampleMenu()]
                    ])
                ]: undefined,

            // --- Render child relations
            schema.relationFields.length > 0 ? [
                ['tr', {},
                 ['td', {class: 'relation-container', colspan: view.userScalarViews.length+2},
                  Object.values(r.childRelations).map(
                      childRelation=>this.renderRelation(childRelation))
                 ]]
            ]: undefined
        ];
    }

    renderCurrentTupleRow(r: CurrentTupleQuery): Markup {
        const schema = r.schema;
        const view = this.viewTree.relationViewForRelation.get(schema)
            ?? panic('unable find relation view for relation', schema.name);
        const current = r.mostRecentTupleVersion;
        return (
            ['tr', {id: `tuple-${this.renderRootId}-${current?.assertion_id}`,
                    class: 'tuple'},
             ['th', {}, view.prompt],
             current ? [  // current is undefined for deleted tuples - more work here TODO
                 view.userScalarViews.map(v=>this.renderScalarCell(r, v, current))
             ]: undefined,
             ['td', {class: 'tuple-menu'}, this.renderSampleMenu()]
            ]);
    }    

    // ??? What happens if the tuple is rendered twice on the same screen - this current id scheme implies both should be under
    // edit.   We either have to disallow having the renderer twice (which seems like an unreasonable restriction) - or scope this
    // somehow.
    // We need to scope our render trees!
    // - Probably better to move tuple under edit into this view class? (it really does belong to it - not to the
    //   shared global thing)
    renderScalarCell(r: CurrentTupleQuery, v: ScalarViewBase, t: TupleVersion, history: boolean=false): Markup {
        return (
            ['td', {class: `field field-${v.field.schemaTypename()}`,
                    onclick:`imports.beginFieldEdit('${this.renderRootId}', ${r.src.id})`,
                    },
             (t.assertion as any)[v.field.bind]     // XXX be fancy here;
            ]);
    }

    renderTupleEditor(r: CurrentTupleQuery, t: TupleEditor): Markup {
        const schema = r.schema;
        const view = this.viewTree.relationViewForRelation.get(schema)
            ?? panic('unable find relation view for relation', schema.name);
        return (
            ['tr', {id: `tuple-${this.renderRootId}-${t.assertion.assertion_id}`},
             ['th', {}, view.prompt],
             view.userScalarViews.map(v=>this.renderScalarCellEditor(r, v, t))
            ]);
    }

    renderScalarCellEditor(r: CurrentTupleQuery, v: ScalarViewBase, t: TupleEditor): Markup {
        return (
            ['td', {class: `fieldedit`},
             'EDIT', (t.assertion as any)[v.field.bind]     // XXX be fancy here;
            ]);
    }

    renderSampleMenu(): Markup {
        return (
            ['div', {class:'dropdown'},
             ['button',
              {class:'btn btn-secondary dropdown-toggle',
               type:'button', 'data-bs-toggle':'dropdown', 'aria-expanded':'false'},
              '≡'],
             ['ul', {class:'dropdown-menu'},
              ['li', {}, ['a', {class:'dropdown-item', href:'#'}, 'Edit']],
              ['li', {}, ['a', {class:'dropdown-item', href:'#'}, 'Move Up']],
              ['li', {}, ['a', {class:'dropdown-item', href:'#'}, 'Move Down']],
              ['li', {}, ['a', {class:'dropdown-item', href:'#'}, 'Insert Above']],
              ['li', {}, ['a', {class:'dropdown-item', href:'#'}, 'Insert Below']],
              ['li', {}, ['a', {class:'dropdown-item', href:'#'}, 'Delete']],
              ['li', {}, ['a', {class:'dropdown-item', href:'#'}, 'Show History']],
             ]]);
    }
}

/**
 *
 */
export class FieldToView implements FieldVisitorI<any,View> {
    visitBooleanField(f: BooleanField, v: any): View { return new BooleanView(f); }
    visitIntegerField(f: IntegerField, v: any): View { return new IntegerView(f); }
    visitFloatField(f: FloatField, v: any): View { return new FloatView(f); }
    visitStringField(f: StringField, v: any): View { return new StringView(f); }
    visitVariantField(f: VariantField, v: any): View { return new VariantView(f); }
    visitIdField(f: IdField, v: any): View { return new IdView(f); }
    visitPrimaryKeyField(f: PrimaryKeyField, v: any): View { return new PrimaryKeyView(f); }
    visitRelationField(f: RelationField, v: any): View {
        return new RelationView(f, f.fields.map(fieldToView));
    }
    visitSchema(f: Schema, v: any): View {
        return new SchemaView(f, f.fields.map(fieldToView));
    }
}

const fieldToViewInst = new FieldToView();

export function fieldToView(f: Field): View {
    return f.accept(fieldToViewInst, undefined);
}

export function schemaView(f: Schema): SchemaView {
    return new SchemaView(f, f.fields.map(fieldToView));
}

/**
 *
 */
export function renderEditor(r: RelationView): any {
}

export const exportToBrowser = ()=> ({
    beginFieldEdit,
});

export const routes = ()=> ({
});
