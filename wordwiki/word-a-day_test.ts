// deno-lint-ignore-file no-explicit-any
/**
 * The word-a-day picker (wordwiki.ts wordADayPicker): the category tree of
 * not-yet-posted PUBLIC words.  Posted words (non-empty twitter-post
 * attribute) and non-public words (status not Completed) are excluded;
 * category-less words land in the Uncategorized bucket.
 */
import { test } from "../liminal/testing/test.ts";
import { assertEquals, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, as, mkEntry, mkChild, bornApprove, TestTimeline,
         type Fixture } from "./testing.ts";
import { markupToString } from "../liminal/markup.ts";

test("word-a-day picker: unposted public words by category", async () => {
    await withTestDb((fx: Fixture) => {
        as(fx, "djz", () => {
            const tl = new TestTimeline();
            let nextId = 1000;
            // One entry: spelling + optional Completed status, one subentry
            // carrying a gloss + optional category / twitter-post attribute.
            const seed = (spell: string, o: {completed?: boolean, cat?: string,
                                             posted?: string} = {}) => {
                const id = nextId; nextId += 100;
                const e = mkEntry(id, tl.next(), {change_by_username: "djz"});
                fx.ww.applyTransaction([e], {quiet: true});
                fx.ww.applyTransaction([mkChild(e, "spl", id + 1, tl.next(),
                    {attr1: spell, order_key: "0.5"})], {quiet: true});
                if(o.completed ?? true)
                    fx.ww.applyTransaction([mkChild(e, "sta", id + 2, tl.next(),
                        {attr1: "Completed"})], {quiet: true});
                const sub = mkChild(e, "sub", id + 3, tl.next(), {});
                fx.ww.applyTransaction([sub], {quiet: true});
                fx.ww.applyTransaction([mkChild(sub, "gls", id + 4, tl.next(),
                    {attr1: `${spell}-gloss`})], {quiet: true});
                if(o.cat)
                    fx.ww.applyTransaction([mkChild(sub, "cat", id + 5, tl.next(),
                        {attr1: o.cat})], {quiet: true});
                if(o.posted)
                    fx.ww.applyTransaction([mkChild(sub, "att", id + 6, tl.next(),
                        {attr1: "twitter-post", attr2: o.posted})], {quiet: true});
            };
            seed("aaa", {cat: "animals"});                          // pickable
            seed("bbb", {cat: "animals", posted: "2020-01-01"});    // posted
            seed("ccc", {});                                        // uncategorized
            seed("ddd", {cat: "animals", completed: false});        // not public
            bornApprove(fx.ww);

            const html = markupToString(fx.ww.wordADayPicker());
            assertStringIncludes(html, "2 public words not yet posted");
            assertStringIncludes(html, "aaa");
            assertStringIncludes(html, "ccc");
            assertEquals(html.includes("bbb"), false);
            assertEquals(html.includes("ddd"), false);
            // 'animals' has one unposted word; no category-table row exists
            // in the fixture, so it renders in the untabled group.
            assertStringIncludes(html, "animals (1)");
            assertStringIncludes(html, "Not in the category table");
            assertStringIncludes(html, "Uncategorized");
            // The word links into its entry.
            assertStringIncludes(html, "wordwiki.wordView(1000)");
        });
    });
});
