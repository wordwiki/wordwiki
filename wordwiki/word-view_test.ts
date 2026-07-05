// deno-lint-ignore-file no-explicit-any
/**
 * The read-only word view + the shared lexeme-link helper (templates.ts):
 * a lexeme link defaults to wordView (read-only) with a pencil to wordEditor;
 * the view renders the public-style renderer over current internal data with
 * a top Edit bar.  Bulk lists suppress the inline pencil.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, as, TestTimeline, mkEntry, mkChild, type Fixture } from "./testing.ts";
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
            // A normal link: view + pencil to the editor.
            const link = markupToString(lexemeLink(1000, "samqwan"));
            assertStringIncludes(link, "wordwiki.wordView(1000)");
            assertStringIncludes(link, "wordwiki.wordEditor(1000)");
            assertStringIncludes(link, "lm-lexeme-pencil");
            // A bulk-list link: view only, no inline pencil.
            const bulk = markupToString(lexemeLink(1000, "samqwan", {pencil: false}));
            assertStringIncludes(bulk, "wordwiki.wordView(1000)");
            assertEquals(bulk.includes("lm-lexeme-pencil"), false);
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
            assertStringIncludes(view, "samqwan");            // the spelling
            assertStringIncludes(view, "water");              // the gloss
            assertStringIncludes(view, "lm-word-edit");       // the top Edit bar
            assertStringIncludes(view, "wordwiki.wordEditor(1000)");
        });
    });
});
