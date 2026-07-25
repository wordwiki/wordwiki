// deno-lint-ignore-file no-explicit-any
/**
 * The SFM parser (sfm.ts, the Sfm.java port): the lexer's exact
 * semantics, the record split, the .typ hierarchy, the tree recovery
 * (incl. synthesized levels and leniency) - and the WATSON DROP as
 * permanent real-data pins (the committed watson/ files): 34,092 records,
 * ZERO problems, the header quirks exactly as analyzed.
 */
import { test } from "../liminal/testing/test.ts";
import { assertEquals, assertThrows } from "../liminal/testing/assert.ts";
import * as sfm from "./sfm.ts";

const fields = (text: string) => [...sfm.readFields(text)];

test("lexer: continuation lines, one-space separator, mid-line backslash is data", () => {
    assertEquals(fields('\\nt line one\nline two\n\\dt x'),
                 [{name: 'nt', content: 'line one\nline two'},
                  {name: 'dt', content: 'x'}]);
    // Only ONE space separates name from content.
    assertEquals(fields('\\lx  two')[0], {name: 'lx', content: ' two'});
    // A backslash NOT at line start is content, not a field.
    assertEquals(fields('\\ge a\\b c')[0], {name: 'ge', content: 'a\\b c'});
    // CRLF files behave as LF; CRs are invisible.
    assertEquals(fields('\\lx a\r\n\\ph b\r\n'),
                 [{name: 'lx', content: 'a'}, {name: 'ph', content: 'b'}]);
    // Empty content at EOF (the Java crashed here).
    assertEquals(fields('\\lx'), [{name: 'lx', content: ''}]);
});

test("records: split on the marker; shoebox blank-line behavior; header slot", () => {
    const db = sfm.readDatabase(
        '\\_sh v3.0\n\n\\lx one\n\\ge g1\n\n\\lx two\n\\ge g2\n', 'lx');
    assertEquals(db.headerRecord?.fields[0], {name: '_sh', content: 'v3.0', children: []});
    assertEquals(db.records.length, 2);
    // The blank separator line is stripped from the last field (field-level
    // strip + record-level strip = shoebox behavior).
    assertEquals(db.records[0].fields.map(f => [f.name, f.content]),
                 [['lx', 'one'], ['ge', 'g1']]);
    // A file STARTING with the record marker puts its first chunk in the
    // header slot (the Java behavior; the Watson Final files' blank
    // template records land there).
    const noHeader = sfm.readDatabase('\\lx a\n\n\\lx b\n', 'lx');
    assertEquals(noHeader.headerRecord?.fields[0].content, 'a');
    assertEquals(noHeader.records.length, 1);
});

const TOY_TYP = [
    '\\+DatabaseType Toy\n\\mkrRecord lx\n',
    '\\+mkr lx\n\\nam Lexeme\n\\lng vernacular\n',
    '\\+mkr ps\n\\mkrOverThis lx\n',
    '\\+mkr sn\n\\mkrOverThis ps\n',
    '\\+mkr ge\n\\mkrOverThis sn\n',
    '\\+mkr xv\n\\mkrOverThis sn\n',
].join('\n');

test(".typ: hierarchy + the record marker from the header", () => {
    const typ = sfm.parseTyp(TOY_TYP);
    assertEquals(typ.recordMarker, 'lx');
    assertEquals(typ.problems, []);
    assertEquals(typ.root?.tagName, 'lx');
    assertEquals(typ.nodes.get('ge')?.parent?.tagName, 'sn');
    assertEquals(typ.nodes.get('lx')?.name, 'Lexeme');
});

test("tree recovery: nesting, pop-back, and SYNTHESIZED missing levels", () => {
    const typ = sfm.parseTyp(TOY_TYP);
    // \ge directly under \lx: the ps and sn levels are synthesized empty.
    const db1 = sfm.readDatabase('\\_sh toy\n\n\\lx w\n\\ge gloss\n', 'lx');
    assertEquals(sfm.applySchema(db1, typ), []);
    const root1 = db1.records[0].root!;
    assertEquals(root1.children.map(c => c.name), ['ps']);
    assertEquals(root1.children[0].content, '');                    // synthesized
    assertEquals(root1.children[0].children[0].name, 'sn');
    assertEquals(root1.children[0].children[0].children[0],
                 {name: 'ge', content: 'gloss', node: typ.nodes.get('ge'), children: []});
    // Two senses: the second \ps pops back up to the record root.
    const db2 = sfm.readDatabase(
        '\\_sh toy\n\n\\lx w\n\\ps n\n\\ge g1\n\\xv x1\n\\ps v\n\\ge g2\n', 'lx');
    sfm.applySchema(db2, typ);
    const root2 = db2.records[0].root!;
    assertEquals(root2.children.map(c => [c.name, c.content]), [['ps', 'n'], ['ps', 'v']]);
    assertEquals(root2.children[0].children[0].children.map(c => c.name), ['ge', 'xv']);
});

test("tree recovery: lenient reports and attaches; strict throws (Java parity)", () => {
    const typ = sfm.parseTyp(TOY_TYP);
    const db = sfm.readDatabase('\\_sh toy\n\n\\lx w\n\\zz mystery\n\\ge g\n', 'lx');
    assertThrows(() => sfm.applySchema(db, typ), Error, "'\\zz'");
    const db2 = sfm.readDatabase('\\_sh toy\n\n\\lx w\n\\zz mystery\n\\ge g\n', 'lx');
    const problems = sfm.applySchema(db2, typ, {lenient: true});
    assertEquals(problems.map(p => [p.kind, p.marker]), [['unknown-marker', 'zz']]);
    const root = db2.records[0].root!;
    assertEquals(root.children.map(c => c.name), ['zz', 'ps']);   // attached to root; ge still lands
});

// --- The WATSON DROP as permanent pins (committed in watson/) ---------------

const WATSON = new URL('../watson/', import.meta.url).pathname;
const loadTyp = () => sfm.parseTyp(sfm.decodeSfmBytes(
    Deno.readFileSync(WATSON + 'MDF.typ'), 'windows-1252'));

test("watson: MDF.typ parses - 103 markers, lx root, zero problems", () => {
    const typ = loadTyp();
    assertEquals(typ.recordMarker, 'lx');       // read from \mkrRecord, not assumed
    assertEquals(typ.nodes.size, 103);
    assertEquals(typ.root?.tagName, 'lx');
    assertEquals(typ.problems, []);
});

test("watson: all three dictionaries parse with ZERO problems", () => {
    const typ = loadTyp();
    const load = (file: string) => {
        const db = sfm.readDatabase(sfm.decodeSfmBytes(
            Deno.readFileSync(WATSON + file), 'utf-8'), typ.recordMarker);
        const problems = sfm.applySchema(db, typ, {lenient: true});
        return {db, problems};
    };
    const rand = load('Rand Mig Eng Dictt 29097');
    assertEquals(rand.db.records.length, 29097);
    assertEquals(rand.problems, []);
    assertEquals(rand.db.headerRecord?.fields[0].name, '_sh');
    assertEquals(rand.db.records[0].fields[0].content, "e'n");
    // The Final pair: headerless files whose blank TEMPLATE record lands
    // in the header slot; Ng carries the \lsf lane, Lk mostly not.
    const ng = load('Ng20726');
    assertEquals(ng.db.records.length, 2498);
    assertEquals(ng.problems, []);
    assertEquals(ng.db.headerRecord?.fields[0], {name: 'lx', content: '', children: []});
    const lk = load('Lk20726');
    assertEquals(lk.db.records.length, 2497);
    assertEquals(lk.problems, []);
});
