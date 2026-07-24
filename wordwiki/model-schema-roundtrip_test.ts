// deno-lint-ignore-file no-explicit-any
/**
 * The schema compact-JSON round trip: parse -> schemaToCompactJson -> parse
 * must preserve EVERYTHING the first parse understood - $style ($view,
 * $options, $markdown, $shape, ...), relation $prompt, variant flags - and
 * emit -> parse -> emit must be a fixed point.  This is a schema-as-data
 * prerequisite (multi-dictionary-survey.md phase 0): schemas must dump/
 * diff/migrate as data without silently shedding presentation metadata,
 * which the serializer did for years (the old "TODO add $style").
 *
 * The real MMO schema literal is the fixture: every $-feature in production
 * use is covered by construction.
 */
import { test } from "../liminal/testing/test.ts";
import { assertEquals } from "../liminal/testing/assert.ts";
import * as model from "./model.ts";
import { dictSchemaJson } from "./entry-schema.ts";

/** JSON-normalize (drops undefined-valued keys, as serialization does). */
function norm(v: any): any { return JSON.parse(JSON.stringify(v ?? null)); }

function parseDict(json: any): model.Schema {
    return model.Schema.parseSchemaFromCompactJson('roundtrip-test', json);
}

test("schema round trip: reparse preserves styles, binds and flags", () => {
    const s1 = parseDict(dictSchemaJson);
    const s2 = parseDict(s1.schemaToCompactJson());

    assertEquals(s2.name, s1.name);
    assertEquals(s2.tag, s1.tag);
    assertEquals(Object.keys(s2.relationsByTag).sort(),
                 Object.keys(s1.relationsByTag).sort());

    for(const [tag, r1] of Object.entries(s1.relationsByTag)) {
        const r2 = s2.relationsByTag[tag];
        assertEquals(r2.name, r1.name, `relation ${tag} name`);
        assertEquals(norm(r2.style), norm(r1.style), `relation ${tag} style`);
        assertEquals(r2.scalarFields.map(f => f.name),
                     r1.scalarFields.map(f => f.name), `relation ${tag} fields`);
        for(const f1 of r1.scalarFields) {
            const f2 = r2.fieldsByName[f1.name] as model.ScalarField;
            const at = `${tag}.${f1.name}`;
            assertEquals(f2.constructor.name, f1.constructor.name, `${at} type`);
            assertEquals(f2.bind, f1.bind, `${at} bind`);
            assertEquals(f2.optional, f1.optional, `${at} optional`);
            assertEquals(norm(f2.style), norm(f1.style), `${at} style`);
            if(f1 instanceof model.VariantField)
                assertEquals((f2 as model.VariantField).variantFlags,
                             f1.variantFlags, `${at} variant flags`);
        }
    }
});

test("schema round trip: emit -> parse -> emit is a fixed point", () => {
    const j1 = parseDict(dictSchemaJson).schemaToCompactJson();
    const j2 = parseDict(j1).schemaToCompactJson();
    assertEquals(j2, j1);
});

test("schema round trip: known $-metadata survives (spot checks)", () => {
    const s2 = parseDict(parseDict(dictSchemaJson).schemaToCompactJson());
    const byTag = s2.relationsByTag;

    // $view.bornApproved (the history-fold flag) on the log relation
    assertEquals(byTag['log'].style.$view?.bornApproved, true);
    // $markdown + $width on the tag value field
    const tagValue = byTag['tdo'].fieldsByName['value'] as model.ScalarField;
    assertEquals(tagValue.style.$markdown, true);
    assertEquals(tagValue.style.$width, 60);
    // $options rides through on an enum ($style is where options live)
    const status = byTag['sta'].fieldsByName['status'] as model.ScalarField;
    assertEquals(typeof (status.style as any).$options, 'object');
    // $shape boundingGroup on the document reference group id
    const refFields = byTag['ref'];
    const groupField = refFields.scalarFields.find(
        f => f.style.$shape === 'boundingGroup');
    assertEquals(groupField !== undefined, true);
});
