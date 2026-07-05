// deno-lint-ignore-file no-explicit-any
/**
 * The recently-changed-words report (recent-words.ts): one row per word,
 * ordered by its newest human change, week-clumped, each row opening the
 * word's view-changes page - the reviewer's word-at-a-time approval loop.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, as, TestTimeline, mkEntry, mkChild, mkEdit,
         bornApprove, type Fixture } from "./testing.ts";
import { markupToString } from "../liminal/markup.ts";
import { isRedirectResponse } from "../liminal/http-server.ts";

// Two published words; then human edits: cat (older), then dog (newer).
function seed(fx: Fixture) {
    const tl = new TestTimeline();
    const mkWord = (id: number, word: string, gloss: string) => {
        const e = mkEntry(id, tl.next());
        fx.ww.applyTransaction([e], {quiet: true});
        const spl = mkChild(e, "spl", id+10, tl.next(), {attr1: word, order_key: "0.5"});
        fx.ww.applyTransaction([spl], {quiet: true});
        const sub = mkChild(e, "sub", id+100, tl.next(), {order_key: "0.5"});
        fx.ww.applyTransaction([sub], {quiet: true});
        const gls = mkChild(sub, "gls", id+200, tl.next(), {attr1: gloss, order_key: "0.5"});
        fx.ww.applyTransaction([gls], {quiet: true});
        return {e, spl, sub, gls};
    };
    const cat = mkWord(1000, "miaw", "cat");
    const dog = mkWord(2000, "nmu'j", "dog");
    bornApprove(fx.ww);
    return {tl, cat, dog};
}

function pageHtml(fx: Fixture, mode?: string): string {
    // The un-anchored visit redirects with to_time stamped (the feed model);
    // follow it by re-invoking with the stamped time.
    const r1: any = fx.ww.recentlyChangedWords();
    assert(isRedirectResponse(r1));
    const page: any = fx.ww.recentlyChangedWords(
        {to_time: fx.ww.lastAllocatedTxTimestamp, ...(mode ? {mode} : {})});
    return markupToString(page.body);
}

test("recent words: one row per word, newest change first, linking to view-changes", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, cat, dog} = seed(fx);
            // Edit cat TWICE (still one row), then dog (newer -> first).
            const e1 = mkEdit(cat.gls, 3010, tl.next(), {attr1: "a cat"});
            fx.ww.applyTransaction([e1], {quiet: true});
            fx.ww.applyTransaction([mkEdit(e1, 3011, tl.next(), {attr1: "the cat"})], {quiet: true});
            fx.ww.applyTransaction([mkEdit(dog.gls, 3020, tl.next(),
                                           {attr1: "the dog", change_by_username: "dmm"})], {quiet: true});
            const html = pageHtml(fx);

            // One row per word, dog before cat (newest change first).
            assertEquals(html.match(/metaEditPage\(2000,true\)/g)?.length, 1);
            assertEquals(html.match(/metaEditPage\(1000,true\)/g)?.length, 1);
            assert(html.indexOf("nmu'j") < html.indexOf("miaw"), "newest-changed word lists first");

            // Word + gloss + who; the week clump header; the pending badge.
            assertStringIncludes(html, "the dog");
            assertStringIncludes(html, "Week of ");
            assertStringIncludes(html, "pending");
        });
    });
});

test("recent words: an untouched word does not list; approval clears the badge", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, cat} = seed(fx);
            fx.ww.applyTransaction([mkEdit(cat.gls, 3010, tl.next(), {attr1: "the cat"})], {quiet: true});

            let html = pageHtml(fx);
            assertEquals(html.includes("metaEditPage(2000,true)"), false);  // dog: no human change
            assertStringIncludes(html, "1 pending");

            fx.ww.lexeme.approveAllChanges(1000);
            // The review queue (mode 'pending', the default) DROPS the word -
            // nothing left to review, and the approval event doesn't count.
            html = pageHtml(fx);
            assertEquals(html.includes("metaEditPage(1000,true)"), false);
            assertStringIncludes(html, "Nothing needs review.");
            // The ALL view still lists it (the approval is its newest
            // activity), with no pending badge.
            html = pageHtml(fx, "all");
            assertStringIncludes(html, "metaEditPage(1000,true)");
            assertEquals(html.includes("pending</span>"), false);
            assertStringIncludes(html, "Recently changed words");
        });
    });
});
