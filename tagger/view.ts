// deno-lint-ignore-file no-unused-vars, no-explicit-any, no-unreachable, no-window

import * as model from "./model.ts";
import {FieldVisitorI, Field, ScalarField, BooleanField, IntegerField, FloatField,
        StringField, EnumField, VariantField, BlobField, AudioField, ImageField,
        IdField, PrimaryKeyField, RelationField, Schema} from "./model.ts";
import {Assertion, getAssertionPath, parentAssertionPath, getAssertionPathFields, assertionPathToFields} from './schema.ts';
import {unwrap, panic} from "../utils/utils.ts";
import {Markup} from '../utils/markup.ts';
import {VersionedDb, CurrentTupleQuery, CurrentRelationQuery, TupleVersion, generateBeforeOrderKey, generateAfterOrderKey} from './workspace.ts';
import * as workspace from './workspace.ts';
import {getAssertionsForEntry} from './workspace.ts';
import * as utils from '../utils/utils.ts';
import * as strings from '../utils/strings.ts';
import { rpc } from '../utils/rpc.ts';
import {block} from "../utils/strings.ts";
import {dictSchemaJson} from "./entry-schema.ts";
import * as timestamp from "../utils/timestamp.ts";
import { renderToStringViaLinkeDOM } from '../utils/markup.ts';
import { BEGINNING_OF_TIME, END_OF_TIME } from "../utils/timestamp.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "./db.ts";
import ContextMenu from '../utils/context-menu.js';
import { PageEditorConfig } from './render-page-editor.ts';


interface RenderCtx {
    renderRootId: string;
}

/**
 *
 */
export abstract class View {

    prompt: string|undefined;

    // Set when a view is added as a child to a RelationView
    parent: RelationView|undefined = undefined;

    // Computed on first access based on parent
    root_: SchemaView|undefined = undefined;

    constructor(public field: Field) {
        this.prompt = field.style.$prompt ??
            strings.capitalize(field.name).replaceAll('_', ' ');
    }

    abstract accept<A,R>(v: ViewVisitorI<A,R>, a: A): R;

    get root(): SchemaView {
        // upwards recursion ends on override on SchemaView
        return this.root_ ??= unwrap(this.parent).root;
    }
}

/**
 *
 */
export abstract class ScalarView extends View {
    declare field: ScalarField;
    constructor(field: ScalarField) { super(field); }

    renderView(ctx: RenderCtx, containingTuple: TupleVersion, fieldValue: any): Markup {
        return String(fieldValue);
    }

    /*abstract*/ renderEditor(ctx: RenderCtx, editor: TupleEditor, relation_id: number, v: any): Markup {
        const inputId = `input-${relation_id}-${this.field.name}`;
        return (
            ['div', {class:'row mb-3'},
             ['label', {
                 for:inputId, class:'col-sm-3 col-form-label'},
              this.prompt],
             ['div', {class:'col-sm-9'},
              this.renderEditorInput(ctx, editor, relation_id, inputId, v)
              //['input', {type:'email' class:'form-control' id:'inputEmail3'}]
             ]
            ]);
    }

    /*abstract*/ renderEditorInput(ctx: RenderCtx, editor: TupleEditor, relation_id: number, inputId: string, v: any): Markup {
        return String(v);
    }

    /**
     *
     *
     * Note: async so that we can load the data from input type=file fields.
     * (+ probably needed for submitting web audio recording when we get that done)
     */
    async loadFromEditor(relation_id: number, input_id: string): Promise<any> {
        return undefined;
    }
}

/**
 *
 */
export class BooleanView extends ScalarView {
    declare field: BooleanField;
    constructor(field: BooleanField) { super(field); }
    accept<A,R>(v: ViewVisitorI<A,R>, a: A): R { return v.visitBooleanView(this, a); }

    renderView(ctx: RenderCtx, t: TupleVersion, v: any): Markup {
        // This should be values on the style $
        return String(v);
    }

    renderEditorInput(ctx: RenderCtx, editor: TupleEditor, relationId: number, inputId: string, v: any): Markup {
        const checkboxAttrs: Record<string,string> = {
            type: 'checkbox',
            id: inputId,
            class: 'form-control'};
        if(v) checkboxAttrs['checked'] = '';
        return ['input', checkboxAttrs];
    }

    async loadFromEditor(relationId: number, inputId: string): Promise<any> {
        const checkboxElement = document.getElementById(inputId) as HTMLInputElement;
        if(!checkboxElement)
            throw new Error(`failed to find checkbox element ${inputId}`); // TODO fix error
        const checkboxValue = checkboxElement.checked;
        console.info('Checkbox value', checkboxValue);
        return checkboxValue;
    }
}

/**
 *
 */
export class IntegerView extends ScalarView {
    declare field: IntegerField;
    constructor(field: IntegerField) { super(field); }
    accept<A,R>(v: ViewVisitorI<A,R>, a: A): R { return v.visitIntegerView(this, a); }

    renderView(ctx: RenderCtx, t: TupleVersion, v: any): Markup {
        console.info('in IntegerView.renderView();');
        console.info('  style is ', this.field.style);
        console.info('  shape is ', this.field.style.$shape, 'for', this.field.name);
        // XXX this very much does not belong here XXX FIX FIX FIX XXX
        switch(this.field.style.$shape) {
            case 'boundingGroup': // XXX MASSIVE HACK FOR DEMO - DO THIS RIGHT
                console.info('ding the thing');
                if(v === null || v === undefined)
                    return ['div', {}, 'ERROR: undefined bounding group'];
                if(typeof v !== 'number')
                    return ['div', {}, `ERROR: malformed bounding group ${v}`];
                const boundingGroup: number = v;
                return (
                    ['div', {onclick:`event.stopPropagation(); window.open('/ww/forwardToSingleBoundingGroupEditorURL(${boundingGroup}, null)')`},
                     //['div', {}, `bounding group id ${boundingGroup} ${typeof boundingGroup}`],
                     ['object', {style: 'pointer-events: none;', data:`/ww/renderStandaloneGroupAsSvgResponse('/', ${boundingGroup})`, 'type':'image/svg+xml', 'id': `bounding-group-${boundingGroup}`}],
                     //[['b', {}, 'Reference Id:'], t.domai], HERE WORKING HERE
                    ]);
            default:
                return super.renderView(ctx, t, v);
        }
    }

    renderEditorInput(ctx: RenderCtx, editor: TupleEditor, relationId: number, inputId: string, v: any): Markup {

        // XXX this very much does not belong here XXX FIX FIX FIX XXX
        // - If we are going to hack this in here, we are going to
        //   need to figure out how to get entry_id and subentry_id here.
        // - the ctx used here is created in openFieldEdit - we don't
        //   currently have subentry_id and entry_id at that point.
        // - BUT: here we do have enough info to find the parent tuple
        //   etc in the workspace .. so maybe that is the winning move.


        // From the renderRootId, we can get the workspace.
        
        switch(this.field.style.$shape) {
            case 'boundingGroup':
                const workspace = activeViews().workspace;
                //const activeView = activeViews().activeViews.get(ctx.renderRootId);
                // if(!activeView)
                //     throw new Error('unable to find active view');
                const assertion = editor.assertion;
                utils.assert(assertion.ty1 === 'ent');
                const entry_id = assertion.id1;
                const subentry_id = assertion.id2;

                return ['PDM', 'Rand', 'Clark', 'RandFirstReadingBook'].map(b=>
                    ['button', {onclick:`event.preventDefault(); event.stopPropagation(); imports.launchAddNewDocumentReference2(${entry_id}, ${subentry_id}, ${JSON.stringify(this.field.name)}, ${JSON.stringify(b)}, 'Edit New Reference')`}, 'Add ', b]);
                
                break;
            default:
                return ['div', {}, 'Integer editor not implemented yet'];
                //return super.renderView(ctx, v);
                
        }
    }
    
}

/**
 *
 */ 
export function reloadBoundingGroup(boundingGroupId: number) {
    console.info('reloading bounding group', boundingGroupId);

    const boundingGroup =
        document.getElementById(`bounding-group-${boundingGroupId}`);

    if(!boundingGroup) {
        console.info('unable to find bounding group', boundingGroup);
        alert(`Internal error: unable to find bounding group to reload ${boundingGroup}`);
        return;
    }

    // (async() => {
    //     try {
    //         const boundingGroupSvgUrl = boundingGroup.getAttribute('data') ?? panic('failed to get bounding group URL'); 

    //         console.info('Refreshing bounding group svg', boundingGroupSvgUrl);
    //         await fetch(boundingGroupSvgUrl, { cache: "reload" });

    //         console.info('Refreshing DOM node');
    //         boundingGroup.outerHTML = boundingGroup.outerHTML;
    //     } catch (e) {
    //         alert(`Failed to update bounding group image: ${boundingGroupId}`);
    //         throw e;
    //     }
    // })();


    boundingGroup.outerHTML = boundingGroup.outerHTML;
}

/**
 *
 */
export class FloatView extends ScalarView {
    declare field: FloatField;
    constructor(field: FloatField) { super(field); }
    accept<A,R>(v: ViewVisitorI<A,R>, a: A): R { return v.visitFloatView(this, a); }
}

/**
 *
 */
export class StringView extends ScalarView {
    declare field: StringField;
    constructor(field: StringField) { super(field); }
    accept<A,R>(v: ViewVisitorI<A,R>, a: A): R { return v.visitStringView(this, a); }

    // TODO: how to know what width to use - easy if one - want full width, but
    //       if multiple?
    // -- give id.
    // -- write a loader that can get the value based on id.
    // -- before writing this, do the other end
    renderEditorInput(ctx: RenderCtx, editor: TupleEditor, relation_id: number, input_id: string, v: any): Markup {
        // if(this.field.name === 'transcription') {
        //     const parentAssertionPath =
        //         schema.parentAssertionPath(schema.getAssertionPath(editor.assertion));
        //     const boundingGroup = editor.assertion.0; //ctx; // QUERY TO FIND BOUINDING GRUPO ID IN PARENT
        //     return ['div', {}, 'TRANSSCRPTION'
        //             ['object', {style: 'pointer-events: none;', data:`/ww/renderStandaloneGroupAsSvgResponse('', ${boundingGroup})`, 'type':'image/svg+xml', 'id': `bounding-group-${boundingGroup}`}]
        //            ];
        // }
        
        return ['input', {type: 'text', /*placeholder: this.prompt,*/
                          size: this.field.style.$width ?? 30,
                          value: String(v??''),
                          autofocus: '',
                          class: 'form-control',
                          id: `input-${relation_id}-${this.field.name}`}];
    }

    async loadFromEditor(relation_id: number, input_id: string): Promise<any> {
        const inputId = `input-${relation_id}-${this.field.name}`;
        const inputElement = document.getElementById(inputId);
        if(!inputElement)
            throw new Error(`failed to find input element ${inputId}`); // TODO fix error
        const value = (inputElement as HTMLInputElement).value; //getAttribute('value');
        // TODO more checking here.
        return value;
        //return undefined;
    }
}

/**
 *
 */
export class EnumView extends StringView {
    declare field: EnumField;
    constructor(field: EnumField) { super(field); }
    accept<A,R>(v: ViewVisitorI<A,R>, a: A): R { return v.visitEnumView(this, a); }

    get choices(): Record<string, string> {
        // XXX Fix this garbage typing
        return (((this.field.style as any).$options
            ?? panic(`enum ${this.field.name} missing options`)) as Record<string, string>);
    }

    renderView(ctx: RenderCtx, t: TupleVersion, v: any): Markup {
        return this.choices[v] ?? String(v);
    }

    renderEditorInput(ctx: RenderCtx, editor: TupleEditor, relation_id: number, input_id: string, val: any): Markup {
        //size: this.field.style.$width ?? 30,


        return ['select', {type: 'text', placeholder: this.prompt,
                           id: `input-${relation_id}-${this.field.name}`,
                           class: 'form-control'},
                Object.entries(this.choices).map(([k,v])=>
                    ['option',
                     {value: k, ...(val===k?{selected:''}:{})}, v])
               ];
    }

    async loadFromEditor(relation_id: number, input_id: string): Promise<any> {
        const inputId = `input-${relation_id}-${this.field.name}`;
        const selectElement = document.getElementById(inputId) as HTMLSelectElement;
        if(!selectElement)
            throw new Error(`failed to find select element ${inputId}`); // TODO fix error
        const selectValue = selectElement.options[selectElement.selectedIndex].value;
        console.info('Select value', selectValue);
        return selectValue;
    }
}

/**
 *
 */
export class VariantView extends EnumView {
    declare field: VariantField;
    constructor(field: VariantField) { super(field); }
    accept<A,R>(v: ViewVisitorI<A,R>, a: A): R { return v.visitVariantView(this, a); }

    get choices(): Record<string, string> {
        // XXX Fix this garbage typing.
        // TODO don't embed mm stuff here directly.
        return {
            '':'',
            'mm': 'mm',
            'mm-li': 'mm-li',
            'mm-sf': 'mm-sf' };
    }
    
    // renderView(ctx: RenderCtx, t: TupleVersion, v: any): Markup {
    //     return v == null || v == '' ? '' : `(${String(v)})`;
    // }
}

/**
 *
 */
export class BlobView extends StringView {
    declare field: BlobField;
    constructor(field: BlobField) { super(field); }
    accept<A,R>(v: ViewVisitorI<A,R>, a: A): R { return v.visitBlobView(this, a); }
}

async function encodeBlobAsBase64(blob: Blob) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (event: any) => {
            const dataUrl = event.target.result;
            const [_, base64] = dataUrl.split(',');
            resolve(base64);
        };
        reader.readAsDataURL(blob);
    });
}

/**
 *
 */
export class AudioView extends StringView {
    declare field: AudioField;
    constructor(field: AudioField) { super(field); }
    accept<A,R>(v: ViewVisitorI<A,R>, a: A): R { return v.visitAudioView(this, a); }

    renderView(ctx: RenderCtx, t: TupleVersion, v: any): Markup {
        // This should be values on the style $
        //return
        const label = 'Audio'; // XXX fix
        const compressedAudioUrl = `/ww/forwardToCompressedRecording("${v}")`;
        return ['a',
                {onclick: `event.preventDefault(); event.stopPropagation(); playAudio(${JSON.stringify(compressedAudioUrl).replaceAll('"', "'")});`, href: compressedAudioUrl.replaceAll('"', "'")},
                label]
    }

    renderEditorInput(ctx: RenderCtx, editor: TupleEditor, relation_id: number, input_id: string, v: any): Markup {
        return ['input', {type: 'file', /*placeholder: this.prompt,*/
                          size: this.field.style.$width ?? 30,
                          accept: '.wav',
                          value: '', //String(v??''),
                          autofocus: '',
                          class: 'form-control',
                          id: `input-${relation_id}-${this.field.name}`}];
    }

    async loadFromEditor(relation_id: number, input_id: string): Promise<any> {
        const inputId = `input-${relation_id}-${this.field.name}`;
        const inputElement = document.getElementById(inputId);
        if(!inputElement)
            throw new Error(`failed to find input element ${inputId}`); // TODO fix error
        if(!(inputElement instanceof HTMLInputElement))
            throw new Error(`audio input element of wrong type ${inputId}`);
        const value = inputElement.value; //(inputElement as HTMLInputElement).value; //getAttribute('value');
        console.info(`Audio filename is ${value}`);
        
        //const file = inputElement.files?.item(0);
        const file = inputElement?.files?.[0];
        if(!file) {
            console.info('audio input did not get a new file - not updating value');
            return undefined;
        }
        console.info('FILE is:', file);

        const recordingBytesAsBase64 = await encodeBlobAsBase64(file);
        console.info('recordingBytesAsBase64', recordingBytesAsBase64);
        
        // (async ()=>{
        //     console.info('text is', await file.text());
        // })();

        // Change this to be a RPC to write the wav and get back a path.
        // Deal with non-change case somehow.
        // const data = await file.arrayBuffer();
        // console.info('bytes is', data);
        // const hashBuffer = await window.crypto.subtle.digest("SHA-256", data);
        // const hashArray = Array.from(new Uint8Array(hashBuffer)); // convert buffer to byte array
        // const hashHex = hashArray
        //     .map((b) => b.toString(16).padStart(2, "0"))
        //     .join(""); // convert bytes to hex string
        // console.info('digest is', hashHex);

        const {audioPath}: {audioPath: string} = await rpc`uploadRecording({recordingBytesAsBase64: ${recordingBytesAsBase64}})`;
        console.info('AUDIO PATH IS', audioPath);
        
        return audioPath;
    }
}

/**
 *
 */
export class ImageView extends StringView {
    declare field: ImageField;
    constructor(field: ImageField) { super(field); }
    accept<A,R>(v: ViewVisitorI<A,R>, a: A): R { return v.visitImageView(this, a); }
}

/**
 *
 */
export class IdView extends ScalarView {
    declare field: IdField;
    constructor(field: IdField) { super(field); }
    accept<A,R>(v: ViewVisitorI<A,R>, a: A): R { return v.visitIdView(this, a); }
}

/**
 *
 */
export class PrimaryKeyView extends ScalarView {
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
    #scalarViews: ScalarView[]|undefined = undefined;
    #userScalarViews: ScalarView[]|undefined = undefined;
    #relationViews: RelationView[]|undefined = undefined;
    #relationViewsByTag: Record<string, RelationView>|undefined = undefined;
    //#ancestorRelations_: RelationView[]|undefined;
    #descendantAndSelfRelationViews_: RelationView[]|undefined;

    constructor(field: RelationField, public views: View[]) {
        super(field);
        for(const v of views) {
            if(v.parent !== undefined)
                throw new Error(`Child view ${v} already has a parent`);
            v.parent = this;
        }
    }

    accept<A,R>(v: ViewVisitorI<A,R>, a: A): R { return v.visitRelationView(this, a); }

    get nonRelationViews(): View[] {
        return this.#nonRelationViews??=this.views.filter(f=>!(f instanceof RelationView));
    }

    get scalarViews(): ScalarView[] {
        return this.#scalarViews??=
            this.views.filter(f=>f instanceof ScalarView).map(f=>f as ScalarView);
    }

    get userScalarViews(): ScalarView[] {
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

   
    renderRelation_(ctx: RenderCtx, r: CurrentRelationQuery): Markup {
        const markup = this.renderRelation(ctx, r);
        console.info('Relation ', r, 'with shape', this.field.style.$shape, 'rendered markup', JSON.stringify(markup, undefined, 2));
        return markup;
    }
    
    // Renders a relation of this view kind.  This includes the title for the
    // relation, structure (like list), controls for inserting etc.
    renderRelation(ctx: RenderCtx, r: CurrentRelationQuery): Markup {
        const shape = this.field.style.$shape;
        switch(shape) {
            case 'inlineListRelation':
                return this.renderInlineListRelation(ctx, r);
            case 'compactInlineListRelation':
                return this.renderCompactInlineListRelation(ctx, r);
            case 'containerRelation':
                return this.renderContainerRelation(ctx, r);
            default:
                throw new Error(`invalid or missing $shape '${shape}' for relation field '{f.name}'`);
                
        }
    }

    renderInlineListRelation(ctx: RenderCtx, r: CurrentRelationQuery): Markup {
        const parentTuple = r.src.parent ?? panic('expected parent tuple');
        if(this.field.relationFields.length > 0)
            throw new Error(`inlineListRelation fields must not have child relations: ${this.field.name}`);

        return [
            ['div', {class: 'inline-list-relation'},
             ['span', {class: 'prompt'}, this.field.prompt+':'],
             ['ul',{},
              r.tuples.length === 0
                 ? ['li', {class: 'editable',
                           onclick:`activeViews().editNewLastChild('${ctx.renderRootId}', '${r.schema.schema.tag}', '${parentTuple.schema.tag}', ${parentTuple.id}, '${r.schema.tag}')`},
                    'No ', this.field.prompt]
                 : r.tuples.map(t=>['li',
                                    {class: 'tuple-context-menu editable',
                                     'data-render-root-id': ctx.renderRootId,
                                     'data-db-tag': t.schema.schema.tag,
                                     'data-tuple-tag': t.schema.tag,
                                     'data-tuple-id': t.src.id,
                                     onclick:`activeViews().editTupleUpdate('${ctx.renderRootId}', '${t.schema.schema.tag}', '${t.schema.tag}', ${t.src.id})`},
                                    this.renderTuple(ctx, t)])
             ]
            ]
        ];
    }

    renderCompactInlineListRelation(ctx: RenderCtx, r: CurrentRelationQuery): Markup {
        const parentTuple = r.src.parent ?? panic('expected parent tuple');
        if(this.field.relationFields.length > 0)
            throw new Error(`compactInlineListRelation fields must not have child relations: ${this.field.name}`);
        return [
            r.tuples.length === 0
                ? ['div', {class: 'compact-inline-list-relation editable',
                           onclick:`activeViews().editNewLastChild('${ctx.renderRootId}', '${r.schema.schema.tag}', '${parentTuple.schema.tag}', ${parentTuple.id}, '${r.schema.tag}')`}, ['b', {}, this.field.prompt, ': '], 'None']
                : r.tuples.map(t=>
                    ['div', {class: 'tuple-context-menu editable',
                             'data-render-root-id': ctx.renderRootId,
                             'data-db-tag': t.schema.schema.tag,
                             'data-tuple-tag': t.schema.tag,
                             'data-tuple-id': t.src.id,
                             onclick:`activeViews().editTupleUpdate('${ctx.renderRootId}', '${t.schema.schema.tag}', '${t.schema.tag}', ${t.src.id})`},
                     ['span', {class: 'prompt'}, this.field.prompt, ': '],
                     this.renderTuple(ctx, t)])
        ];
    }

    renderContainerRelation(ctx: RenderCtx, r: CurrentRelationQuery): Markup {
        const parentTuple = r.src.parent ?? panic('expected parent tuple');
        return [
            r.tuples.length === 0
                ? ['div', {class: 'editable container-relation',
                           onclick:`activeViews().editNewLastChild('${ctx.renderRootId}', '${r.schema.schema.tag}', '${parentTuple.schema.tag}', ${parentTuple.id}, '${r.schema.tag}')`},
                   ['span', {class: 'prompt'}, this.field.prompt, ': '], 'None']
                : r.tuples.map(t=>
                    ['div', {},
                     ['div', {class: 'editable tuple-context-menu',
                              'data-render-root-id': ctx.renderRootId,
                              'data-db-tag': t.schema.schema.tag,
                              'data-tuple-tag': t.schema.tag,
                              'data-tuple-id': t.src.id,
                              onclick:`activeViews().editTupleUpdate('${ctx.renderRootId}', '${t.schema.schema.tag}', '${t.schema.tag}', ${t.src.id})`
                             },
                      ['span', {class: 'prompt'}, this.field.prompt, ': '],
                      this.renderTuple(ctx, t)],
                     ['div', {style: 'margin-left: 2em'},
                      Object.values(t.childRelations).map(childRelation=>
                          ['div', {class: 'child-relation'},
                           unwrap(this.root.relationViewForRelation.get(childRelation.schema)).renderRelation(ctx, childRelation)])
                     ]
                    ])
        ];
    }
    
    // Renders a tuple as a root editor.
    renderRootTuple(ctx: RenderCtx, t: CurrentTupleQuery): Markup {
        return [
            ['h3', {}, this.field.prompt],
            ['div', {},
             this.renderTuple(ctx, t),
             [
                 Object.values(t.childRelations).map(childRelation=>
                     ['div', {},
                      unwrap(this.root.relationViewForRelation.get(childRelation.schema)).renderRelation(ctx, childRelation)])
             ]
            ]];
    }

    renderRootRelation(ctx: RenderCtx, r: CurrentRelationQuery): Markup {
        return this.renderRelation(ctx, r);
    }
    
    // Renders a single tuple of this view kind.  This is called by render relation,
    // but is also used by renderRoot (when we are trying to render a single top
    // level tuple - that is perhaps also a member of a relation)
    renderTuple(ctx: RenderCtx, r: CurrentTupleQuery): Markup {
        //const isHistoryOpen = this.tupleIdsWithHistoryOpen.has(r.src.id);
        const current = r.mostRecentTupleVersion;
        const tupleJson = JSON.stringify(current?.assertion);
        // current is undefined for deleted tuples - more work here TODO
        const body = (!current) ? [] : this.userScalarViews.map(v=>[
            this.renderScalarCell(ctx, r, v, current), ' ']);
        return body;
        // const menu = renderCurrentTupleMenu(ctx.renderRootId, r);
        // return [body, ' ', menu];
    }

    renderScalarCell(ctx: RenderCtx, r: CurrentTupleQuery, v: ScalarView, t: TupleVersion, history: boolean=false): Markup {
        const value = (t.assertion as any)[v.field.bind]; // XXX fix typing
        return v.renderView(ctx, t, value);
        // return ['span', {
        //     onclick:`activeViews().editTupleUpdate('${ctx.renderRootId}', '${r.schema.schema.tag}', '${r.schema.tag}', ${r.src.id})`},
        //         v.renderView(ctx, value)];
        // return (
        //     ['td', {class: `field field-${v.field.schemaTypename()}`,
        //             onclick:`activeViews().editTupleUpdate('${this.renderRootId}', '${r.schema.schema.tag}', '${r.schema.tag}', ${r.src.id})`,
        //            },
        //      v.renderView(ctx, value)
        //     ]);
    }
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

    get root(): SchemaView {
        return this.root_ ??= this;
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
    visitEnumView(f: EnumView, a: A): R;
    visitVariantView(f: VariantView, a: A): R;
    visitBlobView(f: BlobView, a: A): R;
    visitAudioView(f: AudioView, a: A): R;
    visitImageView(f: ImageView, a: A): R;
    visitIdView(f: IdView, a: A): R;
    visitPrimaryKeyView(f: PrimaryKeyView, a: A): R;
    visitRelationView(f: RelationView, a: A): R;
    visitSchemaView(f: SchemaView, a: A): R;
}

/**
 *
 * Currently, rendering is done by renderView() methods on the actual
 * nodes, so this is not presently used.
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

    visitEnumView(f: EnumView, v: any): Markup {
        return this.visitView(f, v);
    }

    visitVariantView(f: VariantView, v: any): Markup {
        return this.visitView(f, v);
    }

    visitBlobView(f: BlobView, v: any): Markup {
        return this.visitView(f, v);
    }

    visitAudioView(f: AudioView, v: any): Markup {
        return this.visitView(f, v);
    }

    visitImageView(f: ImageView, v: any): Markup {
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


// -----------------------------------------------------------------------------------
// -----------------------------------------------------------------------------------
// -----------------------------------------------------------------------------------

/**
 *
 */
// TODO somewhere we want a workspace.  - probably assoc with active views
// makes more sense for views to own workspace than the other way around.
// difficulty
let activeViews_: ActiveViews|undefined = undefined;
export function activeViews(): ActiveViews {
    return activeViews_ ??= (()=> {
        console.info('*** creating new active view');
        return new ActiveViews(new VersionedDb([]));
    })();
}

/**
 * We have changed how we are doing views (we have switched to transient, single
 * item editors).  This hack is used to put off the deeper refactoring to
 * come if we stick with this change.
 */
export function dropActiveViewsAndWorkspace() {
    console.info('*** dropping active views');
    activeViews_ = undefined;
}

/**
 *
 */
export class ActiveViews {
    workspace: VersionedDb;
    activeViews: Map<string, ActiveView> = new Map();
    currentlyOpenTupleEditor: TupleEditor|undefined = undefined;

    constructor(workspace: VersionedDb) {
        this.workspace = workspace;
    }

    nextTime(): number {
        // This is not necc ahead of all the server timestamps, just ahead
        // of all the timestamps in the current workspace.  Once we are live
        // following, this will need redoing XXX
        return timestamp.nextTime(this.workspace.mostRecentLocalTimestamp);
    }

    applyAssertion(assertion: Assertion) {
        // TODO Should check if differnt than prev tuple TODO TODO
        // - what from and to times to use for new assertions.
        //newAssertion =
        this.workspace.applyProposedAssertion(assertion);


        // THIS IS JUST FOR TEST - IT IS BAD!!! - WE ARE bAD !!!
        (async ()=>{
            try {
                await rpc`wordwiki.applyTransactions(${[assertion]})`;
            } catch (e) {
                alert(`Failed to save change - got error ${e}`);
                throw e;
            }
        })();
    }

    /**
     * Note: this is part of a temporary saving model for the proto versin -
     * the workspace must be droppped after saving changes in this manner.
     * TEMPORARY TEMP TEMP XXX
     */
    async saveChanges() {
        console.info('--- Saving changes');
        try {
            await this.workspace.persistProposedAssertions();
            console.info('--- Done saving changes');
        } catch(e) {
            alert(`Failed to save changes: ${e}`);
            throw e;
        }

        // TODO do something nicer!!!
        location.reload();
    }

    viewByName(viewName: string): ActiveView {
        return this.activeViews.get(viewName)
            ?? panic('unable to find active view', viewName);
    }

    registerActiveView(activeView: ActiveView) {
        this.activeViews.set(activeView.id, activeView);
    }

    rerenderAllViews() {
        for(const activeView of this.activeViews.values())
            activeView.rerender();
    }

    rerenderViewById(viewId: string) {
        this.activeViews.get(viewId)?.rerender();
    }

    // rerenderViewTupleEditorById(ctx: RenderCtx, viewId: string) {
    //     this.activeViews.get(viewId)?.rerenderTupleEditor(ctx);
    // }
    
    getCurrentlyOpenTupleEditorForTupleId(renderRootId: string, tuple_id: number): TupleEditor|undefined {
        return (this.currentlyOpenTupleEditor !== undefined &&
            this.currentlyOpenTupleEditor.renderRootId === renderRootId &&
            this.currentlyOpenTupleEditor.ref_tuple_id === tuple_id)
            ? this.currentlyOpenTupleEditor
            : undefined;
    }

    getCurrentlyOpenTupleEditorForRenderRootId(renderRootId: string): TupleEditor|undefined {
        return (this.currentlyOpenTupleEditor !== undefined &&
            this.currentlyOpenTupleEditor.renderRootId === renderRootId)
            ? this.currentlyOpenTupleEditor
            : undefined;
    }

    editNewAbove(renderRootId: string, db_tag: string, tuple_tag: string, tuple_id: number) {
        this.editNewPeer(renderRootId, db_tag, tuple_tag, tuple_id, 'before');
    }

    editNewBelow(renderRootId: string, db_tag: string, tuple_tag: string, tuple_id: number) {
        this.editNewPeer(renderRootId, db_tag, tuple_tag, tuple_id, 'after');
    }

    editNewFirstChild(renderRootId: string, db_tag: string, tuple_tag: string, tuple_id: number, child_tag: string) {
        this.editNewChild(renderRootId, db_tag, tuple_tag, tuple_id, 'firstChild', child_tag);
    }

    editNewLastChild(renderRootId: string, db_tag: string, tuple_tag: string, tuple_id: number, child_tag: string) {
        this.editNewChild(renderRootId, db_tag, tuple_tag, tuple_id, 'lastChild', child_tag);

    }

    editNewPeer(renderRootId: string,
                refDbTag: string, refTupleTag: string, refTupleId: number,
                refKind: 'before'|'after') {

        // --- Find the reference tuple
        const refTuple = this.workspace.getVersionedTupleById(
            refDbTag, refTupleTag, refTupleId)
            ?? panic('cannot find ref tuple for edit', refTupleId);

        const refAssertion = refTuple.mostRecentTuple?.assertion
            ?? panic('cannot use ref tuple', refTupleId);
        const newTupleSchema = refTuple.schema;

        //const mostRecentTupleVersion = refTuple.mostRecentTuple;
        const id = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);

        //const activeView = this.activeViews.get(renderRootId)
        const parent = this.workspace.getVersionedTupleParentRelation(
            getAssertionPath(refTuple.requiredMostRecentTuple.assertion));
        const order_key = refKind === 'before'
            ? generateBeforeOrderKey(parent, refTupleId)
            : generateAfterOrderKey(parent, refTupleId);

        // TODO make this new assertion making less raw.
        const newAssertion: Assertion = Object.assign(
            {},
            getAssertionPathFields(refAssertion),
            {
                ty: refAssertion.ty,
                assertion_id: id,
                valid_from: BEGINNING_OF_TIME,  // This is wrong - but it is overridden
                valid_to: END_OF_TIME,
                [`id${newTupleSchema.ancestorRelations.length}`]: id,
                id: id,
                order_key,
            });

        console.info('REF assertion', refAssertion);
        console.info('NEW assertion', newAssertion);

        this.openFieldEdit(renderRootId, refKind, undefined, refDbTag, refTupleTag, refTupleId, newAssertion);
    }

    editNewChild(renderRootId: string,
                 refDbTag: string, refTupleTag: string, refTupleId: number,
                 refKind: TupleRefKind, childTag: string) {

        // --- Find the reference tuple
        const parentTuple = this.workspace.getVersionedTupleById(
            refDbTag, refTupleTag, refTupleId)
            ?? panic('cannot find tuple for edit', refTupleId);

        // --- Find child relation we are inserting into
        const parentRelation = parentTuple.childRelations[childTag]
            ?? panic('cannot find child relation for edit', childTag);

        // ---
        const id = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);

        // --- Position is tricky
        const order_key = workspace.generateAtEndOrderKey(parentRelation);

        // --- Make new child assertion
        // TODO make this new assertion making less raw.
        const newAssertion: Assertion = Object.assign(
            {},
            assertionPathToFields([...getAssertionPath(parentTuple.currentAssertion??panic()), [childTag, id]]),
            {
                ty: childTag,
                assertion_id: id,
                valid_from: BEGINNING_OF_TIME,  // This is wrong - but it is overridden
                valid_to: END_OF_TIME,
                id: id,
                order_key,
            });

        console.info('NEW assertion', newAssertion);

        this.openFieldEdit(renderRootId, refKind, parentRelation.schema.tag, refDbTag, refTupleTag, refTupleId, newAssertion);
    }

    editNew(renderRootId: string,
            refDbTag: string, refTupleTag: string, refTupleId: number,
            refKind: TupleRefKind, schema: RelationField) {


    }

    editTupleUpdate(renderRootId: string, refDbTag: string, refTupleTag: string, refTupleId: number) {

        // --- Find the reference tuple
        const refTuple = this.workspace.getVersionedTupleById(
            refDbTag, refTupleTag, refTupleId)
            ?? panic('cannot find ref tuple for edit', refTupleId);

        // NEXT populate assertion better!
        // CReating the assertion is a job for the global workspace.
        // USING TUPLE FOR THIS - this needs to factor
        const mostRecentTupleVersion = refTuple.mostRecentTuple
            ?? panic('unexpected missing source tuple');
        const new_assertion: Assertion = Object.assign(
            {},
            mostRecentTupleVersion.assertion,
            {assertion_id: Math.floor(Math.random() * Number.MAX_SAFE_INTEGER),
             replaces_assertion_id: mostRecentTupleVersion.assertion_id });

        this.openFieldEdit(renderRootId, 'replaceSelf', undefined, refDbTag, refTupleTag, refTupleId,
                           new_assertion);
    }

    deleteTuple(renderRootId: string, refDbTag: string, refTupleTag: string, refTupleId: number) {
        console.info('--- Delete', renderRootId, refTupleId);

        // alert('Delete not implemented');
        // return;

        // --- Find the reference tuple
        const refTuple = this.workspace.getVersionedTupleById(
            refDbTag, refTupleTag, refTupleId)
            ?? panic('cannot find ref tuple for delete', refTupleId);

        console.info('FOUND THE TUPLE TO DELETE! SOOO HAPPY', refTuple);

        if(refTuple.findNonDeletedChildTuples().length > 0) {
            alert('Cannot delete a item with non-deleted children - please delete all children first');
            throw new Error('cannot delete tuple with non-deleted children');
        }

        // --- Find the parent of the reference tuple
        const parentTuple = this.workspace.getVersionedTupleByPath(
            parentAssertionPath(getAssertionPath(refTuple.currentAssertion ??
                panic("can't move up tuple with no parent"))));

        console.info('FOUND THE PARENT OF tHE TUPLE TO DELETE! SOOO HAPPY', parentTuple);
        const parentRelation = parentTuple.childRelations[refTupleTag]
            ?? panic("failed to find parent relation for move up");

        const newAssertion: Assertion = Object.assign(
            {},
            refTuple.currentAssertion,
            {assertion_id: Math.floor(Math.random() * Number.MAX_SAFE_INTEGER),
             replaces_assertion_id: refTuple?.currentAssertion?.assertion_id,
             valid_from: this.nextTime(),
             valid_to: this.nextTime(),
            }
        );

        this.applyAssertion(newAssertion);

        this.rerenderViewById(renderRootId);
    }

    moveUp(renderRootId: string, refDbTag: string, refTupleTag: string, refTupleId: number) {
        console.info('--- Move up', renderRootId, refTupleId);
        alert('move up is not implemented yet');
        return;

        // --- Find the reference tuple
        const refTuple = this.workspace.getVersionedTupleById(
            refDbTag, refTupleTag, refTupleId)
            ?? panic('cannot find ref tuple for edit', refTupleId);

        console.info('FOUND THE TUPLE TO MOVE UP! SOOO HAPPY', refTuple);

        // --- Find the parent of the reference tuple
        const parentTuple = this.workspace.getVersionedTupleByPath(
            parentAssertionPath(getAssertionPath(refTuple.currentAssertion ??
                panic("can't move up tuple with no parent"))));

        console.info('FOUND THE PARENT OF tHE TUPLE TO MOVE UP! SOOO HAPPY', parentTuple);
        const parentRelation = parentTuple.childRelations[refTupleTag]
            ?? panic("failed to find parent relation for move up");

        // ---



        // --- If this tuple is already the first tuple in its parent, nothing to do
        const updatedOrderKey = workspace.generateBeforeOrderKey(
            parentRelation, refTuple.id);

        console.info('updatedOrderKey is', updatedOrderKey);

        const newAssertion: Assertion = Object.assign(
            {},
            refTuple.currentAssertion,
            {assertion_id: Math.floor(Math.random() * Number.MAX_SAFE_INTEGER),
             replaces_assertion_id: refTuple?.currentAssertion?.assertion_id,
             valid_from: this.nextTime(),
             valid_to: timestamp.END_OF_TIME,
             order_key: updatedOrderKey
            }
        );

        this.applyAssertion(newAssertion);

        this.rerenderViewById(renderRootId);
    }

    moveDown(renderRootId: string, refDbTag: string, refTupleTag: string, refTupleId: number) {
        console.info('--- Move down', renderRootId, refTupleId);
        alert('move down is not implemented yet');
    }

    /**
     *
     */
    openFieldEdit(renderRootId: string,
                  refKind: TupleRefKind,
                  refRelation: string|undefined,
                  refDbTag: string,
                  refTupleTag: string,
                  refTupleId: number,
                  new_assertion: Assertion) {
        console.info('begin field edit', refKind, refRelation, refTupleTag, refTupleId);

        const ctx:RenderCtx = { renderRootId };
        
        // --- Only one tuple editor can be open at a time
        //     (later will get fancier and close open ones or something TODO)
        if(this.currentlyOpenTupleEditor) {
            //alert('A field editor is already open');
            this.currentlyOpenTupleEditor = undefined;
            getGlobalBoostrapInst().Modal.getOrCreateInstance('#modalEditor').hide();
        }

        // --- Find the view
        const tupleSchema =
            this.workspace.tables.get(refDbTag)?.schema
            ?.descendantAndSelfRelationsByTag[new_assertion.ty]
            ?? panic('unable to find schema for tag', new_assertion.ty);
        const viewTree: SchemaView =
            (this.activeViews.get(renderRootId)
                ?? panic('unable to find render root', renderRootId))
                .viewTree;
        const tupleView = viewTree.relationViewForRelation.get(tupleSchema) ??
            panic('unable to find relation view for relation', tupleSchema.tag);

        // --- Instantiate a field editor
        this.currentlyOpenTupleEditor = new TupleEditor(
            renderRootId, tupleView, refKind, refRelation, refTupleId, new_assertion);

        // Re-render the tuple with the now open tuple editor
        // - we can use the global workspace to find the tuple by tuple_id ???
        // - figure out how this works for the first tuple in a relation (but sounds
        //   patchable)
        //this.rerenderViewById(renderRootId);


        const modalTitle = (document.querySelector(`#modalEditorLabel`)
            ?? panic('unable to find modal editor label for dialog')) as HTMLElement;
        modalTitle.innerText = `Edit ${tupleView.prompt ?? ''}`;

        const modalBody = document.querySelector(`#modalEditorBody`)
            ?? panic('unable to find modal editor body for dialog');

        const activeView = (this.activeViews.get(renderRootId) ??
            panic('unable to find active view for openFieldEdit'));

        modalBody.innerHTML = renderToStringViaLinkeDOM(this.currentlyOpenTupleEditor.renderTupleEditor(ctx, viewTree, tupleSchema));

        getGlobalBoostrapInst().Modal.getOrCreateInstance('#modalEditor').show();
    }

    relationViewForRelation(renderRootId: string,
                            tupleSchema: RelationField): RelationView {
        const viewTree: SchemaView =
            (this.activeViews.get(renderRootId)
                ?? panic('unable to find render root', renderRootId))
                .viewTree;
        return viewTree.relationViewForRelation.get(tupleSchema) ??
            panic('unable to find relation view for relation', tupleSchema.tag);
    }

    async endFieldEdit() {
        if(!this.currentlyOpenTupleEditor) {
            alert('No field editor is currently open');
            return;
        }

        const tupleEditor = this.currentlyOpenTupleEditor;

        await tupleEditor.endFieldEdit();
        const renderRootId = tupleEditor.renderRootId;
        const newAssertion = tupleEditor.assertion;

        newAssertion.valid_from = this.nextTime();
        newAssertion.valid_to = timestamp.END_OF_TIME;

        this.applyAssertion(newAssertion);

        
        this.currentlyOpenTupleEditor = undefined;

        getGlobalBoostrapInst().Modal.getOrCreateInstance('#modalEditor').hide();
        this.rerenderViewById(renderRootId);
    }

}

/**
 *
 */
export class ActiveView {
    tupleIdsWithHistoryOpen: Set<number> = new Set();

    constructor(public id: string,
                public title: string,
                public viewTree: SchemaView, // This is restricting view to be from one schema XXX revisit
                public query: ()=>CurrentTupleQuery|CurrentRelationQuery) {
    }

    toggleHistory(tupleId: number) {
        if(this.tupleIdsWithHistoryOpen.has(tupleId))
            this.tupleIdsWithHistoryOpen.delete(tupleId);
        else
            this.tupleIdsWithHistoryOpen.add(tupleId);
        this.rerender();
    }

    rerender() {

        // FIX FIX
        const ctx:RenderCtx = { renderRootId: this.id };
        
        const queryResults = this.query();
        // if(!(queryResults instanceof CurrentRelationQuery))
        //     throw new Error(`internal error: new render model only supports relation queries`);

        const resultsSchema = queryResults.schema;
        const resultsView = this.viewTree.relationViewForRelation.get(resultsSchema)
            ?? panic('unable find relation view for relation', resultsSchema.name);

        let markup;
        if(queryResults instanceof CurrentTupleQuery) {
            markup = resultsView.renderRootTuple(ctx, queryResults);
        } else if(queryResults instanceof CurrentRelationQuery) {
            markup = resultsView.renderRootRelation(ctx, queryResults);
        } else {
            panic('unexpected active view query');
        }

        //console.info('RENDERED TO MARKUP', JSON.stringify(markup, undefined, 2));

        
        const modalTitle = document.querySelector(`#${this.id}Label`);
        if(modalTitle)
            modalTitle.innerHTML = this.title;

        const modalBody = document.querySelector(`#${this.id}Body`)
            ?? panic('unable to find modal editor body for dialog', this.id);

        console.info(`rendering ${this.id}`);

        modalBody.innerHTML = renderToStringViaLinkeDOM(markup);
    }
    
    // rerenderTupleEditor(ctx: RenderCtx) {
    //     //throw new Error('no');
    //     const renderer = new EditorRenderer(this.viewTree, this.tupleIdsWithHistoryOpen, this.id);
    //     const queryResults = this.query();

    //     let markup;
    //     if(queryResults instanceof CurrentTupleQuery) {
    //         markup = renderer.renderTable(ctx, queryResults);
    //     } else if(queryResults instanceof CurrentRelationQuery) {
    //         markup = renderer.renderRelation(ctx, queryResults);
    //     } else {
    //         panic('unexpected active view query');
    //     }

    //     const modalTitle = document.querySelector(`#${this.id}Label`);
    //     if(modalTitle)
    //         modalTitle.innerHTML = this.title;

    //     const modalBody = document.querySelector(`#${this.id}Body`)
    //         ?? panic('unable to find modal editor body for dialog', this.id);

    //     console.info(`rendering ${this.id}`);

    //     modalBody.innerHTML = renderToStringViaLinkeDOM(markup);
    // }
    
}


type TupleRefKind = 'replaceSelf' | 'firstChild' | 'lastChild' | 'before' | 'after';


/**
 *
 *
 */
export class TupleEditor {

    constructor(public renderRootId: string,
                public view: RelationView,
                public ref_kind: TupleRefKind,
                public ref_relation: string|undefined,
                public ref_tuple_id: number,
                public assertion: Assertion) {
    }

    // TODO: render as a proper bootstrap form.
    renderTupleEditor(ctx: RenderCtx, viewTree: SchemaView, schema: RelationField): Markup {
        const view = viewTree.relationViewForRelation.get(schema)
            ?? panic('unable find relation view for relation', schema.name);
    
        //const isHistoryOpen = this.tupleIdsWithHistoryOpen.has(r.src.id);
        return [
            //['h3', {}, view.prompt],

            ['form',
             {onsubmit:'activeViews().endFieldEdit(); event.preventDefault();',
              id: `tuple-${ctx.renderRootId}-${this.assertion.assertion_id}`},

             view.userScalarViews.map(v=>
                 this.renderScalarCellEditor(ctx, v)),
            
             ['button', {type:'submit',
                         class:'btn btn-primary',
                         onclickOff:'activeViews().endFieldEdit()'}, 'Save'],
            ]
        ];
    }

    renderScalarCellEditor(ctx: RenderCtx, v: ScalarView): Markup {
        const value = (this.assertion as any)[v.field.bind];     // XXX be fancy here;

        return v.renderEditor(ctx, this, this.assertion.assertion_id, value);
        
        // return (
        //     ['div', {class:'row mb-3'},
        //      ['label', {for:'inputEmail3', class:'col-sm-2 col-form-label'},
        //       Email],
        //      ['div', {class:'col-sm-10'},
        //       ['input', {type:'email' class:'form-control' id:'inputEmail3'}]
        //      ]
        //     ]);


            
        //     ['td', {class: `fieldedit`},
        //      v.renderEditorInput(ctx, this.assertion.assertion_id, value)
        //     ]);
        // NEXT NEXT TODO
    }

    // /**
    //  *
    //  */
    // renderHistoryTable(ctx: RenderCtx, r: CurrentTupleQuery): Markup {
    //     const schema = r.schema;
    //     const view = this.getViewForRelation(schema);
    //     const historicalTupleVersions = r.historicalTupleVersions.toReversed();
    //     if(historicalTupleVersions.length === 0)
    //         return ['strong', {}, 'No history'];
    //     else
    //         return ['table', {class: 'history-table'},
    //                 historicalTupleVersions.map(h=>
    //                     ['tr', {},
    //                      ['td', {}],  // Empty header col
    //                      ['td', {},
    //                       timestamp.formatTimestampAsLocalTime(h.assertion.valid_from)],
    //                      ['td', {},
    //                       timestamp.formatTimestampAsLocalTime(h.assertion.valid_to)],
    //                      view.userScalarViews.map(v=>this.renderScalarCell(ctx, r, v, h, true)),
    //                      ['td', {},
    //                       h.assertion.change_by_username],
    //                     ])
    //                ];
    // }

    async endFieldEdit() {
        console.info('in endFieldEdit');
        for(const fieldView of this.view.userScalarViews) {
            const inputId = `input-${this.assertion.assertion_id}-${fieldView.field.name}`;
            const formValue = await fieldView.loadFromEditor(this.assertion.assertion_id, inputId);
            console.info('formValue is', formValue);
            if(formValue !== undefined) {
                (this.assertion as any)[fieldView.field.bind] = formValue;
            }
        }
    }
}

let taggerChangeListenerInstalled: boolean = false;
function installTaggerChangeListener() {
    if(!taggerChangeListenerInstalled) {
        window.addEventListener('message', taggerChangeListener, false);
        taggerChangeListenerInstalled = true;
    }
}

function taggerChangeListener(e: Event) {
    if((e as any).origin !== window.origin) {
        console.info(`ignoring message from wrong origin ${(e as any).origin}`);
        return;
    }
    const message = (e as any).data;

    console.info('TAGGER CHANGE LISTENER FIRED!', e);
    console.info('message', message);

    switch(message.action) {
        case 'reloadBoundingGroup':
            reloadBoundingGroup(message.boundingGroupId);
            break;
        default:
            throw new Error(`unknown message action ${message.action}`);
    }
}

let entryEditorTupleContextMenu: any|undefined = undefined;
let entryEditorEmptyTupleContextMenu: any|undefined = undefined;

function initEntryEditorContextMenus() {
    entryEditorTupleContextMenu ??= createEntryEditorTupleContextMenu();
    entryEditorEmptyTupleContextMenu ??= createEntryEditorEmptyTupleContextMenu();
}

function createEntryEditorTupleContextMenu(): any {
    const menuItems = [
        { name: 'Edit', fn: (target:Element) => invokeTupleMenuEvent(target, 'edit', 'Edit') },
        {},
        { name: 'Insert Above', fn: (target:Element) => invokeTupleMenuEvent(target, 'insertAbove', 'Insert Above') },
        { name: 'Insert Below', fn: (target:Element) => invokeTupleMenuEvent(target, 'insertBelow', 'Insert Below') },
        {},
        { name: 'Move Up', fn: (target:Element) => invokeTupleMenuEvent(target, 'moveUp', 'Move Up') },
        { name: 'Move Down', fn: (target:Element) => invokeTupleMenuEvent(target, 'moveDown', 'Move Down') },
        {},
        { name: 'Delete', fn: (target:Element) => invokeTupleMenuEvent(target, 'delete', 'Delete') },
    ];
    console.info('Installing TupleContextMenu');
    return new ContextMenu('.tuple-context-menu', menuItems);
}

function createEntryEditorEmptyTupleContextMenu(): any {
    const menuItems = [
        { name: 'Edit', fn: (target:Element) => invokeTupleMenuEvent(target, 'edit', 'Edit') },
    ];
    console.info('Installing EmptyTupleContextMenu');
    return new ContextMenu('.empty-tuple-context-menu', menuItems);
}

function invokeTupleMenuEvent(target:Element, name: string, label: string) {
    console.info('invoke tuple menu on', target);
    const renderRootId = target.getAttribute('data-render-root-id') ?? panic('missing render-root-id');
    const dbTag = target.getAttribute('data-db-tag') ?? panic('missing db-tag');
    const tupleTag = target.getAttribute('data-tuple-tag') ?? panic('missing tuple-tag');
    const tupleId = parseInt(target.getAttribute('data-tuple-id') ?? panic('missing tuple-id'));

    console.info('Invoking', {name, label, renderRootId, dbTag, tupleTag, tupleId});

    switch(name) {
        case 'edit':
            activeViews().editTupleUpdate(renderRootId, dbTag, tupleTag, tupleId);
            break;
        case 'insertAbove':
            activeViews().editNewAbove(renderRootId, dbTag, tupleTag, tupleId);
            break;
        case 'insertBelow':
            activeViews().editNewBelow(renderRootId, dbTag, tupleTag, tupleId);
            break;
        case 'moveUp':
            activeViews().moveUp(renderRootId, dbTag, tupleTag, tupleId);
            break;
        case 'moveDown':
            activeViews().moveDown(renderRootId, dbTag, tupleTag, tupleId);
            break;
        case 'delete':
            activeViews().deleteTuple(renderRootId, dbTag, tupleTag, tupleId);
            break;
        default:
            throw new Error(`unexpected menu item ${name}`);
    }

    
    // these cannot (naturally) be fns (attr values are stringified in our current pipeline -
    // for on* fields, this turns into invokable ..., but not here.

    // look at the events - we didn't like repeating all the stuff anyway.

    // renderRootId, schemaTag, 
    
}

//     return ['div', {class: 'has-context-menu'}, 'CTX ME!'];
// }

// function renderCurrentTupleMenu(renderRootId: string, r: CurrentTupleQuery): Markup {
//     // const insertChildMenuItems =
//     //     r.schema.relationFields.map(c=>
//     //         ['li', {},
//     //          ['a', {class:'dropdown-item', href:'#',
//     //                 onclick:`activeViews().editNewLastChild('${renderRootId}', '${r.schema.schema.tag}', '${r.schema.tag}', ${r.src.id}, '${c.tag}')`},
//     //           `Insert Child ${this.viewTree.relationViewForRelation.get(c)?.prompt}`
//     //          ]]);
//     const insertChildMenuItems: any[] = [];

//     // 'true||undefined' type is convenient for eliding sections of markup.
//     const isLeaf = workspace.isRootTupleId(r.src.id) ? undefined : true;

//     return (
//         ['span', {class:'dropdown'},
//          ['button',
//           {class:'btn btn-secondary dropdown-toggle',
//            type:'button', 'data-bs-toggle':'dropdown', 'aria-expanded':'false'},
//           '≡'],
//          ['ul', {class:'dropdown-menu'},
//           ['li', {}, ['a', {class:'dropdown-item', href:'#', onclick:`activeViews().editTupleUpdate('${renderRootId}', '${r.schema.schema.tag}', '${r.schema.tag}', ${r.src.id})`}, 'Edit']],
//           isLeaf && [
//               ['li', {}, ['a', {class:'dropdown-item', href:'#', onclick:`activeViews().moveUp('${renderRootId}', '${r.schema.schema.tag}', '${r.schema.tag}', ${r.src.id})`}, 'Move Up']],
//               ['li', {}, ['a', {class:'dropdown-item', href:'#', onclick:`activeViews().moveDown('${renderRootId}', '${r.schema.schema.tag}', '${r.schema.tag}', ${r.src.id})`}, 'Move Down']],
//               ['li', {}, ['a', {class:'dropdown-item', href:'#',
//                                 onclick:`activeViews().editNewAbove('${renderRootId}', '${r.schema.schema.tag}', '${r.schema.tag}', ${r.src.id})`}, 'Insert Above']],
//               ['li', {}, ['a', {class:'dropdown-item', href:'#', onclick:`activeViews().editNewBelow('${renderRootId}', '${r.schema.schema.tag}', '${r.schema.tag}', ${r.src.id})`}, 'Insert Below']],
//               insertChildMenuItems,
//               ['li', {}, ['a', {class:'dropdown-item', href:'#', onclick:`activeViews().deleteTuple('${renderRootId}', '${r.schema.schema.tag}', '${r.schema.tag}', ${r.src.id})`}, 'Delete']],
//           ], // isLeaf
//           //['li', {}, ['a', {class:'dropdown-item', href:'#'}, 'Show History']],
//          ]]);
// }

// ----------------------------------------------------------------------------------
// ----------------------------------------------------------------------------------
// ----------------------------------------------------------------------------------

/**
 *
 */
export class FieldToView implements FieldVisitorI<any,View> {
    visitBooleanField(f: BooleanField, v: any): View { return new BooleanView(f); }
    visitIntegerField(f: IntegerField, v: any): View { return new IntegerView(f); }
    visitFloatField(f: FloatField, v: any): View { return new FloatView(f); }
    visitStringField(f: StringField, v: any): View { return new StringView(f); }
    visitEnumField(f: EnumField, v: any): View { return new EnumView(f); }
    visitVariantField(f: VariantField, v: any): View { return new VariantView(f); }
    visitBlobField(f: BlobField, v: any): View { return new BlobView(f); }
    visitAudioField(f: AudioField, v: any): View { return new AudioView(f); }
    visitImageField(f: ImageField, v: any): View { return new ImageView(f); }
    visitIdField(f: IdField, v: any): View { return new IdView(f); }
    visitPrimaryKeyField(f: PrimaryKeyField, v: any): View { return new PrimaryKeyView(f); }
    visitRelationField(f: RelationField, v: any): View {
        const fieldViews = f.fields.map(fieldToView);
        return new RelationView(f, fieldViews);
        // const shape = f.style.$shape;
        // switch(f.style.$shape) {
        //     case 'inlineListRelation':
        //         return new InlineListRelationView(f, fieldViews);
        //     case 'compactInlineListRelation':
        //         return new CompactInlineListRelationView(f, fieldViews);
        //     case 'containerRelation':
        //         return new ContainerRelationView(f, fieldViews);
        //     default:
        //         throw new Error(`invalid or missing $shape '${shape}' for relation field '{f.name}'`);
        // }
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

export function renderModalEditorSkeleton() {

    return [
        // Add 'fade' to class list for modal fade effect
        ['div', {class: 'modal',  id:'modalEditor',
                 'data-bs-backdrop':'static', 'data-bs-keyboard':'false',
                 tabindex:'-1', 'aria-labelledby':'modalEditorLabel',
                 'aria-hidden':'true'},
         //['div', {class:'modal-dialog modal-dialog-scrollable modal-fullscreen'},
          ['div', {class:'modal-dialog modal-dialog-scrollable modal-lg'},

          ['div', {class:'modal-content'},

           ['div', {class:'modal-header'},
            ['h1', {class:'modal-title fs-5', id:'modalEditorLabel'},
             'Edit'],
            ['button', {type:'button', class:'btn-close', 'data-bs-dismiss':'modal',
                        'aria-label':'Close'}]

           ], // div.modal-header

           ['div', {class:'modal-body', id:'modalEditorBody'}

           ], // div.modal-body

           // ['div', {class:'modal-footer'},
           //  ['button', {type:'button', class:'btn btn-secondary',
           //              'data-bs-dismiss':'modal',
           //              //onclick:'activeViews().saveChanges()'}, 'Save']
           //              onclick:'location.reload()'}, 'Close']
           // ], // div.modal-footer

          ] // div.modal-content

         ] // div.modal-dialog

        ] // div.modal
    ];

}

/**
 *
 */
export function initPopupEntryEditor() {

}

/**
 * This editor expects to run in an environment where the bootstrap JS code
 * has been loaded as a script.  This function packages accessing the bootstrap
 * global inst via the browser window object.
 */
export function getGlobalBoostrapInst() {
    return (window as any)?.bootstrap
        ?? panic("can't find global bootstrap inst");
}

/**
 *
 */
export async function popupEntryEditor(title: string,
                                       entryId: number,
                                       nestedTypeTag:string='ent',
                                       nestedId:number=entryId,
                                       restrictToRelation:string|undefined = undefined) {
    await entryEditor(title, entryId, nestedTypeTag, nestedId, restrictToRelation);
    getGlobalBoostrapInst().Modal.getOrCreateInstance('#modalEditor').show();
}

/**
 *
 * TODO: firing this again while it is loading will (like on a slow connection) needs
 *       some protection.
 */
export async function entryEditor(title: string,
                                  entryId: number,
                                  nestedTypeTag:string='ent',
                                  nestedId:number=entryId,
                                  restrictToRelation:string|undefined = undefined,
                                  viewId:string = 'modalEditor') {

    initEntryEditorContextMenus();
    installTaggerChangeListener();
    
    // TODO make this less weird
    const assertions = await rpc`getAssertionsForEntry(${entryId})`;

    dropActiveViewsAndWorkspace();

    const views = activeViews();

    const dictSchema = model.Schema.parseSchemaFromCompactJson('dict', dictSchemaJson);
    views.workspace.addTable(dictSchema);

    assertions.forEach((a:Assertion)=>views.workspace.untrackedApplyAssertion(a));

    const dictView = schemaView(dictSchema);

    let query: ()=>CurrentTupleQuery|CurrentRelationQuery;
    if(restrictToRelation)
        query = ()=>new CurrentTupleQuery(
            views.workspace.getVersionedTupleById('dct', nestedTypeTag, nestedId)
                ?? panic('unable to find entry', entryId)).childRelations[restrictToRelation]
        ?? panic('unable to find relation to view', restrictToRelation);
    else
        query = ()=>new CurrentTupleQuery(
            views.workspace.getVersionedTupleById('dct', nestedTypeTag, nestedId) ?? panic('unable to find entry', entryId));

    // query = ()=>new CurrentRelationQuery(
    //     views.workspace.getVersionedTupleById('dct', nestedTypeTag, nestedId) ?? panic('unable to find entry', entryId));        


    // const dictQuery = ()=>new CurrentTupleQuery(
    //     views.workspace.getVersionedTupleById('dct', nestedTypeTag, nestedId) ?? panic('unable to find entry', entryId));
    // const entriesQuery = ()=>{
    //     const dict = views.workspace.getVersionedTupleById('dct', nestedTypeTag, nestedId) ?? panic('unable to find entry', entryId));

    // };
    // HERE WORKING HERE HERE WORKING HERE !!!
    // WE need 
    
    views.registerActiveView(new ActiveView(viewId, title, dictView, query));

    views.rerenderAllViews();


    //console.info('Assertions', JSON.stringify(assertions, undefined, 2));

}

/**
 * XXX todo this is panic written proto crap that should be redone and moved!
 */
export function launchAddNewDocumentReference(entry_id: number, subentry_id: number, friendly_document_id: string, title?: string) {
    console.info('*** Launching add new document reference', entry_id, subentry_id, friendly_document_id, title);
    // Await an RPC that does the data changes.
    // When the RPC returns, navigate to the URL that is returned.
    (async ()=>{
        const editorUrl = await rpc`wordwiki.addNewDocumentReference(${entry_id}, ${subentry_id}, ${friendly_document_id}, ${title})`;
        console.info('*** Editor URL is', editorUrl);
        window.open(editorUrl.location, '_blank');
    })();
}

/**
 * XXX todo this is panic written proto crap that should be redone and moved!
 */
export function launchAddNewDocumentReference2(entry_id: number, subentry_id: number, referenceFieldName: string, friendly_document_id: string, title?: string) {
    console.info('LA2', activeViews().currentlyOpenTupleEditor);
    (async ()=>
        launchAddNewDocumentReference3(entry_id, subentry_id, referenceFieldName, friendly_document_id, title))();
}

export async function launchAddNewDocumentReference3(entry_id: number, subentry_id: number, referenceFieldName: string, friendly_document_id: string, title?: string) {

    // --- Create a new empty bounding group on the specified document.
    const {group_id, layer_id, reference_layer_id, first_page_id} = await rpc`createNewEmptyBoundingGroupForFriendlyDocumentId(${friendly_document_id})` as {group_id: number, layer_id: number, reference_layer_id: number, first_page_id: number};
    console.info('got new group id', group_id, 'in layer', layer_id);

    // --- FIX
    // We are directly updating the assertion in the tuple editor, then
    // triggering endFieldEdit (which will save the assertion under edit, then
    // remove the trigger editor).  This is backdoor hacky stuff and should
    // be refactored to be something more reasonable.
    // WE are also relying on the fact that we don't reload the assertion value
    //    for boundingGroup fields (in fact for any integer at present!!!) - so
    //    this is a minefield!
    const currentlyOpenTupleEditor = activeViews().currentlyOpenTupleEditor ?? panic('no currently open tuple editor');
    // WOW INTO THE SEWER WITH THE ATTR1 HERE!!! BAD BAD BAD
    // (THIS IS BYPASSING OUR SCHEMA LAYERS AND WRITING DIRECTLY TO THE ASSERTION)
    // NO END OF EASY DOOM FROM DOING STUFF LIKE THIS.
    (currentlyOpenTupleEditor.assertion as any)['attr1'] = group_id;

    // Note: we are not awaiting this promise - that is fine.
    activeViews().endFieldEdit();


    // --- Launch the bounding box editor on the new bounding box.
    const pageEditorConfig: PageEditorConfig = {
        layer_id,
        reference_layer_ids: [reference_layer_id],
        title,
        is_popup_editor: true,
        locked_bounding_group_id: group_id,
    };


    // TODO TRIGGER EDTIOR SAVE - WE ARE NOT PRESENTLY SAVING !!@
    
    const taggerUrl = `/ww/renderPageEditorByPageId(${first_page_id}, ${JSON.stringify(pageEditorConfig)})`;
    console.info('*** Editor URL is', taggerUrl);
    window.open(taggerUrl, '_blank');
}

// XXX XXX KIWLL ME!!! I AM bAD
export function launchNewLexeme() {
    console.info('*** Launching new lexeme');
    // Await an RPC that does the data changes.
    // When the RPC returns, navigate to the URL that is returned.
    (async ()=>{
        const lexemeUrl = (await rpc`wordwiki.addNewLexeme()`).location;
        console.info('*** Lexeme URL is', lexemeUrl);
        window.location = lexemeUrl;
    })();
}


/**
 *
 */
export async function run() {
    return;

    console.info('rendering sample 2');
    const views = activeViews();

    const dictSchema = model.Schema.parseSchemaFromCompactJson('dict', dictSchemaJson);
    views.workspace.addTable(dictSchema);

    const dictView = schemaView(dictSchema);

    views.registerActiveView(
        new ActiveView('root',
                       'Edit ENTRY',
                       dictView,
                       ()=>new CurrentTupleQuery(views.workspace.getTableByTag('dct'))));

    // const root = document.getElementById('root') ?? panic();
    // root.innerHTML = 'POW!';

    // TODO make this less weird
    const entryId = 1000;
    const assertions = await rpc`getAssertionsForEntry(${entryId})`;
    //console.info('Assertions', JSON.stringify(assertions, undefined, 2));
    assertions.forEach((a:Assertion)=>views.workspace.untrackedApplyAssertion(a));


    activeViews().rerenderAllViews();
}

export const exportToBrowser = ()=> ({
    activeViews,
    run,
    popupEntryEditor,
    entryEditor,
    //entryEditor2,
    launchAddNewDocumentReference,
    launchAddNewDocumentReference2,
    launchNewLexeme,
    //popupRelationEditor,
    //beginFieldEdit,
});

export const routes = ()=> ({
});
