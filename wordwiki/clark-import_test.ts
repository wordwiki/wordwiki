/**
 * clark-import statics: the soft schema parses, and the assembly-side
 * helpers used by the import behave (header filter, divergence fold).
 * The import itself is exercised against the dev db by the CLI.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import * as model from "./model.ts";
import { CLARK_SCHEMA_JSON } from "./clark-import.ts";
import * as pt from "./page-transcribe.ts";

test("clark schema JSON parses; headword + gloss + documentReference present", () => {
    const schema = model.Schema.parseSchemaFromCompactJson('clark', CLARK_SCHEMA_JSON);
    assertEquals(schema.tag, 'clk');
    const entry = schema.relationFields[0];
    const tags = entry.descendantAndSelfRelations.map(r => r.tag).toSorted();
    assertEquals(tags, ['drv', 'ent', 'gls', 'nte', 'ref', 'spl', 'stx', 'xrf'].toSorted());
});

test("isHeaderLine: guide words, section letters and page numbers; not entries", () => {
    for(const h of ['WEN', 'A', 'ABA', '-170-', '/ 40 /', '—85—'])
        assert(pt.isHeaderLine(h), `header: ${h}`);
    for(const e of ['wep, the pith.', 'Wesek,. Gibraltar, N. S.', 'ship.',
                    'weskijenooe, I am born.'])
        assert(!pt.isHeaderLine(e), `not header: ${e}`);
});

test("diacriticFold: markup/space-insensitive, diacritics preserved", () => {
    assertEquals(pt.diacriticFold('*wenjootēam*, an ox'),
                 pt.diacriticFold('wenjootēam, an  ox'));
    assert(pt.diacriticFold('wenjootēam') !== pt.diacriticFold('wenjootĕam'),
           'macron vs breve stays distinct');
    assertEquals(pt.diacriticFold('pi[l|i]ei'), pt.diacriticFold('pilei'));
});
