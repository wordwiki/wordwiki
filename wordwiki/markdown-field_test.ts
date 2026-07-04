// deno-lint-ignore-file no-explicit-any
/**
 * The $markdown soft-schema style (model.ts Style): a string field marked
 * $markdown renders its value through liminal/markdown.ts on the editor's
 * display surfaces (renderFieldValue drives the edit surface, the review
 * diff, and the history grid), and its dialog widget is a textarea.
 */
import { test } from "../liminal/testing/test.ts";
import { assertEquals, assertStringIncludes } from "../liminal/testing/assert.ts";
import { renderFieldValue } from "./lexeme-editor.ts";
import * as model from "./model.ts";
import * as entrySchema from "./entry-schema.ts";
import { markupToString } from "../liminal/markup.ts";

const md = new model.StringField('notes', 'attr1', true, undefined, {$markdown: true});
const plain = new model.StringField('notes', 'attr1', true);

test("$markdown string field renders its value as markdown", () => {
    const html = markupToString(renderFieldValue(md, 'a **bold** [link](https://x.example)')!);
    assertStringIncludes(html, '<strong>');
    assertStringIncludes(html, "href='https://x.example'");
    assertStringIncludes(html, 'lm-markdown');
    // A hostile scheme never becomes a link (markdown.ts's allowlist).
    const evil = markupToString(renderFieldValue(md, '[x](javascript:alert(1))')!);
    assertEquals(evil.includes('javascript:'), false);
});

test("a plain string field is untouched: markdown source renders literally", () => {
    const html = markupToString(renderFieldValue(plain, 'a **bold** move')!);
    assertStringIncludes(html, 'a **bold** move');
    assertEquals(html.includes('<strong>'), false);
});

test("the real schema's note fields carry $markdown and render as markdown", () => {
    const dict = model.Schema.parseSchemaFromCompactJson('dict', entrySchema.dictSchemaJson);
    // Walk to the three fields dz marked: entry note, ref note, ref public_note.
    const fieldsByPath: Record<string, model.ScalarField> = {};
    const walk = (rel: any, path: string) => {
        for(const f of rel.scalarFields ?? []) fieldsByPath[`${path}.${f.name}`] = f;
        for(const r of rel.relationFields ?? []) walk(r, `${path}.${r.name}`);
    };
    walk(dict.relationFields[0], 'entry');
    for(const p of ['entry.note.note',
                    'entry.subentry.document_reference.note.note',
                    'entry.subentry.document_reference.public_note.public_note']) {
        const f = fieldsByPath[p];
        if(!f) throw new Error(`schema field not found for ${p}`);
        assertEquals((f.style as any).$markdown, true, `${p} should be $markdown`);
        const html = markupToString(renderFieldValue(f, 'a **bold** note')!);
        assertStringIncludes(html, '<strong>bold</strong>');
    }
});
