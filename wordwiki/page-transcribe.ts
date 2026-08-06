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
import { DerivationNotAvailable } from "../liminal/batch-derivation.ts";
import { levenshteinDistance } from "../liminal/levenshtein-distance.ts";
import { containedImageSource } from './transcribe.ts';

const EOT = 9007199254740991;

// The per-band facts a transcription stage's prompt receives (they ride
// extractStage's `input`, so they are part of the cache key).  The stage
// PROMPTS themselves are book/language-specific and live with the project
// package (mikmaq/clark-import.ts) - dz's packaging rule.
export interface BandInput { book: string; printed: number; column: string;
                             expectedLines: number; }

// List prices, for the survey's printed cost line only.
function usdPerMtok(model: string): {inTok: number, outTok: number} {
    return model.includes('sonnet') ? {inTok: 3, outTok: 15}
         : model.includes('haiku')  ? {inTok: 1, outTok: 5}
         :                            {inTok: 15, outTok: 75};   // opus
}

// ---------------------------------------------------------------------------------
// --- Page geometry (textract lines already in the db) -----------------------------
// ---------------------------------------------------------------------------------

export interface PageLine { box_id: number; x: number; y: number; w: number; h: number; text: string; }
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
/**/    SELECT b.bounding_box_id AS box_id, b.x, b.y, b.w, b.h, b.text
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

/** Two-column split at the GUTTER: the largest gap in the line-START
 *  distribution within the central band.  (A center-x rule misfiles
 *  SHORT indented right-column lines - the right column starts left of
 *  page-mid, so a short continuation's center lands under page-mid and
 *  the line joins the wrong column's entry; found via Clark p1 'abode'.)
 *  Falls back to page-mid when no clear gutter exists. */
export function splitColumns(lines: PageLine[], pageWidth: number):
        {left: PageLine[], right: PageLine[]} {
    const xs = [...new Set(lines.map(l => l.x))].toSorted((a, b) => a - b);
    let boundary = pageWidth / 2, best = 0;
    for(let i = 1; i < xs.length; i++) {
        const gap = xs[i] - xs[i - 1];
        if(gap > best && xs[i] > pageWidth * 0.25 && xs[i - 1] < pageWidth * 0.75) {
            best = gap;
            boundary = (xs[i] + xs[i - 1]) / 2;
        }
    }
    if(best < pageWidth * 0.08) boundary = pageWidth / 2;
    return {left: lines.filter(l => l.x < boundary),
            right: lines.filter(l => l.x >= boundary)};
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

export const bandCropImageSource = containedImageSource('derived/band-crops-contained');

// ---------------------------------------------------------------------------------
// --- The stages -------------------------------------------------------------------
// ---------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------
// --- Entry assembly (stage C) -----------------------------------------------------
// ---------------------------------------------------------------------------------

/** Running heads, page numbers and section letters - excluded from
 *  entries mechanically (textract text: guide words print ALL CAPS,
 *  page numbers are digit islands). */
export function isHeaderLine(textractText: string): boolean {
    const t = textractText.trim();
    if(/^[A-Z]{1,4}$/.test(t)) return true;
    if(t.length <= 10 && /\d/.test(t) && /^[^A-Za-z]*\d+[^A-Za-z]*$/.test(t)) return true;
    // Page numbers with digit-confusable textract misreads ('I5' for 15,
    // '2I' for 21) - short digit islands where every letter is I/l/O.
    return t.length <= 6 && /\d/.test(t) && /^[0-9IlO\-–—=/. ]+$/.test(t);
}

/** Diacritic-PRESERVING fold for cross-model divergence detection (the
 *  stage-B letter-level category): markup/ambiguity/spacing-insensitive,
 *  letters and combining marks exact. */
export function diacriticFold(s: string): string {
    return s.replace(/\[([^|\]]*)\|[^\]]*\]/g, '$1')
        .replace(/[*⁇|]/g, '')
        .toLowerCase().normalize('NFC')
        .replace(/[^\p{L}\p{M}]/gu, '');
}

export interface AssembledLine {
    printed: number; page_id: number; box_id: number;
    x: number; y: number; w: number; h: number;
    textract: string;
    text: string;            // primary model line (textract fallback when dropped)
    secondary?: string;      // secondary model line, when a secondary ran
    divergent: boolean;      // models disagree at letter/diacritic level
    dropped: boolean;        // primary produced no line (text = textract fallback)
}

export interface AssembledEntry {
    printed: number;         // page the entry STARTS on
    lines: AssembledLine[];
    text: string;            // primary lines joined
    divergentLines: number;
}

export interface AssembleResult {
    entries: AssembledEntry[];
    headersSkipped: number;
    columnJoins: number;     // entries continued across a column/page boundary
    droppedPrimary: number;
    divergentLines: number;
}

/** Retry transient LLM failures (the client has no retry of its own;
 *  parallel batches turn one 429/529 blip into a hole otherwise). */
export async function llmRetry<T>(fn: () => Promise<T>): Promise<T> {
    const delays = [2000, 8000, 20000];
    for(let attempt = 0; ; attempt++) {
        try { return await fn(); }
        catch(e) {
            // Batch mode's "enrolled, not ready" is CONTROL FLOW, not a
            // failure - it must reach the pass's top loop untouched.
            if(e instanceof DerivationNotAvailable) throw e;
            const msg = e instanceof Error ? e.message : String(e);
            // Schema mismatches are retryable too: an occasional response
            // drops a required field, and a fresh call (nothing invalid is
            // ever cached) almost always validates.
            const transient = /429|529|overloaded|rate.?limit|timeout|ECONN|network|does not match schema/i.test(msg);
            if(!transient || attempt >= delays.length) throw e;
            await new Promise(res => setTimeout(res, delays[attempt]));
        }
    }
}

/** One column's model lines: transcribe per band (bands run in parallel,
 *  each cached), sequence-align to the textract lines, return the model
 *  line per textract index. */
async function columnModelLines(cfg: ExtractConfig, geom: PageGeom, colLines: PageLine[],
                                stage: ExtractStage, book: string, column: string):
        Promise<(string|undefined)[]> {
    const out: (string|undefined)[] = new Array(colLines.length);
    const bands = bandColumn(colLines, geom.width, geom.height);
    const bases: number[] = [];
    let acc = 0;
    for(const b of bands) { bases.push(acc); acc += b.lines.length; }
    await Promise.all(bands.map(async (band, bi) => {
        const crop = await bandCropPath(geom.image_ref, band);
        const input: BandInput = {book, printed: geom.printed, column,
                                  expectedLines: band.lines.length};
        let got: string[];
        try {
            got = ((await llmRetry(() => extractStage(cfg, crop, 0, stage, input)) as any)?.lines ?? [])
                .map(String);
        } catch(e) {
            // A band that still fails after retries degrades to textract
            // fallback for its lines (visible as 'dropped' in the stats) -
            // one bad band must not kill a book-length run.
            console.info(`  band-transcribe FAILED (p${geom.printed} ${column} y=${band.y}, ` +
                         `${stage.model}): ${e instanceof Error ? e.message : e}`);
            return;
        }
        for(const p of alignFolded(band.lines.map(l => fold(l.text)), got.map(fold)))
            if(p.t !== undefined && p.l !== undefined) out[bases[bi] + p.t] = got[p.l];
    }));
    return out;
}

/** Assemble the book's entries over a page range: reading order = page
 *  ascending, left column then right; entry starts by hanging indent; a
 *  column whose first body line is NOT a start continues the previous
 *  entry (the cross-column/cross-page stitch - pages should be
 *  contiguous for the stitches to be real). */
export async function assembleBook(cfg: ExtractConfig, book: string, pages: number[],
                                   primary: ExtractStage, secondary: ExtractStage|undefined,
                                   log: (m: string) => void): Promise<AssembleResult> {
    const r: AssembleResult = {entries: [], headersSkipped: 0, columnJoins: 0,
                               droppedPrimary: 0, divergentLines: 0};
    let current: AssembledEntry|undefined;
    for(const printed of pages) {
        const geom = pageGeometry(book, printed);
        const {left, right} = splitColumns(geom.lines, geom.width);
        for(const [column, colLines] of [['left', left], ['right', right]] as const) {
            const [pri, sec] = await Promise.all([
                columnModelLines(cfg, geom, colLines, primary, book, column),
                secondary === undefined ? Promise.resolve(undefined)
                    : columnModelLines(cfg, geom, colLines, secondary, book, column)]);
            const starts = entryStarts(colLines, geom.width);
            let firstBody = true;
            for(let i = 0; i < colLines.length; i++) {
                const tx = colLines[i];
                if(isHeaderLine(tx.text)) { r.headersSkipped++; continue; }
                const p = pri[i], s = sec?.[i];
                if(p === undefined) r.droppedPrimary++;
                const divergent = p !== undefined && s !== undefined &&
                    diacriticFold(p) !== diacriticFold(s);
                if(divergent) r.divergentLines++;
                const line: AssembledLine = {
                    printed, page_id: geom.page_id, box_id: tx.box_id,
                    x: tx.x, y: tx.y, w: tx.w, h: tx.h,
                    textract: tx.text, text: p ?? tx.text, secondary: s,
                    divergent, dropped: p === undefined};
                if(starts[i] || current === undefined) {
                    current = {printed, lines: [line], text: '', divergentLines: 0};
                    r.entries.push(current);
                } else {
                    if(firstBody) r.columnJoins++;
                    current.lines.push(line);
                }
                firstBody = false;
            }
        }
        log(`${book} printed ${printed}: ${r.entries.length} entries so far`);
    }
    for(const e of r.entries) {
        e.text = e.lines.map(l => l.text).join('\n');
        e.divergentLines = e.lines.filter(l => l.divergent).length;
    }
    return r;
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
    // The stages are the book/language-specific half (prompts, models,
    // versions) - built by the caller (the CLI binary edge, from the
    // project package).
    transcribeStage: ExtractStage;
    interpretStage: ExtractStage;
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
    const tStage = opts.transcribeStage;
    const iStage = opts.interpretStage;
    const rand = randFoldIndex();
    const json: SurveyJson = {book: opts.book, model: tStage.model,
                              promptVersion: tStage.promptVersion, pages: []};

    const report: string[] = [];
    report.push(`# ${opts.book} layer-1 transcription survey`);
    report.push('');
    report.push(`Pages ${opts.pages.join(', ')}; band-transcribe v${tStage.promptVersion}, ` +
                `entry-interpret v${iStage.promptVersion}, model ${tStage.model}.`);
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
