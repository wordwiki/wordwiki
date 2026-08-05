// deno-lint-ignore-file no-explicit-any
/**
 * The REFERENCE BINDER (rand-references-design.md §5): bind a dictionary's
 * entries to the scanned page lines they came from, one Opus extraction
 * stage per page on the Layer-1 substrate (extract.ts / getDerived) - so
 * every LLM call is persistently memoized, re-runs are nearly free, and
 * bumping PROMPT_VERSION_BIND re-extracts exactly what it invalidates.
 *
 * Per printed page:
 *   input  (all in the cache key): the page's OCR Text-layer boxes
 *          (id, rect, text) + the CANDIDATE entries - those whose source
 *          citation names this printed page (headwords in both lanes,
 *          glosses, cited pages).
 *   output (schema-validated): per entry, the box ids forming its region
 *          + a confidence; plus unmatched-entry and unclaimed-region
 *          lists - the human worklist.
 *
 * LANDING (plain code, --apply): a bounding group on the DICTIONARY'S OWN
 * SHEET of the book (§2 sheets), the chosen Text boxes copied in (the
 * page editor's grey-box copy semantic, imported_from preserved), and
 * addReferenceToEntry authored '~<dictionary>-binder' - identifiable,
 * preservable across transform re-runs (--preserve-foreign), and
 * re-derivable.  Idempotent: an entry already referencing a group on the
 * page is SKIPPED (hand tags win; re-runs top up).
 *
 * Dry-run first (the CLI defaults to it): the report lists every proposed
 * binding with its line texts - the 10-page eval surface a human reviews
 * before authorizing the full book.
 */
import { db } from '../liminal/db.ts';
import { block } from '../liminal/strings.ts';
import { panic } from '../liminal/utils.ts';
import * as model from './model.ts';
import * as schemaRoles from './schema-roles.ts';
import { LexemeOps, type LexemeApp } from './lexeme-ops.ts';
import type { Assertion } from './assertion.ts';
import type { WordWiki } from './wordwiki.ts';
import type { DictionaryStore } from './dictionary-store.ts';
import { selectScannedDocumentByFriendlyId, selectLayerByLayerName,
         getOrCreateTaggingSheet, type ScannedDocument } from './scanned-document.ts';
import { copyRefBoxToNewGroup, copyRefBoxToExistingGroup,
         renderStandaloneBoxes, renderStandaloneGroup,
         pageEditorURLForBoundingGroup, imageRefDescription } from './render-page-editor.ts';
import * as entryMeta from './render-entry-meta.ts';
import { updateBoundingBox, type BoundingBox } from './scanned-document.ts';
import { asyncRenderToStringViaLinkeDOM } from '../liminal/markup.ts';
import { extractStage, extractStageCached, type ExtractConfig, type ExtractStage } from '../liminal/extract.ts';
import { DerivationNotAvailable } from '../liminal/batch-derivation.ts';
import { containedImageSource } from './transcribe.ts';

export const PROMPT_VERSION_BIND = 3;   // v2: english + source_spelling keys
                                        //   (skeleton matching); v3: truncated-
                                        //   box extension (OCR missed the
                                        //   accented tail of a line - widen to
                                        //   the column edge) - see bindPrompt
export const BIND_MODEL = 'claude-opus-4-8';
export const BIND_IMAGE_BOX = 2000;   // dense two-column pages; gradeable knob

export const binderUsername = (dictionary: string) => `~${dictionary}-binder`;

// ---------------------------------------------------------------------------------
// --- Page input --------------------------------------------------------------------
// ---------------------------------------------------------------------------------

export interface BinderBox { id: number; x: number; y: number; w: number; h: number;
                             text: string; }
export interface BinderCandidate {
    entry_id: number;
    headwords: Array<{text: string, lane?: string}>;
    glosses: string[];
    // The book's OWN text, round-tripping back to its page (v2 - the
    // PRIMARY match keys): the English phrase as transcribed from the book
    // (\xe) and the book's own spelling of the word (\xv, the source
    // orthography lane).
    english: string[];
    source_spelling: string[];
    cited_pages: number[];
}
export interface BinderPageInput {
    printed_page: number;
    page_id: number;
    page_number: number;         // scan order
    page_width: number;          // column split for truncated-box widening
    image_ref: string;
    boxes: BinderBox[];
    candidates: BinderCandidate[];
}

/** The dictionary's CITATION relation: the relation carrying `book` +
 *  `page` scalar fields (the structured citations the transform parses -
 *  MMO-aligned naming, so this is a name probe, not a tag literal). */
export function citationRelation(schema: model.Schema): model.RelationField {
    const hits = schema.descendantAndSelfRelations.filter(r =>
        r.scalarFields.some(f => f.name === 'book') &&
        r.scalarFields.some(f => f.name === 'page'));
    if(hits.length !== 1)
        panic(`expected exactly one relation with book+page fields, found ${hits.length}`);
    return hits[0];
}

/** All tuple texts across the entry in ONE variant lane - the source
 *  orthography's text (the book's own spelling, hand-transcribed).  Walks
 *  every variant-bearing relation generically. */
function textsInLane(schema: model.Schema, entryJson: any, lane: string): string[] {
    const out: string[] = [];
    for(const rel of schema.descendantAndSelfRelations) {
        const v = rel.scalarFields.find(f => f instanceof model.VariantField)?.name;
        if(v === undefined) continue;
        const textField = rel.scalarFields.find(f =>
            !(f instanceof model.PrimaryKeyField) && !(f instanceof model.VariantField)
                && f.jsTypename() === 'string')?.name;
        if(textField === undefined) continue;
        for(const t of schemaRoles.collectTuples(entryJson, rel))
            if(t[v] === lane && (t[textField] ?? '') !== '' && !out.includes(t[textField]))
                out.push(t[textField]);
    }
    return out;
}

/** The entry's example_translation texts (MMO-aligned naming - for the
 *  imported books this is the English phrase as transcribed FROM the
 *  book).  Absent relation = empty. */
function englishTexts(schema: model.Schema, entryJson: any): string[] {
    const rel = schema.descendantAndSelfRelations.find(r => r.name === 'example_translation');
    if(!rel) return [];
    return schemaRoles.collectTuples(entryJson, rel)
        .map(t => schemaRoles.tupleText(rel, t))
        .filter(t => (t ?? '') !== '');
}

/** The entries citing (citedBook, printedPage), with each entry's FULL
 *  cited-page list for that book (multi-page citations are why a candidate
 *  may legitimately be absent from this page). */
export function candidatesForPage(store: DictionaryStore, citedBook: string,
                                  printedPage: number,
                                  opts: {sourceLane?: string} = {}): BinderCandidate[] {
    const schema = store.dictSchema;
    const rel = citationRelation(schema);
    const bookBind = (rel.fieldsByName['book'] as model.ScalarField).bind;
    const pageBind = (rel.fieldsByName['page'] as model.ScalarField).bind;
    const ids = db().all<{entry_id: number}, {book: string, page: number, ty: string}>(
        `SELECT DISTINCT id1 AS entry_id FROM ${store.assertionTable} ` +
        `WHERE ty = :ty AND valid_to = 9007199254740991 ` +
        `AND ${bookBind} = :book AND ${pageBind} = :page`,
        {book: citedBook, page: printedPage, ty: rel.tag});
    return ids.map(({entry_id}) => {
        const e = store.entriesById.get(entry_id);
        if(!e) return undefined;
        const cited = db().all<{page: number}, {book: string, id: number, ty: string}>(
            `SELECT DISTINCT ${pageBind} AS page FROM ${store.assertionTable} ` +
            `WHERE ty = :ty AND valid_to = 9007199254740991 ` +
            `AND ${bookBind} = :book AND id1 = :id AND ${pageBind} IS NOT NULL ` +
            `ORDER BY page`,
            {book: citedBook, id: entry_id, ty: rel.tag});
        return {entry_id,
                headwords: schemaRoles.headwordsAllLanes(schema, e)
                    .map(h => ({text: h.text, lane: h.variant})),
                glosses: schemaRoles.glossTexts(schema, e),
                english: englishTexts(schema, e),
                source_spelling: opts.sourceLane !== undefined
                    ? textsInLane(schema, e, opts.sourceLane) : [],
                cited_pages: cited.map(c => c.page)} as BinderCandidate;
    }).filter((c): c is BinderCandidate => c !== undefined);
}

/** Everything the extraction stage needs for one printed page, or
 *  undefined when the book has no scan page carrying that printed number. */
export function pageBinderInput(store: DictionaryStore, doc: ScannedDocument,
                                citedBook: string, printedPage: number,
                                opts: {sourceLane?: string} = {})
        : BinderPageInput|undefined {
    const page = db().first<{page_id: number, page_number: number, image_ref: string,
                             width: number},
                            {d: number, p: number}>(
        `SELECT page_id, page_number, image_ref, width FROM scanned_page ` +
        `WHERE document_id = :d AND printed_page_number = :p`,
        {d: doc.document_id, p: printedPage});
    if(!page) return undefined;
    const textLayer = selectLayerByLayerName().required(
        {document_id: doc.document_id, layer_name: 'Text'});
    const boxes = db().all<BinderBox, {page_id: number, layer_id: number}>(
        block`
/**/     SELECT bounding_box_id AS id, x, y, w, h, COALESCE(text, '') AS text
/**/       FROM bounding_box
/**/       WHERE page_id = :page_id AND layer_id = :layer_id
/**/       ORDER BY x > (SELECT width/2 FROM scanned_page WHERE page_id = :page_id), y`,
        {page_id: page.page_id, layer_id: textLayer.layer_id});
    return {printed_page: printedPage, page_id: page.page_id,
            page_number: page.page_number, page_width: page.width,
            image_ref: page.image_ref,
            boxes: boxes.map(b => ({...b, x: Math.round(b.x), y: Math.round(b.y),
                                    w: Math.round(b.w), h: Math.round(b.h)})),
            candidates: candidatesForPage(store, citedBook, printedPage, opts)};
}

// ---------------------------------------------------------------------------------
// --- The extraction stage -----------------------------------------------------------
// ---------------------------------------------------------------------------------

export interface BinderBinding { entry_id: number; box_ids: number[];
                                 extend_box_ids?: number[];
                                 confidence: 'high'|'medium'|'low'; note?: string; }
export interface BinderExtraction { bindings: BinderBinding[];
                                    unmatched_entries: number[];
                                    unclaimed_regions: string[]; }

export const BINDER_SCHEMA = {
    // Only `bindings` is REQUIRED: models sometimes omit empty arrays
    // despite `required` (a full-run killer on page 7 of 286) - the
    // driver defaults the lists instead.
    type: 'object', required: ['bindings'],
    properties: {
        bindings: {type: 'array', items: {type: 'object',
            // Same tolerance at the item level (p.24 omitted box_ids on
            // one of 135 bindings): the driver defaults; an id-less or
            // box-less binding degrades to bad-boxes, never a dead page.
            required: ['entry_id'],
            properties: {entry_id: {type: 'integer'},
                         box_ids: {type: 'array', items: {type: 'integer'}},
                         // Boxes (also listed in box_ids) whose printed line
                         // visibly continues past the box's right edge with
                         // text of THIS entry - the OCR missed the tail; the
                         // landing widens the copy to the column edge.
                         extend_box_ids: {type: 'array', items: {type: 'integer'}},
                         confidence: {enum: ['high', 'medium', 'low']},
                         note: {type: 'string'}}}},
        unmatched_entries: {type: 'array', items: {type: 'integer'}},
        unclaimed_regions: {type: 'array', items: {type: 'string'}},
    },
};

export function bindPrompt(input: BinderPageInput, bookTitle: string): string {
    const boxes = input.boxes.map(b =>
        JSON.stringify({id: b.id, x: b.x, y: b.y, w: b.w, h: b.h, text: b.text}))
        .join('\n');
    const entries = input.candidates.map(c =>
        JSON.stringify({entry_id: c.entry_id,
                        english: c.english,
                        source_spelling: c.source_spelling,
                        headwords: c.headwords.map(h =>
                            h.lane ? `${h.text} [${h.lane}]` : h.text),
                        glosses: c.glosses,
                        cited_pages: c.cited_pages}))
        .join('\n');
    return block`
/**/You are binding dictionary ENTRIES to the printed lines they came from, on
/**/one scanned page of "${bookTitle}" (printed page ${input.printed_page}).
/**/The attached image is the page scan.
/**/
/**/OCR LINE BOXES on this page (one JSON object per line; x/y/w/h are pixels
/**/on the original scan - the attached image may be scaled, so use RELATIVE
/**/positions).  The page body is typically TWO COLUMNS: the boxes are listed
/**/left column top-to-bottom, then right column:
/**/${boxes}
/**/
/**/CANDIDATE ENTRIES - dictionary entries whose source citation names this
/**/printed page.  Their fields, in order of usefulness for matching:
/**/- "english": the entry's English phrase AS TRANSCRIBED FROM THIS BOOK -
/**/  the PRIMARY key.  The printed line is near-verbatim (it may add a
/**/  leading "To "/"A ", punctuation, or hyphenate across lines).
/**/- "source_spelling": the book's OWN spelling of the word, transcribed
/**/  by hand from this book - the Mi'kmaq-side key.  The OCR text LOSES
/**/  AND GARBLES ACCENTS, so compare on the base-letter SKELETON (ignore
/**/  diacritics, case, and word breaks); where the OCR string looks
/**/  mangled, read the attached page image instead.
/**/- "headwords": a MODERN re-spelling - corroboration only, it will not
/**/  match the print letter-for-letter.
/**/${entries}
/**/
/**/TASK: for each candidate entry, identify the box ids of the OCR lines
/**/that make up THAT entry as printed: the English head phrase and its
/**/Mi'kmaq equivalent(s), INCLUDING indented continuation lines.  Entries
/**/run roughly alphabetically by their English phrase.
/**/
/**/Rules:
/**/- The printed entry for one English phrase often lists SEVERAL Mi'kmaq
/**/  equivalents, and each equivalent became its OWN dictionary record - so
/**/  several candidate entries may map to the SAME printed lines.  Assign
/**/  the shared boxes to EACH of those entries.
/**/- PRECISION over recall: if you cannot locate an entry confidently, put
/**/  its id in unmatched_entries instead of guessing.  (A candidate whose
/**/  citation lists several pages may genuinely be on another page.)
/**/- confidence: "high" = certain; "medium" = probable (e.g. the OCR text
/**/  is garbled but position and content agree); "low" = a guess.
/**/- Page furniture (running heads, page numbers, guide words) belongs to
/**/  no entry.
/**/- TRUNCATED BOXES: the OCR sometimes missed the accented tail of a line,
/**/  so its box covers only the start (often just the English words, with
/**/  the Mi'kmaq equivalent visibly printed after it but outside the box).
/**/  Check the image: when a chosen box's printed line continues past the
/**/  box's right edge with text belonging to the SAME entry, list that box
/**/  id in extend_box_ids too (the box will be widened to the column edge).
/**/- unclaimed_regions: short text descriptions of body lines that belong
/**/  to NO candidate (they indicate entries missing from the candidate
/**/  list) - not box ids, just human-readable notes.
/**/`;
}

/** Run the (memoized) extraction stage for one page.  Everything
 *  output-relevant is in the cache key: the page image content path, the
 *  model, PROMPT_VERSION_BIND, the image box, and the full input JSON
 *  (boxes + candidates) - new citations or box edits re-extract the page,
 *  nothing else does. */
export async function bindPageViaLlm(cfg: ExtractConfig, input: BinderPageInput,
                                     bookTitle: string,
                                     model: string = BIND_MODEL,
                                     opts: {cachedOnly?: boolean} = {})
        : Promise<BinderExtraction|undefined> {
    const stage: ExtractStage = {
        name: 'bind', model, promptVersion: PROMPT_VERSION_BIND,
        imageBox: BIND_IMAGE_BOX, schema: BINDER_SCHEMA,
        prompt: (i: unknown) => bindPrompt(i as BinderPageInput, bookTitle),
    };
    // CACHED-ONLY (dz): land what the derived store already holds, skip the
    // rest - re-migrations on any container get the extracted pages at zero
    // LLM spend and with NO credential.
    if(opts.cachedOnly &&
       !await extractStageCached(cfg, input.image_ref, 0, stage, input))
        return undefined;
    const raw = await extractStage(cfg, input.image_ref, 0, stage, input) as BinderExtraction;
    return {bindings: (raw.bindings ?? []).map(b => ({
                ...b, box_ids: b.box_ids ?? [],
                confidence: b.confidence ?? 'low'})),
            unmatched_entries: raw.unmatched_entries ?? [],
            unclaimed_regions: raw.unclaimed_regions ?? []};
}

export function binderImageSource() {
    return containedImageSource('derived/page-contained');
}

// ---------------------------------------------------------------------------------
// --- Landing -------------------------------------------------------------------------
// ---------------------------------------------------------------------------------

/** LexemeOps over the store, authored as the binder's system user (the
 *  machine-contributors per-feature username). */
export function binderOps(ww: WordWiki, store: DictionaryStore, author: string): LexemeOps {
    const app: LexemeApp = {
        get dictSchema() { return store.dictSchema; },
        get workspace() { return store.workspace; },
        get assertionTable() { return store.assertionTable; },
        get entriesById() { return store.entriesById; },
        applyTransaction: (a, o) => store.applyTransaction(a, o ?? {}),
        // Quiet batch apply: the landing loop runs a thousand of these -
        // the default per-tx JSON echo is minutes of console alone.
        applyTransactions: (a) => {
            const byTx = Map.groupBy(a, (x: Assertion) => x.valid_from);
            db().transaction(() => {
                for(const g of byTx.values()) store.applyTransaction([...g], {quiet: true});
            });
        },
        allocTxTimestamps: (c, o) => store.allocTxTimestamps(c, o),
        requestWorkspaceReload: () => store.requestWorkspaceReload(),
        requestEntriesJSONReload: () => store.requestEntriesJSONReload(),
        currentUsername: () => author,
        get orthographies() { return ww.orthographies; },
    };
    return new LexemeOps(app);
}

/** The entry's existing reference groups that have a box on `page_id`
 *  (hand tags OR earlier binder runs) - the idempotence test.  PURE SQL:
 *  the landing loop runs this after every applied binding, and touching
 *  store.entriesById there would rebuild the whole entries JSON per
 *  binding (the applyTransaction invalidation) - hours, not minutes. */
export function entryGroupsOnPage(store: DictionaryStore, entry_id: number,
                                  page_id: number): number[] {
    const refRel = store.dictSchema.relationsByRole.documentReference;
    if(!refRel) return [];
    const bind = refRel.scalarFields.find(f => f.style.$shape === 'boundingGroup')?.bind;
    if(!bind) return [];
    return db().all<{g: number}, {ty: string, e: number, p: number}>(
        `SELECT DISTINCT ref.${bind} AS g FROM ${store.assertionTable} AS ref ` +
        `JOIN bounding_box AS bb ON bb.bounding_group_id = ref.${bind} ` +
        `WHERE ref.ty = :ty AND ref.id1 = :e AND ref.valid_to = 9007199254740991 ` +
        `AND bb.page_id = :p`,
        {ty: refRel.tag, e: entry_id, p: page_id}).map(r => r.g);
}

export interface PlacedBox { id: number; page_id: number;
                             x: number; y: number; w: number; h: number;
                             extended: boolean; }

/** The final rectangles for a binding's boxes: extended boxes widen to
 *  their COLUMN's right edge (the OCR missed the accented tail of the
 *  line; the print runs to the column edge).  Columns split at the page
 *  midline - the same rule the box ordering uses. */
export function placedBoxes(input: BinderPageInput, boxIds: number[],
                            extendIds: Set<number>): PlacedBox[] {
    const byId = new Map(input.boxes.map(b => [b.id, b]));
    const mid = input.page_width / 2;
    const colEdge = (b: BinderBox) => Math.max(
        ...input.boxes.filter(x => (x.x < mid) === (b.x < mid)).map(x => x.x + x.w));
    return boxIds.flatMap(id => {
        const b = byId.get(id);
        if(!b) return [];
        const extended = extendIds.has(id);
        return [{id, page_id: input.page_id, x: b.x, y: b.y,
                 w: extended ? Math.max(b.w, colEdge(b) - b.x) : b.w,
                 h: b.h, extended}];
    });
}

export type LandOutcome =
    | {outcome: 'bound', entry_id: number, bounding_group_id: number, fact_id: number}
    | {outcome: 'already-referenced', entry_id: number}
    | {outcome: 'below-threshold', entry_id: number, confidence: string}
    | {outcome: 'bad-boxes', entry_id: number};

const CONFIDENCE_RANK = {high: 3, medium: 2, low: 1} as const;

/** Land ONE binding: group on the dictionary's sheet + boxes copied from
 *  the Text layer + the reference fact.  Pure landing - the extraction
 *  already happened (and is cached). */
export function landBinding(ww: WordWiki, store: DictionaryStore, ops: LexemeOps,
                            sheetLayerId: number, input: BinderPageInput,
                            b: BinderBinding,
                            minConfidence: 'high'|'medium'|'low'): LandOutcome {
    if(CONFIDENCE_RANK[b.confidence] < CONFIDENCE_RANK[minConfidence])
        return {outcome: 'below-threshold', entry_id: b.entry_id, confidence: b.confidence};
    const known = new Set(input.boxes.map(x => x.id));
    const boxIds = b.box_ids.filter(id => known.has(id));
    if(boxIds.length === 0 || !input.candidates.some(c => c.entry_id === b.entry_id))
        return {outcome: 'bad-boxes', entry_id: b.entry_id};
    if(entryGroupsOnPage(store, b.entry_id, input.page_id).length > 0)
        return {outcome: 'already-referenced', entry_id: b.entry_id};
    const placed = placedBoxes(input, boxIds,
                               new Set(b.extend_box_ids ?? []));
    const {bounding_group_id, bounding_box_id: firstCopy} =
        copyRefBoxToNewGroup(placed[0].id, sheetLayerId, 'green');
    const copies = [{placed: placed[0], copy: firstCopy}];
    for(const pb of placed.slice(1))
        copies.push({placed: pb,
                     copy: copyRefBoxToExistingGroup(bounding_group_id, pb.id).bounding_box_id});
    // Widen the copies of truncated boxes to the column edge (the Text-
    // layer originals stay untouched - only OUR copies stretch).
    for(const c of copies)
        if(c.placed.extended)
            updateBoundingBox(c.copy, ['w'], {w: c.placed.w});
    const {fact_id} = ops.addReferenceToEntry(b.entry_id, bounding_group_id);
    return {outcome: 'bound', entry_id: b.entry_id, bounding_group_id, fact_id};
}

// ---------------------------------------------------------------------------------
// --- The driver + report --------------------------------------------------------------
// ---------------------------------------------------------------------------------

export interface BindPagesOptions {
    book: string;                    // friendly_document_id
    dictionary: string;              // target dictionary table
    citedBook: string;               // the book value citations carry
    printedPages: number[];
    apply?: boolean;
    minConfidence?: 'high'|'medium'|'low';
    sourceLane?: string;             // the book's own-orthography variant lane
                                     //   (rand: 'rand') - fills source_spelling
    // Injectable extractor (tests bind without an LLM; the CLI passes the
    // real memoized stage).  `undefined` = not cached (cached-only mode
    // skips the page).
    extract: (input: BinderPageInput) => Promise<BinderExtraction|undefined>;
    log?: (m: string) => void;
}

export interface PageBindReport {
    printed_page: number;
    page_id?: number;
    page_number?: number;            // scan order (page-editor links)
    candidates: number;
    boxes: number;
    bound: Array<{entry_id: number, headword: string, boxTexts: string[],
                  rects: PlacedBox[], confidence: string}>;
    alreadyReferenced: number[];
    belowThreshold: Array<{entry_id: number, headword: string, confidence: string,
                           rects: PlacedBox[]}>;
    badBoxes: number[];
    unmatched: Array<{entry_id: number, headword: string}>;
    unclaimed: string[];
    noScanPage?: boolean;
    failed?: string;                 // the extraction failed (API/validation) -
                                     //   the page is retryable (nothing cached)
    skippedUncached?: boolean;       // cached-only mode: no extraction yet
    deferred?: boolean;              // batch mode: enrolled, result not landed
                                     //   yet - rerun when the batch ends
}

export async function bindPages(ww: WordWiki, opts: BindPagesOptions)
        : Promise<PageBindReport[]> {
    const log = opts.log ?? ((m: string) => console.info(m));
    const store = ww.storeFor(opts.dictionary);
    const doc = selectScannedDocumentByFriendlyId().required(
        {friendly_document_id: opts.book});
    const sheet = getOrCreateTaggingSheet(doc.document_id, opts.dictionary);
    const ops = binderOps(ww, store, binderUsername(opts.dictionary));
    const minConfidence = opts.minConfidence ?? 'medium';
    // Headwords come from the page's CANDIDATES (already assembled), never
    // from store.entriesById - the entries JSON is invalidated by every
    // applied binding, and re-touching it per row rebuilds the whole
    // dictionary's JSON each time.
    let pageHeadwords = new Map<number, string>();
    const headwordOf = (entry_id: number): string =>
        pageHeadwords.get(entry_id) ?? `(entry ${entry_id})`;

    const reports: PageBindReport[] = [];
    for(const printed of opts.printedPages) {
        const input = pageBinderInput(store, doc, opts.citedBook, printed,
                                      {sourceLane: opts.sourceLane});
        if(!input) {
            reports.push({printed_page: printed, candidates: 0, boxes: 0, bound: [],
                          alreadyReferenced: [], belowThreshold: [], badBoxes: [],
                          unmatched: [], unclaimed: [], noScanPage: true});
            continue;
        }
        pageHeadwords = new Map(input.candidates.map(c =>
            [c.entry_id, c.headwords[0]?.text ?? `(entry ${c.entry_id})`]));
        const r: PageBindReport = {
            printed_page: printed, page_id: input.page_id,
            page_number: input.page_number, candidates: input.candidates.length,
            boxes: input.boxes.length, bound: [], alreadyReferenced: [],
            belowThreshold: [], badBoxes: [], unmatched: [], unclaimed: []};
        if(input.candidates.length === 0) { reports.push(r); continue; }

        // One bad page must not kill a multi-hour run: a failed extraction
        // (transient API error, schema misfire) reports and moves on -
        // nothing caches on failure, so a re-run retries exactly the
        // failed pages at no extra cost for the rest.  In BATCH mode a miss
        // ENROLLS and throws DerivationNotAvailable instead - that page is
        // DEFERRED (this page loop is the design's top loop over units;
        // catching here is what lets every other page still enroll into the
        // same batch), and a rerun after the batch lands completes it.
        let extraction: BinderExtraction|undefined;
        try {
            extraction = await opts.extract(input);
        } catch(e) {
            if(e instanceof DerivationNotAvailable) {
                r.deferred = true;
                reports.push(r);
                continue;
            }
            r.failed = e instanceof Error ? e.message : String(e);
            log(`p.${printed}: EXTRACTION FAILED - ${r.failed}`);
            reports.push(r);
            continue;
        }
        if(extraction === undefined) {
            r.skippedUncached = true;
            reports.push(r);
            continue;
        }
        r.unclaimed = extraction.unclaimed_regions;
        const boxText = new Map(input.boxes.map(b => [b.id, b.text]));
        // The model occasionally contradicts itself (an entry both bound and
        // unmatched, or bound twice): first binding wins, and an entry with
        // an accepted proposal never also reports as unmatched.
        const seen = new Set<number>();
        const bindings = extraction.bindings.filter(b =>
            seen.has(b.entry_id) ? false : (seen.add(b.entry_id), true));
        for(const b of bindings) {
            const known = b.box_ids.filter(id => boxText.has(id));
            const rects = placedBoxes(input, known, new Set(b.extend_box_ids ?? []));
            if(!opts.apply) {
                // Dry run: everything the LANDING would accept reports as a
                // proposal (threshold + validity applied, nothing written).
                if(CONFIDENCE_RANK[b.confidence] < CONFIDENCE_RANK[minConfidence]) {
                    r.belowThreshold.push({entry_id: b.entry_id,
                                           headword: headwordOf(b.entry_id),
                                           confidence: b.confidence, rects});
                    continue;
                }
                if(known.length === 0 ||
                   !input.candidates.some(c => c.entry_id === b.entry_id)) {
                    r.badBoxes.push(b.entry_id); continue;
                }
                if(entryGroupsOnPage(store, b.entry_id, input.page_id).length > 0) {
                    r.alreadyReferenced.push(b.entry_id); continue;
                }
                r.bound.push({entry_id: b.entry_id, headword: headwordOf(b.entry_id),
                              boxTexts: known.map(id => boxText.get(id) ?? ''),
                              rects, confidence: b.confidence});
                continue;
            }
            const out = landBinding(ww, store, ops, sheet, input, b, minConfidence);
            switch(out.outcome) {
                case 'bound':
                    r.bound.push({entry_id: b.entry_id, headword: headwordOf(b.entry_id),
                                  boxTexts: known.map(id => boxText.get(id) ?? ''),
                                  rects, confidence: b.confidence});
                    break;
                case 'already-referenced': r.alreadyReferenced.push(b.entry_id); break;
                case 'below-threshold':
                    r.belowThreshold.push({entry_id: b.entry_id,
                                           headword: headwordOf(b.entry_id),
                                           confidence: b.confidence, rects});
                    break;
                case 'bad-boxes': r.badBoxes.push(b.entry_id); break;
            }
        }
        const proposed = new Set(r.bound.map(b => b.entry_id));
        const candidateIds = new Set(input.candidates.map(c => c.entry_id));
        r.unmatched = extraction.unmatched_entries
            .filter(id => candidateIds.has(id) && !proposed.has(id))
            .map(id => ({entry_id: id, headword: headwordOf(id)}));
        reports.push(r);
        log(`p.${printed}: ${r.bound.length}/${r.candidates} ${opts.apply ? 'bound' : 'proposed'}` +
            (r.alreadyReferenced.length ? `, ${r.alreadyReferenced.length} already-ref'd` : '') +
            (r.belowThreshold.length ? `, ${r.belowThreshold.length} low-conf` : '') +
            (r.unmatched.length ? `, ${r.unmatched.length} unmatched` : ''));
    }
    return reports;
}

/** The VISUAL review page (dz): a linear list of every proposal with its
 *  scan region AND the FULL entry rendering (the word view's metadata
 *  renderer - headword lanes, senses, the transcription/translation
 *  pairs, citations), so each proposal can be judged against the
 *  complete entry without leaving the list.  Tiles and styles serve from
 *  the running app; written into resources/ (the transcribe-eval
 *  pattern) - view it logged in, e.g. /resources/rand-binder-review.html. */
export async function bindReviewHtml(ww: WordWiki,
                                     opts: {book: string, dictionary: string,
                                            citedBook: string, apply: boolean},
                                     reports: PageBindReport[]): Promise<string> {
    const store = ww.storeFor(opts.dictionary);
    const schema = store.dictSchema;
    const scan = (rects: PlacedBox[]) => {
        try {
            return renderStandaloneBoxes('/', rects.map(r => ({
                bounding_box_id: r.id, page_id: r.page_id,
                x: r.x, y: r.y, w: r.w, h: r.h} as BoundingBox)), 3);
        } catch { return ['span', {class: 'muted'}, '(scan unavailable)']; }
    };
    // The full entry, same composition as the facade word page (incl. the
    // reference-scan renderer for entries that ALREADY carry refs - the
    // post-apply review).
    const fullEntry = (entry_id: number) => {
        const e = store.entriesById.get(entry_id);
        if(!e) return ['p', {class: 'muted'}, '(entry not found)'];
        return ['div', {class: 'page-content review-full'},
                entryMeta.renderEntryMeta(
                    {rootPath: '/', audience: 'internal',
                     renderBoundingGroup: (gid: number) => {
                         try {
                             const sc = renderStandaloneGroup('/', gid);
                             let url = ''; try { url = pageEditorURLForBoundingGroup(gid); } catch { /**/ }
                             let desc = ''; try { desc = imageRefDescription(gid); } catch { /**/ }
                             return ['div', {},
                                 ['div', {class: 'lm-me-scan'}, url ? ['a', {href: url}, sc] : sc],
                                 desc ? ['div', {}, url ? ['a', {href: url}, desc] : desc] : ''];
                         } catch {
                             return ['div', {class: 'muted small'}, `(scan group ${gid})`];
                         }
                     }},
                    schema.relationFields[0], e)];
    };
    const wordUrl = (id: number) => `/ww/wordwiki.dicts.${opts.dictionary}.word(${id})`;
    const tot = (f: (r: PageBindReport) => number) => reports.reduce((n, r) => n + f(r), 0);

    const body = [
        ['h1', {}, `Reference binder review: ${opts.citedBook} \u2192 '${opts.dictionary}'` +
            (opts.apply ? '' : ' (dry run - nothing landed)')],
        ['p', {class: 'muted'},
         `${reports.length} page(s); ${tot(r => r.candidates)} candidates; ` +
         `${tot(r => r.bound.length)} ${opts.apply ? 'bound' : 'proposed'}; ` +
         `${tot(r => r.belowThreshold.length)} below threshold; ` +
         `${tot(r => r.unmatched.length)} unmatched; ` +
         `${tot(r => r.unclaimed.length)} unclaimed regions`],
        reports.map(r => [
            ['h2', {}, `Printed p.${r.printed_page} `,
             r.noScanPage
                 ? ['span', {class: 'muted'}, '- no scan page carries this number']
                 : ['a', {href: `/ww/wordwiki.pages.pageEditor(${JSON.stringify(opts.book)}, ` +
                                `${r.page_number}, 'Text', ${JSON.stringify(opts.dictionary)})`,
                          target: '_blank', class: 'muted small'},
                    `(open page in the tagger)`]],
            r.bound.map(b => [
                ['section', {class: 'entry'},
                 ['h3', {},
                  ['a', {href: wordUrl(b.entry_id), target: '_blank'}, b.headword],
                  b.confidence !== 'high'
                      ? ['span', {class: `badge conf`}, b.confidence] : undefined],
                 ['div', {class: 'review-cols'},
                  ['div', {class: 'review-scan'},
                   ['div', {}, scan(b.rects)],
                   ['div', {class: 'muted small'},
                    b.boxTexts.join(' \u23ce '),
                    b.rects.some(x => x.extended)
                        ? ['span', {class: 'badge conf ms-1'}, 'widened'] : undefined]],
                  fullEntry(b.entry_id)]]]),
            // Entries whose reference LANDED in an earlier run (idempotent
            // top-ups): the full card still shows - the landed scan renders
            // inside the entry itself (document_reference).
            r.alreadyReferenced.map(id => {
                const e = store.entriesById.get(id);
                return ['section', {class: 'entry'},
                    ['h3', {},
                     ['a', {href: wordUrl(id), target: '_blank'},
                      (e && schemaRoles.headwordFallback(schema, e)?.text) ?? `(entry ${id})`],
                     ['span', {class: 'badge conf'}, 'landed earlier']],
                    fullEntry(id)];
            }),
            r.belowThreshold.map(b => [
                ['section', {class: 'entry worklist'},
                 ['h3', {},
                  ['a', {href: wordUrl(b.entry_id), target: '_blank'}, b.headword],
                  ['span', {class: 'badge poor'}, `below threshold: ${b.confidence}`]],
                 b.rects.length > 0 ? ['div', {}, scan(b.rects)] : undefined]]),
            r.unmatched.map(u =>
                ['p', {class: 'worklist'}, '\u2757 unmatched: ',
                 ['a', {href: wordUrl(u.entry_id), target: '_blank'}, u.headword]]),
            r.unclaimed.map(u =>
                ['p', {class: 'muted'}, '\u2753 unclaimed region: ', u]),
        ]),
    ];
    const inner = (await asyncRenderToStringViaLinkeDOM(['div', {}, body]))
        .replace(/^<!DOCTYPE html>/, '');    // the shell supplies its own
    // The site's own stylesheets (bootstrap + theme + liminal +
    // page-editor's transparent svg frames) so the full entry renderings
    // look exactly like the word views; served same-origin.
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reference binder review \u2014 ${opts.citedBook}</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
<link href="/resources/site-theme.css" rel="stylesheet">
<link href="/resources/instance.css" rel="stylesheet">
<link href="/resources/liminal.css" rel="stylesheet">
<link href="/resources/page-editor.css" rel="stylesheet">
<style>
 body { margin: 1.5rem auto; max-width: 70rem; padding: 0 1rem; }
 h1 { font-size: 1.4rem; } h2 { font-size: 1.15rem; margin-top: 2rem;
      border-bottom: 2px solid #ccc; padding-bottom: .3rem; }
 h3 { font-size: 1.05rem; margin: 0 0 .3rem; }
 .muted { color: #6c757d; } .small { font-size: .85rem; }
 section.entry { margin: 1.3rem 0; padding-top: .8rem; border-top: 1px solid #ddd; }
 section.worklist, p.worklist { background: #fff8f0; }
 .conf { background: #fff3cd; color: #664d03; }
 .poor { background: #f8d7da; color: #842029; }
 .review-cols { display: flex; gap: 1.2rem; flex-wrap: wrap; align-items: flex-start; }
 .review-scan { flex: 0 1 24rem; }
 .review-full { flex: 1 1 26rem; min-width: 0; font-size: .92rem; }
 .review-full h1 { font-size: 1.05rem; margin: 0 0 .3rem; }
 .review-scan svg { max-width: 100%; height: auto; border: 1px solid #ddd;
                    border-radius: 3px; background: #fff; }
</style></head><body>
${inner}
</body></html>
`;
}

export function bindReportMarkdown(opts: {book: string, dictionary: string,
                                          citedBook: string, apply: boolean},
                                   reports: PageBindReport[]): string {
    const tot = (f: (r: PageBindReport) => number) => reports.reduce((n, r) => n + f(r), 0);
    const lines: string[] = [
        `# Reference binder: ${opts.citedBook} pages -> '${opts.dictionary}' entries` +
            (opts.apply ? '' : ' (DRY RUN)'),
        ``,
        `- pages: ${reports.length}; candidates: ${tot(r => r.candidates)}; ` +
            `${opts.apply ? 'bound' : 'proposed'}: ${tot(r => r.bound.length)}; ` +
            `already-referenced: ${tot(r => r.alreadyReferenced.length)}; ` +
            `below-threshold: ${tot(r => r.belowThreshold.length)}; ` +
            `bad-boxes: ${tot(r => r.badBoxes.length)}; ` +
            `unmatched: ${tot(r => r.unmatched.length)}`,
    ];
    for(const r of reports) {
        lines.push(``, `## printed p.${r.printed_page}` +
            (r.noScanPage ? ' - NO SCAN PAGE CARRIES THIS NUMBER' :
             ` (${r.candidates} candidates, ${r.boxes} boxes)`));
        if(r.failed) lines.push(`- EXTRACTION FAILED (retryable): ${r.failed}`);
        if(r.skippedUncached) lines.push(`- skipped (no cached extraction - cached-only mode)`);
        if(r.deferred) lines.push(`- deferred (enrolled in batch - rerun when the batch lands)`);
        for(const b of r.bound)
            lines.push(`- **${b.headword}** (${b.entry_id}):`,
                       ...b.boxTexts.map(t => `    - ${t}`));
        if(r.alreadyReferenced.length)
            lines.push(`- already referenced (hand tags win): ${r.alreadyReferenced.join(', ')}`);
        for(const b of r.belowThreshold)
            lines.push(`- below threshold (${b.confidence}): entry ${b.entry_id}`);
        if(r.badBoxes.length)
            lines.push(`- bad box ids from the model: ${r.badBoxes.join(', ')}`);
        for(const u of r.unmatched)
            lines.push(`- unmatched: **${u.headword}** (${u.entry_id})`);
        for(const u of r.unclaimed)
            lines.push(`- unclaimed region: ${u}`);
    }
    return lines.join('\n') + '\n';
}
