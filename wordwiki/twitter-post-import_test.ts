// deno-lint-ignore-file no-explicit-any
/**
 * The legacy twitter-post import (twitter-post-import.ts): the SFM parser and
 * the spelling-matched backfill over the in-memory workspace - unique matches
 * get a twitter-post, homonyms and unmatched are skipped, entries that already
 * have one are untouched, and a re-run adds nothing.
 */
import { test } from "../liminal/testing/test.ts";
import { assertEquals, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, as, TestTimeline, mkEntry, mkChild, type Fixture } from "./testing.ts";
import { parseLegacyTwitterPosts, importTwitterPosts, renderSkippedReport,
         TWITTER_POST_ATTR } from "./twitter-post-import.ts";
import { db } from "../liminal/db.ts";
import * as timestamp from "../liminal/timestamp.ts";

// --- The SFM parser (pure) --------------------------------------------------

const DUMP = [
    "\\_sh v3.0  400  MDF 4.0",
    "",
    "\\lx agase'wit\r",           // CRLF, straight apostrophe
    "\\ph aga",
    "\\tp #01448 Su 23 Aug 2015\r",
    "\\ge hire",
    "",
    "\\lx multi",
    "\\tp #001 first",            // first \tp wins
    "\\tp #002 second",
    "",
    "\\lx notposted",             // no \tp -> not in the map
    "\\ge whatever",
    "",
    "\\lx ",                      // empty spelling -> skipped
    "\\tp #003 orphan",
].join("\n");

test("parse: one (lx, first-tp) per block; CRLF, empty-lx and no-tp handled", () => {
    const m = parseLegacyTwitterPosts(DUMP);
    assertEquals(m.get("agase'wit"), "#01448 Su 23 Aug 2015");
    assertEquals(m.get("multi"), "#001 first");
    assertEquals(m.has("notposted"), false);
    assertEquals(m.has(""), false);
    assertEquals(m.size, 2);
});

// --- The import over the workspace ------------------------------------------

// An entry with a Listuguj spelling and one subentry; `variant` defaults to
// mm-li (the \lx variant).  `id` is the entry id.
// Returns the subentry assertion, so a test can hang a pre-existing att off it.
function seedEntry(fx: Fixture, tl: TestTimeline, id: number, spelling: string,
                   opts: {variant?: string} = {}): any {
    const e = mkEntry(id, tl.next());
    fx.ww.applyTransaction([e], {quiet: true});
    fx.ww.applyTransaction([mkChild(e, "spl", id + 1, tl.next(),
        {attr1: spelling, variant: opts.variant ?? "mm-li", order_key: "0.5"})], {quiet: true});
    const sub = mkChild(e, "sub", id + 2, tl.next(), {order_key: "0.5"});
    fx.ww.applyTransaction([sub], {quiet: true});
    return sub;
}

function tpOf(entry_id: number): string[] {
    return db().all<{attr2: string}, any>(
        `SELECT attr2 FROM dict WHERE ty='att' AND attr1=:a AND id1=:id AND valid_to=:eot`,
        {a: TWITTER_POST_ATTR, id: entry_id, eot: timestamp.END_OF_TIME}).map(r => r.attr2);
}

test("import: unique spelling matches get the post; homonyms and unmatched are skipped", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const tl = new TestTimeline();
            seedEntry(fx, tl, 1000, "agase'wit");            // unique -> added
            seedEntry(fx, tl, 2000, "homonym");              // two entries...
            seedEntry(fx, tl, 3000, "homonym");              // ...same spelling
            // 'absent' is in the dump but no entry carries it.

            const dump = [
                "", "\\lx agase'wit", "\\tp #A posted",
                "", "\\lx homonym",   "\\tp #B posted",
                "", "\\lx absent",    "\\tp #C posted",
            ].join("\n");

            const stats = importTwitterPosts(fx.ww, dump, {username: "~twitter-post-import"});
            assertEquals(stats.legacyLexemesWithPost, 3);
            assertEquals(stats.added, 1);
            assertEquals(stats.ambiguous, 1);
            assertEquals(stats.ambiguousSpellings, ["homonym"]);
            assertEquals(stats.unmatched, 1);
            assertEquals(stats.unmatchedSpellings, ["absent"]);

            assertEquals(tpOf(1000), ["#A posted"]);
            assertEquals(tpOf(2000), []);   // homonym untouched
            assertEquals(tpOf(3000), []);

            // The row is stamped with the import identity.
            const u = db().all<{u: string}, any>(
                `SELECT change_by_username u FROM dict WHERE ty='att' AND attr1=:a AND id1=1000 AND valid_to=:eot`,
                {a: TWITTER_POST_ATTR, eot: timestamp.END_OF_TIME})[0].u;
            assertEquals(u, "~twitter-post-import");
        });
    });
});

test("import: an entry that already has a twitter-post is left alone; re-run is a no-op", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const tl = new TestTimeline();
            const sub = seedEntry(fx, tl, 1000, "haswon");
            // Give 1000 a pre-existing twitter-post on its subentry.
            fx.ww.applyTransaction([mkChild(sub, "att", 1009, tl.next(),
                {attr1: TWITTER_POST_ATTR, attr2: "#EXISTING", order_key: "0.51"})], {quiet: true});

            const dump = ["", "\\lx haswon", "\\tp #NEW posted"].join("\n");
            const s1 = importTwitterPosts(fx.ww, dump);
            assertEquals(s1.added, 0);
            assertEquals(s1.alreadyPresent, 1);
            assertEquals(tpOf(1000), ["#EXISTING"]);   // NOT overwritten

            // A word that IS added, then a second run adds nothing.
            seedEntry(fx, tl, 4000, "fresh");
            const dump2 = ["", "\\lx fresh", "\\tp #F posted"].join("\n");
            assertEquals(importTwitterPosts(fx.ww, dump2).added, 1);
            assertEquals(importTwitterPosts(fx.ww, dump2).added, 0);   // idempotent
            assertEquals(tpOf(4000), ["#F posted"]);
        });
    });
});

test("skipped report: homonyms link candidates into production; unmatched are listed", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const tl = new TestTimeline();
            // Two entries share a spelling; give one a gloss so the report can
            // label the candidates (gloss hangs off the subentry).
            const subA = seedEntry(fx, tl, 2000, "twin");
            fx.ww.applyTransaction([mkChild(subA, "gls", 2009, tl.next(),
                {attr1: "the real one", order_key: "0.5"})], {quiet: true});
            seedEntry(fx, tl, 3000, "twin");     // no gloss -> "(no gloss)"

            const dump = [
                "", "\\lx twin",   "\\tp #H posted",
                "", "\\lx absent", "\\tp #U posted",
            ].join("\n");
            const stats = importTwitterPosts(fx.ww, dump);
            const md = renderSkippedReport(stats, {baseUrl: "https://x.example/e"});

            // The homonym row: both candidates as angle-bracket production links.
            assertStringIncludes(md, "[2000](<https://x.example/e(2000)>) — the real one");
            assertStringIncludes(md, "[3000](<https://x.example/e(3000)>) — (no gloss)");
            assertStringIncludes(md, "| twin | #H posted |");
            // The unmatched section lists 'absent' with no link.
            assertStringIncludes(md, "| absent | #U posted |");
            assertStringIncludes(md, "Homonyms (1)");
            assertStringIncludes(md, "Not found (1)");
        });
    });
});

test("import: a non-Listuguj spelling does not match a \\lx", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const tl = new TestTimeline();
            seedEntry(fx, tl, 1000, "sfonly", {variant: "mm-sf"});   // Smith-Francis only
            const dump = ["", "\\lx sfonly", "\\tp #X posted"].join("\n");
            const stats = importTwitterPosts(fx.ww, dump);
            assertEquals(stats.added, 0);
            assertEquals(stats.unmatched, 1);
        });
    });
});
