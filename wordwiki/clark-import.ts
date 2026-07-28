// deno-lint-ignore-file no-explicit-any
/**
 * CLARK IMPORT (clark-import-design.md stage C): land the assembled +
 * interpreted Clark entries as a reference dictionary table, RE-BUILDABLE
 * FROM CACHE - the dual-model layer-1 transcriptions and the layer-2
 * interpretations are all memoized on the extract substrate, so a re-run
 * costs nothing until a prompt version bumps, and the table is an import
 * mirror in the sfm-import sense: wiped and rebuilt each run, refusing if
 * anything else has written to it (edits belong downstream - the whole
 * POINT of this dictionary is joining, not editing).
 *
 * Landing shape per entry: spelling(s) in the 'clark' lane + glosses +
 * derivatives + unresolved cross-refs + notes + the VERBATIM layer-1
 * transcription (first-class, archival) + a documentReference whose
 * bounding group carries the entry's own textract line boxes (we started
 * FROM the images, so refs come with the import - no binder run).
 *
 * Ids are CONTENT-KEYED (sfm-import's contentKeyId): an unchanged entry
 * keeps its id across re-imports, so downstream joins survive iteration.
 */
import * as timestamp from '../liminal/timestamp.ts';
import * as orderkey from '../liminal/orderkey.ts';
import * as posix from "https://deno.land/std@0.195.0/path/posix.ts";
import { db } from "../liminal/db.ts";
import { loadLlm, LlmUsage } from "../liminal/llm.ts";
import { extractTextStage, ExtractConfig } from "../liminal/extract.ts";
import { highestTimestamp, type Assertion, assertionPathToFields } from './assertion.ts';
import * as dictionaryConfig from './dictionary-config.ts';
import { contentKeyId } from './sfm-import.ts';
import { selectScannedDocumentByFriendlyId, getOrCreateTaggingSheet } from './scanned-document.ts';
import { copyRefBoxToNewGroup, copyRefBoxToExistingGroup } from './render-page-editor.ts';
import { bandTranscribeStage, entryInterpretStage, bandCropImageSource, headwordOf,
         assembleBook, llmRetry, TRANSCRIBE_MODEL } from './page-transcribe.ts';

export const CLARK_IMPORT_USERNAME = '~clark-import';
export const CLARK_LANE = 'clark';
// Stage-B verdict (clark/diacritic-eval.md): Sonnet is the better AND
// cheaper transcriber on this print, so its text is PRIMARY; Opus is the
// second opinion in the dual-model gate (divergent lines flagged).
const PRIMARY_MODEL = 'claude-sonnet-5';
const GATE_MODEL = TRANSCRIBE_MODEL;

/** The Clark soft schema (multi-dictionary model: schema is DATA, grown
 *  from what the content contains - see the design doc's layer-2
 *  section).  Verbatim source text is first-class; cross-refs land
 *  unresolved. */
export const CLARK_SCHEMA_JSON: any = {
    $type: 'schema', $name: 'clark', $tag: 'clk',
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
        derivative: {
            $type: 'relation', $tag: 'drv', $prompt: 'Derivative',
            $style: {$shape: 'inlineListRelation',
                     $view: {order: 3, label: 'inline', empty: 'elide'}},
            derivative_id: {$type: 'primary_key', $bind: 'id'},
            form: {$type: 'string', $bind: 'attr1'},
            gloss: {$type: 'string', $bind: 'attr2', $optional: true},
        },
        cross_reference: {
            $type: 'relation', $tag: 'xrf', $prompt: 'Cross reference',
            $style: {$shape: 'inlineListRelation',
                     $view: {order: 4, label: 'inline', empty: 'elide'}},
            cross_reference_id: {$type: 'primary_key', $bind: 'id'},
            text: {$type: 'string', $bind: 'attr1'},
        },
        note: {
            $type: 'relation', $tag: 'nte',
            $style: {$shape: 'compactInlineListRelation',
                     $view: {order: 5, label: 'inline', empty: 'elide'}},
            note_id: {$type: 'primary_key', $bind: 'id'},
            note: {$type: 'string', $bind: 'attr1'},
        },
        source_text: {
            $type: 'relation', $tag: 'stx', $prompt: 'Source text',
            $style: {$shape: 'compactInlineListRelation',
                     $view: {order: 6, label: 'inline', audience: 'internal'}},
            source_text_id: {$type: 'primary_key', $bind: 'id'},
            text: {$type: 'string', $bind: 'attr1', $style: {$width: 60, $height: 5}},
            printed_page: {$type: 'integer', $bind: 'attr2', $optional: true},
        },
        document_reference: {
            $type: 'relation', $tag: 'ref', $role: 'documentReference',
            $style: {$shape: 'containerRelation',
                     $view: {order: 7, label: 'heading', empty: 'elide'}},
            document_reference_id: {$type: 'primary_key', $bind: 'id'},
            bounding_group_id: {$type: 'integer', $bind: 'attr1',
                                $style: {$shape: 'boundingGroup'}},
        },
    },
};

/** The 'clark' orthography row (lane slug for spellings + the skeleton
 *  normalizer registered in mikmaq/language.ts). */
function ensureClarkOrthography(): void {
    const have = db().first<{orthography_id: number}>(
        `SELECT orthography_id FROM orthography WHERE slug = :slug`, {slug: CLARK_LANE});
    if(have) return;
    db().insert('orthography', {
        slug: CLARK_LANE, name: 'Clark (1902)', abbreviation: 'Ck',
        edition: 'preview', publishable: 0, retired: 0, order_key: '0.895',
    }, 'orthography_id');
}

function foreignAssertionCount(table: string): number {
    try {
        return db().first<{n: number}>(
            `SELECT COUNT(*) AS n FROM ${table} WHERE change_by_username IS NULL ` +
            `OR change_by_username <> :u`, {u: CLARK_IMPORT_USERNAME})?.n ?? 0;
    } catch(_e) { return 0; }
}

export interface ClarkImportOpts {
    pages: number[];
    reportPath: string;
    interpretPerEntryModel?: string;   // default sonnet (stage-B validated)
    log?: (m: string) => void;
}

export interface ClarkImportResult {
    pages: number; entries: number; assertions: number;
    glosses: number; derivatives: number; crossRefs: number; notes: number;
    headersSkipped: number; columnJoins: number;
    divergentLines: number; droppedPrimary: number;
    interpretFailures: number; idCollisions: number;
    lowConfidence: number;             // interpretation confidence < 70
}

export async function importClark(opts: ClarkImportOpts): Promise<ClarkImportResult> {
    const log = opts.log ?? ((m: string) => console.info(m));
    const llm = loadLlm('wordwiki');
    if(!llm.available)
        throw new Error('wordwiki-anthropic-credential.json missing/invalid - LLM unavailable');
    const usage = new Map<string, LlmUsage & {calls: number}>();
    const cfg: ExtractConfig = {
        derivedDir: 'derived', image: bandCropImageSource, llm,
        onUsage: (stage, u) => {
            const t = usage.get(stage) ?? {inputTokens: 0, outputTokens: 0, calls: 0};
            t.inputTokens += u.inputTokens; t.outputTokens += u.outputTokens; t.calls++;
            usage.set(stage, t);
        },
    };

    // --- Layer 1 + assembly (all cached after the first run).
    const assembled = await assembleBook(cfg, 'Clark', opts.pages,
                                         bandTranscribeStage(PRIMARY_MODEL),
                                         bandTranscribeStage(GATE_MODEL), log);
    log(`assembled ${assembled.entries.length} entries ` +
        `(${assembled.headersSkipped} headers skipped, ${assembled.columnJoins} column joins, ` +
        `${assembled.divergentLines} divergent lines)`);

    // --- Layer 2 per entry (text-only, cached; small worker pool).
    const iStage = entryInterpretStage(opts.interpretPerEntryModel ?? PRIMARY_MODEL);
    const interps: (any|undefined)[] = new Array(assembled.entries.length);
    let interpretFailures = 0, interpreted = 0, cursor = 0;
    await Promise.all(Array.from({length: 6}, async () => {
        for(;;) {
            const i = cursor++;
            if(i >= assembled.entries.length) break;
            const e = assembled.entries[i];
            try {
                interps[i] = await llmRetry(() => extractTextStage(cfg, iStage, {entryText: e.text}));
            } catch(err) {
                interpretFailures++;
                log(`  interpret FAILED for entry ${i} (p${e.printed} ` +
                    `'${e.text.slice(0, 40)}...'): ${err instanceof Error ? err.message : err}`);
            }
            if(++interpreted % 100 === 0)
                log(`  interpreted ${interpreted}/${assembled.entries.length}`);
        }
    }));

    // --- The dictionary pair: create fresh, or WIPE an unedited mirror.
    ensureClarkOrthography();
    const schemaJson = CLARK_SCHEMA_JSON;
    const exists = db().first<{name: string}>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'clark'`, {}) !== undefined;
    if(exists) {
        const foreign = foreignAssertionCount('clark');
        if(foreign > 0)
            throw new Error(`clark has ${foreign} foreign assertion(s) - re-import would ` +
                            `destroy them; refusing`);
        db().execute(`DELETE FROM clark`, {});
        dictionaryConfig.writeConfigValue('clark', 'schema',
            dictionaryConfig.canonicalSchemaJsonText('clark', schemaJson));
    } else {
        dictionaryConfig.createDictionary('clark', schemaJson, {slug: 'clark'});
    }
    dictionaryConfig.writeConfigValue('clark', 'import_mirror', 'true');
    const generation =
        Number(dictionaryConfig.readConfigValue('clark', 'import_generation') ?? '0') + 1;
    dictionaryConfig.writeConfigValue('clark', 'import_generation', String(generation));
    dictionaryConfig.writeConfigValue('clark', 'import_source',
        `Clark scans, printed pages ${opts.pages[0]}-${opts.pages[opts.pages.length - 1]}`);

    // --- The reference layer: wipe OUR groups, keep everyone else's.
    const doc = selectScannedDocumentByFriendlyId().required({friendly_document_id: 'Clark'});
    const layerId = getOrCreateTaggingSheet(doc.document_id, 'clark');
    db().execute(`DELETE FROM bounding_box WHERE layer_id = :l`, {l: layerId});
    db().execute(`DELETE FROM bounding_group WHERE layer_id = :l`, {l: layerId});

    // --- Rows.  Content-keyed entry ids; child ids by ordinal.
    const t = timestamp.nextTime(highestTimestamp('clark'));
    const usedIds = new Set<number>();
    let idCollisions = 0;
    const claimId = (id: number): number => {
        while(usedIds.has(id)) { idCollisions++; id = contentKeyId(['bump', id]); }
        usedIds.add(id);
        return id;
    };
    const occOf = new Map<string, number>();
    const rows: Assertion[] = [];
    const r: ClarkImportResult = {
        pages: opts.pages.length, entries: assembled.entries.length, assertions: 0,
        glosses: 0, derivatives: 0, crossRefs: 0, notes: 0,
        headersSkipped: assembled.headersSkipped, columnJoins: assembled.columnJoins,
        divergentLines: assembled.divergentLines, droppedPrimary: assembled.droppedPrimary,
        interpretFailures, idCollisions: 0, lowConfidence: 0,
    };

    const strip = (s: string) => s.replace(/\[([^|\]]*)\|[^\]]*\]/g, '$1')
        .replace(/[*⁇]/g, '').trim();

    for(const [idx, e] of assembled.entries.entries()) {
        const interp = interps[idx];
        const occ = occOf.get(e.text) ?? 0;
        occOf.set(e.text, occ + 1);
        const entryId = claimId(contentKeyId(['clark-ent', e.text, occ]));
        let ordinal = 0;
        const lastKey = new Map<string, string>();
        const keyFor = (tag: string): string => {
            const next = orderkey.between(lastKey.get(tag), undefined);
            lastKey.set(tag, next);
            return next;
        };
        const entryPath: [string, number][] = [['clk', 0], ['ent', entryId]];
        rows.push({
            ...assertionPathToFields(entryPath),
            assertion_id: entryId, id: entryId, ty: 'ent',
            valid_from: t, valid_to: timestamp.END_OF_TIME,
            order_key: orderkey.new_range_start_string,
            change_by_username: CLARK_IMPORT_USERNAME,
        } as Assertion);
        const emit = (tag: string, attrs: Record<string, unknown>): void => {
            const id = claimId(contentKeyId(['clark-fld', entryId, ordinal++]));
            rows.push({
                ...assertionPathToFields([...entryPath, [tag, id]]),
                assertion_id: id, id, ty: tag,
                valid_from: t, valid_to: timestamp.END_OF_TIME,
                order_key: keyFor(tag),
                change_by_username: CLARK_IMPORT_USERNAME,
                ...attrs,
            } as Assertion);
        };

        // Headword + alternates in the clark lane (mechanical fallback
        // when interpretation failed - the entry must still browse).
        const headword = strip(interp?.headword ?? headwordOf(e.lines[0]?.text ?? ''));
        if(headword !== '')
            emit('spl', {attr1: headword, variant: CLARK_LANE});
        for(const alt of interp?.alt_spellings ?? [])
            if(strip(alt) !== '' && strip(alt) !== headword)
                emit('spl', {attr1: strip(alt), variant: CLARK_LANE});
        for(const g of interp?.glosses ?? [])
            if(String(g).trim() !== '') { emit('gls', {attr1: String(g).trim()}); r.glosses++; }
        for(const d of interp?.derivatives ?? [])
            if(strip(d?.form ?? '') !== '') {
                emit('drv', {attr1: strip(d.form), attr2: d.gloss ?? null});
                r.derivatives++;
            }
        for(const x of interp?.cross_refs ?? [])
            if(String(x).trim() !== '') { emit('xrf', {attr1: String(x).trim()}); r.crossRefs++; }
        for(const n of interp?.notes ?? [])
            if(String(n).trim() !== '') { emit('nte', {attr1: String(n).trim()}); r.notes++; }
        if(interp !== undefined && Number(interp.confidence ?? 100) < 70) r.lowConfidence++;
        emit('stx', {attr1: e.text, attr2: e.printed});

        // The documentReference: a bounding group of the entry's own
        // textract line boxes, on OUR tagging sheet.
        const boxes = e.lines.map(l => l.box_id);
        if(boxes.length > 0) {
            const {bounding_group_id} = copyRefBoxToNewGroup(boxes[0], layerId, 'green');
            for(const b of boxes.slice(1))
                copyRefBoxToExistingGroup(bounding_group_id, b);
            emit('ref', {attr1: bounding_group_id});
        }
    }
    r.idCollisions = idCollisions;
    r.assertions = rows.length;

    db().transaction(() => {
        for(const row of rows) db().insert('clark', row as any, 'assertion_id');
    });
    log(`clark: ${r.entries} entries, ${r.assertions} assertions (generation ${generation})`);

    // --- Report + spend.
    const lines = [
        `# Clark import (stage C dev band, generation ${generation})`,
        ``,
        `Pages ${opts.pages[0]}-${opts.pages[opts.pages.length - 1]}; primary ${PRIMARY_MODEL}, ` +
        `gate ${GATE_MODEL}, interpret ${iStage.model}.`,
        ``,
        `- entries: ${r.entries} (${r.assertions} assertions)`,
        `- glosses ${r.glosses}, derivatives ${r.derivatives}, cross-refs ${r.crossRefs}, ` +
        `notes ${r.notes}`,
        `- headers skipped: ${r.headersSkipped}; column/page joins: ${r.columnJoins}`,
        `- dual-model divergent lines: ${r.divergentLines} (flagged in-band on their entries); ` +
        `primary dropped ${r.droppedPrimary} (textract fallback)`,
        `- interpret failures: ${r.interpretFailures}; low-confidence (<70): ${r.lowConfidence}`,
        `- id collisions (re-salted): ${r.idCollisions}`,
        ``,
        `## Usage (actual API spend this run; cache hits free)`,
        ``,
        ...[...usage].map(([stage, u]) =>
            `- ${stage}: ${u.calls} calls, ${u.inputTokens} in / ${u.outputTokens} out`),
    ];
    await Deno.mkdir(posix.dirname(opts.reportPath), {recursive: true});
    await Deno.writeTextFile(opts.reportPath, lines.join('\n') + '\n');
    log(`import report written to ${opts.reportPath}`);
    return r;
}
