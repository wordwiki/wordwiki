/**
 * pdm-import statics: the schema parses with the five rungs riding the
 * documentReference, and the entry-line splitter behaves.
 */
import { test } from "../liminal/testing/test.ts";
import { assertEquals } from "../liminal/testing/assert.ts";
import * as model from "../wordwiki/model.ts";
import { PDM_SCHEMA_JSON, splitEntryLine } from "./pdm-import.ts";

test("pdm schema parses; five rungs nest under the documentReference", () => {
    const schema = model.Schema.parseSchemaFromCompactJson('pdm', PDM_SCHEMA_JSON);
    const entry = schema.relationFields[0];
    const ref = entry.relationFields.find(r => r.tag === 'ref')!;
    assertEquals(ref.relationFields.map(r => r.tag).toSorted(),
                 ['rex', 'rne', 'rse', 'rtl', 'rtr']);
    assertEquals(schema.relationsByRole.documentReference?.tag, 'ref');
});

test("splitEntryLine: first comma splits word from gloss", () => {
    assertEquals(splitEntryLine("ewuljewe'jit, he/she is a poor frail one"),
                 {word: "ewuljewe'jit", gloss: 'he/she is a poor frail one'});
    assertEquals(splitEntryLine('apusqi\'gn'), {word: "apusqi'gn", gloss: ''});
});
