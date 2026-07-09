// deno-lint-ignore-file no-explicit-any
/**
 * The read-only word view + the shared lexeme-link helper (templates.ts):
 * a lexeme link defaults to wordView (read-only) with a pencil to wordEditor;
 * the view renders the public-style renderer over current internal data with
 * a top Edit bar.  Bulk lists suppress the inline pencil.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, as, renderRoute, bornApprove, TestTimeline, mkEntry, mkChild, type Fixture } from "./testing.ts";
import { lexemeLink, mayEditLexemes } from "./templates.ts";
import { markupToString } from "../liminal/markup.ts";

function seedWord(fx: Fixture) {
    const tl = new TestTimeline();
    const e = mkEntry(1000, tl.next(), {change_by_username: "djz"});
    fx.ww.applyTransaction([e], {quiet: true});
    fx.ww.applyTransaction([mkChild(e, "spl", 1010, tl.next(),
        {attr1: "samqwan", order_key: "0.5", change_by_username: "djz"})], {quiet: true});
    const sub = mkChild(e, "sub", 1100, tl.next(), {order_key: "0.5"});
    fx.ww.applyTransaction([sub], {quiet: true});
    fx.ww.applyTransaction([mkChild(sub, "gls", 1110, tl.next(),
        {attr1: "water", order_key: "0.5", change_by_username: "djz"})], {quiet: true});
}

test("lexemeLink: defaults to the read-only view with a pencil to the editor", () => {
    // (Within a logged-in security context via `as`, so mayEditLexemes holds.)
    // Use a bare withTestDb actor to get an ambient context.
    // deno-lint-ignore no-explicit-any
    const html = (n: any) => markupToString(n);
    // No context -> not an editor -> no pencil (defensive default).
    assertEquals(mayEditLexemes(), false);
    const anon = html(lexemeLink(42, "samqwan"));
    assertStringIncludes(anon, "wordwiki.wordView(42)");
    assertEquals(anon.includes("wordwiki.wordEditor(42)"), false);   // no pencil for non-editors
});

test("lexemeLink + word view: pencil for editors, suppressed in bulk, edit bar on the view", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            seedWord(fx);
            assert(mayEditLexemes());
            // A normal link: view + the STANDARD pencil (lm-edit-pencil) to the editor.
            const link = markupToString(lexemeLink(1000, "samqwan"));
            assertStringIncludes(link, "wordwiki.wordView(1000)");
            assertStringIncludes(link, "wordwiki.wordEditor(1000)");
            assertStringIncludes(link, "lm-edit-pencil");
            // A bulk-list link: view only, no inline pencil.
            const bulk = markupToString(lexemeLink(1000, "samqwan", {pencil: false}));
            assertStringIncludes(bulk, "wordwiki.wordView(1000)");
            assertEquals(bulk.includes("lm-edit-pencil"), false);
            // The feed variant: new tab + the edit anchor + the reload class.
            const feed = markupToString(lexemeLink(1000, "x",
                {newTab: true, editAnchor: 777, linkClass: "lm-feed-entry-link"}));
            assertStringIncludes(feed, "_blank");
            assertStringIncludes(feed, "wordwiki.wordEditor(1000,777)");
            assertStringIncludes(feed, "lm-feed-entry-link");

            // The word VIEW page: the public-style renderer over current data,
            // plus the top Edit bar.
            const page: any = fx.ww.wordView(1000);
            const view = markupToString(page.body);
            assertStringIncludes(view, "samqwan");            // the spelling (h1 headword)
            assertStringIncludes(view, "water");              // the gloss
            assertStringIncludes(view, "lm-edit-pencil");     // the standard pencil
            assertStringIncludes(view, "wordwiki.wordEditor(1000)");
            // The content is wrapped in .page-content (so public.css styles the
            // headword/glosses), and the pencil lives INSIDE the headword h1
            // (part of the title line, never its own row).
            assertStringIncludes(view, "page-content");
            assert(/<h1[^>]*>(?:(?!<\/h1>).)*lm-edit-pencil/s.test(view.replace(/\n/g,'')),
                   "pencil should sit inside the headword h1");
        });
    });
});

test("word view orthography lens: lane filtered, banner shown, link helper targets it", async () => {
    await withTestDb(async (fx) => {
        // A two-lane word: li + sf spellings (+ a gloss - glosses are
        // $notVariant relics and must survive any lens).
        const tl = new TestTimeline();
        const e = mkEntry(1000, tl.next());
        fx.ww.applyTransaction([e], {quiet: true});
        fx.ww.applyTransaction([mkChild(e, "spl", 1010, tl.next(),
            {attr1: "samqwan", variant: "mm-li", order_key: "0.5"})], {quiet: true});
        fx.ww.applyTransaction([mkChild(e, "spl", 1011, tl.next(),
            {attr1: "samuqwan", variant: "mm-sf", order_key: "0.6"})], {quiet: true});
        const sub = mkChild(e, "sub", 1100, tl.next(), {order_key: "0.5"});
        fx.ww.applyTransaction([sub], {quiet: true});
        fx.ww.applyTransaction([mkChild(sub, "gls", 1110, tl.next(),
            {attr1: "water", order_key: "0.5"})], {quiet: true});

        // Default view: both lanes, no lens banner.
        const plain = markupToString(await as(fx, "djz", () =>
            renderRoute(fx.ww, "wordwiki.wordView(1000)")));
        assertStringIncludes(plain, "samqwan");
        assertStringIncludes(plain, "samuqwan");
        assertEquals(plain.includes("orthography lens"), false);

        // The sf lens: only the sf lane, gloss kept, the lens announced
        // PROMINENTLY with a way back.
        const lensed = markupToString(await as(fx, "djz", () =>
            renderRoute(fx.ww, "wordwiki.wordView(1000, 'mm-sf')")));
        assertStringIncludes(lensed, "samuqwan");
        assertEquals(lensed.includes(">samqwan<"), false);
        assertStringIncludes(lensed, "water");
        assertStringIncludes(lensed, "orthography lens");
        assertStringIncludes(lensed, "Smith-Francis");
        assertStringIncludes(lensed, "wordwiki.wordView(1000)");   // "View normally"

        // The link helper's lens option targets the lensed view.
        const link = markupToString(lexemeLink(1000, "samuqwan", {viewOrthography: "mm-sf"}));
        assertStringIncludes(link, 'wordwiki.wordView(1000, "mm-sf")');
    });
});

import * as security from '../liminal/security.ts';
import { buildPublishSource } from './publish-source.ts';
import { Publish, PublishStatus } from './publish.ts';

test("recordings show the speaker's name with their region in brackets", async () => {
    await withTestDb(async (fx) => {
        security.runSystem(() =>
            fx.ww.users.updateNamedFields(fx.userIds['djz'],
                ['region'], {region: 'Listuguj'} as any));
        const tl = new TestTimeline();
        const e = mkEntry(1000, tl.next());
        fx.ww.applyTransaction([e], {quiet: true});
        fx.ww.applyTransaction([mkChild(e, "spl", 1010, tl.next(),
            {attr1: "samqwan", variant: "mm-li", order_key: "0.5"})], {quiet: true});
        fx.ww.applyTransaction([mkChild(e, "rec", 1020, tl.next(),
            {attr1: "", attr2: "djz", order_key: "0.5"})], {quiet: true});

        // The word view (table-backed label).
        const view = markupToString(await as(fx, "djz", () =>
            renderRoute(fx.ww, "wordwiki.wordView(1000)")));
        assertStringIncludes(view, "David Ziegler (Listuguj)");

        // The publish path (bundle-backed label): the bundle's users
        // section carries the region, and the info-box renderer uses it.
        const source = await as(fx, "system", () => buildPublishSource(fx.ww));
        const pub = new Publish(new PublishStatus(), source);
        assertEquals(pub.speakerLabel("djz"), "David Ziegler (Listuguj)");
        assertEquals(pub.speakerLabel("nobody-such"), "nobody-such");
    });
});

test("word-view title follows the working lane; body keeps all lanes with badges", async () => {
    await withTestDb(async (fx) => {
        security.runSystem(() =>
            fx.ww.users.updateNamedFields(fx.userIds['djz'],
                ['primary_orthography'], {primary_orthography: 'mm-li'} as any));
        const tl = new TestTimeline();
        const e = mkEntry(1000, tl.next());
        fx.ww.applyTransaction([e], {quiet: true});
        fx.ww.applyTransaction([mkChild(e, "spl", 1010, tl.next(),
            {attr1: "samqwan", variant: "mm-li", order_key: "0.5"})], {quiet: true});
        fx.ww.applyTransaction([mkChild(e, "spl", 1011, tl.next(),
            {attr1: "samuqwan", variant: "mm-sf", order_key: "0.6"})], {quiet: true});

        // An li-working user: the TITLE is li only; the body still carries
        // the sf lane, marked with its badge.
        const view = markupToString(await as(fx, "djz", () =>
            renderRoute(fx.ww, "wordwiki.wordView(1000)")));
        const h1 = view.match(/<h1[^>]*>[\s\S]*?<\/h1>/)![0];
        assertStringIncludes(h1, "samqwan");
        assertEquals(h1.includes("samuqwan"), false);
        assertStringIncludes(view, "samuqwan");            // body keeps the lane
        assertStringIncludes(view, "lm-me-orth");          // ...with a badge
        assertStringIncludes(view, ">SF<");

        // No working lane (= the ALL case): the '/'-joined title.
        security.runSystem(() =>
            fx.ww.users.updateNamedFields(fx.userIds['djz'],
                ['primary_orthography'], {primary_orthography: ''} as any));
        const joined = markupToString(await as(fx, "djz", () =>
            renderRoute(fx.ww, "wordwiki.wordView(1000)")));
        const h1b = joined.match(/<h1[^>]*>[\s\S]*?<\/h1>/)![0];
        assertStringIncludes(h1b, "samqwan / samuqwan");
    });
});

test("word links: the inverse 'not public' badge; pencils on bulk lists too", async () => {
    await withTestDb(async (fx) => {
        const tl = new TestTimeline();
        // A: published (Completed -> blessed gate).  B: a draft - no status,
        // no gate.
        const a = mkEntry(1000, tl.next());
        fx.ww.applyTransaction([a], {quiet: true});
        fx.ww.applyTransaction([mkChild(a, "spl", 1010, tl.next(),
            {attr1: "samqwan", variant: "mm-li", order_key: "0.5"})], {quiet: true});
        fx.ww.applyTransaction([mkChild(a, "sta", 1020, tl.next(),
            {attr1: "Completed", order_key: "0.5"})], {quiet: true});
        const aSub = mkChild(a, "sub", 1100, tl.next(), {order_key: "0.5"});
        fx.ww.applyTransaction([aSub], {quiet: true});
        fx.ww.applyTransaction([mkChild(aSub, "cat", 1200, tl.next(),
            {attr1: "water", order_key: "0.5"})], {quiet: true});
        const b = mkEntry(2000, tl.next());
        fx.ww.applyTransaction([b], {quiet: true});
        fx.ww.applyTransaction([mkChild(b, "spl", 2010, tl.next(),
            {attr1: "waqami", variant: "mm-li", order_key: "0.5"})], {quiet: true});
        const bSub = mkChild(b, "sub", 2100, tl.next(), {order_key: "0.5"});
        fx.ww.applyTransaction([bSub], {quiet: true});
        fx.ww.applyTransaction([mkChild(bSub, "cat", 2200, tl.next(),
            {attr1: "water", order_key: "0.5"})], {quiet: true});
        bornApprove(fx.ww);

        await as(fx, "djz", async () => {
            const pub = markupToString(lexemeLink(1000, "samqwan"));
            const draft = markupToString(lexemeLink(2000, "waqami"));
            assertEquals(pub.includes("not public"), false, "published = unmarked (the common case)");
            assertStringIncludes(draft, "not public");

            // Bulk lists carry the pencil now (one tap to edit) AND the badge.
            const listing = markupToString(
                await renderRoute(fx.ww, 'wordwiki.editorReports.entriesForCategory("water")'));
            assertStringIncludes(listing, "wordwiki.wordEditor(1000)");
            assertStringIncludes(listing, "wordwiki.wordEditor(2000)");
            assertStringIncludes(listing, "not public");
        });

        // Publicness is asked IN THE WORKING LANE (dz): the li-public word
        // IS not-public to an sf-working editor - their public site is the
        // sf one.
        security.runSystem(() =>
            fx.ww.users.updateNamedFields(fx.userIds['djz'],
                ['primary_orthography'], {primary_orthography: 'mm-sf'} as any));
        await as(fx, "djz", async () => {
            const sfEye = markupToString(lexemeLink(1000, "samqwan"));
            assertStringIncludes(sfEye, "not public");
            // And the sf LENS page asks in the lens lane.
            const lensed = markupToString(
                await renderRoute(fx.ww, "wordwiki.wordView(1000, 'mm-sf')"));
            assertStringIncludes(lensed, "not public");
            // Back in the li lane the same word is unmarked.
        });
        security.runSystem(() =>
            fx.ww.users.updateNamedFields(fx.userIds['djz'],
                ['primary_orthography'], {primary_orthography: 'mm-li'} as any));
        await as(fx, "djz", () => {
            const liEye = markupToString(lexemeLink(1000, "samqwan"));
            assertEquals(liEye.includes("not public"), false, "public in the li lane = unmarked");
        });
    });
});

test("archived words: filtered from browsing, listed in the Archived Words report", async () => {
    await withTestDb(async (fx) => {
        const tl = new TestTimeline();
        const e = mkEntry(1000, tl.next());
        fx.ww.applyTransaction([e], {quiet: true});
        fx.ww.applyTransaction([mkChild(e, "spl", 1010, tl.next(),
            {attr1: "samqwan", variant: "mm-li", order_key: "0.5"})], {quiet: true});
        const s = mkChild(e, "sub", 1100, tl.next(), {order_key: "0.5"});
        fx.ww.applyTransaction([s], {quiet: true});
        fx.ww.applyTransaction([mkChild(s, "cat", 1200, tl.next(),
            {attr1: "water", order_key: "0.5"})], {quiet: true});
        fx.ww.applyTransaction([mkChild(e, "sta", 1020, tl.next(),
            {attr1: "Archived", order_key: "0.5"})], {quiet: true});

        await as(fx, "djz", async () => {
            const search = markupToString(await renderRoute(fx.ww,
                "wordwiki.searchPage(query)", {queryArgs: {searchText: "samq"}}));
            assertEquals(search.includes("samqwan"), false, "hidden from search");
            const cats = markupToString(await renderRoute(fx.ww,
                'wordwiki.editorReports.entriesForCategory("water")'));
            assertEquals(cats.includes("samqwan"), false, "hidden from category listings");
            const todo = markupToString(await renderRoute(fx.ww,
                "wordwiki.editorReports.todoReport(null, null)"));
            assertEquals(todo.includes("samqwan"), false, "hidden from the TODO report");

            // THE exception: findable (with the pencil to de-archive), and
            // still reachable by direct id.
            const report = markupToString(await renderRoute(fx.ww,
                "wordwiki.editorReports.archivedWords()"));
            assertStringIncludes(report, "samqwan");
            assertStringIncludes(report, "wordwiki.wordEditor(1000)");
            const view = markupToString(await renderRoute(fx.ww, "wordwiki.wordView(1000)"));
            assertStringIncludes(view, "samqwan");
        });
    });
});
