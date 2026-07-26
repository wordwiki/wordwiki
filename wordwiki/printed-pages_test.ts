/**
 * The printed-page sequence fit (printed-pages.ts): runs of constant
 * printed-minus-scan offset, interior interpolation, conflict reporting,
 * noise rejection, and multi-run/overlap behavior.
 */
import { test } from "../liminal/testing/test.ts";
import { assertEquals } from "../liminal/testing/assert.ts";
import { fitPrintedPages, type PageCandidates } from "./printed-pages.ts";

const p = (page_number: number, ...candidates: number[]): PageCandidates =>
    ({page_number, candidates});

test("printed-page fit: one body run - offset, interpolation, conflicts, noise", () => {
    const pages: PageCandidates[] = [
        // Front matter: no headers / roman (no arabic candidates).
        p(1), p(2), p(3),
        // The body: printed = scan - 2 (offset -2), confirmed on most pages.
        p(4, 2), p(5, 3), p(6, 4),
        p(7),                    // header OCR missed -> interpolated
        p(8, 6), p(9, 99),       // 99 = OCR garble -> conflict, continuity wins
        p(10, 8), p(11, 9), p(12, 10), p(13, 11), p(14, 12), p(15, 13),
        // A plate at the end: stray table numbers, no consistent offset.
        p(16, 3, 7, 12),
    ];
    const fit = fitPrintedPages(pages, {minSupport: 5});
    assertEquals(fit.runs.length, 1);
    const run = fit.runs[0];
    // The SECTION-OPENER edge: page 3 (text, no folio, printed 1) joins.
    assertEquals([run.offset, run.fromPage, run.toPage], [-2, 3, 15]);
    assertEquals(run.edgeExtended, [3]);
    assertEquals(fit.assigned.get(3), 1);
    assertEquals(run.confirmed, 10);
    assertEquals(run.interpolated, 2);                   // pages 7 and 9
    assertEquals(fit.assigned.get(7), 5);                // carried by continuity
    assertEquals(fit.assigned.get(9), 7);
    assertEquals(fit.conflicts.map(c => [c.page_number, c.expected]), [[9, 7]]);
    assertEquals(fit.unassigned, [1, 2, 16]);            // outside the run
    assertEquals(fit.assigned.has(16), false);           // plate noise: candidates
                                                         // present -> no edge join
});

test("printed-page fit: boxless neighbors never extend a run", () => {
    const pages: PageCandidates[] = [
        p(1, 11), p(2, 12), p(3, 13), p(4, 14), p(5, 15), p(6, 16),
        {page_number: 7, candidates: [], hasText: false},   // a blank/plate
    ];
    const fit = fitPrintedPages(pages, {minSupport: 5});
    assertEquals(fit.runs.map(r => [r.offset, r.fromPage, r.toPage]), [[10, 1, 6]]);
    assertEquals(fit.unassigned, [7]);
});

test("printed-page fit: two disjoint runs keep their own offsets; overlap loses", () => {
    const pages: PageCandidates[] = [
        // Section A: offset 0 on pages 1-6.
        p(1, 1), p(2, 2), p(3, 3), p(4, 4), p(5, 5), p(6, 6),
        // Section B: restarts numbering - offset -6 on pages 7-12.
        p(7, 1), p(8, 2), p(9, 3), p(10, 4), p(11, 5), p(12, 6),
    ];
    const fit = fitPrintedPages(pages, {minSupport: 5});
    assertEquals(fit.runs.map(r => [r.offset, r.fromPage, r.toPage]),
                 [[0, 1, 6], [-6, 7, 12]]);
    assertEquals(fit.assigned.get(6), 6);
    assertEquals(fit.assigned.get(7), 1);
    assertEquals(fit.unassigned, []);

    // A weaker offset whose span OVERLAPS a stronger run is dropped whole
    // (a page belongs to one numbering).
    const noisy: PageCandidates[] = [
        p(1, 1, 11), p(2, 2, 12), p(3, 3, 13), p(4, 4, 14), p(5, 5, 15),
        p(6, 6), p(7, 7), p(8, 8),
    ];
    const fit2 = fitPrintedPages(noisy, {minSupport: 5});
    assertEquals(fit2.runs.map(r => r.offset), [0]);     // +10 (support 5) lost the overlap
    assertEquals(fit2.assigned.get(3), 3);
});
