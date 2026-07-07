// deno-lint-ignore-file no-explicit-any
/**
 * The variant orthography flags ($notVariant/$mixed/$allowAll/$defaultAll/
 * $metaVariant — fix-orthographies.md "The target model") and the
 * variant-fields-are-leaves parse rule.
 */
import { test } from "../liminal/testing/test.ts";
import { assertEquals, assertThrows } from "../liminal/testing/assert.ts";
import * as model from "./model.ts";

function parseRelation(relationJson: any): model.RelationField {
    return model.RelationField.parseSchemaFromCompactJson('test', 'rel', relationJson);
}

function leafRelation(variantJson: any): any {
    return {
        $type: 'relation', $tag: 'tst',
        test_id: {$type: 'primary_key'},
        text: {$type: 'string', $bind: 'attr1'},
        variant: variantJson,
    };
}

function variantFieldOf(rel: model.RelationField): model.VariantField {
    // (modelFields: `fields` is only populated by resolve(), which these
    // parse-level tests don't need)
    const f = rel.modelFields.find(f => f instanceof model.VariantField);
    if(!f) throw new Error('no variant field');
    return f as model.VariantField;
}

test("variant with no flags parses with all flags false", () => {
    const v = variantFieldOf(parseRelation(leafRelation({$type: 'variant'})));
    assertEquals(v.variantFlags, {
        notVariant: false, mixed: false, allowAll: false, defaultAll: false, metaVariant: false });
});

test("all five flags parse onto variantFlags", () => {
    const v1 = variantFieldOf(parseRelation(leafRelation(
        {$type: 'variant', $notVariant: true})));
    assertEquals(v1.variantFlags.notVariant, true);

    const v2 = variantFieldOf(parseRelation(leafRelation(
        {$type: 'variant', $mixed: true, $allowAll: true, $defaultAll: true})));
    assertEquals(v2.variantFlags,
        { notVariant: false, mixed: true, allowAll: true, defaultAll: true, metaVariant: false });

    const v3 = variantFieldOf(parseRelation(leafRelation(
        {$type: 'variant', $metaVariant: true, $allowAll: true, $defaultAll: true})));
    assertEquals(v3.variantFlags,
        { notVariant: false, mixed: false, allowAll: true, defaultAll: true, metaVariant: true });
});

test("flags round-trip through schemaToCompactJson", () => {
    const src = leafRelation({$type: 'variant', $mixed: true, $allowAll: true, $defaultAll: true});
    const rel = parseRelation(src);
    rel.resolve();   // schemaToCompactJson serializes the resolved `fields`
    const dumped = rel.schemaToCompactJson();
    assertEquals(dumped.variant.$mixed, true);
    assertEquals(dumped.variant.$allowAll, true);
    assertEquals(dumped.variant.$defaultAll, true);
    assertEquals(dumped.variant.$notVariant, undefined);
    assertEquals(dumped.variant.$metaVariant, undefined);
    // And the dump reparses to the same flags.
    const reparsed = variantFieldOf(parseRelation(dumped));
    assertEquals(reparsed.variantFlags,
        { notVariant: false, mixed: true, allowAll: true, defaultAll: true, metaVariant: false });
});

test("$notVariant is exclusive of the other flags", () => {
    assertThrows(() => parseRelation(leafRelation(
        {$type: 'variant', $notVariant: true, $mixed: true})),
        model.ValidationError, 'cannot be combined');
});

test("$defaultAll requires $allowAll", () => {
    assertThrows(() => parseRelation(leafRelation(
        {$type: 'variant', $defaultAll: true})),
        model.ValidationError, 'requires $allowAll');
});

test("unknown $ properties on a variant node are still rejected", () => {
    assertThrows(() => parseRelation(leafRelation(
        {$type: 'variant', $bogus: true})),
        model.ValidationError, 'Unexpected properties');
});

test("a relation with a variant field may not have child relations", () => {
    const interiorVariant = {
        $type: 'relation', $tag: 'par',
        parent_id: {$type: 'primary_key'},
        variant: {$type: 'variant'},
        child: {
            $type: 'relation', $tag: 'chl',
            child_id: {$type: 'primary_key'},
            text: {$type: 'string', $bind: 'attr1'},
        },
    };
    assertThrows(() => parseRelation(interiorVariant),
        model.ValidationError, 'leaf relations');
    // The same shape without the variant is fine.
    const { variant: _, ...noVariant } = interiorVariant as any;
    parseRelation(noVariant);
});
