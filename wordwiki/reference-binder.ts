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
import type { WordWiki } from './wordwiki.ts';
import type { DictionaryStore } from './dictionary-store.ts';
import { selectScannedDocumentByFriendlyId, selectLayerByLayerName,
         getOrCreateTaggingSheet, type ScannedDocument } from './scanned-document.ts';
import { copyRefBoxToNewGroup, copyRefBoxToExistingGroup } from './render-page-editor.ts';
import { extractStage, type ExtractConfig, type ExtractStage } from '../liminal/extract.ts';
import { containedImageSource } from './transcribe.ts';

export const PROMPT_VERSION_BIND = 2;   // v2: english + source_spelling keys
                                        //   (skeleton matching) - see bindPrompt
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
    const page = db().first<{page_id: number, page_number: number, image_ref: string},
                            {d: number, p: number}>(
        `SELECT page_id, page_number, image_ref FROM scanned_page ` +
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
            page_number: page.page_number, image_ref: page.image_ref,
            boxes: boxes.map(b => ({...b, x: Math.round(b.x), y: Math.round(b.y),
                                    w: Math.round(b.w), h: Math.round(b.h)})),
            candidates: candidatesForPage(store, citedBook, printedPage, opts)};
}

// ---------------------------------------------------------------------------------
// --- The extraction stage -----------------------------------------------------------
// ---------------------------------------------------------------------------------

export interface BinderBinding { entry_id: number; box_ids: number[];
                                 confidence: 'high'|'medium'|'low'; note?: string; }
export interface BinderExtraction { bindings: BinderBinding[];
                                    unmatched_entries: number[];
                                    unclaimed_regions: string[]; }

export const BINDER_SCHEMA = {
    type: 'object', required: ['bindings', 'unmatched_entries', 'unclaimed_regions'],
    properties: {
        bindings: {type: 'array', items: {type: 'object',
            required: ['entry_id', 'box_ids', 'confidence'],
            properties: {entry_id: {type: 'integer'},
                         box_ids: {type: 'array', items: {type: 'integer'}},
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
                                     model: string = BIND_MODEL): Promise<BinderExtraction> {
    const stage: ExtractStage = {
        name: 'bind', model, promptVersion: PROMPT_VERSION_BIND,
        imageBox: BIND_IMAGE_BOX, schema: BINDER_SCHEMA,
        prompt: (i: unknown) => bindPrompt(i as BinderPageInput, bookTitle),
    };
    return await extractStage(cfg, input.image_ref, 0, stage, input) as BinderExtraction;
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
        applyTransactions: (a) => store.applyTransactions(a),
        allocTxTimestamps: (c, o) => store.allocTxTimestamps(c, o),
        requestWorkspaceReload: () => store.requestWorkspaceReload(),
        requestEntriesJSONReload: () => store.requestEntriesJSONReload(),
        currentUsername: () => author,
        get orthographies() { return ww.orthographies; },
    };
    return new LexemeOps(app);
}

/** The entry's existing reference groups that have a box on `page_id`
 *  (hand tags OR earlier binder runs) - the idempotence test. */
export function entryGroupsOnPage(store: DictionaryStore, entry_id: number,
                                  page_id: number): number[] {
    const e = store.entriesById.get(entry_id);
    if(!e) return [];
    const groups = schemaRoles.referenceGroupIds(store.dictSchema, e)
        .filter(g => g != null);
    if(groups.length === 0) return [];
    return groups.filter(g =>
        (db().first<{n: number}, {g: number, p: number}>(
            `SELECT COUNT(*) AS n FROM bounding_box ` +
            `WHERE bounding_group_id = :g AND page_id = :p`, {g, p: page_id})?.n ?? 0) > 0);
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
    const {bounding_group_id} = copyRefBoxToNewGroup(boxIds[0], sheetLayerId, 'green');
    for(const id of boxIds.slice(1))
        copyRefBoxToExistingGroup(bounding_group_id, id);
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
    // real memoized stage).
    extract: (input: BinderPageInput) => Promise<BinderExtraction>;
    log?: (m: string) => void;
}

export interface PageBindReport {
    printed_page: number;
    candidates: number;
    boxes: number;
    bound: Array<{entry_id: number, headword: string, boxTexts: string[]}>;
    alreadyReferenced: number[];
    belowThreshold: Array<{entry_id: number, confidence: string}>;
    badBoxes: number[];
    unmatched: Array<{entry_id: number, headword: string}>;
    unclaimed: string[];
    noScanPage?: boolean;
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
    const headwordOf = (entry_id: number): string => {
        const e = store.entriesById.get(entry_id);
        return (e && schemaRoles.headwordFallback(store.dictSchema, e)?.text)
            ?? `(entry ${entry_id})`;
    };

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
        const r: PageBindReport = {
            printed_page: printed, candidates: input.candidates.length,
            boxes: input.boxes.length, bound: [], alreadyReferenced: [],
            belowThreshold: [], badBoxes: [], unmatched: [], unclaimed: []};
        if(input.candidates.length === 0) { reports.push(r); continue; }

        const extraction = await opts.extract(input);
        r.unclaimed = extraction.unclaimed_regions;
        const boxText = new Map(input.boxes.map(b => [b.id, b.text]));
        // The model occasionally contradicts itself (an entry both bound and
        // unmatched, or bound twice): first binding wins, and an entry with
        // an accepted proposal never also reports as unmatched.
        const seen = new Set<number>();
        const bindings = extraction.bindings.filter(b =>
            seen.has(b.entry_id) ? false : (seen.add(b.entry_id), true));
        for(const b of bindings) {
            if(!opts.apply) {
                // Dry run: everything the LANDING would accept reports as a
                // proposal (threshold + validity applied, nothing written).
                if(CONFIDENCE_RANK[b.confidence] < CONFIDENCE_RANK[minConfidence]) {
                    r.belowThreshold.push({entry_id: b.entry_id, confidence: b.confidence});
                    continue;
                }
                const known = b.box_ids.filter(id => boxText.has(id));
                if(known.length === 0 ||
                   !input.candidates.some(c => c.entry_id === b.entry_id)) {
                    r.badBoxes.push(b.entry_id); continue;
                }
                if(entryGroupsOnPage(store, b.entry_id, input.page_id).length > 0) {
                    r.alreadyReferenced.push(b.entry_id); continue;
                }
                r.bound.push({entry_id: b.entry_id, headword: headwordOf(b.entry_id),
                              boxTexts: known.map(id => boxText.get(id) ?? '')});
                continue;
            }
            const out = landBinding(ww, store, ops, sheet, input, b, minConfidence);
            switch(out.outcome) {
                case 'bound':
                    r.bound.push({entry_id: b.entry_id, headword: headwordOf(b.entry_id),
                                  boxTexts: b.box_ids.map(id => boxText.get(id) ?? '')});
                    break;
                case 'already-referenced': r.alreadyReferenced.push(b.entry_id); break;
                case 'below-threshold':
                    r.belowThreshold.push({entry_id: b.entry_id, confidence: b.confidence});
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
