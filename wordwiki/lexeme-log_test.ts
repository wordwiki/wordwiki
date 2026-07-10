// deno-lint-ignore-file no-explicit-any
/**
 * The session LOG (dz 2026-07-09): quick capture of group-sitting feedback
 * on a word.  postLog = one new TOP-POSTED log fact, born-approved under a
 * published entry (bypassing review ceremony - the log is internal-audience),
 * a normal pending fact under an unapproved one (the published-tree
 * invariant).  Internal-audience relations are STRIPPED from the public
 * bundle serialization.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertStringIncludes, assertThrows } from "../liminal/testing/assert.ts";
import { withTestDb, TestTimeline, mkEntry, mkChild, bornApprove, as, renderRoute,
         type Fixture } from "./testing.ts";
import { validateVersionedDb } from "./versioned-db-validate.ts";
import { buildPublishSource, publishSourceToPublicJson } from "./publish-source.ts";
import { renderToStringViaLinkeDOM } from '../liminal/markup.ts';

// One li-public word (approved via bornApprove) with an internal note and a
// todo-tag, and one word left entirely unapproved.
function seed(fx: Fixture): void {
    const tl = new TestTimeline();
    const a = mkEntry(1000, tl.next());
    fx.ww.applyTransaction([a], {quiet: true});
    fx.ww.applyTransaction([mkChild(a, 'spl', 1010, tl.next(),
        {attr1: 'samqwan', variant: 'mm-li', order_key: '0.5'})], {quiet: true});
    fx.ww.applyTransaction([mkChild(a, 'sta', 1020, tl.next(),
        {attr1: 'Completed', order_key: '0.5'})], {quiet: true});
    fx.ww.applyTransaction([mkChild(a, 'nte', 1030, tl.next(),
        {attr1: 'internal editorial note', order_key: '0.5'})], {quiet: true});
    fx.ww.applyTransaction([mkChild(a, 'tdo', 1040, tl.next(),
        {attr1: 'NeedsSpeakerGroupReview', attr2: 'check with elders', order_key: '0.5'})], {quiet: true});
    bornApprove(fx.ww);   // word 1000 is now approved+public in li

    const b = mkEntry(2000, fx.ww.allocTxTimestamps(1, {quiet: true}));
    fx.ww.applyTransaction([b], {quiet: true});
    fx.ww.applyTransaction([mkChild(b, 'spl', 2010,
        fx.ww.allocTxTimestamps(1, {quiet: true}),
        {attr1: 'draft', variant: 'mm-li', order_key: '0.5'})], {quiet: true});
    // NOT blessed: entry 2000 stays entirely unapproved.
}

test("postLog: top-posted, born-approved under a published entry", async () => {
    await withTestDb(async (fx: Fixture) => {
        seed(fx);
        const first = as(fx, 'test', () => fx.ww.lexemeOps.postLog(1000, 'first note'));
        const second = as(fx, 'test', () => fx.ww.lexemeOps.postLog(1000, 'second note'));

        const e = fx.ww.entriesById.get(1000)!;
        assertEquals(e.log.map(l => l.log), ['second note', 'first note'],
                     'top-posted: newest first in the data order');

        // Born-approved: each fact has a published-current version, so the
        // review queue sees nothing.
        const { db } = await import('../liminal/db.ts');
        for(const fact of [first, second]) {
            const published = db().all<any, any>(
                `SELECT 1 FROM dict WHERE id = :id AND published_from IS NOT NULL`,
                {id: fact.fact_id});
            assert(published.length > 0, 'log fact carries a published version');
        }

        // The whole store still validates (no tree-invariant violations).
        const problems = validateVersionedDb(fx.ww.workspace);
        assertEquals(problems.length, 0, JSON.stringify(problems));
    });
});

test("postLog: stays a normal pending fact under an unapproved entry", async () => {
    await withTestDb(async (fx: Fixture) => {
        seed(fx);
        const posted = as(fx, 'test', () => fx.ww.lexemeOps.postLog(2000, 'note on a draft'));
        const { db } = await import('../liminal/db.ts');
        const published = db().all<any, any>(
            `SELECT 1 FROM dict WHERE id = :id AND published_from IS NOT NULL`,
            {id: posted.fact_id});
        assertEquals(published.length, 0, 'no publication stamp under an unapproved entry');
        const problems = validateVersionedDb(fx.ww.workspace);
        assertEquals(problems.length, 0, JSON.stringify(problems));
    });
});

test("postLog: empty text refused", async () => {
    await withTestDb(async (fx: Fixture) => {
        seed(fx);
        assertThrows(() => as(fx, 'test', () => fx.ww.lexemeOps.postLog(1000, '   ')));
    });
});

test("public bundle serialization strips internal relations (note/todo/log)", async () => {
    await withTestDb(async (fx: Fixture) => {
        seed(fx);
        as(fx, 'test', () => fx.ww.lexemeOps.postLog(1000, 'elder discussion - NOT for the public dump'));
        const source = await buildPublishSource(fx.ww);
        // In memory: full entries (identity for the staleness check).
        const inMemory = source.entries.find(e => e.entry_id === 1000)!;
        assert(inMemory.log.length === 1 && (inMemory as any).note.length === 1);
        // Serialized for the public: stripped.
        const json = publishSourceToPublicJson(source);
        assert(!json.includes('NOT for the public dump'), 'log stripped');
        assert(!json.includes('internal editorial note'), 'note stripped');
        assert(!json.includes('check with elders'), 'tag stripped');
        assertStringIncludes(json, 'samqwan');   // real content intact
        const parsed = JSON.parse(json);
        const pe = parsed.entries.find((e: any) => e.entry_id === 1000);
        assertEquals(pe.log, undefined);
        assertEquals(pe.note, undefined);
        assertEquals(pe.tag, undefined);
    });
});

test("postTag: quick-filed as a generic unassigned todo-tag, done=0", async () => {
    await withTestDb(async (fx: Fixture) => {
        seed(fx);
        as(fx, 'test', () => fx.ww.lexemeOps.postTag(1000, 'spelling looks wrong'));
        const e = fx.ww.entriesById.get(1000)!;
        const t = e.tag.find(t => t.value === 'spelling looks wrong');
        assert(t, 'tag present on the entry');
        assertEquals(t!.tag, 'Todo');
        assertEquals(t!.done, 0);
        const problems = validateVersionedDb(fx.ww.workspace);
        assertEquals(problems.length, 0, JSON.stringify(problems));
    });
});

test("log entries: block markdown (lists) indents under the byline", async () => {
    await withTestDb(async (fx: Fixture) => {
        seed(fx);
        as(fx, 'test', () => fx.ww.lexemeOps.postLog(1000, '- first point\n- second point'));
        const markup = await as(fx, 'test', () =>
            renderRoute(fx.ww, `wordwiki.wordView(1000)`));
        const html = renderToStringViaLinkeDOM(markup);
        assertStringIncludes(html, 'ww-log-body');       // block body, indented
        assertStringIncludes(html, '<li>first point</li>');
    });
});

test("word view: log pane renders posts with byline and the Post box", async () => {
    await withTestDb(async (fx: Fixture) => {
        seed(fx);
        as(fx, 'test', () => fx.ww.lexemeOps.postLog(1000, 'remember to **recheck** this'));
        const markup = await as(fx, 'test', () =>
            renderRoute(fx.ww, `wordwiki.wordView(1000)`));
        const html = renderToStringViaLinkeDOM(markup);
        assertStringIncludes(html, 'ww-log-pane');
        assertStringIncludes(html, 'recheck');
        assertStringIncludes(html, 'ww-log-byline');     // author (when) prefix
        assertStringIncludes(html, 'wwLogText');         // the draft box (in the drawer)
        assertStringIncludes(html, 'ww-log-fab');        // the floating dock toggle
        assertStringIncludes(html, 'ww-log-drawer');     // the fixed bottom drawer
        assertStringIncludes(html, 'postLexemeLog');     // posts through the tx route
        assertStringIncludes(html, '<strong>recheck</strong>');  // markdown rendered
        assert(!html.includes('ww-log-body'),
               'single-paragraph entry rides the byline line (no block body)');
        // The reading section is a standard reloadable fragment (posting
        // refreshes it in place - no page reload).
        assertStringIncludes(html, '-lexeme-log-1000-');
        assertStringIncludes(html, 'wordwiki.renderLexemeLogSection(1000)');
        // The actionable peer, re-enabled (dz 2026-07-10): the todo button
        // in the drawer, the open todos in the section (assignee shown by
        // NAME when set).
        assertStringIncludes(html, 'Post as todo');
        assertStringIncludes(html, '>Todos<');            // todos first, own title
        assertStringIncludes(html, 'check with elders');
        assert(!html.includes('>Log<'), "no 'Log' heading (dz: part of the confusion)");
        assert(!html.includes('Add to the log with'), 'instruction line gone');
    });
});
