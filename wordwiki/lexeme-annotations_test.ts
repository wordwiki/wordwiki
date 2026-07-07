// deno-lint-ignore-file no-explicit-any
/**
 * Per-tuple annotations (fix-orthographies.md "Per-tuple annotations"): the
 * public `aside` + the internal `note`, through the whole loop — edit-dialog
 * disclosure inputs, saveTuple persistence (annotation-only edits are real
 * edits), display next to the value (aside everywhere, internal note only to
 * the internal audience), the $aside JSON projection, and the distinct
 * annotation chips in the was-diff.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import { hasText } from "../liminal/testing/markup-assert.ts";
import { markupToString } from "../liminal/markup.ts";
import { withTestDb, as, renderRoute, invoke,
         TestTimeline, mkEntry, mkChild, type Fixture } from './testing.ts';
import { WordWiki } from './wordwiki.ts';
import { Assertion } from './assertion.ts';

// Entry 1000 with spelling 1001 (as in assertion_model_test.ts).
function seedEntry(ww: WordWiki): void {
    const tl = new TestTimeline();
    const entry = mkEntry(1000, tl.next());
    const spelling = mkChild(entry, 'spl', 1001, tl.next(),
                             {attr1: 'cat', variant: 'mm-li', order_key: '0.5'});
    ww.applyTransaction([entry]);
    ww.applyTransaction([spelling]);
}

function currentOf(ww: WordWiki, fact_id: number): Assertion {
    return ww.workspace.getTableByTag('dct').findRequiredVersionedTupleById(fact_id)
        .currentAssertion ?? (() => { throw new Error(`no current version of ${fact_id}`); })();
}

test("annotations: the edit dialog carries the disclosure inputs", async () => {
    await withTestDb(async (fx) => {
        seedEntry(fx.ww);
        const dialog = await as(fx, 'djz', () =>
            renderRoute(fx.ww, 'wordwiki.lexeme.editDialog(1000, 1001)'));
        const html = markupToString(dialog);
        assert(html.includes('name=fact_aside'), 'aside input present');
        assert(html.includes('name=fact_note'), 'internal-note input present');
        assert(html.includes('never published'), 'internal-note help text present');
    });
});

test("annotations: an annotation-only edit is a real edit; values persist and carry forward", async () => {
    await withTestDb(async (fx) => {
        seedEntry(fx.ww);
        // Annotation-only save: no field changes, just an aside + a note.
        const r = await as(fx, 'djz', () => invoke(fx.ww, 'wordwiki.lexeme.saveTuple($arg0)', {
            entry_id: '1000', fact_id: '1001', replaces_assertion_id: '1001',
            'before-text': 'cat', text: 'cat', 'before-variant': 'mm-li', variant: 'mm-li',
            fact_aside: '(Cape Breton)', fact_note: 'checked with elder',
        }));
        assertEquals(r.action, 'reload');   // not the silent no-change path
        const v1 = currentOf(fx.ww, 1001);
        assertEquals(v1.aside, '(Cape Breton)');
        assertEquals(v1.note, 'checked with elder');
        assertEquals(v1.attr1, 'cat');

        // A subsequent VALUE edit carries the annotations forward untouched.
        const r2 = await as(fx, 'djz', () => invoke(fx.ww, 'wordwiki.lexeme.saveTuple($arg0)', {
            entry_id: '1000', fact_id: '1001', replaces_assertion_id: String(v1.assertion_id),
            'before-text': 'cat', text: 'caat', 'before-variant': 'mm-li', variant: 'mm-li',
            fact_aside: '(Cape Breton)', fact_note: 'checked with elder',
        }));
        assertEquals(r2.action, 'reload');
        const v2 = currentOf(fx.ww, 1001);
        assertEquals(v2.attr1, 'caat');
        assertEquals(v2.aside, '(Cape Breton)');

        // Clearing the aside REMOVES it.
        await as(fx, 'djz', () => invoke(fx.ww, 'wordwiki.lexeme.saveTuple($arg0)', {
            entry_id: '1000', fact_id: '1001', replaces_assertion_id: String(v2.assertion_id),
            'before-text': 'caat', text: 'caat', 'before-variant': 'mm-li', variant: 'mm-li',
            fact_aside: '', fact_note: 'checked with elder',
        }));
        assertEquals(currentOf(fx.ww, 1001).aside ?? null, null);

        // An identical resubmit (values AND annotations unchanged) is the
        // no-change path: no new version.
        const before = currentOf(fx.ww, 1001).assertion_id;
        await as(fx, 'djz', () => invoke(fx.ww, 'wordwiki.lexeme.saveTuple($arg0)', {
            entry_id: '1000', fact_id: '1001', replaces_assertion_id: String(before),
            'before-text': 'caat', text: 'caat', 'before-variant': 'mm-li', variant: 'mm-li',
            fact_aside: '', fact_note: 'checked with elder',
        }));
        assertEquals(currentOf(fx.ww, 1001).assertion_id, before);
    });
});

test("annotations: aside shows in the editor; internal note is internal-audience only", async () => {
    await withTestDb(async (fx) => {
        seedEntry(fx.ww);
        await as(fx, 'djz', () => invoke(fx.ww, 'wordwiki.lexeme.saveTuple($arg0)', {
            entry_id: '1000', fact_id: '1001', replaces_assertion_id: '1001',
            'before-text': 'cat', text: 'cat', 'before-variant': 'mm-li', variant: 'mm-li',
            fact_aside: '(Cape Breton)', fact_note: 'INTERNAL-ONLY-TEXT',
        }));
        // The meta EDITOR (internal audience) shows both.
        const editor = await as(fx, 'djz', () =>
            renderRoute(fx.ww, 'wordwiki.lexeme.metaEditPage(1000)'));
        assert(hasText(editor, '(Cape Breton)'), 'aside in editor');
        assert(hasText(editor, 'INTERNAL-ONLY-TEXT'), 'internal note in editor');

        // The projected JSON carries $aside (the public renderer's source)
        // and NOT the internal note.
        const json = JSON.stringify(fx.ww.entries.find((e: any) => e.entry_id === 1000));
        assert(json.includes('(Cape Breton)'), 'aside projected');
        assert(!json.includes('INTERNAL-ONLY-TEXT'), 'internal note NOT projected');
    });
});
