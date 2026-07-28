/**
 * page-transcribe mechanical helpers: column split, banding, hanging-indent
 * entry starts, headword extraction, the comparison fold.  (The LLM stages
 * are exercised by the survey CLI, not unit tests.)
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import * as pt from "./page-transcribe.ts";

const line = (x: number, y: number, text = '', w = 900, h = 60): pt.PageLine =>
    ({x, y, w, h, text});

test("splitColumns: by line center; wide header lands by its center", () => {
    const a = line(170, 300), b = line(1300, 300), header = line(1100, 100, '', 300);
    const {left, right} = pt.splitColumns([header, a, b], 2474);
    assertEquals(left, [a]);
    assertEquals(right, [header, b]);   // header center 1250 >= 1237
});

test("bandColumn: chunks of maxLines; crop rect covers the chunk + margin", () => {
    const lines = Array.from({length: 20}, (_, i) => line(170, 300 + i * 74));
    const bands = pt.bandColumn(lines, 2474, 3954, 16);
    assertEquals(bands.map(b => b.lines.length), [16, 4]);
    const b0 = bands[0];
    assert(b0.x <= 170 && b0.y <= 300, 'margin extends beyond first line');
    assert(b0.y + b0.h >= lines[15].y + lines[15].h, 'covers last chunk line');
});

test("bandColumn + entryStarts: a gutter-crossing stray does not drag the column shape", () => {
    // Right column at x~1300; one textract box merged across the gutter
    // starts at x=400.  It must not widen the crop or move the left edge.
    const lines = [line(1300, 100), line(400, 174, '', 1800), line(1305, 248),
                   line(1302, 322), line(1370, 396), line(1298, 470)];
    const [band] = pt.bandColumn(lines, 2474, 3954, 16);
    assert(band.x > 1200, `crop stays in-column (x=${band.x})`);
    assertEquals(pt.entryStarts(lines, 2474),
                 [true, true, true, true, false, true]);   // stray x<edge still flags; indented 1370 does not
});

test("alignFolded: dropped header and extra line pair correctly around matches", () => {
    const t = ['wes', 'wenmajodeadversity', 'wenmajogunanguish'];
    const l = ['wenmajodeadversity', 'wenmajogunanguish'];
    assertEquals(pt.alignFolded(t, l),
                 [{t: 0}, {t: 1, l: 0}, {t: 2, l: 1}]);
    assertEquals(pt.alignFolded(l, t),
                 [{l: 0}, {t: 0, l: 1}, {t: 1, l: 2}]);
    // Near-miss still aligns as a substitution, not two gaps.
    assertEquals(pt.alignFolded(['wenjoetagiboxstrik'], ['wenjootagaiboxstrike']),
                 [{t: 0, l: 0}]);
});

test("entryStarts: hanging indent - left-edge lines start, indented continue", () => {
    const lines = [line(172, 100), line(240, 174),    // start + continuation
                   line(168, 248), line(170, 322)];   // two starts
    assertEquals(pt.entryStarts(lines, 2474), [true, false, true, true]);
});

test("headwordOf: italic span to first comma; ambiguity resolved; markup stripped", () => {
    assertEquals(pt.headwordOf('*wenjāwe*, I lead.'), 'wenjāwe');
    assertEquals(pt.headwordOf('*wen[j|y]ooe*, a prefix'), 'wenjooe');
    assertEquals(pt.headwordOf('WEN'), 'WEN');
});

test("fold: diacritics, markup and ambiguity collapse for comparison", () => {
    assertEquals(pt.fold('*wenjāwe*, I lead.'), pt.fold('wenjawe, I lead'));
    assertEquals(pt.fold('wĕskōdŭm'), 'weskodum');
    assertEquals(pt.fold('pi[l|i]ei ⁇'), 'pilei');
});
