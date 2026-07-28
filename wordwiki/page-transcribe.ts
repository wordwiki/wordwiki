// deno-lint-ignore-file no-explicit-any
/**
 * Layer-1 PHYSICAL transcription of printed dictionary pages from their
 * scans (clark-import-design.md; Clark is the first user, the machinery is
 * book-generic).  Built on the same scan->extract substrate as the PDM
 * transcription eval (liminal/extract.ts) - every band is memoised in the
 * derived store, so re-running a survey is free until a prompt version
 * bumps.
 *
 * THE SHAPE: textract line GEOMETRY (already loaded as 'Text'-layer
 * bounding boxes) drives everything mechanical - column split, banding,
 * crop rects, entry-start detection - and its accent-stripped TEXT serves
 * only as a per-line fold-comparison check on the LLM output.  The vision
 * model transcribes full-resolution BAND crops (~16 lines; a whole column
 * would be downscaled below diacritic legibility) and is never asked for
 * coordinates and never shown expected spellings (a primed transcriber
 * copies the prior over the ink - the design doc's checker-not-primer
 * rule).
 */
import * as posix from "https://deno.land/std@0.195.0/path/posix.ts";
import { db } from "../liminal/db.ts";
import { block } from "../liminal/strings.ts";
import * as content from "../liminal/content-store.ts";
import * as utils_config from "../liminal/utils-config.ts";
import { loadLlm, LlmUsage } from "../liminal/llm.ts";
import { extractStage, extractTextStage, ExtractConfig, ExtractStage } from "../liminal/extract.ts";
import { levenshteinDistance } from "../liminal/levenshtein-distance.ts";
import { containedImageSource } from './transcribe.ts';

const EOT = 9007199254740991;

// Bump to re-transcribe / re-interpret on the next run - the only cost of
// a prompt iteration (stale extractions are unreachable, not deleted).
export const PROMPT_VERSION_BAND_TRANSCRIBE = 1;
export const PROMPT_VERSION_ENTRY_INTERPRET = 1;
export const TRANSCRIBE_MODEL = 'claude-opus-4-8';

// List prices, for the survey's printed cost line only.
function usdPerMtok(model: string): {inTok: number, outTok: number} {
    return model.includes('sonnet') ? {inTok: 3, outTok: 15}
         : model.includes('haiku')  ? {inTok: 1, outTok: 5}
         :                            {inTok: 15, outTok: 75};   // opus
}

// ---------------------------------------------------------------------------------
// --- Page geometry (textract lines already in the db) -----------------------------
// ---------------------------------------------------------------------------------

export interface PageLine { x: number; y: number; w: number; h: number; text: string; }
export interface PageGeom {
    page_id: number; printed: number; image_ref: string;
    width: number; height: number; lines: PageLine[];
}

/** The page image + its textract LINE boxes ('Text' layer), y-ordered. */
export function pageGeometry(book: string, printed: number): PageGeom {
    const page = db().first<{page_id: number, image_ref: string, width: number, height: number}>(block`
/**/    SELECT p.page_id, p.image_ref, p.width, p.height
/**/       FROM scanned_page p
/**/       JOIN scanned_document d ON d.document_id = p.document_id
/**/       WHERE d.friendly_document_id = :book AND p.printed_page_number = :printed`,
        {book, printed});
    if(!page) throw new Error(`no ${book} page with printed page number ${printed}`);
    const lines = db().all<PageLine, {page_id: number}>(block`
/**/    SELECT b.x, b.y, b.w, b.h, b.text
/**/       FROM bounding_box b
/**/       JOIN layer l ON l.layer_id = b.layer_id
/**/       WHERE b.page_id = :page_id AND l.layer_name = 'Text' AND b.text IS NOT NULL
/**/       ORDER BY b.y`, {page_id: page.page_id});
    if(lines.length === 0) throw new Error(`${book} printed ${printed}: no textract lines loaded`);
    return {...page, printed, lines};
}

// ---------------------------------------------------------------------------------
// --- Mechanical segmentation: columns, bands, entry starts ------------------------
// ---------------------------------------------------------------------------------

/** Two-column split by line center (headers land wherever their center
 *  falls - they are visible as such in the report, not special-cased). */
export function splitColumns(lines: PageLine[], pageWidth: number):
        {left: PageLine[], right: PageLine[]} {
    const left = lines.filter(l => l.x + l.w / 2 < pageWidth / 2);
    const right = lines.filter(l => l.x + l.w / 2 >= pageWidth / 2);
    return {left, right};
}

export interface Band { lines: PageLine[]; x: number; y: number; w: number; h: number; }

const BAND_MARGIN = 18;

function pctl(sorted: number[], p: number): number {
    return sorted[Math.floor(p * (sorted.length - 1))];
}

/** Textract sometimes emits a box that CROSSES the gutter (a left-column
 *  line tail merged with a right-column line): its x sits deep inside the
 *  neighbouring column and would drag crops and the left-edge estimate
 *  across the page.  Column-shape statistics use only the non-stray
 *  lines; strays stay in the line list itself (they are real ink and
 *  still count for alignment). */
export function nonStray(lines: PageLine[], pageWidth: number): PageLine[] {
    if(lines.length === 0) return [];
    const xs = lines.map(l => l.x).toSorted((a, b) => a - b);
    const xL = pctl(xs, 0.25);
    return lines.filter(l => l.x >= xL - pageWidth * 0.04);
}

/** Chunk one column's lines (y-ordered) into bands of <= maxLines; the
 *  crop x-range is the COLUMN's (stray-filtered) x-range, the y-range the
 *  band's, + margin, clamped to the page.  ~16 lines at Clark's print
 *  size is ~1200px - under the vision API's 1568 downscale threshold, so
 *  diacritics reach the model full-res. */
export function bandColumn(lines: PageLine[], pageWidth: number, pageHeight: number,
                           maxLines = 16): Band[] {
    if(lines.length === 0) return [];
    const shape = nonStray(lines, pageWidth);
    const x = Math.max(0, Math.min(...shape.map(l => l.x)) - BAND_MARGIN);
    const right = Math.min(pageWidth, Math.max(...shape.map(l => l.x + l.w)) + BAND_MARGIN);
    const bands: Band[] = [];
    for(let i = 0; i < lines.length; i += maxLines) {
        const chunk = lines.slice(i, i + maxLines);
        const y = Math.max(0, Math.min(...chunk.map(l => l.y)) - BAND_MARGIN);
        const bottom = Math.min(pageHeight, Math.max(...chunk.map(l => l.y + l.h)) + BAND_MARGIN);
        bands.push({lines: chunk, x: Math.round(x), y: Math.round(y),
                    w: Math.max(1, Math.round(right - x)), h: Math.max(1, Math.round(bottom - y))});
    }
    return bands;
}

/** Entry starts by HANGING INDENT: a line is a start if it sits at the
 *  column's left edge (10th-percentile x over the stray-filtered lines)
 *  within a tolerance scaled to the page.  Headers pass too - they fail
 *  the later rand-window check instead of being special-cased here. */
export function entryStarts(lines: PageLine[], pageWidth: number): boolean[] {
    if(lines.length === 0) return [];
    const xs = nonStray(lines, pageWidth).map(l => l.x).toSorted((a, b) => a - b);
    const leftEdge = xs[Math.floor(xs.length / 10)];
    const tolerance = pageWidth * 0.015;
    return lines.map(l => l.x < leftEdge + tolerance);
}

/** Sequence-align a band's textract lines with the model's returned lines
 *  (both folded).  The model legitimately returns a different COUNT - it
 *  drops running heads and page numbers, or splits a gutter-crossing
 *  textract box - and naive index pairing then mis-scores every line
 *  downstream (the first survey's main artifact).  Classic edit-distance
 *  alignment: substitution costs normalized fold distance, a gap costs
 *  GAP.  Returns pairs of indices; t-only = the model dropped a line,
 *  l-only = the model produced an extra line. */
export interface AlignedPair { t?: number; l?: number; }
const GAP = 0.6;

export function alignFolded(tf: string[], lf: string[]): AlignedPair[] {
    const n = tf.length, m = lf.length;
    const sub = (a: string, b: string) =>
        a === b ? 0 : levenshteinDistance(a, b) / Math.max(1, a.length, b.length);
    const cost: number[][] = Array.from({length: n + 1}, () => new Array(m + 1).fill(0));
    for(let i = 1; i <= n; i++) cost[i][0] = i * GAP;
    for(let j = 1; j <= m; j++) cost[0][j] = j * GAP;
    for(let i = 1; i <= n; i++)
        for(let j = 1; j <= m; j++)
            cost[i][j] = Math.min(cost[i-1][j-1] + sub(tf[i-1], lf[j-1]),
                                  cost[i-1][j] + GAP,
                                  cost[i][j-1] + GAP);
    const pairs: AlignedPair[] = [];
    let i = n, j = m;
    while(i > 0 || j > 0) {
        if(i > 0 && j > 0 && cost[i][j] === cost[i-1][j-1] + sub(tf[i-1], lf[j-1]))
            pairs.push({t: --i, l: --j});
        else if(i > 0 && cost[i][j] === cost[i-1][j] + GAP)
            pairs.push({t: --i});
        else
            pairs.push({l: --j});
    }
    return pairs.reverse();
}

/** The candidate headword of an entry-start line: the italic span up to
 *  the first comma, markup and ambiguity brackets removed (first
 *  alternative kept - fold() makes the same choice). */
export function headwordOf(lineText: string): string {
    return lineText.split(',')[0]
        .replace(/\[([^|\]]*)\|[^\]]*\]/g, '$1')
        .replace(/[*⁇]/g, '')
        .trim();
}

/** Diacritic/markup/case fold for textract-vs-LLM comparison and rand
 *  window lookup: markup stripped, [a|b] resolved to a, combining marks
 *  dropped, non-alphanumerics dropped. */
export function fold(s: string): string {
    return s.replace(/\[([^|\]]*)\|[^\]]*\]/g, '$1')
        .replace(/[*⁇]/g, '')
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]/g, '');
}

// ---------------------------------------------------------------------------------
// --- Band crop (derived, content-addressed like the PDM group crops) --------------
// ---------------------------------------------------------------------------------

/** MASKED band crop (the PDM group-crop lesson, re-learned here on survey
 *  run 2: a plain rect crop catches the neighbouring column's protruding
 *  hyphen tails, which the model dutifully transcribes as line-prefix
 *  junk).  White canvas of the band rect, each LINE box pasted at its
 *  position with a small keep-margin - the model sees exactly the band's
 *  ink.  Content-addressed by [page image, rect, line boxes]. */
const LINE_BOX_MARGIN = 12;

export async function bandCropPath(image_ref: string, band: Band): Promise<string> {
    const rects = band.lines.map(l => ({
        x1: Math.max(0, Math.round(l.x - band.x - LINE_BOX_MARGIN)),
        y1: Math.max(0, Math.round(l.y - band.y - LINE_BOX_MARGIN)),
        x2: Math.min(band.w, Math.round(l.x - band.x + l.w + LINE_BOX_MARGIN)),
        y2: Math.min(band.h, Math.round(l.y - band.y + l.h + LINE_BOX_MARGIN)),
    }));
    return 'derived/' + await content.getDerived(
        'derived/band-crops', {bandCropCmd},
        ['bandCropCmd', image_ref, band.x, band.y, band.w, band.h, rects], 'jpg');
}

async function bandCropCmd(targetResultPath: string, sourceImagePath: string,
                           x: number, y: number, w: number, h: number,
                           rects: Array<{x1: number, y1: number, x2: number, y2: number}>) {
    const pastes = rects.flatMap(r => [
        '(', sourceImagePath,
        '-crop', `${r.x2 - r.x1}x${r.y2 - r.y1}+${x + r.x1}+${y + r.y1}`, '+repage', ')',
        '-geometry', `+${r.x1}+${r.y1}`, '-composite',
    ]);
    const { code, stderr } = await new Deno.Command(
        utils_config.imageMagickPath, {
            args: ['-size', `${w}x${h}`, 'xc:white', ...pastes,
                   '-quality', '90', `jpg:${targetResultPath}`],
        }).output();
    if(code !== 0)
        throw new Error(`failed to mask-crop ${sourceImagePath}: ${new TextDecoder().decode(stderr)}`);
}

const bandCropImageSource = containedImageSource('derived/band-crops-contained');

// ---------------------------------------------------------------------------------
// --- The stages -------------------------------------------------------------------
// ---------------------------------------------------------------------------------

// Physical facts only: glyphs, diacritics, style.  Language tagging,
// entry boundaries and meaning are layer 2 - and the model never sees
// expected spellings (checker, not primer).  The per-band facts
// (expected line count, position context) travel in `input` so they are
// part of the cache key.
export interface BandInput { book: string; printed: number; column: string;
                             expectedLines: number; }

const AMBIGUITY_RULES = block`
/**/If you are genuinely unsure between readings, DO NOT silently pick one:
/**/write the alternatives in square brackets separated by | (e.g. "wen[j|y]awe"
/**/means the letter could be j or y).  Use ⁇ for a truly illegible character.
/**/Use these sparingly - only where you are actually unsure.`;

const CONFIDENCE_RULES = block`
/**/Also return "confidence": an integer 0-100, your overall confidence that
/**/your transcription is correct (100 = certain).  Be honest - this number
/**/is used to decide which results need human review.`;

export function bandTranscribeStage(model = TRANSCRIBE_MODEL): ExtractStage {
    return {
        name: 'band-transcribe',
        model,
        promptVersion: PROMPT_VERSION_BAND_TRANSCRIBE,
        imageBox: 1600,
        schema: {
            type: 'object',
            properties: {
                lines: {type: 'array', items: {type: 'string'},
                        description: 'one string per printed line, in order'},
                confidence: {type: 'integer', description: 'overall confidence 0-100'},
            },
            required: ['lines', 'confidence'],
        },
        prompt: (input: unknown) => {
            const b = input as BandInput;
            return block`
/**/You are transcribing a band of consecutive lines from one column of a
/**/printed 1902 Mi'kmaq dictionary page (${b.book}, printed page ${b.printed},
/**/${b.column} column).  The orthography is Rand-style, using diacritics such
/**/as ā ē ī ō ū â ĕ ŏ ŭ and apostrophes.  The image shows ${b.expectedLines}
/**/printed lines.
/**/
/**/Transcribe EXACTLY what is printed, letter for letter:
/**/- return exactly one output line per printed line, in order
/**/  (${b.expectedLines} lines);
/**/- preserve every diacritic exactly as printed; do not normalize,
/**/  modernize or correct spellings;
/**/- wrap italic text in *...* (in this book headwords and Mi'kmaq words
/**/  are typically italic, English roman - but record what the TYPE shows,
/**/  not what you expect);
/**/- keep punctuation, capitalization, parentheses and end-of-line
/**/  hyphenation exactly as printed; never join or re-wrap lines;
/**/- transcribe the physical text only: do not interpret, translate,
/**/  complete or expand anything.
/**/${AMBIGUITY_RULES}
/**/${CONFIDENCE_RULES}`;
        },
    };
}

// Layer-2 TASTE stage for the survey: read one assembled entry as the
// intelligent reader and pull out the structure the soft schema will
// need.  Text-only (extractTextStage) - iterating this is nearly free.
export function entryInterpretStage(model = TRANSCRIBE_MODEL): ExtractStage {
    return {
        name: 'clark-entry-interpret',
        model,
        promptVersion: PROMPT_VERSION_ENTRY_INTERPRET,
        imageBox: 0,
        schema: {
            type: 'object',
            properties: {
                headword: {type: 'string', description: 'the entry headword, markup removed'},
                alt_spellings: {type: 'array', items: {type: 'string'},
                                description: 'alternate spellings given for the headword, e.g. parenthesized variants'},
                glosses: {type: 'array', items: {type: 'string'},
                          description: 'English senses of the headword itself'},
                derivatives: {type: 'array', items: {type: 'object', properties: {
                                  form: {type: 'string'}, gloss: {type: 'string'}},
                              required: ['form', 'gloss']},
                              description: 'embedded related Mi\'kmaq forms with their own glosses'},
                cross_refs: {type: 'array', items: {type: 'string'},
                             description: 'references to other words, entries or texts, verbatim'},
                notes: {type: 'array', items: {type: 'string'},
                        description: 'dialect / usage / place-name / editorial notes, verbatim'},
                confidence: {type: 'integer'},
            },
            required: ['headword', 'glosses', 'confidence'],
        },
        prompt: (input: unknown) => {
            const {entryText} = input as {entryText: string};
            return block`
/**/Below is a faithful transcription of ONE entry from Clark's 1902 Mi'kmaq
/**/dictionary (italics are wrapped in *...*; [a|b] marks an uncertain
/**/reading; line breaks are the printed line breaks - rejoin hyphenated
/**/words).  The prose assumes an intelligent reader: glosses, embedded
/**/derivative forms, cross-references ("cf. ...", "See ..."), dialect and
/**/place-name notes may all be mixed together.  Extract the structure.
/**/Quote Mi'kmaq forms EXACTLY as transcribed, diacritics intact.
/**/
/**/ENTRY:
/**/${entryText}
/**/${CONFIDENCE_RULES}`;
        },
    };
}

// ---------------------------------------------------------------------------------
// --- The survey -------------------------------------------------------------------
// ---------------------------------------------------------------------------------

/** Fold-index of every rand-lane spelling (etx role), for the headword
 *  join-rate measurement. */
export function randFoldIndex(): Set<string> {
    const idx = new Set<string>();
    for(const r of db().all<{attr1: string}, {eot: number}>(
        `SELECT attr1 FROM rand WHERE ty = 'etx' AND valid_to = :eot AND attr1 IS NOT NULL`,
        {eot: EOT}))
        idx.add(fold(r.attr1));
    return idx;
}

interface LineScore { textract: string; llm: string; dist: number; }
interface EntryRow { headword: string; folded: string; inRand: boolean; lineCount: number; }

export interface SurveyOptions {
    book: string;
    pages: number[];
    interpretPerPage: number;      // layer-2 taste entries per page
    reportPath: string;
    jsonPath?: string;             // per-line aligned data (model comparisons)
    model?: string;
    log?: (msg: string) => void;
}

// Per-line survey data for cross-model comparison (stage B): the aligned
// LLM line (diacritics intact) for every textract line, per page.
export interface SurveyJson {
    book: string; model: string; promptVersion: number;
    pages: Array<{printed: number,
                  lines: Array<{column: string, x: number, y: number, w: number, h: number,
                                textract: string, llm?: string}>,
                  interpretations: Array<{entryText: string, out: unknown}>}>;
}

export async function transcribeSurvey(opts: SurveyOptions): Promise<void> {
    const log = opts.log ?? ((m: string) => console.info(m));
    const llm = loadLlm('wordwiki');
    if(!llm.available)
        throw new Error('wordwiki-anthropic-credential.json missing/invalid - LLM unavailable');

    const usage = new Map<string, LlmUsage & {calls: number}>();
    const cfg: ExtractConfig = {
        derivedDir: 'derived',
        image: bandCropImageSource,
        llm,
        onUsage: (stageName, u) => {
            const t = usage.get(stageName) ?? {inputTokens: 0, outputTokens: 0, calls: 0};
            t.inputTokens += u.inputTokens; t.outputTokens += u.outputTokens; t.calls++;
            usage.set(stageName, t);
        },
    };
    const tStage = bandTranscribeStage(opts.model);
    const iStage = entryInterpretStage(opts.model);
    const rand = randFoldIndex();
    const json: SurveyJson = {book: opts.book, model: tStage.model,
                              promptVersion: PROMPT_VERSION_BAND_TRANSCRIBE, pages: []};

    const report: string[] = [];
    report.push(`# ${opts.book} layer-1 transcription survey`);
    report.push('');
    report.push(`Pages ${opts.pages.join(', ')}; band-transcribe v${PROMPT_VERSION_BAND_TRANSCRIBE}, ` +
                `entry-interpret v${PROMPT_VERSION_ENTRY_INTERPRET}, model ${tStage.model}.`);
    report.push(`Line scoring compares diacritic-FOLDED LLM lines against the (accent-stripped) ` +
                `textract lines - it checks reading fidelity, NOT diacritic fidelity ` +
                `(that needs the stage-B hand reference).`);

    for(const printed of opts.pages) {
        const geom = pageGeometry(opts.book, printed);
        const {left, right} = splitColumns(geom.lines, geom.width);
        log(`${opts.book} printed ${printed}: ${geom.lines.length} lines ` +
            `(${left.length} left, ${right.length} right)`);

        const lineScores: LineScore[] = [];
        const entries: EntryRow[] = [];
        const columnTexts: {column: string, llmByLine: (string|undefined)[], starts: boolean[]}[] = [];
        const jsonLines: SurveyJson['pages'][number]['lines'] = [];
        const jsonInterps: Array<{entryText: string, out: unknown}> = [];
        let dropped = 0, extra = 0;

        for(const [column, colLines] of [['left', left], ['right', right]] as const) {
            // The model's line for each TEXTRACT line index, via per-band
            // sequence alignment (the model may drop headers or split
            // gutter-crossing boxes - counts differ legitimately).
            const llmByLine: (string|undefined)[] = new Array(colLines.length);
            let base = 0;
            for(const band of bandColumn(colLines, geom.width, geom.height)) {
                const crop = await bandCropPath(geom.image_ref, band);
                const input: BandInput = {book: opts.book, printed, column,
                                          expectedLines: band.lines.length};
                const out: any = await extractStage(cfg, crop, 0, tStage, input);
                const got: string[] = (out?.lines ?? []).map(String);
                const pairs = alignFolded(band.lines.map(l => fold(l.text)),
                                          got.map(fold));
                for(const p of pairs) {
                    if(p.t !== undefined && p.l !== undefined) {
                        llmByLine[base + p.t] = got[p.l];
                        lineScores.push({textract: band.lines[p.t].text, llm: got[p.l],
                                         dist: levenshteinDistance(fold(band.lines[p.t].text),
                                                                   fold(got[p.l]))});
                    } else if(p.t !== undefined) dropped++;
                    else extra++;
                }
                base += band.lines.length;
            }
            const starts = entryStarts(colLines, geom.width);
            columnTexts.push({column, llmByLine, starts});
            for(let i = 0; i < colLines.length; i++)
                jsonLines.push({column, x: colLines[i].x, y: colLines[i].y,
                                w: colLines[i].w, h: colLines[i].h,
                                textract: colLines[i].text, llm: llmByLine[i]});
            // Entry rows: start line + its continuation count, headword join.
            for(let i = 0; i < colLines.length; i++) {
                if(!starts[i]) continue;
                let n = 1;
                while(i + n < colLines.length && !starts[i + n]) n++;
                const hw = headwordOf(llmByLine[i] ?? '');
                if(hw === '') continue;
                entries.push({headword: hw, folded: fold(hw),
                              inRand: rand.has(fold(hw)), lineCount: n});
            }
        }

        const exact = lineScores.filter(s => s.dist === 0).length;
        const near = lineScores.filter(s => s.dist > 0 && s.dist <= 2).length;
        const off = lineScores.filter(s => s.dist > 2);
        const matched = entries.filter(e => e.inRand).length;

        report.push('');
        report.push(`## Printed page ${printed}`);
        report.push('');
        report.push(`- lines: ${geom.lines.length}; aligned ${lineScores.length}, fold-exact ${exact} ` +
                    `(${(100 * exact / Math.max(1, lineScores.length)).toFixed(1)}%), ` +
                    `near (dist<=2) ${near}, disagreeing ${off.length}; ` +
                    `model dropped ${dropped} (headers etc.), extra ${extra}`);
        report.push(`- entry starts (hanging indent): ${entries.length}; headword in rand ` +
                    `window: ${matched} (${(100 * matched / Math.max(1, entries.length)).toFixed(1)}%)`);
        if(off.length > 0) {
            report.push('');
            report.push(`### Disagreeing lines (textract vs LLM, first 15)`);
            report.push('');
            for(const s of off.slice(0, 15))
                report.push(`- d${s.dist} | \`${s.textract}\` | \`${s.llm}\``);
        }
        const unmatched = entries.filter(e => !e.inRand);
        if(unmatched.length > 0) {
            report.push('');
            report.push(`### Headwords NOT in the rand window (${unmatched.length})`);
            report.push('');
            report.push(unmatched.map(e => `\`${e.headword}\``).join(', '));
        }

        // Layer-2 taste: interpret the first N well-formed entries.
        if(opts.interpretPerPage > 0) {
            report.push('');
            report.push(`### Interpreted entries (layer-2 taste, first ${opts.interpretPerPage})`);
            let done = 0;
            for(const ct of columnTexts) {
                for(let i = 0; i < ct.starts.length && done < opts.interpretPerPage; i++) {
                    if(!ct.starts[i]) continue;
                    let n = 1;
                    while(i + n < ct.starts.length && !ct.starts[i + n]) n++;
                    const entryText = ct.llmByLine.slice(i, i + n)
                        .filter(l => l !== undefined).join('\n');
                    if(fold(entryText) === '' || !entryText.includes(',')) continue;
                    const out: any = await extractTextStage(cfg, iStage, {entryText});
                    jsonInterps.push({entryText, out});
                    report.push('');
                    report.push('```');
                    report.push(entryText);
                    report.push('=>');
                    report.push(JSON.stringify(out, undefined, 2));
                    report.push('```');
                    done++;
                }
                if(done >= opts.interpretPerPage) break;
            }
        }
        json.pages.push({printed, lines: jsonLines, interpretations: jsonInterps});
    }

    // The batch's ACTUAL spend (cache hits never reach onUsage).
    report.push('');
    report.push('## Usage (actual API spend this run; cache hits free)');
    report.push('');
    let cost = 0;
    const rates = usdPerMtok(tStage.model);
    for(const [stage, u] of usage) {
        const c = u.inputTokens * rates.inTok / 1e6 + u.outputTokens * rates.outTok / 1e6;
        cost += c;
        report.push(`- ${stage}: ${u.calls} calls, ${u.inputTokens} in / ${u.outputTokens} out ` +
                    `tokens (~$${c.toFixed(2)})`);
    }
    report.push(`- total ~$${cost.toFixed(2)}`);

    await Deno.mkdir(posix.dirname(opts.reportPath), {recursive: true});
    await Deno.writeTextFile(opts.reportPath, report.join('\n') + '\n');
    if(opts.jsonPath) {
        await Deno.mkdir(posix.dirname(opts.jsonPath), {recursive: true});
        await Deno.writeTextFile(opts.jsonPath, JSON.stringify(json, undefined, 1));
    }
    log(`survey report written to ${opts.reportPath} (~$${cost.toFixed(2)} spent this run)`);
}
