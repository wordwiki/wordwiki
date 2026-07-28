// deno-lint-ignore-file no-explicit-any
/**
 * PDM SEGMENTATION PILOT (pdm-import-survey.md step 1): can a vision LLM
 * resolve a manuscript page's ENTRY STRUCTURE?  The go/no-go measurement
 * for the whole PDM import ambition, scored against the hand-drawn
 * Tagging groups (2,277 groups on 73 pages - the segmentation gold).
 *
 * METHOD (the Clark lesson applied - the model never emits coordinates):
 * textract word boxes are clustered mechanically into numbered RUNS
 * (line-level, x-gap-broken); the page is rendered with the runs outlined
 * and numbered; the model assigns each run number to an entry (or to page
 * furniture).  Proposals are scored as WORD-set assignments against the
 * gold groups: pairwise same-entry F1 + recovered-group rate.  Dual-model
 * divergence is measured as the future review gate (the handwriting has
 * no textract fold check - divergence and confidence stand in).
 *
 * All LLM work rides the extract substrate (cached; re-runs free).
 */
import * as posix from "https://deno.land/std@0.195.0/path/posix.ts";
import { db } from "../liminal/db.ts";
import { block } from "../liminal/strings.ts";
import * as content from "../liminal/content-store.ts";
import * as utils_config from "../liminal/utils-config.ts";
import { loadLlm, LlmUsage } from "../liminal/llm.ts";
import { extractStage, ExtractConfig, ExtractStage } from "../liminal/extract.ts";
import { containedImageSource } from '../wordwiki/transcribe.ts';
import { llmRetry } from '../wordwiki/page-transcribe.ts';

export const PROMPT_VERSION_PDM_SEGMENT = 2;   // v2: tuned run clustering
                                               // (ceiling 74->97); array-shape
                                               // insistence (p435 failures)

// The tuned clustering (ceiling sweep 2026-07-28: mean 96.8% over the 43
// dense gold pages; word-units on sparse pages where textract recall is
// the limit, line runs elsewhere).
// The interior optimum probe (2026-07-28): the finest clustering
// (ceiling 98%) SANK the models - 150-230 units exceed what they can
// visually track (scores 40-57, schema breakdowns).  Middle setting:
// ceiling ~89, ~half the units.
export const TUNED_CLUSTER: ClusterOpts = {yFactor: 0.45, gapPx: 60, wordUnitBelow: 180};
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

// ---------------------------------------------------------------------------------
// --- Page data --------------------------------------------------------------------
// ---------------------------------------------------------------------------------

export interface Word { id: number; x: number; y: number; w: number; h: number; }
export interface PdmPage {
    page_id: number; page_number: number; image_ref: string;
    width: number; height: number;
    words: Word[];
    gold: Map<number, {x: number, y: number, w: number, h: number}[]>;  // group -> boxes
}

export function pdmPage(page_number: number): PdmPage {
    const page = db().first<{page_id: number, image_ref: string, width: number, height: number}>(
        block`
/**/  SELECT page_id, image_ref, width, height FROM scanned_page
/**/     WHERE document_id = (SELECT document_id FROM scanned_document
/**/                          WHERE friendly_document_id = 'PDM')
/**/       AND page_number = :page_number`, {page_number});
    if(!page) throw new Error(`no PDM page ${page_number}`);
    const words = db().all<Word, {page_id: number}>(block`
/**/  SELECT b.bounding_box_id AS id, b.x, b.y, b.w, b.h
/**/     FROM bounding_box b JOIN layer l ON l.layer_id = b.layer_id
/**/     WHERE b.page_id = :page_id AND l.layer_name = 'Text'`, {page_id: page.page_id});
    const gold = new Map<number, {x: number, y: number, w: number, h: number}[]>();
    for(const r of db().all<{g: number, x: number, y: number, w: number, h: number},
                            {page_id: number}>(block`
/**/  SELECT b.bounding_group_id AS g, b.x, b.y, b.w, b.h
/**/     FROM bounding_box b JOIN layer l ON l.layer_id = b.layer_id
/**/     WHERE b.page_id = :page_id AND l.layer_name = 'Tagging'`, {page_id: page.page_id}))
        (gold.get(r.g) ?? gold.set(r.g, []).get(r.g)!).push(r);
    return {...page, page_number, words, gold};
}

// ---------------------------------------------------------------------------------
// --- Mechanical runs --------------------------------------------------------------
// ---------------------------------------------------------------------------------

export interface Run { id: number; words: Word[]; x: number; y: number; w: number; h: number; }

/** Cluster word boxes into line-level RUNS: greedy y-center line grouping
 *  (cursive overlaps a lot - the threshold is generous), then x-gap
 *  breaks within a line.  The run inventory is the model's assignment
 *  vocabulary - it never touches coordinates. */
export interface ClusterOpts { gapPx?: number; yFactor?: number;
                               // Below this word count the words THEMSELVES
                               // are the units: sparse/faint pages have too
                               // few textract words per entry for line runs
                               // (p250: 154 words over 82 tiny entries).
                               wordUnitBelow?: number; }

export function clusterRuns(words: Word[], opts: ClusterOpts = {}): Run[] {
    const gapPx = opts.gapPx ?? 100, yFactor = opts.yFactor ?? 0.6;
    if(words.length === 0) return [];
    if(words.length <= (opts.wordUnitBelow ?? 0)) {
        const sorted = [...words].toSorted((a, b) =>
            (a.y + a.h / 2) - (b.y + b.h / 2) || a.x - b.x);
        return sorted.map((w, i) => ({id: i, words: [w], x: w.x, y: w.y, w: w.w, h: w.h}));
    }
    const hs = words.map(w => w.h).toSorted((a, b) => a - b);
    const medh = hs[Math.floor(hs.length / 2)];
    const sorted = [...words].toSorted((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2));
    const lines: {yc: number, ws: Word[]}[] = [];
    for(const w of sorted) {
        const yc = w.y + w.h / 2;
        const last = lines[lines.length - 1];
        if(last && Math.abs(yc - last.yc) < medh * yFactor) {
            last.ws.push(w);
            last.yc = last.ws.reduce((s, x) => s + x.y + x.h / 2, 0) / last.ws.length;
        } else lines.push({yc, ws: [w]});
    }
    const runs: Run[] = [];
    for(const line of lines) {
        const ws = line.ws.toSorted((a, b) => a.x - b.x);
        let cur: Word[] = [ws[0]];
        const flush = () => {
            const x1 = Math.min(...cur.map(w => w.x)), y1 = Math.min(...cur.map(w => w.y));
            const x2 = Math.max(...cur.map(w => w.x + w.w)), y2 = Math.max(...cur.map(w => w.y + w.h));
            runs.push({id: runs.length, words: cur, x: x1, y: y1, w: x2 - x1, h: y2 - y1});
        };
        for(const w of ws.slice(1)) {
            if(w.x - (cur[cur.length - 1].x + cur[cur.length - 1].w) > gapPx) { flush(); cur = [w]; }
            else cur.push(w);
        }
        flush();
    }
    return runs;
}

/** The annotated page: run rectangles + index labels drawn on the scan,
 *  content-addressed by [image, run rects] so it stands in for the pixels
 *  in the extraction cache key. */
export async function annotatedPagePath(image_ref: string, runs: Run[]): Promise<string> {
    const rects = runs.map(r => ({x: r.x, y: r.y, w: r.w, h: r.h}));
    return 'derived/' + await content.getDerived(
        'derived/pdm-segment-annot', {pdmAnnotCmd},
        ['pdmAnnotCmd', image_ref, rects], 'jpg');
}

async function pdmAnnotCmd(targetResultPath: string, sourceImagePath: string,
                           rects: Array<{x: number, y: number, w: number, h: number}>) {
    const colors = ['red', 'blue', 'green', 'purple'];
    const draw: string[] = ['-font', FONT];
    rects.forEach((r, i) => {
        const c = colors[i % colors.length];
        draw.push('-stroke', c, '-fill', 'none',
                  '-draw', `rectangle ${r.x},${r.y} ${r.x + r.w},${r.y + r.h}`,
                  '-stroke', 'none', '-fill', c, '-pointsize', '64',
                  '-draw', `text ${Math.max(0, r.x - 10)},${Math.max(64, r.y - 8)} '${i}'`);
    });
    const { code, stderr } = await new Deno.Command(
        utils_config.imageMagickPath, {
            args: [sourceImagePath, '-strokewidth', '5', ...draw,
                   '-quality', '90', `jpg:${targetResultPath}`],
        }).output();
    if(code !== 0)
        throw new Error(`failed to annotate ${sourceImagePath}: ${new TextDecoder().decode(stderr)}`);
}

// ---------------------------------------------------------------------------------
// --- The segmentation stage -------------------------------------------------------
// ---------------------------------------------------------------------------------

export function pdmSegmentStage(model: string): ExtractStage {
    return {
        name: 'pdm-segment',
        model,
        promptVersion: PROMPT_VERSION_PDM_SEGMENT,
        imageBox: 1600,
        schema: {
            type: 'object',
            properties: {
                entries: {type: 'array', items: {type: 'object', properties: {
                    runs: {type: 'array', items: {type: 'integer'},
                           description: 'the run numbers belonging to this entry, reading order'},
                    kind: {type: 'string', enum: ['entry', 'furniture'],
                           description: "'furniture' = page numbers, slips, stamps - not dictionary content"},
                    headword: {type: 'string',
                               description: 'your best reading of the headword (optional, may be rough)'},
                }, required: ['runs', 'kind']}},
                confidence: {type: 'integer', description: 'overall confidence 0-100'},
            },
            required: ['entries', 'confidence'],
        },
        prompt: (input: unknown) => {
            const {page, runCount} = input as {page: number, runCount: number};
            return block`
/**/This is page ${page} of Father Pacifique's handwritten Mi'gmaq-French
/**/dictionary manuscript (early 1900s).  Each entry is a Mi'gmaq headword
/**/followed by French glosses (sometimes English), often with related word
/**/forms: Pacifique writes word FAMILIES, eliding the repeated stem (e.g.
/**/"eolamg, avoir pitié" then ", telgei, telemg" - suffix forms of the
/**/same family), and sometimes columns of inflected PARADIGM forms to the
/**/right of an entry - those belong WITH their entry.  Entries usually
/**/start at the left margin (hanging indent); insertions and arrows may
/**/relocate text; struck-through text still belongs to its entry.
/**/
/**/The image has ${runCount} numbered colored boxes ("runs") drawn over
/**/the text - each is a horizontal stretch of handwriting.  Your task is
/**/the PAGE STRUCTURE, not the reading: group the runs into dictionary
/**/entries.
/**/
/**/Return "entries" as a JSON ARRAY of objects (never a string).
/**/
/**/Rules:
/**/- assign EVERY run number 0..${runCount - 1} to exactly one group;
/**/- one group per dictionary entry (headword + its glosses + its family
/**/  forms + its paradigm columns + its citations), in reading order
/**/  (top-to-bottom by the entry's first line);
/**/- page numbers, library stamps, attached slips of paper and other
/**/  non-dictionary matter go into groups with kind 'furniture';
/**/- when a run visibly spans TWO entries (the mechanical boxes are
/**/  imperfect), assign it to the entry holding most of it;
/**/- 'headword' per entry: a rough reading of its first word (optional -
/**/  layout is the task, not transcription).
/**/Also return "confidence": 0-100, your honest overall confidence.`;
        },
    };
}

/** VISUAL-ENTRY GOLD (decision (a), dz 2026-07-28): the hand groups are
 *  per-word OVERLAPPING evidence sets (each = shared stem + shared gloss
 *  + its own paradigm cell), not a partition of the page.  For the
 *  SEGMENTATION target - the visual entry as Pacifique wrote it - merge
 *  groups into connected components wherever their boxes materially
 *  overlap; the per-word split (and its evidence box-sets) belongs to
 *  the INTERPRETATION stage, which can read the block. */
export function mergeOverlappingGold(gold: PdmPage['gold']): PdmPage['gold'] {
    const ids = [...gold.keys()];
    const parent = new Map(ids.map(i => [i, i]));
    const find = (i: number): number => {
        let r = i;
        while(parent.get(r) !== r) r = parent.get(r)!;
        parent.set(i, r);
        return r;
    };
    const overlap = (a: {x: number, y: number, w: number, h: number},
                     b: {x: number, y: number, w: number, h: number}) => {
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if(ox <= 0 || oy <= 0) return 0;
        return (ox * oy) / Math.min(a.w * a.h, b.w * b.h);
    };
    for(let i = 0; i < ids.length; i++)
        for(let j = i + 1; j < ids.length; j++) {
            if(find(ids[i]) === find(ids[j])) continue;
            outer: for(const a of gold.get(ids[i])!)
                for(const b of gold.get(ids[j])!)
                    if(overlap(a, b) >= 0.4) {
                        parent.set(find(ids[j]), find(ids[i]));
                        break outer;
                    }
        }
    const merged = new Map<number, {x: number, y: number, w: number, h: number}[]>();
    for(const id of ids) {
        const root = find(id);
        (merged.get(root) ?? merged.set(root, []).get(root)!).push(...gold.get(id)!);
    }
    return merged;
}

// ---------------------------------------------------------------------------------
// --- V3: entry-START marking (spans built mechanically) ---------------------------
// ---------------------------------------------------------------------------------
//
// The grouping task exceeded the models' visual assignment capacity (the
// pilot's measured collapse past ~100 units).  V3 asks only WHICH RUNS
// BEGIN AN ENTRY - output size scales with entries (~50), not units - and
// builds the spans mechanically: reading-order bands between consecutive
// starts, each remaining run assigned to the band holding its y-center
// (this attaches right-column paradigm runs to their entry by geometry).

export function pdmStartStage(model: string): ExtractStage {
    return {
        name: 'pdm-starts',
        model,
        promptVersion: 1,
        imageBox: 1600,
        schema: {
            type: 'object',
            properties: {
                starts: {type: 'array', items: {type: 'object', properties: {
                    run: {type: 'integer', description: 'run number that BEGINS a new entry'},
                    headword: {type: 'string', description: 'rough reading of the headword (optional)'},
                }, required: ['run']}},
                furniture: {type: 'array', items: {type: 'integer'},
                            description: 'runs that are page numbers, stamps, slips - not dictionary content'},
                confidence: {type: 'integer'},
            },
            required: ['starts', 'confidence'],
        },
        prompt: (input: unknown) => {
            const {page, runCount} = input as {page: number, runCount: number};
            return block`
/**/This is page ${page} of Father Pacifique's handwritten Mi'gmaq-French
/**/dictionary manuscript.  Each dictionary entry starts at the LEFT
/**/margin with a Mi'gmaq headword, followed by French glosses and related
/**/word forms; some entries continue over several lines (continuations
/**/are indented or flow on), and columns of short inflected forms
/**/sometimes hang to the RIGHT of an entry - those are NOT new entries.
/**/Struck-through entries still count as entries.
/**/
/**/The image has ${runCount} numbered colored boxes ("runs") over the
/**/text.  Identify ONLY the runs that BEGIN a new dictionary entry (the
/**/run containing the entry's headword - normally at the left margin),
/**/top to bottom.  Do NOT list continuation runs, gloss runs, or the
/**/right-hand inflection columns.  Also list runs that are page
/**/furniture (page numbers, stamps, attached slips) under "furniture".
/**/Return "starts" as a JSON ARRAY of objects and "confidence" 0-100.`;
        },
    };
}

/** Build entry spans from start runs: reading-order bands.  Each
 *  non-start, non-furniture run joins the latest start whose top edge is
 *  at-or-above the run's y-center (ties between same-line starts resolved
 *  toward the nearest start left of the run). */
export function spansFromStarts(runs: Run[], startIds: number[], furnitureIds: number[]):
        {runs: number[], kind: string}[] {
    const furn = new Set(furnitureIds);
    const starts = startIds.filter(id => runs[id] !== undefined && !furn.has(id))
        .map(id => ({id, yTop: runs[id].y, x: runs[id].x}))
        .toSorted((a, b) => a.yTop - b.yTop || a.x - b.x);
    if(starts.length === 0)
        return runs.length === 0 ? [] : [{runs: runs.map(r => r.id), kind: 'entry'}];
    const entries = starts.map(st => ({runs: [st.id], kind: 'entry'}));
    const medh = runs.map(r => r.h).toSorted((a, b) => a - b)[Math.floor(runs.length / 2)] ?? 60;
    for(const r of runs) {
        if(furn.has(r.id) || starts.some(st => st.id === r.id)) continue;
        const yc = r.y + r.h / 2;
        // candidate bands: starts whose top is above the run's center
        // (with half-line slack for same-line starts)
        let bandIdx = -1;
        for(let i = 0; i < starts.length; i++)
            if(starts[i].yTop <= yc + medh * 0.3) bandIdx = i; else break;
        if(bandIdx < 0) bandIdx = 0;
        // same-line tie: if the NEXT start shares this line and sits left
        // of the run, the run belongs to the next entry
        const next = starts[bandIdx + 1];
        if(next && Math.abs(next.yTop - runs[starts[bandIdx].id].y) < medh * 0.6
           && next.x <= r.x && next.yTop <= yc + medh * 0.3)
            bandIdx = bandIdx + 1;
        entries[bandIdx].runs.push(r.id);
    }
    return [...entries,
            ...(furnitureIds.length ? [{runs: furnitureIds, kind: 'furniture'}] : [])];
}

/** The V3 mechanical ceiling: spans built from the GOLD starts (first
 *  covered run of each gold group in reading order) - measures the
 *  span-building rule itself with a perfect start-marker. */
export function startOracle(page: PdmPage, runs: Run[]): {runs: number[], kind: string}[] {
    const gold = goldAssignment(page);
    const firstRun = new Map<number, number>();   // gold group -> earliest run
    for(const r of runs) {
        const counts = new Map<number, number>();
        for(const w of r.words) {
            const g = gold.get(w.id);
            if(g !== undefined) counts.set(g, (counts.get(g) ?? 0) + 1);
        }
        if(counts.size === 0) continue;
        const g = [...counts.entries()].toSorted((a, b) => b[1] - a[1])[0][0];
        const cur = firstRun.get(g);
        if(cur === undefined
           || runs[cur].y > r.y || (runs[cur].y === r.y && runs[cur].x > r.x))
            firstRun.set(g, r.id);
    }
    return spansFromStarts(runs, [...firstRun.values()], []);
}

// ---------------------------------------------------------------------------------
// --- Scoring against the hand groups ----------------------------------------------
// ---------------------------------------------------------------------------------

export interface PageScore {
    page: number; runs: number; goldGroups: number; coveredWords: number; totalWords: number;
    proposedEntries: number;
    pairF1: number; pairPrecision: number; pairRecall: number;
    recovered: number;            // gold groups with a >=80%-pure-and-complete proposal
    confidence: number;
}

/** Word -> gold group by max box overlap (>=30% of the word's area). */
export function goldAssignment(page: PdmPage): Map<number, number> {
    const area = (w: number, h: number) => Math.max(0, w) * Math.max(0, h);
    const out = new Map<number, number>();
    for(const w of page.words) {
        let best = -1, bestA = 0;
        for(const [g, boxes] of page.gold) {
            let a = 0;
            for(const b of boxes) {
                const ox = Math.min(w.x + w.w, b.x + b.w) - Math.max(w.x, b.x);
                const oy = Math.min(w.y + w.h, b.y + b.h) - Math.max(w.y, b.y);
                a += area(ox, oy);
            }
            if(a > bestA) { bestA = a; best = g; }
        }
        if(best >= 0 && bestA >= 0.3 * w.w * w.h) out.set(w.id, best);
    }
    return out;
}

export function scoreProposal(page: PdmPage, runs: Run[], entries: {runs: number[], kind: string}[],
                              confidence: number): PageScore {
    const gold = goldAssignment(page);
    // word -> proposed entry index (furniture = excluded like uncovered gold)
    const prop = new Map<number, number>();
    entries.forEach((e, i) => {
        if(e.kind === 'furniture') return;
        for(const ri of e.runs)
            for(const w of runs[ri]?.words ?? [])
                if(!prop.has(w.id)) prop.set(w.id, i);
    });
    // pairwise same-entry over words covered by BOTH gold and proposal
    const ids = [...gold.keys()].filter(id => prop.has(id));
    let tp = 0, fp = 0, fn = 0;
    for(let i = 0; i < ids.length; i++)
        for(let j = i + 1; j < ids.length; j++) {
            const sameG = gold.get(ids[i]) === gold.get(ids[j]);
            const sameP = prop.get(ids[i]) === prop.get(ids[j]);
            if(sameG && sameP) tp++;
            else if(!sameG && sameP) fp++;
            else if(sameG && !sameP) fn++;
        }
    const prec = tp + fp === 0 ? 0 : tp / (tp + fp);
    const rec = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = prec + rec === 0 ? 0 : 2 * prec * rec / (prec + rec);
    // recovered gold groups
    const byGold = new Map<number, number[]>();
    for(const id of ids) (byGold.get(gold.get(id)!) ?? byGold.set(gold.get(id)!, []).get(gold.get(id)!)!).push(id);
    let recovered = 0;
    for(const [, members] of byGold) {
        const counts = new Map<number, number>();
        for(const id of members) counts.set(prop.get(id)!, (counts.get(prop.get(id)!) ?? 0) + 1);
        const [bestEntry, inCount] = [...counts.entries()].toSorted((a, b) => b[1] - a[1])[0];
        const entrySize = ids.filter(id => prop.get(id) === bestEntry).length;
        if(inCount / members.length >= 0.8 && inCount / entrySize >= 0.8) recovered++;
    }
    return {page: page.page_number, runs: runs.length, goldGroups: byGold.size,
            coveredWords: ids.length, totalWords: page.words.length,
            proposedEntries: entries.filter(e => e.kind !== 'furniture').length,
            pairF1: f1, pairPrecision: prec, pairRecall: rec,
            recovered, confidence};
}

/** Cross-model divergence: fraction of shared covered words whose
 *  same-entry relation the two proposals disagree on (sampled pairs). */
export function proposalDivergence(runs: Run[], a: {runs: number[], kind: string}[],
                                   b: {runs: number[], kind: string}[]): number {
    const asg = (es: {runs: number[], kind: string}[]) => {
        const m = new Map<number, number>();
        es.forEach((e, i) => { if(e.kind !== 'furniture')
            for(const ri of e.runs) for(const w of runs[ri]?.words ?? [])
                if(!m.has(w.id)) m.set(w.id, i); });
        return m;
    };
    const ma = asg(a), mb = asg(b);
    const ids = [...ma.keys()].filter(id => mb.has(id));
    let agree = 0, total = 0;
    for(let i = 0; i < ids.length; i++)
        for(let j = i + 1; j < ids.length; j++) {
            total++;
            if((ma.get(ids[i]) === ma.get(ids[j])) === (mb.get(ids[i]) === mb.get(ids[j]))) agree++;
        }
    return total === 0 ? 0 : 1 - agree / total;
}

/** The RUN-GRANULARITY CEILING: the best any model could score given the
 *  mechanical runs - each run assigned to its majority gold group.  The
 *  gap between ceiling and model = model error; between 100 and ceiling =
 *  clustering error (fix the clustering, not the prompt). */
export function ceilingProposal(page: PdmPage, runs: Run[]): {runs: number[], kind: string}[] {
    const gold = goldAssignment(page);
    const byGroup = new Map<number, number[]>();
    runs.forEach((r, i) => {
        const counts = new Map<number, number>();
        for(const w of r.words) {
            const g = gold.get(w.id);
            if(g !== undefined) counts.set(g, (counts.get(g) ?? 0) + 1);
        }
        if(counts.size === 0) return;
        const best = [...counts.entries()].toSorted((a, b) => b[1] - a[1])[0][0];
        (byGroup.get(best) ?? byGroup.set(best, []).get(best)!).push(i);
    });
    return [...byGroup.values()].map(rs => ({runs: rs, kind: 'entry'}));
}

/** Ceiling SWEEP (zero LLM): grid-search the clustering params against
 *  the hand groups over every densely-tagged page.  The tuning loop's
 *  inner measure. */
export function ceilingSweep(minGroups = 10): string {
    const pages = db().all<{page_number: number}, {n: number}>(block`
/**/  SELECT p.page_number FROM scanned_page p
/**/     WHERE p.document_id = (SELECT document_id FROM scanned_document
/**/                            WHERE friendly_document_id = 'PDM')
/**/       AND (SELECT COUNT(DISTINCT b.bounding_group_id) FROM bounding_box b
/**/              JOIN layer l ON l.layer_id = b.layer_id
/**/              WHERE b.page_id = p.page_id AND l.layer_name = 'Tagging') >= :n
/**/     ORDER BY p.page_number`, {n: minGroups}).map(r => r.page_number);
    const data = pages.map(pdmPage);
    const lines: string[] = [`ceiling sweep over ${pages.length} pages (>=${minGroups} gold groups)`];
    let best = {f1: 0, gap: 0, yf: 0, wub: 0};
    for(const yf of [0.3, 0.35, 0.4])
        for(const gap of [25, 40, 60])
          for(const wub of [0, 180, 240, 400]) {
            const f1s = data.map(page => {
                const runs = clusterRuns(page.words, {gapPx: gap, yFactor: yf, wordUnitBelow: wub});
                return scoreProposal(page, runs, ceilingProposal(page, runs), 0).pairF1;
            });
            const mean = f1s.reduce((s, x) => s + x, 0) / f1s.length;
            const worst = Math.min(...f1s);
            lines.push(`yf=${yf} gap=${gap} wub=${wub}: mean ${(100 * mean).toFixed(1)} worst ${(100 * worst).toFixed(0)}`);
            if(mean > best.f1) best = {f1: mean, gap, yf, wub};
          }
    lines.push(`BEST: yf=${best.yf} gap=${best.gap} wub=${best.wub} mean ${(100 * best.f1).toFixed(1)}`);
    // Per-page ceilings at the best combo, worst-first (the residual list).
    const per = data.map(page => {
        const runs = clusterRuns(page.words, {gapPx: best.gap, yFactor: best.yf, wordUnitBelow: best.wub});
        return {page: page.page_number,
                f1: scoreProposal(page, runs, ceilingProposal(page, runs), 0).pairF1};
    }).toSorted((a, b) => a.f1 - b.f1);
    lines.push('worst pages at best combo: ' +
               per.slice(0, 8).map(p => `p${p.page}:${(100 * p.f1).toFixed(0)}`).join(' '));
    return lines.join('\n');
}

// ---------------------------------------------------------------------------------
// --- The pilot runner -------------------------------------------------------------
// ---------------------------------------------------------------------------------

export interface PilotOptions {
    pages: number[];
    models: string[];             // [primary, gate]
    reportPath: string;
    task?: 'group' | 'starts';    // v1 grouping vs v3 start-marking
    gold?: 'hand' | 'merged';     // per-word hand groups vs visual entries (v4)
    log?: (m: string) => void;
}

export async function segmentPilot(opts: PilotOptions): Promise<void> {
    const log = opts.log ?? ((m: string) => console.info(m));
    const llm = loadLlm('wordwiki');
    if(!llm.available) throw new Error('LLM unavailable');
    const usage = new Map<string, LlmUsage & {calls: number}>();
    const cfg: ExtractConfig = {
        derivedDir: 'derived',
        image: containedImageSource('derived/pdm-segment-contained'),
        llm,
        onUsage: (stage, u) => {
            const t = usage.get(stage) ?? {inputTokens: 0, outputTokens: 0, calls: 0};
            t.inputTokens += u.inputTokens; t.outputTokens += u.outputTokens; t.calls++;
            usage.set(stage, t);
        },
    };
    const report: string[] = [
        `# PDM segmentation pilot (task ${opts.task ?? 'group'}, gold ${opts.gold ?? 'merged'}, prompt v${PROMPT_VERSION_PDM_SEGMENT})`,
        '',
        `Pages ${opts.pages.join(', ')}; models ${opts.models.join(' vs ')}.  Scored against`,
        `the hand Tagging groups: pairwise same-entry F1 over words covered by both`,
        `gold and proposal; 'recovered' = gold groups matched by a >=80% pure+complete`,
        `proposed entry.  Divergence = same-entry disagreement between the models.`,
        '',
        `| page | runs | gold | ceiling | ${opts.models.map(m => `${m.split('-')[1]} F1 / rec / conf`).join(' | ')} | diverge |`,
        `|---|---|---|---|${opts.models.map(() => '---').join('|')}|---|`,
    ];
    const totalsCeil: number[] = [];
    const totals: Record<string, {f1: number[], rec: number[], recAll: number[]}> = {};
    for(const m of opts.models) totals[m] = {f1: [], rec: [], recAll: []};
    const divergences: number[] = [];

    let failures = 0;
    for(const pageNo of opts.pages) {
        let page = pdmPage(pageNo);
        if((opts.gold ?? 'merged') === 'merged')
            page = {...page, gold: mergeOverlappingGold(page.gold)};
        const runs = clusterRuns(page.words, TUNED_CLUSTER);
        const annot = await annotatedPagePath(page.image_ref, runs);
        const results: Record<string, any> = {};
        try {
            await Promise.all(opts.models.map(async model => {
                const stage = opts.task === 'starts' ? pdmStartStage(model)
                    : pdmSegmentStage(model);
                const raw: any = await llmRetry(() =>
                    extractStage(cfg, annot, 0, stage, {page: pageNo, runCount: runs.length}));
                results[model] = opts.task === 'starts'
                    ? {entries: spansFromStarts(runs,
                          (raw.starts ?? []).map((st: any) => Number(st.run)),
                          (raw.furniture ?? []).map(Number)),
                       confidence: raw.confidence}
                    : raw;
            }));
        } catch(e) {
            failures++;
            log(`p${pageNo}: FAILED (${e instanceof Error ? e.message.slice(0, 120) : e})`);
            report.push(`| ${pageNo} | ${runs.length} | - | - | FAILED | - |`);
            continue;
        }
        const ceil = scoreProposal(page, runs,
            opts.task === 'starts' ? startOracle(page, runs) : ceilingProposal(page, runs), 0);
        const cells: string[] = [];
        for(const model of opts.models) {
            const out = results[model];
            const s = scoreProposal(page, runs, out.entries ?? [], Number(out.confidence ?? 0));
            totals[model].f1.push(s.pairF1);
            totals[model].rec.push(s.recovered / Math.max(1, s.goldGroups));
            cells.push(`${(100 * s.pairF1).toFixed(0)} / ${s.recovered}/${s.goldGroups} / c${s.confidence}`);
        }
        const div = proposalDivergence(runs, results[opts.models[0]].entries ?? [],
                                       results[opts.models[1]]?.entries ?? []);
        divergences.push(div);
        const s0 = scoreProposal(page, runs, results[opts.models[0]].entries ?? [], 0);
        report.push(`| ${pageNo} | ${runs.length} | ${s0.goldGroups} | ` +
                    `${(100 * ceil.pairF1).toFixed(0)} | ${cells.join(' | ')} | ` +
                    `${(100 * div).toFixed(0)}% |`);
        totalsCeil.push(ceil.pairF1);
        log(`p${pageNo}: runs ${runs.length}, gold ${s0.goldGroups}, ceiling ${(100 * ceil.pairF1).toFixed(0)}, ` +
            `${opts.models.map((m, i) => `${m}: ${cells[i]}`).join('; ')}, div ${(100 * div).toFixed(0)}%`);
    }
    if(failures > 0) report.push('', `**${failures} page(s) FAILED after retries.**`);

    report.push('');
    report.push(`- **run-granularity ceiling**: mean pair-F1 ` +
                `${(100 * totalsCeil.reduce((s, x) => s + x, 0) / Math.max(1, totalsCeil.length)).toFixed(1)}%`);
    for(const m of opts.models) {
        const f1s = totals[m].f1, recs = totals[m].rec;
        const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
        report.push(`- **${m}**: mean pair-F1 ${(100 * mean(f1s)).toFixed(1)}%, ` +
                    `mean recovered-group rate ${(100 * mean(recs)).toFixed(1)}%`);
    }
    report.push(`- mean cross-model divergence: ` +
                `${(100 * divergences.reduce((s, x) => s + x, 0) / Math.max(1, divergences.length)).toFixed(1)}%`);
    report.push('', '## Usage (actual API spend this run)', '');
    for(const [stage, u] of usage)
        report.push(`- ${stage}: ${u.calls} calls, ${u.inputTokens} in / ${u.outputTokens} out`);
    await Deno.mkdir(posix.dirname(opts.reportPath), {recursive: true});
    await Deno.writeTextFile(opts.reportPath, report.join('\n') + '\n');
    log(`pilot report written to ${opts.reportPath}`);
}
