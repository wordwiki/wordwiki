// deno-lint-ignore-file no-explicit-any
/**
 * The first-class orthography table (orthography.ts): the seeded vocabulary,
 * the publishable flag driving the Public row + makePublic, the 'mm'
 * wildcard staying model-side (offered only under $allowAll), and the chip
 * suppressions (import-epoch dates, automation authors).
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertRejects, assertThrows } from "../liminal/testing/assert.ts";
import { markupToString } from "../liminal/markup.ts";
import { withTestDb, as, bornApprove, renderRoute, invoke,
         TestTimeline, mkEntry, mkChild, type Fixture } from './testing.ts';
import { db } from '../liminal/db.ts';
import * as timestamp from '../liminal/timestamp.ts';
import { seedOrthographies, orthographyVocabulary } from './orthography.ts';

const EOT = timestamp.END_OF_TIME;

function seedWord(fx: Fixture, entry_id = 1000): void {
    const tl = new TestTimeline();
    const e = mkEntry(entry_id, tl.next());
    fx.ww.applyTransaction([e], {quiet: true});
    fx.ww.applyTransaction([mkChild(e, 'spl', entry_id + 1, tl.next(),
                                    {attr1: 'samqwan', variant: 'mm-li'})], {quiet: true});
    bornApprove(fx.ww);
}

test("orthography table: seeded once, idempotently; 'mm' is refused as a row", async () => {
    await withTestDb((fx) => {
        const rows = fx.ww.orthographies.allByOrder.all({});
        assertEquals(rows.map((o: any) => [o.slug, !!o.publishable]),
                     [['mm-li', true], ['mm-sf', true], ['mm-mp', false], ['mm-pm', false]]);
        assertEquals(seedOrthographies(fx.ww.orthographies).inserted, 0);   // idempotent
        assertThrows(() => fx.ww.orthographies.insert({slug: 'mm', name: 'nope'}),
                     Error, 'wildcard');
        // The scan vocabulary = table slugs + the wildcard.
        assertEquals(orthographyVocabulary(fx.ww.orthographies).sort(),
                     ['mm', 'mm-li', 'mm-mp', 'mm-pm', 'mm-sf']);
    });
});

test("publishable flag: archaic orthographies are hidden and refused as publish targets", async () => {
    await withTestDb(async (fx) => {
        seedWord(fx);
        // The Public row: only the publishable orthographies appear.
        const html = markupToString(await as(fx, 'djz', () =>
            renderRoute(fx.ww, 'wordwiki.lexeme.metaPublicRowFragment(1000)')));
        assert(html.includes('Listuguj') && html.includes('Smith-Francis'));
        assert(!html.includes('Modified Pacifique') && !html.includes('Pacifique Manuscript'),
               'archaic source orthographies hidden entirely');
        // ...and the verb refuses them server-side.
        await assertRejects(() => as(fx, 'djz', () =>
            invoke(fx.ww, `wordwiki.lexeme.makePublic($arg0, $arg1)`, 1000, 'mm-pm')),
            Error, 'not a publishable orthography');
    });
});

test("chips: import-epoch dates and automation authors are suppressed", async () => {
    await withTestDb(async (fx) => {
        // A GRANDFATHERED word, exactly as the import + migrate-status leave
        // it: every row at the IMPORT EPOCH (applyTransaction rewrites
        // timestamps, so these are direct inserts, like the importer's), the
        // gate authored by the automation identity.
        const BOT = timestamp.BEGINNING_OF_TIME;
        const imp = (row: any) => db().insert('dict', {
            ty0: 'dct', valid_from: BOT, valid_to: EOT,
            published_from: BOT, published_to: EOT, order_key: '0.5', ...row,
        } as any, 'assertion_id');
        imp({ty1: 'ent', id1: 1000, assertion_id: 1000, id: 1000, ty: 'ent'});
        imp({ty1: 'ent', id1: 1000, ty2: 'spl', id2: 1001, assertion_id: 1001, id: 1001,
             ty: 'spl', attr1: 'samqwan', variant: 'mm-li'});
        imp({ty1: 'ent', id1: 1000, ty2: 'pub', id2: 7777, assertion_id: 7777, id: 7777,
             ty: 'pub', variant: 'mm-li', change_by_username: '~status-migrate'});
        fx.ww.requestWorkspaceReload();

        const html = markupToString(await as(fx, 'djz', () =>
            renderRoute(fx.ww, 'wordwiki.lexeme.metaPublicRowFragment(1000)')));
        assert(html.includes('Listuguj ✓'), 'the gate shows');
        assert(!html.includes('since'), 'the mass-import time is not a meaningful date');
        assert(!html.includes('~status-migrate'), 'automation authorship is noise');
    });
});

test("variant selects: table-driven; 'mm' offered only under $allowAll", async () => {
    await withTestDb(async (fx) => {
        const tl = new TestTimeline();
        fx.ww.applyTransaction([mkEntry(1000, tl.next())], {quiet: true});
        // spelling: no $allowAll - the wildcard must not be offered.
        const spl = markupToString(await as(fx, 'djz', () =>
            renderRoute(fx.ww, `wordwiki.lexeme.insertDialog(1000, 1000, 'spl')`)));
        assert(spl.includes('Listuguj'), 'table names offered');
        assert(!spl.includes("All Mig"), "no wildcard on spelling");
        // todo: $allowAll (+ $defaultAll) - the wildcard IS offered.
        const tdo = markupToString(await as(fx, 'djz', () =>
            renderRoute(fx.ww, `wordwiki.lexeme.insertDialog(1000, 1000, 'tdo')`)));
        assert(tdo.includes("All Mig"), 'wildcard offered under $allowAll');
    });
});

test("the Orthography Table admin page renders via dispatch", async () => {
    await withTestDb(async (fx) => {
        const html = markupToString(await as(fx, 'djz', () =>
            renderRoute(fx.ww, 'wordwiki.orthographies.renderOrthographiesPage()')));
        assert(html.includes('Orthography Table'));
        assert(html.includes('orthography-row-'), 'rows render');
        assert(html.includes('New orthography'), 'admin can create');
    });
});

test("editor rows carry the quiet orthography badge; 'mm' stays unmarked", async () => {
    await withTestDb(async (fx) => {
        const tl = new TestTimeline();
        const e = mkEntry(1000, tl.next());
        fx.ww.applyTransaction([e], {quiet: true});
        fx.ww.applyTransaction([mkChild(e, 'spl', 1001, tl.next(),
                                        {attr1: 'samqwan', variant: 'mm-li'})], {quiet: true});
        fx.ww.applyTransaction([mkChild(e, 'spl', 1002, tl.next(),
                                        {attr1: 'samkwan', variant: 'mm-sf'})], {quiet: true});
        fx.ww.applyTransaction([mkChild(e, 'tdo', 1003, tl.next(),
                                        {attr1: 'Todo', variant: 'mm'})], {quiet: true});
        const html = markupToString(await as(fx, 'djz', () =>
            renderRoute(fx.ww, 'wordwiki.lexeme.renderMetaEntry(1000)')));
        assert(html.includes("class=lm-me-orth>Li<") || /lm-me-orth[^>]*>Li</.test(html),
               'the Listuguj row is marked Li');
        assert(/lm-me-orth[^>]*>SF</.test(html), 'the Smith-Francis row is marked SF');
        // The 'mm' todo row is NOT marked (renders everywhere).
        const mmBadges = (html.match(/lm-me-orth/g) ?? []).length;
        assertEquals(mmBadges, 2, "exactly the two orthography rows carry badges");
    });
});
