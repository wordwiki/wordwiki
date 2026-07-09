// deno-lint-ignore-file no-explicit-any
/**
 * The read-only word view + the shared lexeme-link helper (templates.ts):
 * a lexeme link defaults to wordView (read-only) with a pencil to wordEditor;
 * the view renders the public-style renderer over current internal data with
 * a top Edit bar.  Bulk lists suppress the inline pencil.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, as, renderRoute, TestTimeline, mkEntry, mkChild, type Fixture } from "./testing.ts";
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
