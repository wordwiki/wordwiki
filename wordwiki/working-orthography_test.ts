// deno-lint-ignore-file no-explicit-any
/**
 * Working orthography (fix-orthographies.md): the user record's
 * primary_orthography defaults the variant of NEW content in the insert
 * dialog; unset applies no default.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import { markupToString } from "../liminal/markup.ts";
import { withTestDb, as, renderRoute, invoke, TestTimeline, mkEntry, mkChild, bornApprove } from './testing.ts';
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
        assert(!sf.includes('water'), 'no sf-tagged content on the word yet');
        assert(sf.includes('Smith-Francis'), 'the page names the working lane');
        const sfCat0 = markupToString(await as(fx, 'djz', () =>
            renderRoute(fx.ww, 'wordwiki.editorReports.entriesForCategory("water")')));
        assert(!sfCat0.includes('samqwan'), 'category listing follows the lane too');

        // THE POINT of presence-based lanes (dz): a PENDING sf fact - work
        // in progress, not published, not gated - puts the word in the sf
        // editor's view immediately, no explicit transition.
        fx.ww.applyTransaction([mkChild(e, 'spl', 1011, tl.next(),
            {attr1: 'samuqwan', variant: 'mm-sf', order_key: '0.6'})], {quiet: true});
        const sf2 = markupToString(await as(fx, 'djz', () =>
            renderRoute(fx.ww, 'wordwiki.editorReports.categoriesDirectory()')));
        assert(sf2.includes('water'), 'a word under sf edit appears in the sf lane');
        const sfCat = markupToString(await as(fx, 'djz', () =>
            renderRoute(fx.ww, 'wordwiki.editorReports.entriesForCategory("water")')));
        assert(sfCat.includes('samuqwan'), 'and is listed under its category');
    });
});

import * as templates from './templates.ts';
import * as date from '../liminal/date.ts';

// A logged-in context WITH a session row (the transient-override tests
// need context.sessionToken, which plain as() does not set).
function withSession<T>(fx: any, username: string, session_token: string, fn: () => T): T {
    const actorId = fx.userIds[username];
    const u = security.runSystem(() => fx.ww.users.getById(actorId));
    security.runSystem(() => {
        if(!fx.ww.userSession.getBySessionToken.first({session_token})) {
            const now = date.currentSqliteDateTime();
            fx.ww.userSession.insert({session_token, user_id: actorId,
                start_time: now, last_resume_time: now, last_ip: ''});
        }
    });
    return security.run({actorId, roles: security.rolesFromPermissionsField(u.permissions),
                         sessionToken: session_token}, fn);
}

test("session override beats primary_orthography; set/clear via the route", async () => {
    await withTestDb(async (fx) => {
        security.runSystem(() =>
            fx.ww.users.updateNamedFields(fx.userIds['djz'],
                ['primary_orthography'], {primary_orthography: 'mm-li'} as any));

        await withSession(fx, 'djz', 'tok-1', async () => {
            assertEquals(fx.ww.currentWorkingOrthography(), 'mm-li');

            // Set the override through the ROUTE (dispatch, POST - the
            // route-undeclared pattern).
            await invoke(fx.ww, 'wordwiki.setOrthographyOverride($arg0)', {orthography: 'mm-sf'});
            assertEquals(fx.ww.sessionOrthographyOverride(), 'mm-sf');
            assertEquals(fx.ww.currentWorkingOrthography(), 'mm-sf');

            // An unknown orthography is refused.
            let threw = false;
            try { await invoke(fx.ww, 'wordwiki.setOrthographyOverride($arg0)', {orthography: 'xx-zz'}); }
            catch { threw = true; }
            assert(threw, 'bad slug refused');

            // Clear ('' = back to the profile default).
            await invoke(fx.ww, 'wordwiki.setOrthographyOverride($arg0)', {orthography: ''});
            assertEquals(fx.ww.currentWorkingOrthography(), 'mm-li');

            // The switch bounces back to the page it was made FROM (dz:
            // re-render the same page in the new orthography) - but only
            // to site-relative paths, never an open redirect.
            const back: any = await invoke(fx.ww, 'wordwiki.setOrthographyOverride($arg0)',
                {orthography: 'mm-sf', returnTo: '/ww/wordwiki.editorReports.categoriesDirectory()'});
            assertEquals(back.headers['Location'],
                         '/ww/wordwiki.editorReports.categoriesDirectory()');
            const evil: any = await invoke(fx.ww, 'wordwiki.setOrthographyOverride($arg0)',
                {orthography: '', returnTo: '//evil.example/x'});
            assertEquals(evil.headers['Location'], '/ww/');
        });
    });
});

test("navbar: brand suffix for the working lane; PROMINENT banner only when overridden", async () => {
    await withTestDb(async (fx) => {
        const html = () => markupToString(templates.navBar());

        // Anonymous: no orthography UI at all.
        security.run({actorId: undefined, roles: new Set()}, () => {
            const h = html();
            assert(!h.includes('setOrthographyOverride'), 'no switcher for anonymous');
        });

        // Primary set, no override: the subtle level-1 suffix, no banner.
        security.runSystem(() =>
            fx.ww.users.updateNamedFields(fx.userIds['djz'],
                ['primary_orthography'], {primary_orthography: 'mm-li'} as any));
        withSession(fx, 'djz', 'tok-2', () => {
            const h = html();
            assert(h.includes('Li</span>'), 'the working-lane badge beside the brand');
            assert(h.includes('setOrthographyOverride'), 'the badge IS the switcher');
            assert(h.includes('Working orthography'), 'the badge announces itself');
            assert(!h.includes('overridden'), 'no banner without an override');
        });

        // Override active: suffix follows the EFFECTIVE lane + the amber
        // banner with the inline way out.
        security.runSystem(() => fx.ww.userSession.setOrthographyOverride('tok-2', 'mm-sf'));
        withSession(fx, 'djz', 'tok-2', () => {
            const h = html();
            assert(h.includes('SF</span>'), 'the badge shows the effective (overridden) lane');
            assert(h.includes('overridden to'), 'the banner is present');
            assert(h.includes('Smith-Francis'), 'named in full');
            assert(h.includes('Clear override'), 'one-click way out');
        });
    });
});

test("the working-site reports follow the session override", async () => {
    await withTestDb(async (fx) => {
        // (Same seed as the primary_orthography differential above.)
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

        security.runSystem(() => {
            const now = date.currentSqliteDateTime();
            fx.ww.userSession.insert({session_token: 'tok-3', user_id: fx.userIds['djz'],
                start_time: now, last_resume_time: now, last_ip: ''});
            fx.ww.userSession.setOrthographyOverride('tok-3', 'mm-sf');
        });
        const h = await withSession(fx, 'djz', 'tok-3', async () =>
            markupToString(await renderRoute(fx.ww, 'wordwiki.editorReports.categoriesDirectory()')));
        assert(!h.includes('water'), 'the mm-sf lane: no sf-tagged content on the word');
        assert(h.includes('Smith-Francis'), 'the report names the working lane');
    });
});

test("ALL ('mm') override: viewing mode - creation falls back to the profile lane", async () => {
    await withTestDb(async (fx) => {
        security.runSystem(() =>
            fx.ww.users.updateNamedFields(fx.userIds['djz'],
                ['primary_orthography'], {primary_orthography: 'mm-li'} as any));
        await withSession(fx, 'djz', 'tok-4', async () => {
            await invoke(fx.ww, 'wordwiki.setOrthographyOverride($arg0)', {orthography: 'mm'});
            assertEquals(fx.ww.currentWorkingOrthography(), 'mm');
            // New content must NOT default to the wildcard.
            assertEquals(fx.ww.newContentOrthography(), 'mm-li');
            // A specific override DOES drive creation.
            await invoke(fx.ww, 'wordwiki.setOrthographyOverride($arg0)', {orthography: 'mm-sf'});
            assertEquals(fx.ww.newContentOrthography(), 'mm-sf');
        });
        // The badge names the ALL mode.
        security.runSystem(() => fx.ww.userSession.setOrthographyOverride('tok-4', 'mm'));
        withSession(fx, 'djz', 'tok-4', () => {
            const h = markupToString(templates.navBar());
            assert(h.includes('All</span>'), "the badge reads 'All'");
            assert(h.includes('All orthographies'), 'banner/switcher name it in full');
        });
    });
});

test("search follows the working lane: pool AND presentation", async () => {
    await withTestDb(async (fx) => {
        const tl = new TestTimeline();
        // 1000 has sf presence (li + sf spellings); 2000 is li-only.
        const a = mkEntry(1000, tl.next());
        fx.ww.applyTransaction([a], {quiet: true});
        fx.ww.applyTransaction([mkChild(a, 'spl', 1010, tl.next(),
            {attr1: 'samqwan', variant: 'mm-li', order_key: '0.5'})], {quiet: true});
        fx.ww.applyTransaction([mkChild(a, 'spl', 1011, tl.next(),
            {attr1: 'samuqwan', variant: 'mm-sf', order_key: '0.6'})], {quiet: true});
        const b = mkEntry(2000, tl.next());
        fx.ww.applyTransaction([b], {quiet: true});
        fx.ww.applyTransaction([mkChild(b, 'spl', 2010, tl.next(),
            {attr1: 'samqwatl', variant: 'mm-li', order_key: '0.5'})], {quiet: true});

        security.runSystem(() =>
            fx.ww.users.updateNamedFields(fx.userIds['djz'],
                ['primary_orthography'], {primary_orthography: 'mm-sf'} as any));
        const h = markupToString(await as(fx, 'djz', () =>
            renderRoute(fx.ww, 'wordwiki.searchPage(query)',
                        {queryArgs: {searchText: 'samq'}})));
        // Pool: only the word with sf-tagged content; matched BY its li text.
        assert(!h.includes('samqwatl'), 'li-only word not in the sf lane pool');
        // Presentation: the sf spelling is the headword.
        assert(h.includes('samuqwan'), 'result presented in the working lane');
        assert(h.includes('wordView(1000, "mm-sf")')
               || h.includes('wordView(1000, &quot;mm-sf&quot;)'),
               'result links the lensed view');
    });
});

test("summary fallback: no spelling in the lane -> greyed first spelling + superscript", async () => {
    await withTestDb(async (fx) => {
        const tl = new TestTimeline();
        // sf presence via a definition, but NO sf spelling.
        const e = mkEntry(1000, tl.next());
        fx.ww.applyTransaction([e], {quiet: true});
        fx.ww.applyTransaction([mkChild(e, 'spl', 1010, tl.next(),
            {attr1: 'samqwan', variant: 'mm-li', order_key: '0.5'})], {quiet: true});
        const s = mkChild(e, 'sub', 1100, tl.next(), {order_key: '0.5'});
        fx.ww.applyTransaction([s], {quiet: true});
        fx.ww.applyTransaction([mkChild(s, 'alt', 1110, tl.next(),
            {attr1: 'samuqwanl', variant: 'mm-sf', order_key: '0.5'})], {quiet: true});

        security.runSystem(() =>
            fx.ww.users.updateNamedFields(fx.userIds['djz'],
                ['primary_orthography'], {primary_orthography: 'mm-sf'} as any));
        const h = markupToString(await as(fx, 'djz', () =>
            renderRoute(fx.ww, 'wordwiki.searchPage(query)',
                        {queryArgs: {searchText: 'samq'}})));
        assert(h.includes('samqwan'), 'the first-lane spelling stands in');
        assert(h.includes('text-muted'), 'greyed');
        assert(h.includes('lm-me-orth'), 'with its lane superscript');
        assert(h.includes('>Li<'), 'the superscript names the lane');
    });
});
