// deno-lint-ignore-file no-explicit-any
/**
 * The STRICT $style/$view validator (schema parse time).  Before this, only
 * $prompt/$style were checked and the result discarded - a typo'd $view key
 * (bornAproved) silently did nothing.  With per-dictionary schemas becoming
 * DATA files (multi-dictionary-survey.md), a bad key must be a parse error
 * with a locus, caught at load rather than surfacing as a mutely-missing
 * behavior.
 */
import { test } from "../liminal/testing/test.ts";
import { assertEquals, assertThrows } from "../liminal/testing/assert.ts";
import * as model from "./model.ts";

function parseRelation(relationJson: any): model.RelationField {
    return model.RelationField.parseSchemaFromCompactJson('test', 'rel', relationJson);
}

function relation(extra: any): any {
    return {
        $type: 'relation', $tag: 'tst',
        test_id: {$type: 'primary_key'},
        text: {$type: 'string', $bind: 'attr1'},
        ...extra,
    };
}

test("a typo'd $view key is a parse error", () => {
    assertThrows(
        () => parseRelation(relation({$style: {$view: {bornAproved: true}}})),
        Error, "unknown $view key 'bornAproved'");
});

test("an unknown $style key is a parse error", () => {
    assertThrows(
        () => parseRelation(relation({$style: {$wdith: 60}})),
        Error, "unknown $style key '$wdith'");
});

test("a wrong-typed $view value is a parse error", () => {
    assertThrows(
        () => parseRelation(relation({$style: {$view: {label: 'bold'}}})),
        Error, "must be one of 'heading', 'inline', 'none'");
    assertThrows(
        () => parseRelation(relation({$style: {$view: {hidden: 'yes'}}})),
        Error, "must be a boolean");
    assertThrows(
        () => parseRelation(relation({$style: {$view: {wrap: ['(']}}})),
        Error, "must be a [prefix, suffix] pair");
});

test("scalar-field styles are validated too (with the field in the locus)", () => {
    assertThrows(
        () => parseRelation(relation({
            text2: {$type: 'string', $bind: 'attr2', $style: {$view: {orderr: 1}}}})),
        Error, "unknown $view key 'orderr'");
});

test("$view.compose naming an unknown field is a parse error", () => {
    assertThrows(
        () => parseRelation(relation({$style: {$view: {compose: ['text', 'no_such']}}})),
        Error, "compose names unknown field 'no_such'");
    // a valid compose parses
    const r = parseRelation(relation({$style: {$view: {compose: ['text']}}}));
    assertEquals(r.style.$view?.compose, ['text']);
});

test("$view.keyField naming an unknown field is a parse error", () => {
    assertThrows(
        () => parseRelation(relation({$style: {$view: {keyField: 'no_such'}}})),
        Error, "keyField names unknown field 'no_such'");
});

test("a fully-loaded valid style parses and lands on the field", () => {
    const r = parseRelation(relation({
        $prompt: 'Tests',
        $style: {$view: {label: 'heading', order: 2, numbered: true,
                         emphasis: 'italic', wrap: ['(', ')'], sep: ' — '}},
        kind: {$type: 'enum', $bind: 'attr2',
               $style: {$options: {a: 'Aaa', b: 'Bbb'}, $width: 40}},
        body: {$type: 'string', $bind: 'attr3',
               $style: {$markdown: true, $height: 3}},
    }));
    assertEquals(r.prompt, 'Tests');
    assertEquals(r.style.$view?.wrap, ['(', ')']);
    const kind = r.modelFields.find(f => f.name === 'kind')!;
    assertEquals(kind.style.$options?.a, 'Aaa');
    const body = r.modelFields.find(f => f.name === 'body')!;
    assertEquals(body.style.$markdown, true);
});

test("$options with non-string labels is a parse error", () => {
    assertThrows(
        () => parseRelation(relation({
            kind: {$type: 'enum', $bind: 'attr2', $style: {$options: {a: 1}}}})),
        Error, "must be a {code: label} string map");
});
