// deno-lint-ignore-file no-explicit-any
/**
 * The TAG vocabulary table (tag.ts): edit through the real dispatch path
 * (routeterp strict, as an admin actor), the create dialog (was missing -
 * the 'New tag…' menu 404'd), and the detail page's matching-lexemes.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, as, invoke, renderRoute, TestTimeline,
         mkEntry, mkChild, bornApprove, type Fixture } from "./testing.ts";
import { renderToStringViaLinkeDOM } from '../liminal/markup.ts';

// A tag row + a word carrying it (a todo tag with a value + assignee).
function seed(fx: Fixture): void {
    as(fx, 'system', () =>
        fx.ww.tags.insert({slug: 'Todo', name: 'Todo', is_todo: 1, retired: 0}));
    const tl = new TestTimeline();
    const a = mkEntry(1000, tl.next());
    fx.ww.applyTransaction([a], {quiet: true});
    fx.ww.applyTransaction([mkChild(a, 'spl', 1010, tl.next(),
        {attr1: 'samqwan', variant: 'mm-li', order_key: '0.5'})], {quiet: true});
    fx.ww.applyTransaction([mkChild(a, 'tdo', 1020, tl.next(),
        {attr1: 'Todo', attr2: 'check spelling', attr3: 'djz', attr4: 0,
         variant: 'mm', order_key: '0.5'})], {quiet: true});
    bornApprove(fx.ww);
}

test("tag: the New tag… create dialog is a reachable route (was missing)", async () => {
    await withTestDb(async (fx: Fixture) => {
        const md = await as(fx, 'djz', () =>
            renderRoute(fx.ww, `wordwiki.tags.newDialog()`));
        assert(Array.isArray(md), 'newDialog returns a form');
        assertStringIncludes(renderToStringViaLinkeDOM(md), 'Save');
    });
});

test("tag: editing a tag through dispatch (as admin) saves the change", async () => {
    await withTestDb(async (fx: Fixture) => {
        seed(fx);
        const id = fx.ww.tags.bySlug.first({slug: 'Todo'})!.tag_id;
        const r: any = await as(fx, 'djz', () => invoke(fx.ww,
            `wordwiki.tags.saveForm($arg0)`,
            {tag_id: String(id), name: 'To Do', 'before-name': 'Todo',
             is_todo: 'on', 'before-is_todo': 'on'}));
        assertEquals(r.action, 'reload');
        assertEquals(fx.ww.tags.getById(id).name, 'To Do');
    });
});

test("tag detail: lists matching lexemes with the tag's value/assignee", async () => {
    await withTestDb(async (fx: Fixture) => {
        seed(fx);
        const id = fx.ww.tags.bySlug.first({slug: 'Todo'})!.tag_id;
        const html = renderToStringViaLinkeDOM(
            await as(fx, 'djz', () => renderRoute(fx.ww, `wordwiki.tags.renderDetail(${id})`)));
        assertStringIncludes(html, 'Entries (1)');
        assertStringIncludes(html, 'samqwan');
        assertStringIncludes(html, 'check spelling');   // the tag's value
        assertStringIncludes(html, 'wordwiki.wordView(1000)');
    });
});
