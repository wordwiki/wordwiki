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
import * as model from './model.ts';
import * as workspace from './workspace.ts';
import {VersionedTuple, CurrentTupleQuery, TupleVersion} from './workspace.ts';
import {Assertion, getAssertionPath, assertionPathToFields} from './assertion.ts';
import {BoundingGroup, selectScannedDocumentByFriendlyId, selectScannedPageByPageNumber,
        getOrCreateNamedLayer} from './scanned-document.ts';
import * as timestamp from '../liminal/timestamp.ts';
import * as orderkey from '../liminal/orderkey.ts';
import * as table from '../liminal/table.ts';
import * as action from '../liminal/action.ts';
import {Markup} from '../liminal/markup.ts';
import {markdownToMarkup} from '../liminal/markdown.ts';
import {panic} from '../liminal/utils.ts';
import * as utils from '../liminal/utils.ts';
import * as random from '../liminal/random.ts';
import {db} from '../liminal/db.ts';
import * as audio from './audio.ts';
import {newId, placeholderTxTime, isTombstone, unapprovedDimension} from './lexeme-ops.ts';
import {route, authenticated} from '../liminal/security.ts';
import {classifyFact, isComment, latestContentVersion, type FactReview} from './versioned-model.ts';
import * as server from '../liminal/http-server.ts';
import {renderGroupedChangeList, renderChangeGroup, initials,
        type ChangeEvent, type ChangeKind, type ChangeGroup} from './change-list.ts';
import {diffValues} from './diff.ts';
import {isAutomatedUsername} from './user.ts';
import * as templates from './templates.ts';
import * as category from './category.ts';
import * as lexicalForm from './lexical-form.ts';
import * as entrySchema from './entry-schema.ts';
import type {PageEditorConfig} from './render-page-editor.ts';
import {renderStandaloneGroup, singlePublicBoundingGroupEditorURL, imageRefDescription} from './render-page-editor.ts';
import * as entryMeta from './render-entry-meta.ts';
import type {WordWiki} from './wordwiki.ts';

// All editor routes live under /ww/ (wordwiki's route mount); tx`...` calls use
// page-relative exprs, which resolve under /ww/ because the editor pages
// themselves live there.  hx-get URLs are absolute so they work from any page.
const R = '/ww/wordwiki.lexeme';

// The reference books offered by the per-book "add document reference"
// buttons (the same set the navbar and home page link to).
const REFERENCE_BOOKS = ['PDM', 'Rand', 'Clark', 'PacifiquesGeography', 'RandFirstReadingBook'];

/**
 * The versioned-workspace backend for the metadata renderer's EntryNode seam
 * (render-entry-meta.ts): it walks CurrentTupleQuery instead of projected JSON,
 * so the same layout code renders over live data AND carries fact identity for
 * the edit affordances.  (The read/export path uses JsonNode; this is the
 * editor path.)
 */
export class WorkspaceNode implements entryMeta.EntryNode {
    constructor(private tq: CurrentTupleQuery,
                private entryId: number,
                private parentFactId: number) {}

    children(rf: model.RelationField): entryMeta.EntryNode[] {
        const rel: any = this.tq.childRelations[rf.tag];
        if(!rel) return [];
        return (rel.tuples as CurrentTupleQuery[])
            .filter(t => t.mostRecentTupleVersion)   // skip pending deletions
            .map(t => new WorkspaceNode(t, this.entryId, this.tq.src.id));
    }

    value(f: model.Field): any {
        const a: any = this.tq.mostRecentTupleVersion?.assertion;
        return a ? a[(f as any).bind] : undefined;   // content scalars carry a bind column
    }

    identity(): entryMeta.TupleIdentity {
        return {entryId: this.entryId, factId: this.tq.src.id, parentFactId: this.parentFactId};
    }
}

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
        const recId = 'rec-'+this.name;
        return [
            ['div', {'class':'col-12'},
             ['label', {class:'form-label'}, this.prompt],
             value ? ['div', {class:'mb-1'},
                      audio.renderAudio(String(value), [audio.audioPlayIcon, ' Current recording'], undefined, '/')]
                   : undefined,
             ['input', {type:'hidden', name:this.name, id:inputId, value: value ?? ''}],
             ['input', {type:'file', class:'form-control', accept:'.wav,audio/*',
                        onchange:`lmAudioUploadChange(event, '${inputId}')`}],
             // Record directly in the browser (alongside the file picker): capture
             // with MediaRecorder, re-encode to WAV client-side (lmAudioRecord* in
             // lexeme-editor-scripts.js), then feed the SAME uploadRecording path.
             ['div', {class:'mt-2 d-flex align-items-center flex-wrap gap-2'},
              ['button', {type:'button', class:'btn btn-outline-danger btn-sm', id:recId+'-rec',
                          onclick:`lmAudioRecordToggle('${inputId}', '${recId}')`}, '● Record'],
              ['span', {class:'text-muted small', id:recId+'-timer'}, ''],
              ['audio', {id:recId+'-preview', controls:'controls',
                         style:'display:none; height:32px; vertical-align:middle;'}],
              ['button', {type:'button', class:'btn btn-outline-primary btn-sm', id:recId+'-use',
                          style:'display:none;', onclick:`lmAudioUseRecording('${inputId}', '${recId}')`},
               'Use this recording']],
             ['div', {class:'form-text', id:inputId+'-status'},
              value ? 'Choose a file, or record a new clip, to replace the current recording.'
                    : 'Choose a recording file, or record a new clip.'],
            ]];
    }
}

/**
 * A controlled-vocabulary select - shared by the category field (category
 * table) and the part-of-speech field (lexical form table).  Free text is
 * what produced the old misspelled/duplicated vocabularies; creating a new
 * value is a deliberate act on the matching admin page, and the editor only
 * OFFERS active (non-retired) rows, grouped by theme (the shared grouping
 * from category.ts: themes in table order, names sorted within).
 *
 * A current value that is not offered (a retired row, or legacy free text
 * not in the table) stays selectable as a marked extra option, so editing
 * it leaves it untouched - but a CHANGED value must be an active slug
 * (validated server-side in parseSimpleInput; the select is only the
 * client-side half).
 */
interface VocabRow { slug: string; name: string; theme?: string; retired: number; }
class VocabSelectField extends table.EnumField {
    // Takes ALL rows: the active ones become the offered optgroups; the
    // retired ones supply a friendly label when the CURRENT value is a
    // retired slug.
    active: VocabRow[];
    constructor(name: string, public rows: VocabRow[],
                public vocab: {what: string, adminPage: string},
                options: table.FieldOptions = {}) {
        super(name, Object.fromEntries(rows.map(c => [c.slug, c.name])), options);
        this.active = rows.filter(c => !c.retired);
    }

    override renderInput(value: any): Markup {
        const runs = category.groupByTheme(this.active);
        // The current value when it is not offered: a retired row (kept with
        // its name) or a value not in the table at all (legacy free text).
        let currentExtra: Markup;
        if(value != null && value !== '' && !this.active.some(c => c.slug === value)) {
            const retired = this.rows.find(c => c.slug === value);
            currentExtra = ['option', {value, selected: ''},
                retired ? `${retired.name} - retired (kept until changed)`
                        : `${value} (not in the ${this.vocab.what} table - kept until changed)`];
        }
        return [
            ['div', {'class':'col-12'},
             ['label', {for:'input-'+this.name, class:'form-label'}, this.prompt],
             ['select', {name: this.name, id: `input-${this.name}`, class: 'form-select'},
              ['option', {value: '', ...((value==null||value==='')?{selected:''}:{})}, ''],
              currentExtra,
              runs.map(run =>
                  ['optgroup', {label: run.theme},
                   run.cats.map(c =>
                       ['option', {value: c.slug, ...(value===c.slug?{selected:''}:{})},
                        `${c.name} (${c.slug})`])]),
             ]]];
    }

    // Only runs for CHANGED values (parseInput skips inputs equal to their
    // before-snapshot), so legacy/retired values survive unrelated edits.
    override parseSimpleInput(value: string): any {
        if(value === '') return null;
        if(!this.active.some(c => c.slug === value))
            throw new Error(`'${value}' is not an active ${this.vocab.what} - ` +
                            `${this.vocab.what}s are managed on the ` +
                            `${this.vocab.adminPage} page (Admin menu)`);
        return value;
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

function widgetFor(f: model.ScalarField, rel: model.RelationField,
                   vocabs: VocabProviders): table.Field {
    // Controlled-vocabulary values get selects over their tables (falling
    // back to the free-text widget while a table is unseeded).
    if(rel.tag === entrySchema.CategoryTag && f.name === 'category') {
        const cats = vocabs.categories();
        if(cats.some(c => !c.retired))
            return new VocabSelectField(f.name, cats,
                {what: 'category', adminPage: 'Category Table'},
                {nullable: true, prompt: f.prompt});
    }
    if(rel.tag === entrySchema.SubentryTag && f.name === 'part_of_speech') {
        const forms = vocabs.lexicalForms();
        if(forms.some(c => !c.retired))
            return new VocabSelectField(f.name, forms,
                {what: 'lexical form', adminPage: 'Lexical Form Table'},
                {nullable: true, prompt: f.prompt});
    }
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
        // $markdown fields use rabid's established markdown widget (textarea
        // + the quiet syntax hint) - the same one the category/lexical-form
        // description fields use.
        if(f.style.$markdown)
            return new table.MarkdownField(f.name, {nullable: true, prompt: f.prompt});
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
interface VocabProviders {
    categories: () => category.Category[];
    lexicalForms: () => lexicalForm.LexicalForm[];
}

function parseDialogFields(rel: model.RelationField, form: Record<string, any>,
                           vocabs: VocabProviders): Record<string, any> {
    const changed: Record<string, any> = {};
    for(const f of dialogFields(rel))
        widgetFor(f, rel, vocabs).parseInput(form, changed);
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

// newId/placeholderTxTime/isTombstone moved to lexeme-ops.ts (shared with
// the table pages' assertion verbs); imported above.

// The editor's two looks: 'edit' shows each fact's bare current value with
// editing affordances; 'review' shows each fact diffed against its published
// baseline, adds approve/revert/comment, and surfaces pending deletions (see
// publication-model.md).  The mode rides in each fragment's hx-get, so an
// in-place reload re-renders in the same mode.
export type EditMode = 'edit' | 'review';

// Review-mode view state, carried in the entry fragment's hx-get so a reload
// preserves it.  `participant` is a username whose threads to show, or
// 'everyone'; `full` extends each fact's timeline back past the published
// baseline to creation.  `since` is the sitting's anchor - the db's top
// tx timestamp when the page was entered (stamped into the URL by entryPage).
// A fact settled by a review action NEWER than `since` stays visible as a
// receipt (flipped to "approved ✓"/"rejected") instead of vanishing from the
// queue; 0 = no anchor (an old link), which disables receipts.
export interface ReviewOpts { participant: string; full: boolean; since: number; }

/** The receipt outcome for a fact settled during this sitting: the review
 *  action newer than the `since` anchor, or undefined.  Reads the latest
 *  content version only - a fresh pending edit on top of a sitting's approval
 *  puts the fact back in the queue, receipt gone. */
function factReceipt(t: VersionedTuple, since: number): 'approved'|'reverted'|undefined {
    if(!(since > 0)) return undefined;
    const content = latestContentVersion(t.tupleVersions.map(v => v.assertion));
    if(!content || content.valid_from <= since) return undefined;
    const a = content.change_action;
    return a === 'approved' || a === 'reverted' ? a : undefined;
}

// ---------------------------------------------------------------------------
// --- Value rendering (module-level: drives both the edit surface and the ----
// --- review diff, over a raw assertion rather than a TupleVersion) ----------
// ---------------------------------------------------------------------------

/** One scalar field's value as display markup (undefined = render nothing).
 *  Exported for tests. */
export function renderFieldValue(f: model.ScalarField, v: any): Markup|undefined {
    if(v === null || v === undefined || v === '') return undefined;
    if(f instanceof model.AudioField)
        return audio.renderAudio(String(v), [audio.audioPlayIcon, ' Recording'], undefined, '/');
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
        return ['div', {onclick: `event.stopPropagation(); window.open('/ww/wordwiki.pages.forwardToSingleBoundingGroupEditorURL(${v}, null)')`},
                ['object', {style: 'pointer-events: none;',
                            data: `/ww/wordwiki.pages.renderStandaloneGroupAsSvgResponse('/', ${v})`,
                            type: 'image/svg+xml'}]];
    // $markdown string fields render their value as markdown (safe by
    // construction - see liminal/markdown.ts).  After the EnumField case:
    // enums are StringFields too, and their labels are never markdown.
    if(f instanceof model.StringField && f.style.$markdown)
        return markdownToMarkup(String(v));
    return ['span', {}, String(v)];
}

/** The edit mode carried in a dialog postback (defaults to plain editing). */
function formMode(form: Record<string, any>): EditMode {
    return form.mode === 'review' ? 'review' : 'edit';
}

/** A user's display name for the history grid (the friendly name when known,
 *  else the bare username; 'unknown' for an unstamped row). */
function userLabel(username: string | null | undefined): string {
    return username ? (entrySchema.users[username] ?? username) : 'unknown';
}

/** The "imported base set": the predecessor-system dictionary (loaded at
 *  valid_from = BEGINNING_OF_TIME, no author) and the automated batch migrations
 *  (a '~' identity).  These are filtered out of the review change list - they
 *  are not human activity and drown the real changes.  The values they carry
 *  still surface as the "from" of any human change on top of them, and the full
 *  raw record stays reachable through the history picker. */
function isImportedEvent(a: Assertion): boolean {
    return a.valid_from === timestamp.BEGINNING_OF_TIME
        || isAutomatedUsername(a.change_by_username);
}

/** The optional change-note widget appended to the edit/insert dialogs.  Read
 *  raw on save into the version's change_note (it is NOT a relation field), so
 *  an edit can carry a rationale that shows in the review timeline. */
function changeNoteWidget(): table.Field {
    return new TextAreaField('change_note', 2,
        {nullable: true, prompt: 'Note (optional) — a short why, shown to reviewers'});
}

/** The change note from a dialog postback, trimmed (undefined when blank). */
function formChangeNote(form: Record<string, any>): string | undefined {
    const n = typeof form.change_note === 'string' ? form.change_note.trim() : '';
    return n || undefined;
}

/** A field whose value is free text (so a character/word diff is meaningful) -
 *  i.e. a plain string, not an enum/variant (whole-value vocab), audio/image
 *  (a path), or a bounding-group reference. */
function isFreeTextField(f: model.ScalarField): boolean {
    return f instanceof model.StringField
        && !(f instanceof model.EnumField)       // VariantField < EnumField too
        && !(f instanceof model.AudioField)
        && !(f instanceof model.ImageField);
}

/** A fact's free-text content, for diffing one version against another (empty
 *  when the fact carries no text - e.g. a recording or a reference). */
function factText(rf: model.RelationField, a: Assertion | undefined): string {
    if(!a) return '';
    return rf.scalarFields
        .filter(f => !(f instanceof model.PrimaryKeyField) && isFreeTextField(f))
        .map(f => (a as any)[f.bind])
        .filter(v => v !== null && v !== undefined && v !== '')
        .join(' · ');
}

/** Every non-pk scalar of a relation, rendered from one assertion's values. */
function renderAssertionValues(rf: model.RelationField, a: Assertion): Markup {
    const parts = rf.scalarFields
        .filter(f => !(f instanceof model.PrimaryKeyField))
        .map(f => renderFieldValue(f, (a as any)[f.bind]))
        .filter(p => p !== undefined);
    return parts.length === 0
        ? ['span', {class:'text-muted'}, '(empty)']
        : parts.map(p => [p, ' ']);
}

// ---------------------------------------------------------------------------
// --- The editor --------------------------------------------------------------
// ---------------------------------------------------------------------------

export class LexemeEditor {

    constructor(public app: WordWiki) {
    }

    // The select options for the controlled-vocabulary fields (an arrow
    // property: passed unbound into widgetFor/parseDialogFields).  Queried
    // per dialog open, so admin-table edits show up immediately.  ALL rows:
    // active ones are offered; retired ones label a kept current value.
    private vocabs: VocabProviders = {
        categories: () => this.app.categories.allByOrder.all({}),
        lexicalForms: () => this.app.lexicalForms.allByOrder.all({}),
    };

    // ------------------------------------------------------------------------
    // --- Page + fragments ----------------------------------------------------
    // ------------------------------------------------------------------------

    @route(authenticated)
    entryPage(entry_id: number, mode: EditMode = 'edit',
              since: number = 0): templates.Page | server.Response {
        // The sitting anchor: an un-anchored visit redirects to the canonical
        // URL stamped with the db's top tx timestamp, so the anchor lives in
        // the browser URL - refresh/back keep the sitting (review receipts
        // persist); navigating in fresh re-stamps it (a clean queue).
        if(!(since > 0)) {
            const t = this.app.lastAllocatedTxTimestamp;
            // No space after the comma: it would percent-encode to %20 in the
            // address bar (this URL is the one users see and share).
            return server.forwardResponse(mode === 'edit'
                ? `/ww/wordwiki.entry(${entry_id},${t})`
                : `${R}.entryPage(${entry_id},'${mode}',${t})`);
        }
        const e = this.app.entriesById.get(entry_id);
        const title = e ? entrySchema.renderEntrySpellingsSummary(e) : `Entry ${entry_id}`;
        return templates.page(title, this.renderEntry(entry_id, mode, '', '', since));
    }

    /** The root-level fragment: the whole entry (heading + all relations).  The
     *  mode AND the review view-state (participant / full-history) ride in the
     *  fragment's hx-get, so every in-place reload re-renders identically. */
    @route(authenticated)
    renderEntry(entry_id: number, mode: EditMode = 'edit',
                participant: string = '', full: string = '',
                since: number = 0): Markup {
        const entryTuple = this.entryTuple(entry_id);
        const q = new CurrentTupleQuery(entryTuple);
        const e = this.app.entriesById.get(entry_id);
        const heading = e ? entrySchema.renderEntrySpellingsSummary(e) : `Entry ${entry_id}`;

        const opts = this.reviewOpts(participant, full, since);
        const hxGet = mode === 'review'
            ? `${R}.renderEntry(${entry_id}, 'review', '${opts.participant}', '${opts.full ? 'full' : ''}', ${opts.since})`
            : `${R}.renderEntry(${entry_id}, 'edit', '', '', ${opts.since})`;

        return (
            ['div', {class: `-entry-${entry_id}- container py-3`,
                     'hx-get': hxGet,
                     'hx-trigger': 'reload consume', 'hx-swap': 'outerHTML'},
             this.renderModeToggle(entry_id, entryTuple, mode, opts),
             ['h2', {}, heading || 'No spellings'],
             mode === 'review'
                ? renderGroupedChangeList(
                    this.lexemeChangeGroups(entry_id, entryTuple, opts),
                    opts.full ? 'No changes recorded.' : 'Nothing needs approving.')
                : this.renderChildRelations(entry_id, q),
            ]);
    }

    /** The Editing ⇄ Reviewing switch; in review mode also the pending count,
     *  the participant filter, and the full-history toggle.  Each control is a
     *  plain htmx swap of the entry fragment - its own hx-get keeps the look. */
    private renderModeToggle(entry_id: number, entryTuple: VersionedTuple,
                             mode: EditMode, opts: ReviewOpts): Markup {
        if(mode === 'review') {
            return ['div', {class: 'd-flex align-items-center gap-2 mb-2 lm-review-bar flex-wrap'},
                    ['span', {class: 'badge text-bg-warning'}, 'Reviewing'],
                    this.renderReviewPending(entry_id, opts.participant),
                    this.participantControl(entry_id, entryTuple, opts),
                    this.fullHistoryToggle(entry_id, opts),
                    this.modeSwapButton(entry_id, 'edit', 'Edit entry',
                                        'btn btn-sm btn-outline-secondary ms-auto', opts.since)];
        }
        const n = this.entryPendingCount(entryTuple, 'everyone');
        return ['div', {class: 'd-flex mb-2'},
                this.modeSwapButton(entry_id, 'review', `Review changes${n>0?` (${n})`:''}`,
                     `btn btn-sm ms-auto ${n>0?'btn-outline-warning':'btn-outline-secondary'}`,
                     opts.since)];
    }

    // A button that swaps the entry fragment into the other mode (review opens
    // with the default participant/full, resolved server-side).  The sitting's
    // `since` anchor rides across the swap in both directions.
    private modeSwapButton(entry_id: number, to: EditMode, label: Markup, cls: string,
                           since: number): Markup {
        const url = to === 'review'
            ? `${R}.renderEntry(${entry_id}, 'review', '', '', ${since})`
            : `${R}.renderEntry(${entry_id}, 'edit', '', '', ${since})`;
        return ['button', {type: 'button', class: cls,
                           'hx-get': url, 'hx-target': `.-entry-${entry_id}-`,
                           'hx-swap': 'outerHTML'}, label];
    }

    // "Showing: <who>" - a dropdown of Everyone + the people active on this
    // entry (the logged-in user always offered), each swapping the fragment.
    private participantControl(entry_id: number, entryTuple: VersionedTuple,
                               opts: ReviewOpts): Markup {
        const people = this.entryParticipants(entryTuple);
        const me = this.app.currentUsername();
        if(me && !people.includes(me)) people.unshift(me);
        const reviewUrl = (p: string) =>
            `${R}.renderEntry(${entry_id}, 'review', '${p}', '${opts.full ? 'full' : ''}', ${opts.since})`;
        const item = (value: string, text: string) =>
            ['li', {}, ['button', {type: 'button',
                class: `dropdown-item ${value === opts.participant ? 'active' : ''}`,
                'hx-get': reviewUrl(value), 'hx-target': `.-entry-${entry_id}-`,
                'hx-swap': 'outerHTML'}, text]];
        const current = opts.participant === 'everyone' ? 'Everyone' : userLabel(opts.participant);
        return ['div', {class: 'dropdown'},
                ['button', {type: 'button', class: 'btn btn-sm btn-outline-secondary dropdown-toggle',
                            'data-bs-toggle': 'dropdown', 'aria-expanded': 'false'},
                 `Showing: ${current}`],
                ['ul', {class: 'dropdown-menu'},
                 item('everyone', 'Everyone'),
                 people.map(u => item(u, userLabel(u)))]];
    }

    // Extend every fact's timeline back past the published baseline to creation.
    private fullHistoryToggle(entry_id: number, opts: ReviewOpts): Markup {
        const to = opts.full ? '' : 'full';
        return ['button', {type: 'button',
            class: `btn btn-sm ${opts.full ? 'btn-secondary' : 'btn-outline-secondary'}`,
            'hx-get': `${R}.renderEntry(${entry_id}, 'review', '${opts.participant}', '${to}', ${opts.since})`,
            'hx-target': `.-entry-${entry_id}-`, 'hx-swap': 'outerHTML'},
            opts.full ? 'Full history ✓' : 'Full history'];
    }

    /** Pending facts in this entry's subtree (added / edited / removed): the
     *  review badge's count.  Walks the VersionedTuples directly (pending
     *  deletions are not in the current view). */
    private entryPendingCount(entryTuple: VersionedTuple, participant: string): number {
        let n = 0;
        entryTuple.forEachVersionedTuple(t => {
            if(t.tupleVersions.length === 0) return;
            if(participant !== 'everyone' && !this.participantActiveOnFact(t, participant)) return;
            const s = classifyFact(t.tupleVersions.map(v => v.assertion),
                                   timestamp.END_OF_TIME).state;
            if(s !== 'added' && s !== 'edited' && s !== 'removed') return;
            // Same gate as the queue groups: a pending fact whose only events
            // are the imported base set produces NO group, so it must not be
            // counted (else "15 pending" over 7 visible groups).
            if(this.factChangeEvents(t.schema, t, false, true).length === 0) return;
            n++;
        });
        return n;
    }

    /** The parent-level fragment: one relation (header + its tuples). */
    @route(authenticated)
    renderRelationFragment(entry_id: number, parent_fact_id: number, tag: string): Markup {
        const parent = this.findTupleInEntry(entry_id, parent_fact_id);
        const rf = parent.schema.relationFields.find(r => r.tag === tag)
            ?? panic('no child relation', `${tag} on ${parent.schema.tag}`);
        const pq = new CurrentTupleQuery(parent);
        return this.renderRelation(entry_id, parent_fact_id, rf, pq.childRelations[tag]);
    }

    /** The self-level fragment: one tuple's editable surface. */
    @route(authenticated)
    renderTupleFragment(entry_id: number, fact_id: number): Markup {
        const tuple = this.findTupleInEntry(entry_id, fact_id);
        const tq = new CurrentTupleQuery(tuple);
        return this.renderTupleSurface(entry_id, tuple.schema, tq,
                                       this.surfaceClasses(tuple.schema));
    }

    // ------------------------------------------------------------------------
    // --- Metadata-driven EDITOR (experiment) ---------------------------------
    // ------------------------------------------------------------------------
    //
    // The read-only metadata renderer (render-entry-meta.ts) run in EDIT mode
    // over the versioned workspace (WorkspaceNode).  "The editor is the read
    // view + a few overrides": the affordances (the row ☰, click-to-edit, the
    // add lines) are built HERE - reusing this editor's existing action
    // machinery - and injected as EditingHooks; the renderer only places them.
    //
    // Refresh (first cut): every affordance element carries its fine-grained
    // reload class (-fact- / -rel-) but redirects the reload to re-render the
    // WHOLE metadata entry - coarse but correct.  (Fine-grained metadata
    // fragments are a later optimisation.)

    /** The reload page (a normal navigation target). */
    @route(authenticated)
    metaEditPage(entry_id: number): templates.Page {
        const e = this.app.entriesById.get(entry_id);
        const title = e ? entrySchema.renderEntrySpellingsSummary(e) : `Entry ${entry_id}`;
        return templates.page(title, this.renderMetaEntry(entry_id));
    }

    /** The whole metadata entry as an outerHTML-swappable reload fragment. */
    @route(authenticated)
    renderMetaEntry(entry_id: number): Markup {
        const q = new CurrentTupleQuery(this.entryTuple(entry_id));
        const root = new WorkspaceNode(q, entry_id, q.src.id);
        const entryRel = this.app.dictSchema.relationsByTag[entrySchema.EntryTag];
        const renderer = new entryMeta.EntryRenderer({
            rootPath: '/', audience: 'internal', publicKeys: ['borrowed-word'],
            renderBoundingGroup: (gid) => this.metaBoundingGroup(gid),
            editing: this.metaEditingHooks(entry_id),
        });
        return ['div', {class: `-entry-${entry_id}- container py-3`,
                        'hx-get': `${R}.renderMetaEntry(${entry_id})`,
                        'hx-trigger': 'reload consume', 'hx-swap': 'outerHTML'},
                ['div', {class: 'page-content'}, renderer.render(entryRel, root)]];
    }

    /** Re-render the whole metadata entry into its wrapper - the redirect target
     *  for every affordance's reload, so any mutation refreshes the view. */
    private metaReloadAttrs(entry_id: number): any {
        return {'hx-trigger': 'reload consume',
                'hx-get': `${R}.renderMetaEntry(${entry_id})`,
                'hx-target': `.-entry-${entry_id}-`, 'hx-swap': 'outerHTML'};
    }

    /** The reference scan + composed reference-book link (see wordView). */
    private metaBoundingGroup(id: number): Markup {
        const scan = renderStandaloneGroup('/', id);
        let url = ''; try { url = singlePublicBoundingGroupEditorURL('/', id, ''); } catch { /**/ }
        let desc = ''; try { desc = imageRefDescription(id); } catch { /**/ }
        return ['div', {},
            ['div', {class: 'lm-me-scan'}, url ? ['a', {href: url}, scan] : scan],
            desc ? ['div', {}, url ? ['a', {href: url}, desc] : desc] : ''];
    }

    /** The edit affordances, built from this editor's action machinery. */
    private metaEditingHooks(entry_id: number): entryMeta.EditingHooks {
        return {
            tupleSurface: (rf, id, body) => {
                const current = new CurrentTupleQuery(
                    this.findTupleInEntry(id.entryId, id.factId)).mostRecentTupleVersion;
                if(!current) return body;
                const menu = action.actionMenu(
                    this.editMenuItems(id.entryId, id.factId, rf, current.assertion, 'edit'),
                    {ariaLabel: `Actions for this ${rf.prompt}`});
                return ['div', {class: `-fact-${id.factId}- lm-editable lm-me-editable d-flex align-items-start gap-1`,
                                ...this.metaReloadAttrs(id.entryId),
                                onclick: 'lmEditableClick(event)'},
                        ['div', {class: 'flex-grow-1'}, body],
                        menu];
            },
            emptyRelation: (rf, parentId) => {
                // An empty slot reads and behaves like a FILLED row: same flex
                // structure ("Prompt:" + a muted value, ☰ in the same right
                // gutter), and the same tap-anywhere-to-edit - except "editing"
                // an empty slot IS the insert-first dialog.  So a user just
                // edits away from "empty" without learning a separate insert
                // concept.  (Keyed on parent id + child tag; no fact exists.)
                const rowAttrs = {
                    class: `-rel-${parentId.factId}-${rf.tag}- lm-me-empty d-flex align-items-start gap-1`,
                    ...this.metaReloadAttrs(parentId.entryId),
                };
                const label = (trailing: Markup = ''): Markup =>
                    ['div', {class: 'flex-grow-1'},
                     ['b', {}, rf.prompt + ': '],
                     ['span', {class: 'text-muted fst-italic'}, 'empty'],
                     trailing];
                if(rf.scalarFields.some(isBoundingGroupField))
                    // Per-book add buttons ride inline (no single dialog for a
                    // body-click to delegate to).
                    return ['div', rowAttrs,
                            label([' ', this.addButtons(parentId.entryId, parentId.factId, rf)])];
                if(rf.scalarFields.some(isDialogReadOnly))
                    return ['div', rowAttrs, label()];
                const menu = action.actionMenu(
                    [{label: 'Edit', btnClass: 'edit', mode: {kind: 'modal',
                      dialogUrl: `${R}.insertDialog(${parentId.entryId}, ${parentId.factId}, '${rf.tag}')`}}],
                    {ariaLabel: `Add ${rf.prompt}`});
                return ['div', {...rowAttrs,
                                class: rowAttrs.class + ' lm-editable lm-me-editable',
                                onclick: 'lmEditableClick(event)'},
                        label(), menu];
            },
        };
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
            'hx-trigger': 'reload consume', 'hx-swap': 'outerHTML',
        };
        const header =
            ['div', {class:'d-flex align-items-center gap-2 lex-relation-header'},
             ['span', {class:'fw-bold'}, rf.prompt],
             this.addButtons(entry_id, parent_fact_id, rf),
             this.relationHeaderMenu(entry_id, parent_fact_id, rf, rq)];

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
     * the whole area opens the edit dialog, and the standard ☰ menu carries
     * ALL of the tuple's actions (the liminal UI language - see
     * action.actionMenu).  No pencil: the ☰ is the row's single icon, and
     * its Edit item (class 'edit') doubles as the body tap's delegation
     * target (lmEditableClick taps button.edit).
     */
    private renderTupleSurface(entry_id: number, rf: model.RelationField,
                               tq: CurrentTupleQuery, extraClasses: string = ''): Markup {
        const fact_id = tq.src.id;
        const current = tq.mostRecentTupleVersion;
        if(!current) return [];
        // Even in the compact (default) view, mark a fact whose current value is
        // not yet approved (an unpublished edit/addition sitting on top of - or
        // in place of - the published version), so an editor can see at a glance
        // what still carries an unaccepted change.  (publication-model.md)
        const pending = (() => {
            const s = classifyFact(tq.src.tupleVersions.map(v => v.assertion),
                                   timestamp.END_OF_TIME).state;
            return s === 'added' || s === 'edited';
        })();
        return (
            ['div', {class: `-fact-${fact_id}- lm-editable d-flex align-items-start `
                            + `${pending ? 'lm-pending-fact ' : ''}${extraClasses}`,
                     'hx-get': `${R}.renderTupleFragment(${entry_id}, ${fact_id})`,
                     'hx-trigger': 'reload consume', 'hx-swap': 'outerHTML',
                     onclick: 'lmEditableClick(event)'},
             pending ? ['span', {class:'lm-pending-dot', title:'unapproved change'}, ''] : [],
             ['div', {class:'flex-grow-1'}, this.renderTupleValues(rf, current)],
             this.tupleActionMenu(entry_id, fact_id, rf, current),
            ]);
    }

    /** The tuple's ☰: every action on the tuple, one tap away.
     *  (lmEditableClick declines clicks on buttons, so opening the menu
     *  doesn't also open the edit dialog.) */
    private tupleActionMenu(entry_id: number, fact_id: number,
                            rf: model.RelationField, current: TupleVersion): Markup {
        return action.actionMenu(
            this.editMenuItems(entry_id, fact_id, rf, current.assertion, 'edit'),
            {ariaLabel: `Actions for this ${rf.prompt}`});
    }

    /** The editing affordances for a tuple (Edit / Insert / Move / History /
     *  Delete).  Factored out so review mode can offer them too (a reviewer
     *  often fixes a value in place) above its approve/revert/comment items.
     *  `mode` rides into every action so its reload re-renders in the same
     *  look (review mode reloads coarsely - see mutationTargets). */
    private editMenuItems(entry_id: number, fact_id: number, rf: model.RelationField,
                          current: Assertion, mode: EditMode): action.ActionMenuItem[] {
        const parentPath = getAssertionPath(current);
        const parent_fact_id = parentPath[parentPath.length-2][1];
        // Bounding-group/image relations create tuples via their own flows
        // (per-book buttons / not yet) - no generic positioned inserts.
        const insertable = !rf.scalarFields.some(isBoundingGroupField)
            && !rf.scalarFields.some(isDialogReadOnly);
        // The mode rides as a trailing arg ONLY in review mode (it defaults to
        // 'edit' server-side), so plain editing keeps its byte-identical wire.
        const m = mode === 'review' ? `, 'review'` : '';
        return [
            {label: 'Edit', btnClass: 'edit', mode: {kind: 'modal',
                dialogUrl: `${R}.editDialog(${entry_id}, ${fact_id}${m})`}},
            ...(insertable ? [
                {label: `Insert ${rf.prompt} before`, mode: {kind: 'modal' as const,
                    dialogUrl: `${R}.insertDialog(${entry_id}, ${parent_fact_id}, '${rf.tag}', ${fact_id}, 'before'${m})`}},
                {label: `Insert ${rf.prompt} after`, mode: {kind: 'modal' as const,
                    dialogUrl: `${R}.insertDialog(${entry_id}, ${parent_fact_id}, '${rf.tag}', ${fact_id}, 'after'${m})`}},
            ] : []),
            {label: 'Move up', mode: {kind: 'immediate',
                expr: `wordwiki.lexeme.move(${entry_id}, ${fact_id}, 'up'${m})`}},
            {label: 'Move down', mode: {kind: 'immediate',
                expr: `wordwiki.lexeme.move(${entry_id}, ${fact_id}, 'down'${m})`}},
            {label: 'History', mode: {kind: 'modal',
                dialogUrl: `${R}.historyDialog(${entry_id}, ${fact_id}${m})`}},
            {label: 'Delete', mode: {kind: 'confirm',
                expr: `wordwiki.lexeme.deleteTuple(${entry_id}, ${fact_id}${m})`,
                message: `Delete this ${rf.prompt}?`}},
        ];
    }

    private renderTupleValues(rf: model.RelationField, tv: TupleVersion): Markup {
        return renderAssertionValues(rf, tv.assertion);
    }

    /**
     * The relation header's add affordance (task.ts style): the common verb
     * as a quiet icon-only + (so an EMPTY relation still has a visible way
     * to add), with the header ☰ naming it for discoverability and carrying
     * the rare actions (the deleted-items dialog).  Special cases by
     * metadata: a bounding-group relation keeps one labelled button per
     * reference book (create group + ref, then open the tagger); an image
     * relation has no add flow yet.
     */
    private addButtons(entry_id: number, parent_fact_id: number, rf: model.RelationField): Markup {
        if(rf.scalarFields.some(isBoundingGroupField))
            return REFERENCE_BOOKS.map(book => action.actionButton('+ ' + book,
                {kind: 'immediate',
                 expr: `wordwiki.lexeme.addDocumentReference(${entry_id}, ${parent_fact_id}, '${rf.tag}', '${book}')`},
                'btn btn-sm btn-outline-primary lex-add-btn py-0 px-1'));
        if(rf.scalarFields.some(isDialogReadOnly))
            return [];
        return action.actionButton(action.plusIcon(),
            {kind: 'modal', dialogUrl: `${R}.insertDialog(${entry_id}, ${parent_fact_id}, '${rf.tag}')`},
            'lm-menu-button', {'aria-label': `New ${rf.prompt}`, title: `New ${rf.prompt}`});
    }

    // The header ☰: names the add for discoverability, and carries the
    // deleted-items dialog (rare - it used to be an inline "n deleted"
    // link).  Omitted when it would be empty.
    private relationHeaderMenu(entry_id: number, parent_fact_id: number,
                               rf: model.RelationField, rq: workspace.CurrentRelationQuery): Markup {
        const items: Array<{label: string, mode: action.ActionMode}> = [];
        if(!rf.scalarFields.some(isBoundingGroupField) && !rf.scalarFields.some(isDialogReadOnly))
            items.push({label: `Add ${rf.prompt}…`, mode: {kind: 'modal',
                dialogUrl: `${R}.insertDialog(${entry_id}, ${parent_fact_id}, '${rf.tag}')`}});
        const deletedCount = this.deletedTuples(rq).length;
        if(deletedCount > 0)
            items.push({label: `Deleted items (${deletedCount})…`, mode: {kind: 'modal',
                dialogUrl: `${R}.deletedDialog(${entry_id}, ${parent_fact_id}, '${rf.tag}')`}});
        if(items.length === 0) return [];
        return action.actionMenu(items, {ariaLabel: `${rf.prompt} list actions`});
    }

    private deletedTuples(rq: workspace.CurrentRelationQuery): VersionedTuple[] {
        return [...rq.src.tuples.values()].filter(t =>
            t.mostRecentTuple !== undefined && !t.mostRecentTuple.isCurrent);
    }

    // ------------------------------------------------------------------------
    // --- Review mode: the change list -----------------------------------------
    // ------------------------------------------------------------------------
    //
    // Review is NOT a second tree.  The lexeme tree is already at the edge of
    // what the users can hold; nesting a per-fact history inside it tipped it
    // over.  So review renders one FLAT change list (change-list.ts) - the
    // lexeme's events merged in time order, each line naming its fact - read
    // exactly like the single-fact / global / per-user lists that reuse the
    // same component.  Only the SET of events differs; the rendering never
    // does.  The walk is over raw VersionedTuples, so pending DELETIONS appear.

    /** The events for ONE fact, oldest-to-newest, from the published baseline
     *  (or, with `full`, from creation).  The value is carried only when it
     *  MOVES (so comments/no-ops add no value noise).  This is the single-fact
     *  change list, and the per-fact slice the lexeme list is built from. */
    factChangeEvents(rf: model.RelationField, tuple: VersionedTuple,
                     full: boolean, hideImported = false): ChangeEvent[] {
        const versions = tuple.tupleVersions;
        const review = classifyFact(versions.map(v => v.assertion), timestamp.END_OF_TIME);
        const baseId = review.baseline?.assertion_id;
        const startIdx = (!full && baseId !== undefined)
            ? versions.findIndex(v => v.assertion.assertion_id === baseId) : 0;
        const norm = (v: any) => (v === null || v === undefined || v === '') ? null : v;
        const hasContent = (a: Assertion) => rf.scalarFields.some(f =>
            !(f instanceof model.PrimaryKeyField) && norm((a as any)[f.bind]) !== null);
        const val = (a: Assertion | undefined) =>
            (a && hasContent(a)) ? renderAssertionValues(rf, a) : undefined;

        const events: ChangeEvent[] = [];
        // The previous CONTENT value (the change's "from") - tracked explicitly,
        // because in the merged lexeme log the prior version is not the row
        // above (other facts' events interleave), so a change must carry its
        // own before/after to be legible.
        let prevContent: Assertion | undefined = undefined;
        for(let i = startIdx; i < versions.length; i++) {
            const a = versions[i].assertion;
            const isBaseline = baseId !== undefined && a.assertion_id === baseId;
            const comment = isComment(a);
            const tomb = isTombstone(a);

            // An explicit action (comment / revert / approve) names itself even
            // when that version is the current published baseline - otherwise an
            // approval that became the baseline (the usual case) would render as
            // a quiet baseline and lose its "approved by" chip.  (tomb stays
            // ahead of approved: an approved DELETION reads as 'deleted'.)
            const kind: ChangeKind =
                comment                          ? 'commented'
              : a.change_action === 'reverted'   ? 'reverted'
              : tomb                             ? 'deleted'
              : a.change_action === 'approved'   ? 'approved'
              : isBaseline                       ? 'baseline'
              : (!review.baseline && i === startIdx) ? 'added'
              :                                    'changed';

            // Structural/container facts (an entry, a subentry - no scalar value
            // of their own) contribute no baseline NOISE; only their real events.
            if(kind === 'baseline' && !hasContent(a)) { prevContent = a; continue; }

            const u = a.change_by_username;
            const ev: ChangeEvent = {
                when: a.valid_from,
                whoInitials: initials(u, u ? entrySchema.users[u] : undefined),
                whoName: userLabel(u),
                authorUsername: u ?? undefined,
                automated: isAutomatedUsername(u),
                field: rf.prompt,
                kind,
                note: a.change_note ?? undefined,
            };
            switch(kind) {
                case 'changed':
                case 'reverted': {                  // a change: before -> after, aligned
                    // Diff the free text so the DIFFERENCE draws the eye (a
                    // single-letter lexeme tweak vs a reworded sentence pick
                    // their own nicest rendering); a non-text change (audio,
                    // enum, ...) falls back to the plain rendered values.
                    const fromText = factText(rf, prevContent), toText = factText(rf, a);
                    if(fromText !== toText) {
                        const d = diffValues(fromText, toText);
                        ev.from = d.from; ev.to = d.to;
                    } else {
                        ev.from = val(prevContent); ev.to = val(a);
                    }
                    prevContent = a;
                    break;
                }
                case 'deleted':                      // show what is being removed
                    ev.value = val(prevContent);
                    break;
                case 'added':
                    ev.value = val(a);
                    prevContent = a;
                    break;
                case 'approved':
                    ev.value = val(a);
                    prevContent = a;
                    break;
                case 'baseline':
                    ev.value = val(a);
                    prevContent = a;
                    break;
                case 'commented':                    // the note IS the content (inline)
                    break;
            }
            // Drop imported base-set events from the display (prevContent above
            // already advanced, so a human change on top still shows its "from").
            if(hideImported && isImportedEvent(a)) continue;
            events.push(ev);
        }
        return events;
    }

    /** The whole lexeme's change list: every fact's events, merged in time
     *  order, each carrying its fact as the subject.  The participant filter
     *  keeps only the facts that user is party to; 'everyone' keeps all.  The
     *  fact's action menu rides its latest event. */
    lexemeChangeEvents(entry_id: number, entryTuple: VersionedTuple,
                       opts: ReviewOpts): ChangeEvent[] {
        const all: ChangeEvent[] = [];
        // The lexeme headword, stamped on every event's subject (redundant in
        // this single-lexeme view, but it makes a line self-identifying so the
        // SAME list works unchanged in a multi-lexeme / global feed).
        const e = this.app.entriesById.get(entry_id);
        const headword = e ? entrySchema.renderEntrySpellingsSummary(e) : `Entry ${entry_id}`;
        entryTuple.forEachVersionedTuple(t => {
            if(t.tupleVersions.length === 0) return;
            if(opts.participant !== 'everyone'
               && !this.participantActiveOnFact(t, opts.participant)) return;
            const review = classifyFact(t.tupleVersions.map(v => v.assertion),
                                        timestamp.END_OF_TIME);
            if(review.state === 'hidden') return;   // settled, no-longer-public deletion
            const evs = this.factChangeEvents(t.schema, t, opts.full);
            for(const ev of evs) ev.lexeme = headword;
            // Actions ride the latest event - but ONLY when the fact has a
            // pending change to act on.  A clean/approved fact is just log
            // history; giving it a (roll-back) menu reads as "this accepted
            // thing is under review", which is confusing.
            const pending = review.state === 'added' || review.state === 'edited'
                || review.state === 'removed';
            if(pending && evs.length > 0)
                evs[evs.length - 1].actions =
                    this.factActionMenu(entry_id, t.id, t.schema, review);
            all.push(...evs);
        });
        // Stable chronological merge (Array.sort is stable in V8).
        all.sort((a, b) => a.when - b.when);
        return all;
    }

    /** The lexeme review, GROUPED by fact: one headed block per fact, so "what
     *  needs approving" reads as a short list of groups rather than a long flat
     *  log.  DEFAULT (not full) is the approval queue - only facts with a
     *  pending change; `full` reveals every fact's complete record.  Within a
     *  group the field is in the header, so the lines drop their subject. */
    lexemeChangeGroups(entry_id: number, entryTuple: VersionedTuple,
                       opts: ReviewOpts): ChangeGroup[] {
        const groups: ChangeGroup[] = [];
        entryTuple.forEachVersionedTuple(t => {
            const g = this.reviewGroupFor(entry_id, t, opts);
            if(g) groups.push(g);
        });
        return groups;
    }

    /** One fact's review group, as its OWN reloadable fragment - or null when
     *  the fact does not belong in the current view (settled in the queue,
     *  filtered out, or pure import).  An action that touches this fact reloads
     *  just `.-review-group-<fact_id>-`: it re-renders here - reclassified, or
     *  flipped to a receipt when the action settled it this sitting - or
     *  returns nothing and the fragment removes itself (a fact settled BEFORE
     *  the sitting's anchor, gone from the queue). */
    private reviewGroupFor(entry_id: number, t: VersionedTuple,
                           opts: ReviewOpts): ChangeGroup | null {
        if(t.tupleVersions.length === 0) return null;
        if(opts.participant !== 'everyone'
           && !this.participantActiveOnFact(t, opts.participant)) return null;
        const review = classifyFact(t.tupleVersions.map(v => v.assertion), timestamp.END_OF_TIME);
        // A receipt keeps the group in view: settling a fact must flip it in
        // place ("approved ✓"), not vanish it - disappearance reads as "did
        // that work?", and rows vanishing shift the queue under the pointer.
        const receipt = factReceipt(t, opts.since);
        // settled, no-longer-public deletion - unless settled this sitting
        if(review.state === 'hidden' && !receipt) return null;
        const pending = review.state === 'added' || review.state === 'edited'
            || review.state === 'removed';
        if(!opts.full && !pending && !receipt) return null;  // the queue: pending + receipts
        // The imported base set is filtered everywhere in the review (it is not
        // human activity); a fact left with no human events drops out.
        const events = this.factChangeEvents(t.schema, t, opts.full, true);
        if(events.length === 0) return null;
        return {
            attrs: {
                class: `-review-group-${t.id}- lm-cl-group`,
                'hx-get': `${R}.renderReviewGroupFragment(${entry_id}, ${t.id}, `
                        + `'${opts.participant}', '${opts.full ? 'full' : ''}', ${opts.since})`,
                'hx-trigger': 'reload consume', 'hx-swap': 'outerHTML',
            },
            header: this.changeGroupHeader(entry_id, t.id, t.schema, review, pending,
                                           pending ? undefined : receipt),
            events,
        };
    }

    // The default review view-state (an approver lands on EVERYONE - their
    // queue; a plain contributor on their OWN threads), shared by renderEntry
    // and the per-group/count fragments so a reload keeps the same view.
    private reviewOpts(participant: string, full: string, since: number = 0): ReviewOpts {
        return {
            participant: participant
                || (this.app.lexemeOps.hasApprovePermission()
                    ? 'everyone' : (this.app.currentUsername() ?? 'everyone')),
            full: full === 'full',
            since: since > 0 ? since : 0,
        };
    }

    /** The self-reloading fragment for one review group: re-render it, or
     *  nothing (so htmx removes it) when the fact has left the view. */
    @route(authenticated)
    renderReviewGroupFragment(entry_id: number, fact_id: number,
                              participant: string = '', full: string = '',
                              since: number = 0): Markup {
        const opts = this.reviewOpts(participant, full, since);
        const tuple = this.findTupleInEntry(entry_id, fact_id);
        const g = this.reviewGroupFor(entry_id, tuple, opts);
        return g ? renderChangeGroup(g) : [];
    }

    /** The pending-count fragment in the review bar (reloaded after an action,
     *  so the count tracks without re-rendering the whole entry). */
    @route(authenticated)
    renderReviewPending(entry_id: number, participant: string = ''): Markup {
        const p = this.reviewOpts(participant, '').participant;
        const n = this.entryPendingCount(this.entryTuple(entry_id), p);
        return ['span', {class: `-review-pending-${entry_id}- text-muted small`,
                         'hx-get': `${R}.renderReviewPending(${entry_id}, '${p}')`,
                         'hx-trigger': 'reload consume', 'hx-swap': 'outerHTML'},
                n === 0 ? 'nothing pending' : `${n} change${n===1?'':'s'} pending approval`];
    }

    // The reload targets for a review action on one fact: its group (re-renders
    // or removes itself) and the bar's pending count - never the whole entry.
    private reviewActionTargets(entry_id: number, fact_id: number): string[] {
        return [`.-review-group-${fact_id}-`, `.-review-pending-${entry_id}-`];
    }

    // A group's header: the field, and - when pending - a "needs approval" badge
    // with DIRECT Approve / Reject buttons (the primary decision shouldn't hide
    // in a menu).  A small ☰ holds the rarer actions (comment, edit, and
    // revert-to-a-past-value, which opens the history picker rather than putting
    // a per-version menu on every row).  A fact settled during this sitting
    // carries its outcome as a receipt badge instead - the reviewer's
    // confirmation that the action landed (and who made it: the event's chip).
    private changeGroupHeader(entry_id: number, fact_id: number, rf: model.RelationField,
                              review: FactReview<Assertion>, pending: boolean,
                              receipt?: 'approved'|'reverted'): Markup {
        const parts: Markup[] = [['span', {class: 'lm-cl-field'}, rf.prompt]];
        if(receipt) {
            parts.push(receipt === 'approved'
                ? ['span', {class: 'badge text-bg-success'},
                   review.state === 'hidden' ? 'deletion approved ✓' : 'approved ✓']
                : ['span', {class: 'badge text-bg-secondary'}, 'rejected']);
        }
        if(pending) {
            parts.push(['span', {class: 'badge text-bg-warning'}, 'needs approval']);
            if(this.app.lexemeOps.mayApprove(review.content.change_by_username ?? null))
                parts.push(action.actionButton(
                    review.state === 'removed' ? 'Approve deletion' : 'Approve',
                    {kind: 'immediate', expr: `wordwiki.lexeme.reviewApprove(${entry_id}, ${fact_id})`},
                    'btn btn-sm btn-success py-0'));
            if(this.app.lexemeOps.hasApprovePermission())
                parts.push(action.actionButton('Reject…',
                    {kind: 'modal', dialogUrl: `${R}.revertDialog(${entry_id}, ${fact_id})`},
                    'btn btn-sm btn-outline-danger py-0'));
        }
        parts.push(this.groupMenu(entry_id, fact_id, rf, review));
        return ['div', {class: 'd-flex align-items-center gap-2 flex-wrap'}, parts];
    }

    // The group ☰: the rarer per-fact actions.  "Revert to a past value…" opens
    // the history picker (one entry point, not a menu per version row) - it
    // re-asserts the chosen value, which covers reverting an intermediate value
    // while building, or rolling a published value back to any past one.
    private groupMenu(entry_id: number, fact_id: number, rf: model.RelationField,
                      review: FactReview<Assertion>): Markup {
        const items: action.ActionMenuItem[] = [
            {label: 'Comment…',
             mode: {kind: 'modal', dialogUrl: `${R}.commentDialog(${entry_id}, ${fact_id})`}},
        ];
        if(review.state !== 'removed')
            items.push({label: 'Edit…',
                mode: {kind: 'modal', dialogUrl: `${R}.editDialog(${entry_id}, ${fact_id}, 'review')`}});
        items.push({label: 'Revert to a past value…',
            mode: {kind: 'modal', dialogUrl: `${R}.historyDialog(${entry_id}, ${fact_id}, 'review')`}});
        return action.actionMenu(items, {ariaLabel: `More actions for this ${rf.prompt}`});
    }

    /** The action menu for a PENDING fact in the change list: approve (when the
     *  two-person rule allows), reject, comment, and edit-in-place - scoped to
     *  the one fact (the spatial moves/inserts belong to the tree editor, not
     *  the flat log).  Clean facts get no menu (see lexemeChangeEvents); there
     *  is deliberately no roll-back-an-approved-value affordance here - that
     *  rare moderation move doesn't belong on every accepted value. */
    private factActionMenu(entry_id: number, fact_id: number,
                           rf: model.RelationField, review: FactReview<Assertion>): Markup {
        const items: action.ActionMenuItem[] = [];
        if(this.app.lexemeOps.mayApprove(review.content.change_by_username ?? null))
            items.push({label: review.state === 'removed' ? 'Approve deletion' : 'Approve',
                mode: {kind: 'immediate',
                       expr: `wordwiki.lexeme.reviewApprove(${entry_id}, ${fact_id})`}});
        if(this.app.lexemeOps.hasApprovePermission())
            items.push({label: 'Reject…',
                mode: {kind: 'modal', dialogUrl: `${R}.revertDialog(${entry_id}, ${fact_id})`}});
        items.push({label: 'Comment…',
            mode: {kind: 'modal', dialogUrl: `${R}.commentDialog(${entry_id}, ${fact_id})`}});
        if(review.state !== 'removed')
            items.push({label: 'Edit…', mode: {kind: 'modal',
                dialogUrl: `${R}.editDialog(${entry_id}, ${fact_id}, 'review')`}});
        return action.actionMenu(items, {ariaLabel: `Actions for this ${rf.prompt}`});
    }

    // A user "participates" in a fact when they authored a version that is NOT
    // the published baseline (an edit, reassert, revert, or comment) - so the
    // importer of a born-approved fact is not a participant in it.
    private participantActiveOnFact(tuple: VersionedTuple, participant: string): boolean {
        const baseId = classifyFact(tuple.tupleVersions.map(v => v.assertion),
                                    timestamp.END_OF_TIME).baseline?.assertion_id;
        return tuple.tupleVersions.some(v =>
            v.assertion.change_by_username === participant
            && v.assertion.assertion_id !== baseId);
    }

    // The (human) users with activity anywhere in this entry - the participant
    // filter's options (automated identities excluded).
    private entryParticipants(entryTuple: VersionedTuple): string[] {
        const set = new Set<string>();
        entryTuple.forEachVersionedTuple(t => {
            if(t.tupleVersions.length === 0) return;
            const baseId = classifyFact(t.tupleVersions.map(v => v.assertion),
                                        timestamp.END_OF_TIME).baseline?.assertion_id;
            for(const v of t.tupleVersions) {
                const u = v.assertion.change_by_username;
                if(u && v.assertion.assertion_id !== baseId && !isAutomatedUsername(u))
                    set.add(u);
            }
        });
        return [...set].sort();
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
    @route(authenticated)
    editDialog(entry_id: number, fact_id: number, mode: EditMode = 'edit'): Markup {
        const tuple = this.findTupleInEntry(entry_id, fact_id);
        const rel = tuple.schema;
        const current = tuple.mostRecentTuple ?? panic('no current version for', fact_id);

        const fields = dialogFields(rel);
        const widgets = fields.map(f => widgetFor(f, rel, this.vocabs));
        const defaults = current.domainFields;
        const noteWidget = changeNoteWidget();

        const hidden: Record<string, any> = {
            entry_id, fact_id, mode,
            replaces_assertion_id: current.assertion.assertion_id,
        };
        // The before-<name> snapshots parseInput compares against (only fields
        // the user actually changed are parsed out of the postback).
        fields.forEach((f, i) => hidden['before-'+f.name] = widgets[i].toFormValue(defaults[f.name]));

        // The optional change note starts empty (it describes THIS edit, not a
        // prior one) and is read raw on save into change_note - it rides the
        // version like a comment/revert reason and shows in the review timeline.
        const form = action.renderParamForm([...widgets, noteWidget],
            {...defaults, change_note: ''}, {
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
        // The tuple's other actions (moves/history/delete) live in the
        // surface's ☰ menu, not here - the dialog is just the form.
        return [['script', {}, 'setTimeout(showModalEditor)'],
                form];
    }

    /**
     * The insert dialog: the same record form over an empty tuple, with the
     * insert position as hidden params.  By default inserts at the end of
     * the relation; with an anchor (the ☰'s "Insert before/after") the new
     * tuple lands next to the anchor tuple.
     */
    @route(authenticated)
    insertDialog(entry_id: number, parent_fact_id: number, child_tag: string,
                 anchor_fact_id?: number|null, where?: 'before'|'after'|null,
                 mode: EditMode = 'edit'): Markup {
        const parent = this.findTupleInEntry(entry_id, parent_fact_id);
        const rel = parent.childRelations[child_tag]?.schema
            ?? panic('no child relation', `${child_tag} on ${parent.schema.tag}`);

        const fields = dialogFields(rel);
        const widgets = fields.map(f => widgetFor(f, rel, this.vocabs));

        const hidden: Record<string, any> = {entry_id, parent_fact_id, child_tag, mode};
        if(anchor_fact_id !== undefined && (where === 'before' || where === 'after')) {
            hidden.anchor_fact_id = anchor_fact_id;
            hidden.where = where;
        }
        fields.forEach(f => hidden['before-'+f.name] = '');

        // A NEW recording's speaker defaults to the logged-in user (recording
        // yourself is the common case) - only when they are in the speaker
        // vocabulary (an identity outside it - a robot, an admin who never
        // records - must not inject itself), and only here on INSERT: an edit
        // dialog shows the stored value.  The before- snapshot stays '', so
        // an untouched default still submits as a change and is saved.
        const defaults: Record<string, any> = {change_note: ''};
        const me = this.app.currentUsername();
        if(me) for(const f of fields)
            if(f.name === 'speaker' && f instanceof model.EnumField
               && Object.hasOwn((f.style as any).$options ?? {}, me))
                defaults[f.name] = me;

        // Self-lift, as in editDialog (composable wherever it is loaded from).
        return [['script', {}, 'setTimeout(showModalEditor)'],
                action.renderParamForm([...widgets, changeNoteWidget()], defaults, {
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
    @route(authenticated)
    historyDialog(entry_id: number, fact_id: number, mode: EditMode = 'edit'): Markup {
        const tuple = this.findTupleInEntry(entry_id, fact_id);
        const rel = tuple.schema;
        const versions = tuple.tupleVersions.toReversed();
        const mostRecent = tuple.mostRecentTuple;
        // As in editMenuItems: the mode rides along only in review (edit keeps
        // its byte-identical wire).
        const m = mode === 'review' ? `, 'review'` : '';

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
             action.actionButton('← Edit',
                 {kind: 'modal', dialogUrl: `${R}.editDialog(${entry_id}, ${fact_id}${m})`},
                 'btn btn-sm btn-outline-secondary')],
            ['div', {class:'list-group lm-list'},
             this.collapseAutomatedRuns(versions.map(v => {
                 const a = v.assertion;
                 const isCurrent = a.assertion_id === mostRecent?.assertion.assertion_id && v.isCurrent;
                 const item = ['div', {class:'list-group-item d-flex align-items-start gap-2'},
                         ['div', {class:'flex-grow-1'},
                          ['div', {class:'small text-muted'},
                           timestamp.formatTimestampAsLocalTime(a.valid_from),
                           a.change_by_username ? ` — ${entrySchema.users[a.change_by_username] ?? a.change_by_username}` : '',
                           isAutomatedUsername(a.change_by_username)
                              ? ['span', {class:'badge text-bg-secondary ms-1'}, 'automated'] : ''],
                          isTombstone(a)
                             ? ['span', {class:'text-danger'}, '(deleted)']
                             : this.renderTupleValues(rel, v)],
                         isCurrent
                            ? ['span', {class:'badge text-bg-success'}, 'Current']
                            : isTombstone(a)
                            ? []
                            : this.restoreBarrierFrom(tuple) > a.valid_from
                            // Pre-migration versions are view-only: their
                            // values are expressed in a vocabulary that no
                            // longer exists (also enforced in restoreVersion).
                            ? ['span', {class:'small text-muted'},
                               'not restorable (predates a vocabulary migration)']
                            : action.actionButton('Restore',
                                {kind: 'confirm',
                                 expr: `wordwiki.lexeme.restoreVersion(${entry_id}, ${fact_id}, ${a.assertion_id}${m})`,
                                 message: `Restore this version of ${rel.prompt}?`},
                                'btn btn-sm btn-outline-secondary')];
                 return {automated: isAutomatedUsername(a.change_by_username) && !isCurrent, item};
             }))],
        ];
    }

    /** The migration barrier for a fact: the valid_from of its most recent
     *  AUTOMATED version (batch import/migration).  Versions older than
     *  this are view-only in the history dialog and refused by
     *  restoreVersion.  BEGINNING_OF_TIME when the fact has none. */
    private restoreBarrierFrom(tuple: VersionedTuple): number {
        return tuple.tupleVersions.findLast(
            v => isAutomatedUsername(v.assertion.change_by_username))
            ?.assertion.valid_from ?? timestamp.BEGINNING_OF_TIME;
    }

    /** Fold runs of consecutive automated versions behind a <details>
     *  disclosure ("N automated changes ...") so a migration reads as one
     *  event, not a pile of edits.  Single automated items keep their badge
     *  but aren't worth a fold. */
    private collapseAutomatedRuns(items: {automated: boolean, item: Markup}[]): Markup {
        const out: Markup[] = [];
        for(let i = 0; i < items.length; ) {
            if(!items[i].automated) { out.push(items[i].item); i++; continue; }
            let j = i;
            while(j < items.length && items[j].automated) j++;
            const run = items.slice(i, j).map(x => x.item);
            out.push(run.length === 1 ? run[0] :
                ['details', {class: 'list-group-item lm-automated-run'},
                 ['summary', {class: 'small text-muted'},
                  `${run.length} automated changes (batch import / migration)`],
                 run]);
            i = j;
        }
        return out;
    }

    /**
     * The deleted-items dialog for a relation: each tombstoned tuple's last
     * real values, with a restore button (re-asserts that version over the
     * tombstone, starting a new valid period).
     */
    @route(authenticated)
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
                       const tombstone = t.mostRecentTuple?.assertion;
                       // Removed by a batch migration: restoring would
                       // resurrect values the migration deliberately retired
                       // (also enforced in restoreVersion).
                       const byMigration = isAutomatedUsername(tombstone?.change_by_username);
                       return ['div', {class:'list-group-item d-flex align-items-start gap-2'},
                               ['div', {class:'flex-grow-1'},
                                ['div', {class:'small text-muted'},
                                 'deleted ', tombstone !== undefined ? timestamp.formatTimestampAsLocalTime(tombstone.valid_from) : '',
                                 byMigration
                                    ? ['span', {class:'badge text-bg-secondary ms-1'}, 'by migration'] : ''],
                                lastReal ? this.renderTupleValues(rel, lastReal)
                                         : ['span', {class:'text-muted'}, '(no recorded values)']],
                               byMigration
                                  ? ['span', {class:'small text-muted'},
                                     'not restorable (retired by a vocabulary migration)']
                                  : lastReal
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
    @route(authenticated)
    saveTuple(form: Record<string, any>): any {
        if(form.fact_id !== undefined && form.fact_id !== '')
            return this.saveEdit(form);
        else
            return this.saveInsert(form);
    }

    // --- Review actions (publication-model.md) ------------------------------
    //
    // Thin wrappers over the LexemeOps publication verbs (which do the work and
    // enforce permissions).  Each reloads only the touched fact's GROUP (which
    // re-renders the fact reclassified, or removes itself if it has left the
    // queue) plus the bar's pending COUNT - never the whole entry.

    /** Approve a fact's pending content (publishes it). */
    @route(authenticated)
    reviewApprove(entry_id: number, fact_id: number): any {
        this.app.lexemeOps.approveFact(fact_id);
        return this.reload(this.reviewActionTargets(entry_id, fact_id));
    }

    /** The revert/rollback note dialog (a reject reason or a rollback rationale). */
    @route(authenticated)
    revertDialog(entry_id: number, fact_id: number): Markup {
        return this.noteDialog(entry_id, fact_id, 'submitRevert',
            {title: 'Revert to the published value',
             prompt: 'Reason (required) — kept with the reverted value',
             submitLabel: 'Revert'});
    }

    /** The discussion-comment dialog. */
    @route(authenticated)
    commentDialog(entry_id: number, fact_id: number): Markup {
        return this.noteDialog(entry_id, fact_id, 'submitComment',
            {title: 'Add a comment',
             prompt: 'Comment (required) — recorded on the fact, never published',
             submitLabel: 'Comment'});
    }

    private noteDialog(entry_id: number, fact_id: number, submit: string,
                       o: {title: string, prompt: string, submitLabel: string}): Markup {
        const note = new TextAreaField('note', 3, {nullable: false, prompt: o.prompt});
        return [
            ['script', {}, 'setTimeout(showModalEditor)'],
            action.renderParamForm([note], {}, {
                title: o.title,
                submitLabel: o.submitLabel,
                hidden: {entry_id, fact_id},
                dispatch: {id: 'edit-form',
                           onsubmit: `event.preventDefault(); tx\`wordwiki.lexeme.${submit}(\${getFormJSON(event.target)})\``},
            })];
    }

    @route(authenticated)
    submitRevert(form: Record<string, any>): any {
        const entry_id = utils.parseIntOrError(String(form.entry_id));
        const fact_id = utils.parseIntOrError(String(form.fact_id));
        this.app.lexemeOps.revertFact(fact_id, String(form.note ?? ''));
        return this.reload(this.reviewActionTargets(entry_id, fact_id));
    }

    @route(authenticated)
    submitComment(form: Record<string, any>): any {
        const entry_id = utils.parseIntOrError(String(form.entry_id));
        const fact_id = utils.parseIntOrError(String(form.fact_id));
        this.app.lexemeOps.commentFact(fact_id, String(form.note ?? ''));
        return this.reload(this.reviewActionTargets(entry_id, fact_id));
    }

    private saveEdit(form: Record<string, any>): any {
        const entry_id = utils.parseIntOrError(String(form.entry_id));
        const fact_id = utils.parseIntOrError(String(form.fact_id));
        const replaces = utils.parseIntOrError(String(form.replaces_assertion_id));
        const mode = formMode(form);

        const tuple = this.findTupleInEntry(entry_id, fact_id);
        const rel = tuple.schema;
        const current = tuple.mostRecentTuple ?? panic('no current version for', fact_id);

        // The assertion model's native conflict guard: we may only replace the
        // assertion the dialog was generated from.
        if(current.assertion.assertion_id !== replaces || !current.isCurrent)
            return {action: 'alert',
                    message: 'This item was changed by someone else since you opened the editor. ' +
                             'Please close the dialog and re-open it to see the latest version.'};

        const changed = parseDialogFields(rel, form, this.vocabs);
        if(Object.keys(changed).length === 0)
            return this.reload(this.mutationTargets(entry_id, current.assertion, 'self', mode));

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
            ...unapprovedDimension,
            change_note: formChangeNote(form),
        };
        setAssertionFields(newAssertion, rel, values);

        this.app.applyTransaction([newAssertion]);
        return this.reload(this.mutationTargets(entry_id, newAssertion, 'self', mode));
    }

    /** Where a new tuple lands: next to the anchor when the form carries
     *  one (the ☰'s "Insert before/after"), else at the end.  A vanished
     *  anchor (deleted while the dialog was open) degrades to at-end. */
    private insertOrderKey(relation: workspace.VersionedRelation,
                           form: Record<string, any>): string {
        const anchorRaw = form.anchor_fact_id;
        const where = String(form.where ?? '');
        if(anchorRaw === undefined || anchorRaw === '' ||
           (where !== 'before' && where !== 'after'))
            return workspace.generateAtEndOrderKey(relation);
        const anchor_fact_id = utils.parseIntOrError(String(anchorRaw));
        const peers = workspace.currentTuplesForVersionedRelation(relation);
        const i = peers.findIndex(p => p.src.id === anchor_fact_id);
        if(i === -1)
            return workspace.generateAtEndOrderKey(relation);
        const keyOf = (p: workspace.CurrentTupleQuery|undefined): string|undefined =>
            p?.mostRecentTupleVersion?.assertion.order_key ?? undefined;
        return where === 'before'
            ? orderkey.between(i > 0 ? keyOf(peers[i-1]) : orderkey.begin_string,
                               keyOf(peers[i]))
            : orderkey.between(keyOf(peers[i]),
                               i + 1 < peers.length ? keyOf(peers[i+1]) : orderkey.end_string);
    }

    private saveInsert(form: Record<string, any>): any {
        const entry_id = utils.parseIntOrError(String(form.entry_id));
        const parent_fact_id = utils.parseIntOrError(String(form.parent_fact_id));
        const child_tag = String(form.child_tag ?? '') || panic('missing child_tag');

        const parent = this.findTupleInEntry(entry_id, parent_fact_id);
        const relation = parent.childRelations[child_tag]
            ?? panic('no child relation', `${child_tag} on ${parent.schema.tag}`);
        const rel = relation.schema;

        const changed = parseDialogFields(rel, form, this.vocabs);

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
            change_note: formChangeNote(form),
            order_key: this.insertOrderKey(relation, form),
        } as Assertion;
        setAssertionFields(newAssertion, rel, changed);

        this.app.applyTransaction([newAssertion]);
        return this.reload(this.mutationTargets(entry_id, newAssertion, 'parent', formMode(form)));
    }

    /** Delete = a tombstone assertion (see LexemeOps.tombstoneFact - the
     *  mutation and its race handling live there); this method only
     *  translates the outcome into the editor's alerts/reload targets. */
    @route(authenticated)
    deleteTuple(entry_id: number, fact_id: number, mode: EditMode = 'edit'): any {
        const r = this.app.lexemeOps.tombstoneFact(entry_id, fact_id);
        switch(r.outcome) {
            case 'has-children':
                return {action: 'alert',
                        message: 'Cannot delete an item that still has child items - please delete those first.'};
            case 'already-deleted':
                // A stale dialog's delete racing another user's: idempotent -
                // just refresh.
                return this.reload(r.mostRecent
                    ? this.mutationTargets(entry_id, r.mostRecent, 'parent', mode)
                    : [this.rootTarget(entry_id)]);
            case 'removed':
                return this.reload(this.mutationTargets(entry_id, r.replaced, 'parent', mode));
        }
    }

    /** Reorder within the parent relation by re-asserting with a fresh
     *  order_key between the appropriate neighbours. */
    @route(authenticated)
    move(entry_id: number, fact_id: number, direction: 'up'|'down', mode: EditMode = 'edit'): any {
        const tuple = this.findTupleInEntry(entry_id, fact_id);
        const mostRecent = tuple.mostRecentTuple ?? panic('no versions for', String(fact_id));
        // A stale dialog's move racing another user's delete: re-asserting a
        // tombstoned fact would silently RESURRECT it - refuse instead.
        if(!mostRecent.isCurrent)
            return {action: 'alert',
                    message: 'This item was deleted by someone else since you opened the editor.'};
        const current = mostRecent.assertion;

        const parentRelation = this.app.workspace.getVersionedTupleParentRelation(
            getAssertionPath(current));
        const peers = workspace.currentTuplesForVersionedRelation(parentRelation);
        const i = peers.findIndex(p => p.src.id === fact_id);
        if(i === -1) panic('tuple not found among its peers', fact_id);

        const keyOf = (p: workspace.CurrentTupleQuery|undefined): string|null|undefined =>
            p?.mostRecentTupleVersion?.assertion.order_key;

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
            ...unapprovedDimension,
            order_key,
        };
        this.app.applyTransaction([newAssertion]);
        return this.reload(this.mutationTargets(entry_id, newAssertion, 'parent', mode));
    }

    /**
     * Undo: re-assert an old version's values as a new assertion on top of
     * the fact's current state.  Works both for a live fact (revert) and a
     * tombstoned one (restore after delete - starts a new valid period).
     */
    @route(authenticated)
    restoreVersion(entry_id: number, fact_id: number, assertion_id: number,
                   mode: EditMode = 'edit'): any {
        const tuple = this.findTupleInEntry(entry_id, fact_id);
        const hist = tuple.tupleVersions.find(v => v.assertion.assertion_id === assertion_id)
            ?? panic('no such version', assertion_id);
        const mostRecent = tuple.mostRecentTuple ?? panic('no versions for', fact_id);

        if(isTombstone(hist.assertion))
            return {action: 'alert', message: 'Cannot restore a deletion marker.'};
        if(mostRecent.assertion.assertion_id === assertion_id && mostRecent.isCurrent)
            return {action: 'alert', message: 'This is already the current version.'};
        // The migration barrier: a version older than the fact's most recent
        // automated version is expressed in a vocabulary that no longer
        // exists - restoring it would plant stale tags in current data.
        if(this.restoreBarrierFrom(tuple) > hist.assertion.valid_from)
            return {action: 'alert',
                    message: 'This version predates a batch vocabulary migration - ' +
                             'its values are no longer in use, so it cannot be restored.'};

        const wasDeleted = !mostRecent.isCurrent;
        // Tree-ordering (gate #4, symmetric to the approve gate): restoring a
        // DELETED fact makes it live again, so its parent must be live - else
        // we resurrect a child under a still-deleted parent (an orphan in the
        // valid tree).  Restore the parent first.
        if(wasDeleted && !this.app.lexemeOps.parentIsLiveOf(tuple))
            return {action: 'alert',
                    message: 'This item’s parent has been deleted — restore the parent ' +
                             'first, then restore this item.'};
        const newAssertion: Assertion = {
            ...hist.assertion,
            assertion_id: newId(),
            replaces_assertion_id: mostRecent.assertion.assertion_id,
            valid_from: placeholderTxTime(),
            valid_to: timestamp.END_OF_TIME,
            ...this.changeStamp(),
            ...unapprovedDimension,
            // Restoring values, not position: a live fact keeps its current
            // place; a restored-after-delete fact returns at its old key.
            order_key: wasDeleted ? hist.assertion.order_key : mostRecent.assertion.order_key,
        };
        this.app.applyTransaction([newAssertion]);
        return this.reload(this.mutationTargets(entry_id, newAssertion, wasDeleted ? 'parent' : 'self', mode));
    }

    /**
     * Add a document reference: create an empty bounding group in the named
     * reference book, assert the ref tuple pointing at it, then open the page
     * tagger (popup) locked to the new group.  When the tagger's "Done editing
     * reference" posts back, the reference's fragment reloads (listener in
     * lexeme-editor-scripts.js).
     */
    @route(authenticated)
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
                url: `/ww/wordwiki.pages.renderPageEditorByPageId(${page_id}, ${JSON.stringify(pageEditorConfig)})`,
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
        return this.app.lexemeOps.changeStamp();
    }

    private rootTarget(entry_id: number): string {
        return `.-entry-${entry_id}-`;
    }

    // The three-level refresh scope for a mutation of this assertion's tuple:
    // 'self' reloads the tuple's surface, 'parent' the containing relation -
    // except that anything touching a spelling widens to the whole entry,
    // because spellings feed the entry heading.
    //
    // Review mode reloads coarsely: the whole entry fragment, always.  Any
    // mutation there can change a fact's CLASSIFICATION (approving an edit
    // makes it clean; deleting makes it a pending-removal; editing a clean
    // fact makes it edited), and those changes ripple through the diff display
    // - so a fine-grained self/parent reload would leave sibling classes stale.
    private mutationTargets(entry_id: number, a: Assertion, scope: 'self'|'parent',
                            mode: EditMode = 'edit'): string[] {
        if(mode === 'review' || a.ty === entrySchema.SpellingTag)
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
        return this.app.lexemeOps.entryTuple(entry_id);
    }

    private findTupleInEntry(entry_id: number, fact_id: number): VersionedTuple {
        return this.app.lexemeOps.findTupleInEntry(entry_id, fact_id);
    }
}
