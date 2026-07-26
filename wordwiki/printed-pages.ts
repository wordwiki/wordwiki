// deno-lint-ignore-file no-explicit-any
/**
 * PRINTED page numbers for scanned books (rand-references-design.md §5).
 *
 * Citations cite the number PRINTED on the page (`\so Rand 1888, p 282`);
 * `scanned_page.page_number` is scan order, shifted by front matter.  This
 * module derives `scanned_page.printed_page_number` from the OCR Text
 * layer: each page's top-band boxes yield integer CANDIDATES (page
 * headers), and a SEQUENCE FIT turns them into per-page assignments -
 * printing is continuous, so the fit looks for runs of pages sharing a
 * constant `printed - scan` OFFSET, interpolates interior pages whose
 * header the OCR missed, and reports (never trusts) pages whose candidates
 * contradict the run.  Roman-numbered front matter stays NULL (arabic body
 * pages are what citations target).
 *
 * Derivation is a deliberate human-in-the-loop step: the CLI
 * (`derive-printed-pages <book> [--apply]`) prints the report for spot
 * checking; --apply writes the column.
 */
import { db } from '../liminal/db.ts';
import { block } from '../liminal/strings.ts';
import { selectScannedDocumentByFriendlyId } from './scanned-document.ts';

// ---------------------------------------------------------------------------------
// --- The pure sequence fit --------------------------------------------------------
// ---------------------------------------------------------------------------------

export interface PageCandidates {
    page_number: number;
    candidates: number[];
    hasText?: boolean;      // any OCR boxes at all (default true); boxless
                            // pages (plates, blanks) never extend a run
}

export interface PrintedRun {
    offset: number;         // printed = page_number + offset, inside the run
    fromPage: number;       // scan page_number span (confirmed endpoints,
    toPage: number;         //   plus at most one edge-extension per side)
    confirmed: number;      // pages whose candidates include the expected number
    interpolated: number;   // interior pages carried by continuity alone
    edgeExtended: number[]; // section-opener edges assigned by the ±1 rule
}

export interface PrintedPageFit {
    assigned: Map<number, number>;   // scan page_number -> printed number
    runs: PrintedRun[];
    // Pages INSIDE a run whose candidates exist but contradict the expected
    // number (assigned anyway - continuity beats one page's OCR - but these
    // are the spot-check worklist).
    conflicts: Array<{page_number: number, expected: number, candidates: number[]}>;
    unassigned: number[];            // scan pages outside every run
}

/** Fit runs of constant offset to the per-page candidates.  Greedy by
 *  support: offsets confirmed on at least `minSupport` pages become runs
 *  (span = first..last confirming page); overlapping weaker runs are
 *  dropped (a page belongs to one numbering); interior gaps interpolate. */
export function fitPrintedPages(pages: PageCandidates[],
                                opts: {minSupport?: number} = {}): PrintedPageFit {
    const minSupport = opts.minSupport ?? 10;
    const byPage = new Map(pages.map(p => [p.page_number, new Set(p.candidates)]));

    const support = new Map<number, number[]>();   // offset -> confirming pages
    for(const p of pages)
        for(const c of p.candidates) {
            const o = c - p.page_number;
            let l = support.get(o);
            if(!l) support.set(o, l = []);
            if(l[l.length - 1] !== p.page_number) l.push(p.page_number);
        }

    const fit: PrintedPageFit = {assigned: new Map(), runs: [], conflicts: [], unassigned: []};
    const accepted: Array<{offset: number, from: number, to: number}> = [];
    const candidates = [...support.entries()]
        .filter(([_o, l]) => l.length >= minSupport)
        .toSorted((a, b) => b[1].length - a[1].length);
    for(const [offset, confirming] of candidates) {
        const from = confirming[0], to = confirming[confirming.length - 1];
        if(accepted.some(r => from <= r.to && to >= r.from)) continue;  // overlap: weaker loses
        accepted.push({offset, from, to});
    }
    accepted.sort((a, b) => a.from - b.from);

    for(const r of accepted) {
        const run: PrintedRun = {offset: r.offset, fromPage: r.from, toPage: r.to,
                                 confirmed: 0, interpolated: 0, edgeExtended: []};
        // SECTION-OPENER EDGES: the first page of a printed section
        // classically carries no folio (the body's page 1 sits under a
        // section title - Rand's scan 13).  Extend each edge by AT MOST
        // ONE page, only onto a page that HAS text but shows no number
        // at all, only while printed stays >= 1, never into another run.
        // Reported separately - these are spot-check candidates.
        const pageInfo = new Map(pages.map(pg => [pg.page_number, pg]));
        for(const [edge, dir] of [[r.from - 1, 'from'], [r.to + 1, 'to']] as const) {
            const pg = pageInfo.get(edge);
            if(!pg || (pg.hasText ?? true) === false || pg.candidates.length > 0) continue;
            if(edge + r.offset < 1) continue;
            if(accepted.some(a => a !== r && edge >= a.from && edge <= a.to)) continue;
            if(dir === 'from') run.fromPage = edge; else run.toPage = edge;
            run.edgeExtended.push(edge);
        }
        for(let p = run.fromPage; p <= run.toPage; p++) {
            const expected = p + r.offset;
            fit.assigned.set(p, expected);
            const cands = byPage.get(p);
            if(cands?.has(expected)) run.confirmed++;
            else if(run.edgeExtended.includes(p)) { /* counted as edge-extended */ }
            else {
                run.interpolated++;
                if(cands && cands.size > 0)
                    fit.conflicts.push({page_number: p, expected, candidates: [...cands]});
            }
        }
        fit.runs.push(run);
    }
    for(const p of pages)
        if(!fit.assigned.has(p.page_number)) fit.unassigned.push(p.page_number);
    fit.unassigned.sort((a, b) => a - b);
    return fit;
}

// ---------------------------------------------------------------------------------
// --- Candidates from the OCR Text layer --------------------------------------------
// ---------------------------------------------------------------------------------

/** Integer candidates from each page's TOP BAND of Text-layer boxes (the
 *  header line region: within `bandPx` of the page's topmost box).  Pure
 *  digits after stripping trailing punctuation; prose lines never qualify,
 *  and stray numbers (plates, tables) are the fit's problem, not ours. */
export function pageCandidatesForDocument(document_id: number,
                                          opts: {bandPx?: number} = {}): PageCandidates[] {
    const bandPx = opts.bandPx ?? 160;
    const boxes = db().all<{page_number: number, y: number, text: string|null},
                           {document_id: number}>(
        block`
/**/     SELECT p.page_number AS page_number, bb.y AS y, bb.text AS text
/**/       FROM bounding_box AS bb
/**/         JOIN layer AS l ON l.layer_id = bb.layer_id
/**/         JOIN scanned_page AS p ON p.page_id = bb.page_id
/**/       WHERE p.document_id = :document_id AND
/**/             l.document_id = :document_id AND l.layer_name = 'Text'
/**/       ORDER BY p.page_number, bb.y`, {document_id});
    const byPage = new Map<number, Array<{y: number, text: string|null}>>();
    // Seed EVERY scanned page (boxless plates/blanks must appear in the
    // report's unassigned accounting, and must never extend a run).
    for(const r of db().all<{page_number: number}, {document_id: number}>(
            `SELECT page_number FROM scanned_page WHERE document_id = :document_id`,
            {document_id}))
        byPage.set(r.page_number, []);
    for(const b of boxes) {
        let l = byPage.get(b.page_number);
        if(!l) byPage.set(b.page_number, l = []);
        l.push(b);
    }
    const out: PageCandidates[] = [];
    for(const [page_number, bs] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
        if(bs.length === 0) { out.push({page_number, candidates: [], hasText: false}); continue; }
        const minY = Math.min(...bs.map(b => b.y));
        const candidates: number[] = [];
        for(const b of bs) {
            if(b.y > minY + bandPx) break;   // ordered by y
            let t = (b.text ?? '').trim().replace(/[.,:;]+$/, '');
            // Digit-OCR confusions (Clark's 'I2' for 12): decode I/l/|->1,
            // O/o->0, S->5 - but ONLY in tokens already containing a real
            // digit, so guide words ('SO', 'ALA') never become numbers.
            if(/^[0-9IlOoS|]{1,4}$/.test(t) && /\d/.test(t))
                t = t.replace(/[Il|]/g, '1').replace(/[Oo]/g, '0').replace(/S/g, '5');
            if(/^\d{1,4}$/.test(t)) {
                const n = Number(t);
                if(n >= 1 && n <= 2000 && !candidates.includes(n)) candidates.push(n);
            }
        }
        out.push({page_number, candidates});
    }
    return out;
}

// ---------------------------------------------------------------------------------
// --- Derive + apply + report --------------------------------------------------------
// ---------------------------------------------------------------------------------

export function derivePrintedPages(friendly_document_id: string,
                                   opts: {apply?: boolean} = {})
        : {fit: PrintedPageFit, report: string} {
    const doc = selectScannedDocumentByFriendlyId().required({friendly_document_id});
    const pages = pageCandidatesForDocument(doc.document_id);
    const fit = fitPrintedPages(pages);
    if(opts.apply) {
        db().transaction(() => {
            db().execute(
                `UPDATE scanned_page SET printed_page_number = NULL WHERE document_id = :d`,
                {d: doc.document_id});
            for(const [page_number, printed] of fit.assigned)
                db().execute(
                    `UPDATE scanned_page SET printed_page_number = :printed ` +
                    `WHERE document_id = :d AND page_number = :page_number`,
                    {printed, d: doc.document_id, page_number});
        });
    }
    return {fit, report: printedPagesReportMarkdown(friendly_document_id, pages.length, fit,
                                                    opts.apply ?? false)};
}

/** Compress a sorted page list to 'a-b, c, d-e' for the report. */
function ranges(pages: number[]): string {
    const out: string[] = [];
    for(let i = 0; i < pages.length; ) {
        let j = i;
        while(j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
        out.push(i === j ? `${pages[i]}` : `${pages[i]}-${pages[j]}`);
        i = j + 1;
    }
    return out.join(', ');
}

export function printedPagesReportMarkdown(book: string, pageCount: number,
                                           fit: PrintedPageFit, applied: boolean): string {
    return [
        `# Printed page numbers: ${book}${applied ? '' : ' (DRY RUN - use --apply to write)'}`,
        ``,
        `- scan pages: ${pageCount}; assigned: ${fit.assigned.size}; ` +
            `unassigned: ${fit.unassigned.length}`,
        ``,
        `## Runs (printed = scan + offset)`,
        ...fit.runs.map(r =>
            `- scan ${r.fromPage}-${r.toPage}: printed ${r.fromPage + r.offset}-` +
            `${r.toPage + r.offset} (offset ${r.offset >= 0 ? '+' : ''}${r.offset}; ` +
            `${r.confirmed} confirmed, ${r.interpolated} interpolated` +
            (r.edgeExtended.length > 0
                ? `; section-opener edge: scan ${r.edgeExtended.join(', ')}` : '') + ')'),
        ``,
        `## Conflicts (assigned by continuity; SPOT-CHECK these)`,
        ...(fit.conflicts.length === 0 ? ['- (none)'] :
            fit.conflicts.slice(0, 40).map(c =>
                `- scan page ${c.page_number}: expected ${c.expected}, ` +
                `OCR top band says ${c.candidates.join(', ')}`)),
        ...(fit.conflicts.length > 40 ? [`- ... and ${fit.conflicts.length - 40} more`] : []),
        ``,
        `## Unassigned scan pages (front matter / plates / roman)`,
        `- ${fit.unassigned.length === 0 ? '(none)' : ranges(fit.unassigned)}`,
    ].join('\n') + '\n';
}
