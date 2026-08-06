// deno-lint-ignore-file no-explicit-any
/**
 * PDM IMPORT (pdm-import-survey.md; the Clark landing pattern applied to
 * the Pacifique manuscript): segment pages into VISUAL entries, read each
 * with the five-stage recipe under the MEASURED escalation policy, and
 * land a `pdm` reference dictionary whose documentReferences carry the
 * same five rungs the researchers produce by hand (rtr/rex/rtl/rse/rne)
 * - machine drafts in the researcher's own shape, ready for dz's
 * browse-and-import-to-MMO flow.
 *
 * SEGMENTATION (v4-measured): the grouping task with Opus (68.3 F1 vs
 * visual-entry gold), starts+bands as the fallback when a grouping
 * response is malformed.  Groups land on the 'Tagging:pdm' sheet (the
 * hand Tagging layer is untouched gold).
 *
 * READING (escalation-measured): Sonnet letter stages; the WHOLE REF
 * re-runs on Opus when transcribe confidence < 42 (each model wins its
 * own regime - the gate beats all-Opus on transcribe); structuring
 * stages always Opus.
 *
 * LANDING: import-mirror semantics (wipe + rebuild, content-keyed ids,
 * human workflow rows exempt), the Clark conventions throughout.
 */
import * as timestamp from '../liminal/timestamp.ts';
import * as orderkey from '../liminal/orderkey.ts';
import * as posix from "https://deno.land/std@0.195.0/path/posix.ts";
import { db } from "../liminal/db.ts";
import { loadLlm, LlmUsage } from "../liminal/llm.ts";
import { extractStage, ExtractConfig, ExtractStage } from "../liminal/extract.ts";
import { highestTimestamp, type Assertion, assertionPathToFields } from '../wordwiki/assertion.ts';
import * as dictionaryConfig from '../wordwiki/dictionary-config.ts';
import { contentKeyId } from '../wordwiki/sfm-import.ts';
import { selectScannedDocumentByFriendlyId, getOrCreateTaggingSheet } from '../wordwiki/scanned-document.ts';
import { copyRefBoxToNewGroup, copyRefBoxToExistingGroup } from '../wordwiki/render-page-editor.ts';
import { groupCropPath, boxesCropPath, groupCropImageSource, pdmRecipe, wordSplitStage,
         coerceRuns, coerceConfidence } from '../wordwiki/transcribe.ts';
import { llmRetry } from '../wordwiki/page-transcribe.ts';
import { DerivationNotAvailable } from '../liminal/batch-derivation.ts';
import { pdmPage, clusterRuns, annotatedPagePath, pdmSegmentStage, pdmStartStage,
         spansFromStarts, TUNED_CLUSTER, type Run } from './pdm-segment.ts';

export const PDM_IMPORT_USERNAME = '~pdm-import';
const SEGMENT_MODEL = 'claude-opus-4-8';       // v4: opus wins segmentation
const LETTER_MODEL = 'claude-sonnet-5';        // parity on the vision stages
const STRONG_MODEL = 'claude-opus-4-8';        // structuring + escalation
const ESCALATE_BELOW = 42;                     // transcribe confidence gate

const WORKFLOW_TYS = `('tdo', 'log')`;

/** The pdm soft schema: spellings in BOTH lanes (mm-li from the
 *  normalized rung, mm-pm from the transcription), the English gloss,
 *  and a documentReference carrying the five machine rungs in the SAME
 *  tags the researchers' manual fields use (rtr/rex/rtl/rse/rne) - so
 *  the import-to-MMO copy is field-for-field. */
export const PDM_SCHEMA_JSON: any = {
    $type: 'schema', $name: 'pdm', $tag: 'pdm',
    entry: {
        $type: 'relation', $tag: 'ent', $style: {$shape: 'containerRelation'},
        entry_id: {$type: 'primary_key', $bind: 'id'},
        spelling: {
            $type: 'relation', $tag: 'spl',
            $style: {$shape: 'compactInlineListRelation',
                     $view: {order: 1, titleRole: 'headword', join: ' / ', label: 'inline'}},
            spelling_id: {$type: 'primary_key', $bind: 'id'},
            text: {$type: 'string', $bind: 'attr1'},
            variant: {$type: 'variant', $bind: 'variant'},
        },
        gloss: {
            $type: 'relation', $tag: 'gls',
            $style: {$shape: 'inlineListRelation',
                     $view: {order: 2, titleRole: 'gloss', label: 'inline'}},
            gloss_id: {$type: 'primary_key', $bind: 'id'},
            gloss: {$type: 'string', $bind: 'attr1'},
        },
        document_reference: {
            $type: 'relation', $tag: 'ref', $role: 'documentReference',
            $style: {$shape: 'containerRelation',
                     $view: {order: 3, label: 'heading', empty: 'elide'}},
            document_reference_id: {$type: 'primary_key', $bind: 'id'},
            bounding_group_id: {$type: 'integer', $bind: 'attr1',
                                $style: {$shape: 'boundingGroup'}},
            transcription: {
                $type: 'relation', $tag: 'rtr',
                $style: {$shape: 'compactInlineListRelation',
                         $view: {order: 1, label: 'inline', empty: 'elide'}},
                transcription_id: {$type: 'primary_key', $bind: 'id'},
                text: {$type: 'string', $bind: 'attr1', $style: {$width: 60, $height: 4}},
                confidence: {$type: 'integer', $bind: 'attr2', $optional: true},
            },
            expanded: {
                $type: 'relation', $tag: 'rex',
                $style: {$shape: 'compactInlineListRelation',
                         $view: {order: 2, label: 'inline', empty: 'elide'}},
                expanded_id: {$type: 'primary_key', $bind: 'id'},
                text: {$type: 'string', $bind: 'attr1', $style: {$width: 60, $height: 4}},
                confidence: {$type: 'integer', $bind: 'attr2', $optional: true},
            },
            transliteration: {
                $type: 'relation', $tag: 'rtl',
                $style: {$shape: 'compactInlineListRelation',
                         $view: {order: 3, label: 'inline', empty: 'elide'}},
                transliteration_id: {$type: 'primary_key', $bind: 'id'},
                text: {$type: 'string', $bind: 'attr1', $style: {$width: 60, $height: 4}},
                confidence: {$type: 'integer', $bind: 'attr2', $optional: true},
            },
            source_as_entry: {
                $type: 'relation', $tag: 'rse',
                $style: {$shape: 'compactInlineListRelation',
                         $view: {order: 4, label: 'inline', empty: 'elide'}},
                source_as_entry_id: {$type: 'primary_key', $bind: 'id'},
                text: {$type: 'string', $bind: 'attr1', $style: {$width: 60, $height: 4}},
                confidence: {$type: 'integer', $bind: 'attr2', $optional: true},
            },
            normalized: {
                $type: 'relation', $tag: 'rne',
                $style: {$shape: 'compactInlineListRelation',
                         $view: {order: 5, label: 'inline', empty: 'elide'}},
                normalized_id: {$type: 'primary_key', $bind: 'id'},
                text: {$type: 'string', $bind: 'attr1', $style: {$width: 60, $height: 4}},
                confidence: {$type: 'integer', $bind: 'attr2', $optional: true},
            },
        },
    },
};

// ---------------------------------------------------------------------------------
// --- Segmentation (production shape: grouping primary, starts fallback) -----------
// ---------------------------------------------------------------------------------

interface SegmentedEntry { runIds: number[]; }

async function segmentPage(cfg: ExtractConfig, pageNo: number):
        Promise<{runs: Run[], entries: SegmentedEntry[], fallback: boolean}> {
    const page = pdmPage(pageNo);
    const runs = clusterRuns(page.words, TUNED_CLUSTER);
    if(runs.length === 0) return {runs, entries: [], fallback: false};
    const annot = await annotatedPagePath(page.image_ref, runs);
    const input = {page: pageNo, runCount: runs.length};
    try {
        const out: any = await llmRetry(() =>
            extractStage(cfg, annot, 0, pdmSegmentStage(SEGMENT_MODEL), input));
        const entries = (out.entries ?? [])
            .filter((e: any) => e.kind !== 'furniture')
            .map((e: any) => ({runIds: (e.runs ?? []).map(Number)
                .filter((i: number) => runs[i] !== undefined)}))
            .filter((e: SegmentedEntry) => e.runIds.length > 0);
        return {runs, entries, fallback: false};
    } catch(e) {
        // Batch mode: an ENROLLED (not-ready) grouping is not malformed -
        // it must defer the page, never trigger the PAID starts-fallback.
        if(e instanceof DerivationNotAvailable) throw e;
        // Malformed grouping response after retries: the robust
        // starts+bands fallback (v3).
        const out: any = await llmRetry(() =>
            extractStage(cfg, annot, 0, pdmStartStage(SEGMENT_MODEL), input));
        const spans = spansFromStarts(runs,
            (out.starts ?? []).map((st: any) => Number(st.run)),
            (out.furniture ?? []).map(Number));
        return {runs,
                entries: spans.filter(s => s.kind !== 'furniture')
                    .map(s => ({runIds: s.runs})),
                fallback: true};
    }
}

// ---------------------------------------------------------------------------------
// --- Reading (the measured escalation policy) -------------------------------------
// ---------------------------------------------------------------------------------

export interface RungResult { text: string; confidence: number; }
export interface WordFact { source: string; normalized: string; gloss: string;
                            confidence: number; }
export interface EntryReading {
    rungs: Record<string, RungResult>;   // stage name -> result
    words: WordFact[];                   // the word-split layer (family members)
    escalated: boolean;
}

const OUT_FIELD: Record<string, string> = {
    transcribe: 'runs', expand: 'runs', transliterate: 'transliteration',
    'source-as-entry': 'source_as_entry', normalize: 'normalized_entry'};

function stageText(stage: string, out: any): string {
    if(OUT_FIELD[stage] === 'runs')
        return coerceRuns(out).map(r => r.text).join('');
    const v = out?.[OUT_FIELD[stage]];
    if(typeof v === 'string') return v;
    // Lenient fallback: any non-empty string property.
    const flat = Object.values(out ?? {}).find(x => typeof x === 'string' && x.trim() !== '');
    return flat ? String(flat) : '';
}

async function runChain(cfg: ExtractConfig, crop: string, recipe: ExtractStage[]):
        Promise<Record<string, {out: any, text: string, confidence: number}>> {
    const results: Record<string, {out: any, text: string, confidence: number}> = {};
    let input: unknown = null;
    for(const stage of recipe) {
        const out: any = await llmRetry(() => extractStage(cfg, crop, 0, stage, input));
        results[stage.name] = {out, text: stageText(stage.name, out),
                               confidence: coerceConfidence(out)};
        input = out;
    }
    return results;
}

function recipeWithModels(letter: string, structuring: string): ExtractStage[] {
    const recipe = pdmRecipe();
    for(const st of recipe)
        st.model = (st.name === 'source-as-entry' || st.name === 'normalize')
            ? structuring : letter;
    return recipe;
}

export async function readEntry(cfg: ExtractConfig, bounding_group_id: number):
        Promise<EntryReading> {
    return readEntryFromCrop(cfg, await groupCropPath(bounding_group_id));
}

/** The reading over a CROP PATH - the DUAL-MODE op (dz 2026-08-06): the
 *  bulk derive phase calls it with cfg.batch (misses enroll + defer) on
 *  crops computed straight from segmentation boxes; interactive
 *  re-derivation after a user edits a box calls it sync via readEntry.
 *  Identical closures either way (the crop path is content-addressed by
 *  geometry, groups copy geometry verbatim), so each mode serves the
 *  other's cache.  PURE up to its awaits - no side effects, so a batch
 *  unwind mid-chain is safe (§6). */
export async function readEntryFromCrop(cfg: ExtractConfig, crop: string):
        Promise<EntryReading> {
    let chain = await runChain(cfg, crop, recipeWithModels(LETTER_MODEL, STRONG_MODEL));
    let escalated = false;
    if((chain['transcribe']?.confidence ?? 0) < ESCALATE_BELOW) {
        chain = await runChain(cfg, crop, recipeWithModels(STRONG_MODEL, STRONG_MODEL));
        escalated = true;
    }
    const rungs: Record<string, RungResult> = {};
    for(const [name, r] of Object.entries(chain))
        rungs[name] = {text: r.text, confidence: r.confidence};
    // The WORD-SPLIT layer (decision (a)'s secondary tagging): family
    // members from the expanded transcription, strong model.
    let words: WordFact[] = [];
    try {
        const ws = wordSplitStage();
        ws.model = STRONG_MODEL;
        const out: any = await llmRetry(() =>
            extractStage(cfg, crop, 0, ws, chain['expand']?.out ?? chain['transcribe']?.out));
        words = (out?.words ?? [])
            .map((w: any) => ({source: String(w?.source ?? '').trim(),
                               normalized: String(w?.normalized ?? '').trim(),
                               gloss: String(w?.gloss ?? '').trim(),
                               confidence: coerceConfidence(w)}))
            .filter((w: WordFact) => w.source !== '' || w.normalized !== '');
    } catch(e) {
        // An ENROLLED word-split must defer the entry, not silently land
        // the single-entry fallback (which would then be wrong forever).
        if(e instanceof DerivationNotAvailable) throw e;
        /* otherwise fall back to the single-entry landing */
    }
    return {rungs, words, escalated};
}

// ---------------------------------------------------------------------------------
// --- The DERIVE phase (the batched import's pure pass) -----------------------------
// ---------------------------------------------------------------------------------

export interface PdmPageDerivation {
    pageNo: number;
    status: 'complete' | 'deferred' | 'failed';
    entries: number;                 // segmented visual entries
    read: number;                    // readings fully derived (incl. escalation + split)
    deferredReads: number;
    failedReads: number;
    error?: string;                  // page-level (segmentation) failure
}

/** PHASE A of the batched import: derive EVERYTHING (segmentation +
 *  readings) for the pages with ZERO db writes - the throw-tolerant pure
 *  pass of the batch design (per-page units, enroll on miss, defer on
 *  DerivationNotAvailable).  Crops are computed from the segmentation
 *  output's Text-layer boxes via boxesCropPath - the SAME keys importPdm
 *  later reaches through the copied groups (geometry copies verbatim;
 *  cropClosure is the one shared key computation), so once every page is
 *  'complete', importPdm lands the whole mirror as pure cache hits -
 *  commit-at-end for the entire import.  Runs sync too (no cfg.batch:
 *  each miss just computes now). */
export async function derivePdm(cfg: ExtractConfig, pages: number[],
                                log: (m: string) => void = m => console.info(m)):
        Promise<PdmPageDerivation[]> {
    const out: PdmPageDerivation[] = [];
    for(const pageNo of pages) {
        const r: PdmPageDerivation = {pageNo, status: 'complete', entries: 0,
                                      read: 0, deferredReads: 0, failedReads: 0};
        out.push(r);
        let seg;
        try {
            seg = await segmentPage(cfg, pageNo);
        } catch(e) {
            if(e instanceof DerivationNotAvailable) { r.status = 'deferred'; continue; }
            r.status = 'failed';
            r.error = e instanceof Error ? e.message.slice(0, 120) : String(e);
            continue;
        }
        r.entries = seg.entries.length;
        const page = pdmPage(pageNo);
        // Same box selection AND order as the landing loop's groups (the
        // rects array is part of the crop key, so order is identity).
        const entryBoxes = seg.entries
            .map(e => e.runIds.flatMap(ri => seg.runs[ri].words))
            .filter(boxes => boxes.length > 0);
        // The landing loop's 4-reader pool shape; every entry advances its
        // own frontier each cycle regardless of its siblings' state.
        let cursor = 0;
        await Promise.all(Array.from({length: 4}, async () => {
            for(;;) {
                const i = cursor++;
                if(i >= entryBoxes.length) break;
                try {
                    await readEntryFromCrop(cfg,
                        await boxesCropPath(page.page_id, entryBoxes[i]));
                    r.read++;
                } catch(e) {
                    if(e instanceof DerivationNotAvailable) r.deferredReads++;
                    else r.failedReads++;
                }
            }
        }));
        if(r.deferredReads > 0) r.status = 'deferred';
        log(`p${pageNo}: ${r.status} - ${r.read}/${r.entries} read` +
            (r.deferredReads ? `, ${r.deferredReads} deferred` : '') +
            (r.failedReads ? `, ${r.failedReads} read-failed` : '') +
            (r.error ? ` (${r.error})` : ''));
    }
    return out;
}

// ---------------------------------------------------------------------------------
// --- The import -------------------------------------------------------------------
// ---------------------------------------------------------------------------------

function foreignAssertionCount(table: string): number {
    try {
        return db().first<{n: number}>(
            `SELECT COUNT(*) AS n FROM ${table} WHERE (change_by_username IS NULL ` +
            `OR change_by_username <> :u) AND ty NOT IN ${WORKFLOW_TYS}`,
            {u: PDM_IMPORT_USERNAME})?.n ?? 0;
    } catch(_e) { return 0; }
}

/** "word, gloss" split of a rung line: the first comma outside
 *  parentheses divides headword from gloss. */
export function splitEntryLine(line: string): {word: string, gloss: string} {
    const m = line.match(/^([^,()]+),\s*(.*)$/s);
    if(!m) return {word: line.trim(), gloss: ''};
    return {word: m[1].trim(), gloss: m[2].trim()};
}

export interface PdmImportOpts {
    pages: number[];
    reportPath: string;
    log?: (m: string) => void;
}

export async function importPdm(opts: PdmImportOpts): Promise<void> {
    const log = opts.log ?? ((m: string) => console.info(m));
    const llm = loadLlm('wordwiki');
    if(!llm.available) throw new Error('LLM unavailable');
    const usage = new Map<string, LlmUsage & {calls: number}>();
    const cfg: ExtractConfig = {
        derivedDir: 'derived', image: groupCropImageSource, llm,
        onUsage: (stage, u) => {
            const t = usage.get(stage) ?? {inputTokens: 0, outputTokens: 0, calls: 0};
            t.inputTokens += u.inputTokens; t.outputTokens += u.outputTokens; t.calls++;
            usage.set(stage, t);
        },
    };

    // --- Dictionary pair: create or wipe (workflow rows preserved).
    const exists = db().first<{name: string}>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pdm'`, {}) !== undefined;
    if(exists) {
        const foreign = foreignAssertionCount('pdm');
        if(foreign > 0)
            throw new Error(`pdm has ${foreign} foreign assertion(s) - refusing`);
        db().execute(`DELETE FROM pdm WHERE ty NOT IN ${WORKFLOW_TYS}`, {});
        dictionaryConfig.writeConfigValue('pdm', 'schema',
            dictionaryConfig.canonicalSchemaJsonText('pdm', PDM_SCHEMA_JSON));
    } else {
        dictionaryConfig.createDictionary('pdm', PDM_SCHEMA_JSON, {slug: 'pdm'});
    }
    dictionaryConfig.writeConfigValue('pdm', 'import_mirror', 'true');
    dictionaryConfig.writeConfigValue('pdm', 'name', 'Pacifique (draft)');
    const generation =
        Number(dictionaryConfig.readConfigValue('pdm', 'import_generation') ?? '0') + 1;
    dictionaryConfig.writeConfigValue('pdm', 'import_generation', String(generation));
    dictionaryConfig.writeConfigValue('pdm', 'import_source',
        `PDM scans pages ${opts.pages[0]}-${opts.pages[opts.pages.length - 1]} (machine draft)`);
    dictionaryConfig.ensureWorkflowRelations('pdm');

    // --- Machine groups: OUR sheet, wiped per import; the hand Tagging
    //     layer is gold and untouched.
    const doc = selectScannedDocumentByFriendlyId().required({friendly_document_id: 'PDM'});
    const layerId = getOrCreateTaggingSheet(doc.document_id, 'pdm');
    db().execute(`DELETE FROM bounding_box WHERE layer_id = :l`, {l: layerId});
    db().execute(`DELETE FROM bounding_group WHERE layer_id = :l`, {l: layerId});

    const t = timestamp.nextTime(highestTimestamp('pdm'));
    const usedIds = new Set<number>();
    const claimId = (id: number): number => {
        while(usedIds.has(id)) id = contentKeyId(['bump', id]);
        usedIds.add(id);
        return id;
    };
    const rows: Assertion[] = [];
    let entries = 0, escalated = 0, fallbackPages = 0, readFailures = 0;

    for(const pageNo of opts.pages) {
        const seg = await segmentPage(cfg, pageNo);
        if(seg.fallback) fallbackPages++;
        log(`p${pageNo}: ${seg.entries.length} entries${seg.fallback ? ' (starts fallback)' : ''}`);
        // Groups first (cheap, sequential), then read entries in a small
        // parallel pool.
        // One group per WORD-ENTRY, not per block (the hand model: each
        // word draws its OWN group over the shared ink - overlapping
        // groups, strict 1-1 group<->ref; dz 2026-07-29).  The block's
        // group is made first (the reading needs a crop NOW); per-word
        // twins are copied at landing time below.
        const groups: {gid: number, boxIds: number[], e: SegmentedEntry}[] = [];
        for(const e of seg.entries) {
            const boxIds = e.runIds.flatMap(ri => seg.runs[ri].words.map(w => w.id));
            if(boxIds.length === 0) continue;
            const {bounding_group_id} = copyRefBoxToNewGroup(boxIds[0], layerId, 'blue');
            for(const b of boxIds.slice(1)) copyRefBoxToExistingGroup(bounding_group_id, b);
            groups.push({gid: bounding_group_id, boxIds, e});
        }
        const readings: (EntryReading|undefined)[] = new Array(groups.length);
        let cursor = 0;
        await Promise.all(Array.from({length: 4}, async () => {
            for(;;) {
                const i = cursor++;
                if(i >= groups.length) break;
                try { readings[i] = await readEntry(cfg, groups[i].gid); }
                catch(e) {
                    readFailures++;
                    log(`  read FAILED (p${pageNo} group ${groups[i].gid}): ` +
                        `${e instanceof Error ? e.message.slice(0, 90) : e}`);
                }
            }
        }));

        for(let i = 0; i < groups.length; i++) {
            const reading = readings[i];
            if(!reading) continue;
            const {gid} = groups[i];
            if(reading.escalated) escalated++;
            const rtr = reading.rungs['transcribe'], rex = reading.rungs['expand'],
                  rtl = reading.rungs['transliterate'],
                  rse = reading.rungs['source-as-entry'], rne = reading.rungs['normalize'];
            const norm = splitEntryLine(rne?.text ?? rse?.text ?? '');
            const pmWord = splitEntryLine(rtr?.text ?? '').word;
            // ONE ENTRY PER WORD (the secondary layer - dz's p250 case):
            // the word-split facts; single block entry as the fallback.
            const words: WordFact[] = reading.words.length > 0
                ? reading.words
                : (norm.word !== '' || pmWord !== '')
                    ? [{source: pmWord, normalized: norm.word, gloss: norm.gloss,
                        confidence: rne?.confidence ?? 0}]
                    : [];
            if(words.length === 0) continue;
            const canonical = `${pageNo}${rtr?.text ?? ''}`;
            const {boxIds} = groups[i];
            for(const [wi, word] of words.entries()) {
            entries++;
            // The first word keeps the block's group; each further word
            // gets its OWN overlapping twin (same boxes copied).
            let wordGid = gid;
            if(wi > 0 && boxIds.length > 0) {
                const g2 = copyRefBoxToNewGroup(boxIds[0], layerId, 'blue');
                for(const b of boxIds.slice(1)) copyRefBoxToExistingGroup(g2.bounding_group_id, b);
                wordGid = g2.bounding_group_id;
            }
            const entryId = claimId(contentKeyId(['pdm-ent', canonical, wi, word.source]));
            let ordinal = 0;
            const lastKey = new Map<string, string>();
            const keyFor = (tag: string): string => {
                const next = orderkey.between(lastKey.get(tag), undefined);
                lastKey.set(tag, next);
                return next;
            };
            const entryPath: [string, number][] = [['pdm', 0], ['ent', entryId]];
            rows.push({
                ...assertionPathToFields(entryPath),
                assertion_id: entryId, id: entryId, ty: 'ent',
                valid_from: t, valid_to: timestamp.END_OF_TIME,
                order_key: orderkey.new_range_start_string,
                change_by_username: PDM_IMPORT_USERNAME,
            } as Assertion);
            const emitAt = (parentPath: [string, number][], tag: string,
                            attrs: Record<string, unknown>): number => {
                const id = claimId(contentKeyId(['pdm-fld', entryId, ordinal++]));
                rows.push({
                    ...assertionPathToFields([...parentPath, [tag, id]]),
                    assertion_id: id, id, ty: tag,
                    valid_from: t, valid_to: timestamp.END_OF_TIME,
                    order_key: keyFor(tag),
                    change_by_username: PDM_IMPORT_USERNAME,
                    ...attrs,
                } as Assertion);
                return id;
            };
            if(word.normalized !== '')
                emitAt(entryPath, 'spl', {attr1: word.normalized, variant: 'mm-li'});
            if(word.source !== '' && word.source !== word.normalized)
                emitAt(entryPath, 'spl', {attr1: word.source, variant: 'mm-pm'});
            if(word.gloss !== '')
                emitAt(entryPath, 'gls', {attr1: word.gloss});
            const refId = emitAt(entryPath, 'ref', {attr1: wordGid});
            const refPath: [string, number][] = [...entryPath, ['ref', refId]];
            const rung = (tag: string, r: RungResult|undefined) => {
                if(r && r.text.trim() !== '')
                    emitAt(refPath, tag, {attr1: r.text, attr2: r.confidence});
            };
            rung('rtr', rtr); rung('rex', rex); rung('rtl', rtl);
            rung('rse', rse); rung('rne', rne);
            }
        }
    }

    db().transaction(() => {
        for(const row of rows) db().insert('pdm', row as any, 'assertion_id');
    });
    log(`pdm: ${entries} entries, ${rows.length} assertions (generation ${generation})`);

    const lines = [
        `# PDM import (generation ${generation})`,
        '',
        `Pages ${opts.pages.join(', ')}; segment ${SEGMENT_MODEL}; letters ${LETTER_MODEL} ` +
        `with whole-ref escalation to ${STRONG_MODEL} below c${ESCALATE_BELOW}; ` +
        `structuring ${STRONG_MODEL}.`,
        '',
        `- entries: ${entries} (${rows.length} assertions)`,
        `- escalated readings: ${escalated} (${(100 * escalated / Math.max(1, entries)).toFixed(0)}%)`,
        `- segmentation fallback pages: ${fallbackPages}; read failures: ${readFailures}`,
        '',
        '## Usage (actual API spend this run; cache hits free)',
        '',
        ...[...usage].map(([stage, u]) =>
            `- ${stage}: ${u.calls} calls, ${u.inputTokens} in / ${u.outputTokens} out`),
    ];
    await Deno.mkdir(posix.dirname(opts.reportPath), {recursive: true});
    await Deno.writeTextFile(opts.reportPath, lines.join('\n') + '\n');
    log(`import report written to ${opts.reportPath}`);
}
