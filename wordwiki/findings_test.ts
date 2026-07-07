/**
 * The findings-report machinery (findings.ts): console echo + accumulation,
 * markdown serialization with the point-in-time banner, counts, links.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertStringIncludes } from "../liminal/testing/assert.ts";
import { FindingsReport } from "./findings.ts";

function sampleReport(lexemeBase = ''): FindingsReport {
    const report = new FindingsReport('Variant (orthography) scan', {
        quiet: true,
        sourceDb: 'database/db.db [db_purpose: dev]',
        generatedAt: new Date('2026-07-07T12:00:00Z'),
        links: { lexemeBase },
    });
    const gate = report.section('Drop gate');
    gate.info('checked 7 tags');
    gate.finding(`GATE: 'rec' holds 'zzz' ×1 — e.g. ${report.lexemeLink(123, "samqwan")}`);
    gate.table(['tag', 'blank', 'other'], [['rec', 20757, 'mm ×1'], ['prn', 13, '—']]);
    report.section('Blanks');   // deliberately finding-free
    return report;
}

test("findings counts: findings are counted, info and tables are not", () => {
    const report = sampleReport();
    assertEquals(report.findingCount, 1);
    assertEquals(report.sections.length, 2);
    assertEquals(report.sections[0].findingCount, 1);
    assertEquals(report.sections[1].findingCount, 0);
});

test("markdown report: banner, summary, sections, findings bold, tables", () => {
    const md = sampleReport().toMarkdown();
    // The prominent point-in-time banner with stamp + source db.
    assertStringIncludes(md, '2026-07-07T12:00:00.000Z');
    assertStringIncludes(md, 'database/db.db [db_purpose: dev]');
    assertStringIncludes(md, 'not a live view');
    // Per-section summary.
    assertStringIncludes(md, '**1 finding(s)** across 2 section(s)');
    assertStringIncludes(md, '- Drop gate: 1 finding(s)');
    // Sections + content.
    assertStringIncludes(md, '## Drop gate');
    assertStringIncludes(md, "- **GATE: 'rec' holds 'zzz'");
    assertStringIncludes(md, '| tag | blank | other |');
    assertStringIncludes(md, '| rec | 20757 | mm ×1 |');
});

test("lexemeLink renders against the configured base", () => {
    assertEquals(sampleReport().lexemeLink(123, 'samqwan'),
                 '[samqwan](/ww/wordwiki.entry(123))');
    assertEquals(sampleReport('https://mikwite.ca').lexemeLink(123, 'samqwan'),
                 '[samqwan](https://mikwite.ca/ww/wordwiki.entry(123))');
});

test("table cells escape pipes and newlines", () => {
    const report = new FindingsReport('t', {quiet: true});
    report.section('s').table(['a'], [['x|y\nz']]);
    const md = report.toMarkdown();
    assertStringIncludes(md, '| x\\|y z |');
    assert(!md.includes('| x|y'));
});
