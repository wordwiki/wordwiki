// deno-lint-ignore-file no-explicit-any
/**
 * Lexeme Editor v2 - the server-side htmx lexeme editor.
 *
 * A parallel replacement for the client-side editor in datawiki/view.ts,
 * built on the liminal htmx editing model (see lexeme-editor-design.md):
 *
 *  - the entry renders server-side with every tuple an editable surface
 *    (tap/pencil opens a dialog);
 *  - every mutation is an action in one of three forms (immediate / confirm /
 *    modal collecting the action's arguments);
 *  - dialogs are generated server-side from the soft schema's metadata, so
 *    schema changes need no editor changes;
 *  - saves build a new assertion ON THE SERVER and run it through the
 *    existing applyTransaction; the affected fragment then reloads in place.
 *
 * Refresh scope is three-level (self / parent / root): a field edit reloads
 * just the tuple's surface, a structural change (insert/delete/move/restore-
 * after-delete) reloads the containing relation, and anything touching a
 * spelling reloads the whole entry (spellings feed the heading).  All three
 * levels are reloadable fragments tagged -fact-<id>- / -rel-<parent>-<tag>- /
 * -entry-<id>-.
 *
 * Edit-conflict protection is the assertion model's own: the dialog carries
 * replaces_assertion_id, and a save against a tuple someone else re-asserted
 * is refused with an alert (nothing is ever overwritten - see
 * assertion-model.md).  The same property gives us history and undo: the
 * history dialog lists a fact's versions, and "restore" simply re-asserts an
 * old version's values as a new assertion.
 *
 * Remaining v1 scope notes:
 *  - image fields render read-only (the picture relation keeps its old flow
 *    until an image counterpart of the audio eager-upload widget exists);
 *  - every assertion this editor creates is stamped with change_by_username
 *    from the logged-in session (see changeStamp());
 *  - audio upload is eager: picking a file uploads it immediately (the
 *    existing uploadRecording endpoint) and the form carries the returned
 *    content-store path (see lmAudioUploadChange in
 *    resources/lexeme-editor-scripts.js);
 *  - document references are created via the per-book "+" buttons: the server
 *    creates the bounding group + ref assertion, then the page tagger opens in
 *    a popup; on "Done editing reference" the tagger posts a message that
 *    reloads the reference's fragment (listener in lexeme-editor-scripts.js).
 */
import * as model from '../datawiki/model.ts';
import * as workspace from '../datawiki/workspace.ts';
import {VersionedTuple, CurrentTupleQuery, TupleVersion} from '../datawiki/workspace.ts';
import {Assertion, getAssertionPath, assertionPathToFields, BoundingGroup,
        selectScannedDocumentByFriendlyId, selectScannedPageByPageNumber,
        getOrCreateNamedLayer} from './schema.ts';
import * as timestamp from '../liminal/timestamp.ts';
import * as orderkey from '../liminal/orderkey.ts';
import * as table from '../liminal/table.ts';
import * as action from '../liminal/action.ts';
import {Markup} from '../liminal/markup.ts';
import {panic} from '../liminal/utils.ts';
import * as utils from '../liminal/utils.ts';
import * as random from '../liminal/random.ts';
import {db} from '../liminal/db.ts';
import * as audio from './audio.ts';
import * as templates from './templates.ts';
import * as entrySchema from './entry-schema.ts';
import type {PageEditorConfig} from '../scannedpage/render-page-editor.ts';
import type {WordWiki} from './wordwiki.ts';

// All editor routes live under /ww/ (wordwiki's route mount); tx`...` calls use
// page-relative exprs, which resolve under /ww/ because the editor pages
// themselves live there.  hx-get URLs are absolute so they work from any page.
const R = '/ww/wordwiki.lexeme';

// The reference books offered by the per-book "add document reference"
// buttons (the same set the navbar and home page link to).
const REFERENCE_BOOKS = ['PDM', 'Rand', 'Clark', 'PacifiquesGeography', 'RandFirstReadingBook'];

// ---------------------------------------------------------------------------
// --- Soft-schema field -> liminal widget adapter ----------------------------
// ---------------------------------------------------------------------------
//
// Dialogs are built with action.renderParamForm over liminal/table.ts Field
// widgets.  This adapter maps the soft schema's field classes onto those
// widgets (by field NAME; the $bind -> attrN mapping is applied only when the
// parsed values are written into an assertion, in setAssertionFields).
// If this shape sticks, fold the widget interface into datawiki/model.ts and
// delete the adapter.

// A multi-line text widget (the soft schema's $height drives textarea use;
// liminal's StringField is single-line only).
class TextAreaField extends table.StringField {
    constructor(name: string, public rows: number, options: table.FieldOptions = {}) {
        super(name, options);
    }
    override renderInput(value: any): Markup {
        return [
            ['div', {'class':'col-12'},
             ['label', {for:'input-'+this.name, class:'form-label'}, this.prompt],
             ['textarea', {class:'form-control', name:this.name, id:'input-'+this.name,
                           rows:this.rows},
              String(value ?? '')]
            ]];
    }
}

/**
 * Audio with eager upload: the field's value (a content-store path) lives in a
 * hidden input; picking a file uploads it immediately via the existing
 * uploadRecording endpoint (lmAudioUploadChange in lexeme-editor-scripts.js)
 * and writes the returned path into the hidden input, so the normal form
 * submit just carries a string.  An abandoned dialog leaves an orphaned blob
 * in the content-addressed store, which is harmless.
 */
class AudioUploadField extends table.StringField {
    override renderInput(value: any): Markup {
        const inputId = 'input-'+this.name;
        return [
            ['div', {'class':'col-12'},
             ['label', {class:'form-label'}, this.prompt],
             value ? ['div', {class:'mb-1'},
                      audio.renderAudio(String(value), '🔉 Current recording', undefined, '/')]
                   : undefined,
             ['input', {type:'hidden', name:this.name, id:inputId, value: value ?? ''}],
             ['input', {type:'file', class:'form-control', accept:'.wav,audio/*',
                        onchange:`lmAudioUploadChange(event, '${inputId}')`}],
             ['div', {class:'form-text', id:inputId+'-status'},
              value ? 'Choose a file to replace the current recording.'
                    : 'Choose a recording file to upload.'],
            ]];
    }
}

/**
 * Fields that cannot be edited through a dialog yet: images (need an image
 * counterpart of the audio eager-upload widget) and bounding-group references
 * (created through the per-book buttons + the page tagger).  They render
 * read-only in the entry view, are omitted from dialogs, and their values are
 * preserved across an edit (the save merges parsed changes over the current
 * tuple's values).
 */
function isDialogReadOnly(f: model.ScalarField): boolean {
    return f instanceof model.ImageField
        || isBoundingGroupField(f);
}

function isBoundingGroupField(f: model.ScalarField): boolean {
    return f instanceof model.IntegerField && f.style.$shape === 'boundingGroup';
}

/** The soft-schema fields that become dialog inputs for a relation. */
function dialogFields(rel: model.RelationField): model.ScalarField[] {
    return rel.scalarFields.filter(f =>
        !(f instanceof model.PrimaryKeyField) && !isDialogReadOnly(f));
}

function widgetFor(f: model.ScalarField): table.Field {
    // NOTE: instanceof order matters - the soft schema's field classes form
    // a hierarchy (Variant < Enum < String, Audio/Image < Blob < String).
    if(f instanceof model.VariantField)
        return new table.EnumField(f.name, entrySchema.variants, {nullable: true, prompt: f.prompt});
    if(f instanceof model.EnumField)
        return new table.EnumField(f.name, (f.style as any).$options ?? {},
                                   {nullable: f.optional, prompt: f.prompt});
    if(f instanceof model.AudioField)
        return new AudioUploadField(f.name, {nullable: true, prompt: f.prompt});
    if(f instanceof model.BooleanField)
        return new table.BooleanField(f.name, {nullable: true, prompt: f.prompt});
    if(f instanceof model.StringField) {
        if(f.style.$height)
            return new TextAreaField(f.name, f.style.$height, {nullable: true, prompt: f.prompt});
        return new table.StringField(f.name, {nullable: true, prompt: f.prompt});
    }
    if(f instanceof model.IntegerField)
        return new table.IntegerField(f.name, {nullable: f.optional, prompt: f.prompt});
    if(f instanceof model.FloatField)
        return new table.FloatingPointField(f.name, {nullable: f.optional, prompt: f.prompt});
    throw new Error(`no dialog widget for soft-schema field '${f.name}' (${f.schemaTypename()})`);
}

/**
 * Parse the dialog inputs for a relation out of a submitted form.  Returns
 * only the CHANGED fields (the widgets' parseInput compares each input to its
 * before-<name> snapshot, which the dialog generators supply as hidden params).
 */
function parseDialogFields(rel: model.RelationField, form: Record<string, any>): Record<string, any> {
    const changed: Record<string, any> = {};
    for(const f of dialogFields(rel))
        widgetFor(f).parseInput(form, changed);
    return changed;
}

/**
 * Write domain values (keyed by field NAME) into an assertion's bound columns
 * (attr1..attrN / variant), for every non-pk scalar field of the relation.
 * Absent values write null - callers pass a complete value set (current
 * values merged with parsed changes).
 */
function setAssertionFields(assertion: Assertion, rel: model.RelationField,
                            values: Record<string, any>): void {
    for(const f of rel.scalarFields) {
        if(f instanceof model.PrimaryKeyField) continue;
        (assertion as any)[f.bind] = values[f.name] ?? null;
    }
}

// New fact/assertion ids use the same scheme as the rest of the system (see
// the id-allocation TODOs in assertion-model.md) - but now allocated in one
// place, on the server.
function newId(): number {
    return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

// Placeholder tx time: applyTransaction rewrites every assertion in the tx to
// a freshly allocated server timestamp (it only requires the tx's assertions
// to share this placeholder, and tombstones to have valid_to === valid_from).
function placeholderTxTime(): number {
    return timestamp.nextTime(timestamp.BEGINNING_OF_TIME);
}

// A tombstone marks a deletion: a version whose valid period is empty.
function isTombstone(a: Assertion): boolean {
    return a.valid_from === a.valid_to;
}

// ---------------------------------------------------------------------------
// --- The editor --------------------------------------------------------------
// ---------------------------------------------------------------------------

export class LexemeEditor {

    constructor(public app: WordWiki) {
    }

    // ------------------------------------------------------------------------
    // --- Page + fragments ----------------------------------------------------
    // ------------------------------------------------------------------------

    entryPage(entry_id: number): templates.Page {
        const e = this.app.entriesById.get(entry_id);
        const title = e ? entrySchema.renderEntrySpellingsSummary(e) : `Entry ${entry_id}`;
        return templates.page(title, this.renderEntry(entry_id));
    }

    /** The root-level fragment: the whole entry (heading + all relations). */
    renderEntry(entry_id: number): Markup {
        const entryTuple = this.entryTuple(entry_id);
        const q = new CurrentTupleQuery(entryTuple);
        const e = this.app.entriesById.get(entry_id);
        const heading = e ? entrySchema.renderEntrySpellingsSummary(e) : `Entry ${entry_id}`;
        return (
            ['div', {class: `-entry-${entry_id}- container py-3`,
                     'hx-get': `${R}.renderEntry(${entry_id})`,
                     'hx-trigger': 'reload', 'hx-swap': 'outerHTML'},
             ['h2', {}, heading || 'No spellings'],
             this.renderChildRelations(entry_id, q),
            ]);
    }

    /** The parent-level fragment: one relation (header + its tuples). */
    renderRelationFragment(entry_id: number, parent_fact_id: number, tag: string): Markup {
        const parent = this.findTupleInEntry(entry_id, parent_fact_id);
        const rf = parent.schema.relationFields.find(r => r.tag === tag)
            ?? panic('no child relation', `${tag} on ${parent.schema.tag}`);
        const pq = new CurrentTupleQuery(parent);
        return this.renderRelation(entry_id, parent_fact_id, rf, pq.childRelations[tag]);
    }

    /** The self-level fragment: one tuple's editable surface. */
    renderTupleFragment(entry_id: number, fact_id: number): Markup {
        const tuple = this.findTupleInEntry(entry_id, fact_id);
        const tq = new CurrentTupleQuery(tuple);
        return this.renderTupleSurface(entry_id, tuple.schema, tq,
                                       this.surfaceClasses(tuple.schema));
    }

    // ------------------------------------------------------------------------
    // --- Metadata-driven rendering -------------------------------------------
    // ------------------------------------------------------------------------

    private surfaceClasses(rf: model.RelationField): string {
        return rf.style.$shape === 'containerRelation'
            ? '' : 'list-group-item list-group-item-action lm-item';
    }

    private renderChildRelations(entry_id: number, parentQ: CurrentTupleQuery): Markup {
        return parentQ.schema.relationFields.map(rf =>
            this.renderRelation(entry_id, parentQ.src.id, rf, parentQ.childRelations[rf.tag]));
    }

    private renderRelation(entry_id: number, parent_fact_id: number,
                           rf: model.RelationField, rq: workspace.CurrentRelationQuery): Markup {
        const fragmentProps = {
            class: `lex-relation mt-2 -rel-${parent_fact_id}-${rf.tag}-`,
            'hx-get': `${R}.renderRelationFragment(${entry_id}, ${parent_fact_id}, '${rf.tag}')`,
            'hx-trigger': 'reload', 'hx-swap': 'outerHTML',
        };
        const header =
            ['div', {class:'d-flex align-items-center gap-2 lex-relation-header'},
             ['span', {class:'fw-bold'}, rf.prompt],
             this.addButtons(entry_id, parent_fact_id, rf),
             this.deletedButton(entry_id, parent_fact_id, rf, rq)];

        switch(rf.style.$shape) {
            case 'containerRelation':
                return ['div', {...fragmentProps, class: fragmentProps.class + ' mt-3'},
                        header,
                        rq.tuples.map(tq =>
                            ['div', {class:'card mt-1 mb-2'},
                             ['div', {class:'card-body py-2'},
                              this.renderTupleSurface(entry_id, rf, tq),
                              ['div', {class:'ms-4'},
                               this.renderChildRelations(entry_id, tq)]]])];
            case 'inlineListRelation':
            case 'compactInlineListRelation':
            default:
                return ['div', fragmentProps,
                        header,
                        ['div', {class:'list-group lm-list'},
                         rq.tuples.map(tq => this.renderTupleSurface(
                             entry_id, rf, tq, this.surfaceClasses(rf)))]];
        }
    }

    /**
     * One tuple as an editable surface (and a self-level reloadable fragment):
     * the whole area opens the edit dialog (delegating to the contained
     * pencil - the visible affordance cue).
     */
    private renderTupleSurface(entry_id: number, rf: model.RelationField,
                               tq: CurrentTupleQuery, extraClasses: string = ''): Markup {
        const fact_id = tq.src.id;
        const current = tq.mostRecentTupleVersion;
        if(!current) return [];
        return (
            ['div', {class: `-fact-${fact_id}- lm-editable d-flex align-items-start ${extraClasses}`,
                     'hx-get': `${R}.renderTupleFragment(${entry_id}, ${fact_id})`,
                     'hx-trigger': 'reload', 'hx-swap': 'outerHTML',
                     onclick: 'lmEditableClick(event)'},
             ['div', {class:'flex-grow-1'}, this.renderTupleValues(rf, current)],
             this.editPencil(entry_id, fact_id),
            ]);
    }

    private renderTupleValues(rf: model.RelationField, tv: TupleVersion): Markup {
        const parts = rf.scalarFields
            .filter(f => !(f instanceof model.PrimaryKeyField))
            .map(f => this.renderFieldValue(f, (tv.assertion as any)[f.bind]))
            .filter(p => p !== undefined);
        return parts.length === 0
            ? ['span', {class:'text-muted'}, '(empty)']
            : parts.map(p => [p, ' ']);
    }

    private renderFieldValue(f: model.ScalarField, v: any): Markup|undefined {
        if(v === null || v === undefined || v === '') return undefined;
        if(f instanceof model.AudioField)
            return audio.renderAudio(String(v), '🔉 Recording', undefined, '/');
        if(f instanceof model.ImageField)
            return ['img', {src: '/'+String(v), style: 'max-width: 10em; max-height: 10em;'}];
        if(f instanceof model.VariantField)
            return ['span', {class:'badge text-bg-light'}, entrySchema.variants[v] ?? String(v)];
        if(f instanceof model.EnumField) {
            const options = (f.style as any).$options as Record<string,string>|undefined;
            return ['span', {}, options?.[v] ?? String(v)];
        }
        if(f instanceof model.BooleanField)
            return ['span', {}, f.prompt, ': ', v ? 'Yes' : 'No'];
        if(isBoundingGroupField(f))
            // The reference image; clicking opens the page tagger on its group
            // (stopPropagation so the surrounding editable surface doesn't also
            // open the edit dialog).
            return ['div', {onclick: `event.stopPropagation(); window.open('/ww/forwardToSingleBoundingGroupEditorURL(${v}, null)')`},
                    ['object', {style: 'pointer-events: none;',
                                data: `/ww/renderStandaloneGroupAsSvgResponse('/', ${v})`,
                                type: 'image/svg+xml'}]];
        return ['span', {}, String(v)];
    }

    private editPencil(entry_id: number, fact_id: number): Markup {
        return ['button', {...table.editButtonProps(`${R}.editDialog(${entry_id}, ${fact_id})`),
                           class: 'edit lm-edit-pencil', type: 'button', 'aria-label': 'Edit'},
                table.pencilIcon()];
    }

    /**
     * The relation header's add affordance.  Three cases by metadata:
     * a bounding-group relation gets one button per reference book (create
     * group + ref, then open the tagger); an image relation gets nothing yet;
     * everything else gets the generic "+" (insert dialog).
     */
    private addButtons(entry_id: number, parent_fact_id: number, rf: model.RelationField): Markup {
        if(rf.scalarFields.some(isBoundingGroupField))
            return REFERENCE_BOOKS.map(book => action.actionButton('+ ' + book,
                {kind: 'immediate',
                 expr: `wordwiki.lexeme.addDocumentReference(${entry_id}, ${parent_fact_id}, '${rf.tag}', '${book}')`},
                'btn btn-sm btn-outline-primary lex-add-btn py-0 px-1'));
        if(rf.scalarFields.some(isDialogReadOnly))
            return [];
        return action.actionButton('+',
            {kind: 'modal', dialogUrl: `${R}.insertDialog(${entry_id}, ${parent_fact_id}, '${rf.tag}')`},
            'btn btn-sm btn-outline-primary lex-add-btn py-0 px-1');
    }

    // A subtle "n deleted" affordance when the relation has tombstoned tuples;
    // opens the deleted-items dialog (with restore buttons).
    private deletedButton(entry_id: number, parent_fact_id: number,
                          rf: model.RelationField, rq: workspace.CurrentRelationQuery): Markup {
        const deletedCount = this.deletedTuples(rq).length;
        if(deletedCount === 0) return [];
        return action.actionButton(`${deletedCount} deleted`,
            {kind: 'modal', dialogUrl: `${R}.deletedDialog(${entry_id}, ${parent_fact_id}, '${rf.tag}')`},
            'btn btn-sm btn-link text-muted p-0 lex-deleted-btn');
    }

    private deletedTuples(rq: workspace.CurrentRelationQuery): VersionedTuple[] {
        return [...rq.src.tuples.values()].filter(t =>
            t.mostRecentTuple !== undefined && !t.mostRecentTuple.isCurrent);
    }

    // ------------------------------------------------------------------------
    // --- Dialogs --------------------------------------------------------------
    // ------------------------------------------------------------------------

    /**
     * The edit dialog for an existing tuple: the relation's fields as widgets
     * over the current values, plus the tuple's secondary actions.  Hidden
     * params carry the addressing and the conflict guard
     * (replaces_assertion_id).
     */
    editDialog(entry_id: number, fact_id: number): Markup {
        const tuple = this.findTupleInEntry(entry_id, fact_id);
        const rel = tuple.schema;
        const current = tuple.mostRecentTuple ?? panic('no current version for', fact_id);

        const fields = dialogFields(rel);
        const widgets = fields.map(widgetFor);
        const defaults = current.domainFields;

        const hidden: Record<string, any> = {
            entry_id, fact_id,
            replaces_assertion_id: current.assertion.assertion_id,
        };
        // The before-<name> snapshots parseInput compares against (only fields
        // the user actually changed are parsed out of the postback).
        fields.forEach((f, i) => hidden['before-'+f.name] = widgets[i].toFormValue(defaults[f.name]));

        const form = action.renderParamForm(widgets, defaults, {
            title: `Edit ${rel.prompt}`,
            submitLabel: 'Save',
            hidden,
            dispatch: {id: 'edit-form',
                       onsubmit: 'event.preventDefault(); tx`wordwiki.lexeme.saveTuple(${getFormJSON(event.target)})`'},
        });

        // Self-lift (deferred - the script runs during insertion, before its
        // sibling elements exist): this dialog is also reachable from WITHIN
        // the modal (the history dialog's "Back to edit"), where the issuing
        // button is detached by its own swap before after-request can fire.
        // showModalEditor composes safely with the page-pencil path (it keeps
        // the header when the title has already been lifted).
        return [['script', {}, 'setTimeout(showModalEditor)'],
                form,
                this.renderSecondaryActions(entry_id, fact_id, rel)];
    }

    // The tuple's secondary actions (move/delete/history) live in the dialog,
    // keeping the read surface to a single affordance.
    private renderSecondaryActions(entry_id: number, fact_id: number, rel: model.RelationField): Markup {
        return (
            ['div', {class:'d-flex gap-2 mt-4 pt-2 border-top flex-wrap'},
             action.actionButton('Move up',
                 {kind: 'immediate', expr: `wordwiki.lexeme.move(${entry_id}, ${fact_id}, 'up')`},
                 'btn btn-sm btn-outline-secondary'),
             action.actionButton('Move down',
                 {kind: 'immediate', expr: `wordwiki.lexeme.move(${entry_id}, ${fact_id}, 'down')`},
                 'btn btn-sm btn-outline-secondary'),
             action.actionButton('History',
                 {kind: 'modal', dialogUrl: `${R}.historyDialog(${entry_id}, ${fact_id})`},
                 'btn btn-sm btn-outline-secondary'),
             action.actionButton('Delete',
                 {kind: 'confirm', expr: `wordwiki.lexeme.deleteTuple(${entry_id}, ${fact_id})`,
                  message: `Delete this ${rel.prompt}?`},
                 'btn btn-sm btn-outline-danger ms-auto'),
            ]);
    }

    /**
     * The insert dialog: the same record form over an empty tuple, with the
     * insert position (parent + relation tag) as hidden params.  Inserts at
     * the end of the relation; the new tuple can then be moved.
     */
    insertDialog(entry_id: number, parent_fact_id: number, child_tag: string): Markup {
        const parent = this.findTupleInEntry(entry_id, parent_fact_id);
        const rel = parent.childRelations[child_tag]?.schema
            ?? panic('no child relation', `${child_tag} on ${parent.schema.tag}`);

        const fields = dialogFields(rel);
        const widgets = fields.map(widgetFor);

        const hidden: Record<string, any> = {entry_id, parent_fact_id, child_tag};
        fields.forEach(f => hidden['before-'+f.name] = '');

        // Self-lift, as in editDialog (composable wherever it is loaded from).
        return [['script', {}, 'setTimeout(showModalEditor)'],
                action.renderParamForm(widgets, {}, {
                    title: `New ${rel.prompt}`,
                    submitLabel: 'Save',
                    hidden,
                    dispatch: {id: 'edit-form',
                               onsubmit: 'event.preventDefault(); tx`wordwiki.lexeme.saveTuple(${getFormJSON(event.target)})`'},
                })];
    }

    /**
     * The history dialog: every version of a fact, newest first, with a
     * restore button on the non-current ones.  "Restore" never mutates - it
     * re-asserts the old version's values as a NEW assertion (the undo model:
     * mutes are not allowed).
     */
    historyDialog(entry_id: number, fact_id: number): Markup {
        const tuple = this.findTupleInEntry(entry_id, fact_id);
        const rel = tuple.schema;
        const versions = tuple.tupleVersions.toReversed();
        const mostRecent = tuple.mostRecentTuple;

        return [
            // This dialog is opened from a button INSIDE the modal body, which
            // the swap detaches before its own after-request can fire - so the
            // content lifts its own title (htmx executes swapped-in scripts).
            // Deferred a tick: the script runs during node insertion, before
            // the sibling title element below exists.
            ['script', {}, 'setTimeout(showModalEditor)'],
            ['h2', {class: 'lm-dialog-title h5'}, `History of ${rel.prompt}`],
            // The way back to the assertion this is the history OF.
            ['div', {class: 'mb-2'},
             action.actionButton('← Back to edit',
                 {kind: 'modal', dialogUrl: `${R}.editDialog(${entry_id}, ${fact_id})`},
                 'btn btn-sm btn-outline-secondary')],
            ['div', {class:'list-group lm-list'},
             versions.map(v => {
                 const a = v.assertion;
                 const isCurrent = a.assertion_id === mostRecent?.assertion.assertion_id && v.isCurrent;
                 return ['div', {class:'list-group-item d-flex align-items-start gap-2'},
                         ['div', {class:'flex-grow-1'},
                          ['div', {class:'small text-muted'},
                           timestamp.formatTimestampAsLocalTime(a.valid_from),
                           a.change_by_username ? ` — ${entrySchema.users[a.change_by_username] ?? a.change_by_username}` : ''],
                          isTombstone(a)
                             ? ['span', {class:'text-danger'}, '(deleted)']
                             : this.renderTupleValues(rel, v)],
                         isCurrent
                            ? ['span', {class:'badge text-bg-success'}, 'Current']
                            : isTombstone(a)
                            ? []
                            : action.actionButton('Restore',
                                {kind: 'confirm',
                                 expr: `wordwiki.lexeme.restoreVersion(${entry_id}, ${fact_id}, ${a.assertion_id})`,
                                 message: `Restore this version of ${rel.prompt}?`},
                                'btn btn-sm btn-outline-secondary')];
             })],
        ];
    }

    /**
     * The deleted-items dialog for a relation: each tombstoned tuple's last
     * real values, with a restore button (re-asserts that version over the
     * tombstone, starting a new valid period).
     */
    deletedDialog(entry_id: number, parent_fact_id: number, child_tag: string): Markup {
        const parent = this.findTupleInEntry(entry_id, parent_fact_id);
        const rel = parent.childRelations[child_tag]?.schema
            ?? panic('no child relation', `${child_tag} on ${parent.schema.tag}`);
        const pq = new CurrentTupleQuery(parent);
        const deleted = this.deletedTuples(pq.childRelations[child_tag]);

        return [
            // Self-lift, as in historyDialog (this dialog is reachable from
            // both the page header and, conceivably, from within the modal).
            ['script', {}, 'setTimeout(showModalEditor)'],
            ['h2', {class: 'lm-dialog-title h5'}, `Deleted ${rel.prompt} items`],
            deleted.length === 0
                ? ['p', {class:'text-muted'}, 'Nothing deleted here.']
                : ['div', {class:'list-group lm-list'},
                   deleted.map(t => {
                       const lastReal = t.tupleVersions.findLast(v => !isTombstone(v.assertion));
                       const deletedAt = t.mostRecentTuple?.assertion.valid_from;
                       return ['div', {class:'list-group-item d-flex align-items-start gap-2'},
                               ['div', {class:'flex-grow-1'},
                                ['div', {class:'small text-muted'},
                                 'deleted ', deletedAt !== undefined ? timestamp.formatTimestampAsLocalTime(deletedAt) : ''],
                                lastReal ? this.renderTupleValues(rel, lastReal)
                                         : ['span', {class:'text-muted'}, '(no recorded values)']],
                               lastReal
                                  ? action.actionButton('Restore',
                                      {kind: 'confirm',
                                       expr: `wordwiki.lexeme.restoreVersion(${entry_id}, ${t.id}, ${lastReal.assertion.assertion_id})`,
                                       message: `Restore this ${rel.prompt}?`},
                                      'btn btn-sm btn-outline-secondary')
                                  : []];
                   })],
        ];
    }

    // ------------------------------------------------------------------------
    // --- Actions --------------------------------------------------------------
    // ------------------------------------------------------------------------

    /**
     * Save a dialog postback - the one generic endpoint for both edit (has
     * fact_id) and insert (has parent_fact_id + child_tag); the soft schema
     * supplies everything else.
     */
    saveTuple(form: Record<string, any>): any {
        if(form.fact_id !== undefined && form.fact_id !== '')
            return this.saveEdit(form);
        else
            return this.saveInsert(form);
    }

    private saveEdit(form: Record<string, any>): any {
        const entry_id = utils.parseIntOrError(String(form.entry_id));
        const fact_id = utils.parseIntOrError(String(form.fact_id));
        const replaces = utils.parseIntOrError(String(form.replaces_assertion_id));

        const tuple = this.findTupleInEntry(entry_id, fact_id);
        const rel = tuple.schema;
        const current = tuple.mostRecentTuple ?? panic('no current version for', fact_id);

        // The assertion model's native conflict guard: we may only replace the
        // assertion the dialog was generated from.
        if(current.assertion.assertion_id !== replaces || !current.isCurrent)
            return {action: 'alert',
                    message: 'This item was changed by someone else since you opened the editor. ' +
                             'Please close the dialog and re-open it to see the latest version.'};

        const changed = parseDialogFields(rel, form);
        if(Object.keys(changed).length === 0)
            return this.reload(this.mutationTargets(entry_id, current.assertion, 'self'));

        // Re-assert the whole tuple: current values merged with the changes.
        // Starting from a copy of the current assertion preserves the columns
        // the dialog doesn't model (tags, note, confidence, change_*).
        const values = {...current.domainFields, ...changed};
        const newAssertion: Assertion = {
            ...current.assertion,
            assertion_id: newId(),
            replaces_assertion_id: current.assertion.assertion_id,
            valid_from: placeholderTxTime(),
            valid_to: timestamp.END_OF_TIME,
            ...this.changeStamp(),
        };
        setAssertionFields(newAssertion, rel, values);

        this.app.applyTransaction([newAssertion]);
        return this.reload(this.mutationTargets(entry_id, newAssertion, 'self'));
    }

    private saveInsert(form: Record<string, any>): any {
        const entry_id = utils.parseIntOrError(String(form.entry_id));
        const parent_fact_id = utils.parseIntOrError(String(form.parent_fact_id));
        const child_tag = String(form.child_tag ?? '') || panic('missing child_tag');

        const parent = this.findTupleInEntry(entry_id, parent_fact_id);
        const relation = parent.childRelations[child_tag]
            ?? panic('no child relation', `${child_tag} on ${parent.schema.tag}`);
        const rel = relation.schema;

        const changed = parseDialogFields(rel, form);

        const id = newId();
        const parentAssertion = parent.currentAssertion
            ?? panic('cannot insert under a deleted parent');
        const newAssertion: Assertion = {
            ...assertionPathToFields([...getAssertionPath(parentAssertion), [child_tag, id]]),
            ty: child_tag,
            id,
            assertion_id: id,
            valid_from: placeholderTxTime(),
            valid_to: timestamp.END_OF_TIME,
            ...this.changeStamp(),
            order_key: workspace.generateAtEndOrderKey(relation),
        } as Assertion;
        setAssertionFields(newAssertion, rel, changed);

        this.app.applyTransaction([newAssertion]);
        return this.reload(this.mutationTargets(entry_id, newAssertion, 'parent'));
    }

    /** Delete = a tombstone assertion (valid_from === valid_to).  Children
     *  must be deleted first (same rule as the old editor). */
    deleteTuple(entry_id: number, fact_id: number): any {
        const tuple = this.findTupleInEntry(entry_id, fact_id);
        if(tuple.findNonDeletedChildTuples().length > 0)
            return {action: 'alert',
                    message: 'Cannot delete an item that still has child items - please delete those first.'};
        const current = tuple.currentAssertion;
        if(!current)
            return this.reload([this.rootTarget(entry_id)]);  // already deleted - just refresh

        const t = placeholderTxTime();
        const tombstone: Assertion = {
            ...current,
            assertion_id: newId(),
            replaces_assertion_id: current.assertion_id,
            valid_from: t,
            valid_to: t,
            ...this.changeStamp(),
        };
        this.app.applyTransaction([tombstone]);
        return this.reload(this.mutationTargets(entry_id, current, 'parent'));
    }

    /** Reorder within the parent relation by re-asserting with a fresh
     *  order_key between the appropriate neighbours. */
    move(entry_id: number, fact_id: number, direction: 'up'|'down'): any {
        const tuple = this.findTupleInEntry(entry_id, fact_id);
        const current = tuple.currentAssertion
            ?? panic('cannot move a deleted item');

        const parentRelation = this.app.workspace.getVersionedTupleParentRelation(
            getAssertionPath(current));
        const peers = workspace.currentTuplesForVersionedRelation(parentRelation);
        const i = peers.findIndex(p => p.src.id === fact_id);
        if(i === -1) panic('tuple not found among its peers', fact_id);

        const keyOf = (p: workspace.CurrentTupleQuery|undefined): string|undefined =>
            p?.mostRecentTupleVersion?.assertion.order_key ?? undefined;

        let order_key: string;
        if(direction === 'up') {
            if(i === 0) return {action: 'alert', message: 'Already first.'};
            order_key = orderkey.between(i >= 2 ? keyOf(peers[i-2]) : orderkey.begin_string,
                                         keyOf(peers[i-1]));
        } else {
            if(i === peers.length - 1) return {action: 'alert', message: 'Already last.'};
            order_key = orderkey.between(keyOf(peers[i+1]),
                                         i + 2 < peers.length ? keyOf(peers[i+2]) : orderkey.end_string);
        }

        const newAssertion: Assertion = {
            ...current,
            assertion_id: newId(),
            replaces_assertion_id: current.assertion_id,
            valid_from: placeholderTxTime(),
            valid_to: timestamp.END_OF_TIME,
            ...this.changeStamp(),
            order_key,
        };
        this.app.applyTransaction([newAssertion]);
        return this.reload(this.mutationTargets(entry_id, newAssertion, 'parent'));
    }

    /**
     * Undo: re-assert an old version's values as a new assertion on top of
     * the fact's current state.  Works both for a live fact (revert) and a
     * tombstoned one (restore after delete - starts a new valid period).
     */
    restoreVersion(entry_id: number, fact_id: number, assertion_id: number): any {
        const tuple = this.findTupleInEntry(entry_id, fact_id);
        const hist = tuple.tupleVersions.find(v => v.assertion.assertion_id === assertion_id)
            ?? panic('no such version', assertion_id);
        const mostRecent = tuple.mostRecentTuple ?? panic('no versions for', fact_id);

        if(isTombstone(hist.assertion))
            return {action: 'alert', message: 'Cannot restore a deletion marker.'};
        if(mostRecent.assertion.assertion_id === assertion_id && mostRecent.isCurrent)
            return {action: 'alert', message: 'This is already the current version.'};

        const wasDeleted = !mostRecent.isCurrent;
        const newAssertion: Assertion = {
            ...hist.assertion,
            assertion_id: newId(),
            replaces_assertion_id: mostRecent.assertion.assertion_id,
            valid_from: placeholderTxTime(),
            valid_to: timestamp.END_OF_TIME,
            ...this.changeStamp(),
            // Restoring values, not position: a live fact keeps its current
            // place; a restored-after-delete fact returns at its old key.
            order_key: wasDeleted ? hist.assertion.order_key : mostRecent.assertion.order_key,
        };
        this.app.applyTransaction([newAssertion]);
        return this.reload(this.mutationTargets(entry_id, newAssertion, wasDeleted ? 'parent' : 'self'));
    }

    /**
     * Add a document reference: create an empty bounding group in the named
     * reference book, assert the ref tuple pointing at it, then open the page
     * tagger (popup) locked to the new group.  When the tagger's "Done editing
     * reference" posts back, the reference's fragment reloads (listener in
     * lexeme-editor-scripts.js).
     */
    addDocumentReference(entry_id: number, parent_fact_id: number, child_tag: string,
                         friendly_document_id: string): any {
        const parent = this.findTupleInEntry(entry_id, parent_fact_id);
        const relation = parent.childRelations[child_tag]
            ?? panic('no child relation', `${child_tag} on ${parent.schema.tag}`);
        const rel = relation.schema;
        const groupField = rel.scalarFields.find(isBoundingGroupField)
            ?? panic('relation has no bounding-group field', child_tag);

        // --- Create the empty bounding group in the book's tagging layer
        //     (same scheme as WordWiki.addNewDocumentReference).
        const groupColors = [
            'crimson', 'palevioletred', 'darkorange', 'gold', 'darkkhaki',
            'seagreen', 'steelblue', 'peru', 'rebeccapurple'];
        const document = selectScannedDocumentByFriendlyId().required({friendly_document_id});
        const document_id = document.document_id;
        const layer_id = getOrCreateNamedLayer(document_id, 'Tagging', 0);
        const color = groupColors[random.randomInt(0, groupColors.length-1)];
        const bounding_group_id = db().insert<BoundingGroup, 'bounding_group_id'>(
            'bounding_group', {document_id, layer_id, color}, 'bounding_group_id');

        // --- Assert the reference tuple pointing at the new group.
        const id = newId();
        const parentAssertion = parent.currentAssertion
            ?? panic('cannot add a reference under a deleted parent');
        const newAssertion: Assertion = {
            ...assertionPathToFields([...getAssertionPath(parentAssertion), [child_tag, id]]),
            ty: child_tag,
            id,
            assertion_id: id,
            valid_from: placeholderTxTime(),
            valid_to: timestamp.END_OF_TIME,
            ...this.changeStamp(),
            order_key: workspace.generateAtEndOrderKey(relation),
            [groupField.bind]: bounding_group_id,
        } as Assertion;
        this.app.applyTransaction([newAssertion]);

        // --- Open the page tagger on the new (empty) group.
        const page_id = selectScannedPageByPageNumber()
            .required({document_id, page_number: 1}).page_id;
        const reference_layer_id = getOrCreateNamedLayer(document_id, 'Text', 1);
        const pageEditorConfig: PageEditorConfig = {
            layer_id,
            reference_layer_ids: [reference_layer_id],
            title: `New ${document.short_title ?? friendly_document_id} reference`,
            is_popup_editor: true,
            locked_bounding_group_id: bounding_group_id,
        };
        return {action: 'open',
                url: `/ww/renderPageEditorByPageId(${page_id}, ${JSON.stringify(pageEditorConfig)})`,
                targets: this.mutationTargets(entry_id, newAssertion, 'parent')};
    }

    // ------------------------------------------------------------------------
    // --- Refresh scoping ------------------------------------------------------
    // ------------------------------------------------------------------------

    private reload(targets: string[]): any {
        return {action: 'reload', targets};
    }

    // Stamped into every assertion this editor creates.  (Assertions built by
    // spreading a previous version would otherwise inherit ITS author.)
    private changeStamp(): Pick<Assertion, 'change_by_username'> {
        return {change_by_username: this.app.currentUsername()};
    }

    private rootTarget(entry_id: number): string {
        return `.-entry-${entry_id}-`;
    }

    // The three-level refresh scope for a mutation of this assertion's tuple:
    // 'self' reloads the tuple's surface, 'parent' the containing relation -
    // except that anything touching a spelling widens to the whole entry,
    // because spellings feed the entry heading.
    private mutationTargets(entry_id: number, a: Assertion, scope: 'self'|'parent'): string[] {
        if(a.ty === entrySchema.SpellingTag)
            return [this.rootTarget(entry_id)];
        if(scope === 'self')
            return [`.-fact-${a.id}-`];
        const path = getAssertionPath(a);
        const parent_fact_id = path[path.length-2][1];
        return [`.-rel-${parent_fact_id}-${a.ty}-`];
    }

    // ------------------------------------------------------------------------
    // --- Workspace addressing -------------------------------------------------
    // ------------------------------------------------------------------------

    private entryTuple(entry_id: number): VersionedTuple {
        const dict = this.app.workspace.getTableByTag(entrySchema.DictTag);
        return dict.childRelations[entrySchema.EntryTag]?.tuples.get(entry_id)
            ?? panic('entry not found', entry_id);
    }

    // Tuples are addressed as (entry_id, fact_id) so the search is scoped to
    // the entry's (small) subtree rather than the whole dictionary.
    private findTupleInEntry(entry_id: number, fact_id: number): VersionedTuple {
        const entryTuple = this.entryTuple(entry_id);
        if(fact_id === entry_id) return entryTuple;
        return entryTuple.findRequiredVersionedTupleById(fact_id);
    }
}
