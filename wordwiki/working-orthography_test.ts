// deno-lint-ignore-file no-explicit-any
/**
 * Working orthography (fix-orthographies.md): the user record's
 * primary_orthography defaults the variant of NEW content in the insert
 * dialog; unset applies no default.
 */
import { test } from "../liminal/testing/test.ts";
import { assert } from "../liminal/testing/assert.ts";
import { markupToString } from "../liminal/markup.ts";
import { withTestDb, as, renderRoute, TestTimeline, mkEntry, mkChild, bornApprove } from './testing.ts';
import * as security from '../liminal/security.ts';

test("insert dialog: variant defaults from the user's primary_orthography", async () => {
    await withTestDb(async (fx) => {
        const tl = new TestTimeline();
        fx.ww.applyTransaction([mkEntry(1000, tl.next())]);

        // djz has no primary_orthography: the variant select has NO default.
        const before = markupToString(await as(fx, 'djz', () =>
            renderRoute(fx.ww, `wordwiki.lexeme.insertDialog(1000, 1000, 'spl')`)));
        assert(!/value=.?mm-\w+.? selected/.test(before), 'no default when unset');

        security.runSystem(() =>
            fx.ww.users.updateNamedFields(fx.userIds['djz'],
                ['primary_orthography'], {primary_orthography: 'mm-sf'} as any));

        const after = markupToString(await as(fx, 'djz', () =>
            renderRoute(fx.ww, `wordwiki.lexeme.insertDialog(1000, 1000, 'spl')`)));
        assert(/value=.?mm-sf.? selected/.test(after),
               'new spelling defaults to the editor\'s working orthography');
    });
});

test("categoriesDirectory follows the editor's working orthography", async () => {
    await withTestDb(async (fx) => {
        // A categorized public entry, seeded old-shape (Completed) and
        // blessed like the V1 cutover - so its pub gate lands in mm-li, the
        // public site's orthography.
        const tl = new TestTimeline();
        const e = mkEntry(1000, tl.next());
        fx.ww.applyTransaction([e], {quiet: true});
        fx.ww.applyTransaction([mkChild(e, 'spl', 1010, tl.next(),
            {attr1: 'samqwan', variant: 'mm-li', order_key: '0.5'})], {quiet: true});
        fx.ww.applyTransaction([mkChild(e, 'sta', 1020, tl.next(),
            {attr1: 'Completed', order_key: '0.5'})], {quiet: true});
        const s = mkChild(e, 'sub', 1100, tl.next(), {order_key: '0.5'});
        fx.ww.applyTransaction([s], {quiet: true});
        fx.ww.applyTransaction([mkChild(s, 'cat', 1200, tl.next(),
            {attr1: 'water', order_key: '0.5'})], {quiet: true});
        bornApprove(fx.ww);

        // No primary_orthography: the report falls back to the public
        // site's view and counts the mm-li-public entry.
        const li = markupToString(await as(fx, 'djz', () =>
            renderRoute(fx.ww, 'wordwiki.editorReports.categoriesDirectory()')));
        assert(li.includes('water'), 'mm-li public entry counted in the default view');

        const liCat = markupToString(await as(fx, 'djz', () =>
            renderRoute(fx.ww, 'wordwiki.editorReports.entriesForCategory("water")')));
        assert(liCat.includes('samqwan'), 'entry listed under its category');

        // An mm-sf editor sees the mm-sf view - nothing is public there
        // yet, and the page says which orthography it is showing.
        security.runSystem(() =>
            fx.ww.users.updateNamedFields(fx.userIds['djz'],
                ['primary_orthography'], {primary_orthography: 'mm-sf'} as any));
        const sf = markupToString(await as(fx, 'djz', () =>
            renderRoute(fx.ww, 'wordwiki.editorReports.categoriesDirectory()')));
        assert(!sf.includes('water'), 'nothing is public in mm-sf yet');
        assert(sf.includes('mm-sf'), 'the page names the working orthography');

        const sfCat = markupToString(await as(fx, 'djz', () =>
            renderRoute(fx.ww, 'wordwiki.editorReports.entriesForCategory("water")')));
        assert(!sfCat.includes('samqwan'), 'category listing follows the view too');
    });
});
