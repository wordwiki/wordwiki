// deno-lint-ignore-file no-explicit-any
/**
 * The Phase 1 public-renderer switch: WordWiki.publishedEntries is now the
 * PUBLISHED projection (published_to=EOT facts) filtered by status (dz: status
 * AND published). So a pending edit on a Completed entry does not leak to the
 * public — the public sees the last approved value — and an in-progress entry
 * stays off the public site even though approval runs while it is built.
 */
import { test } from "../liminal/testing/test.ts";
import { assertEquals } from "../liminal/testing/assert.ts";
import { withTestDb, as, TestTimeline, mkEntry, mkChild, mkEdit, type Fixture } from "./testing.ts";
import { backfillPublication } from "./publication-backfill.ts";

const applyOne = (ww: any, a: any) => ww.applyTransaction([a], { quiet: true });
const spellingOf = (entries: any[], id: number) =>
    entries.find((e) => e.entry_id === id)?.spelling?.[0]?.text;

test("publishedEntries = published projection AND status; a pending edit does not leak", () => {
    return withTestDb((fx: Fixture) => {
        const ww = fx.ww;
        let spl: any;
        as(fx, "system", () => {
            const tl = new TestTimeline();
            // A Completed entry (1000) with a spelling, and an in-progress
            // entry (2000) - approval runs while it's built, but it's not ready.
            const ent = mkEntry(1000, tl.next());
            applyOne(ww, ent);
            applyOne(ww, mkChild(ent, "sta", 1001, tl.next(), { attr1: "Completed" }));
            spl = mkChild(ent, "spl", 1002, tl.next(), { attr1: "samqwan" });
            applyOne(ww, spl);

            const ip = mkEntry(2000, tl.next());
            applyOne(ww, ip);
            applyOne(ww, mkChild(ip, "sta", 2001, tl.next(), { attr1: "InProgress" }));
            applyOne(ww, mkChild(ip, "spl", 2002, tl.next(), { attr1: "draft" }));
        });

        // Phase 0 born-approve (stamps Completed entries only), then rebuild the
        // in-RAM workspace - the backfill wrote the db directly.
        backfillPublication();
        ww.requestWorkspaceReload();

        // The Completed entry is public with its published spelling; the
        // in-progress one is off the public site (no published facts + status).
        assertEquals(ww.publishedEntries.length, 1);
        assertEquals(spellingOf(ww.publishedEntries, 1000), "samqwan");
        assertEquals(ww.publishedEntries.some((e: any) => e.entry_id === 2000), false);

        // Edit the Completed entry's spelling - pending, NOT approved.
        as(fx, "system", () =>
            applyOne(ww, mkEdit(spl, 1003, new TestTimeline().next(), { attr1: "samqwann" })));

        // Editor view: the new value. Public view: still the approved value.
        assertEquals(spellingOf(ww.entries, 1000), "samqwann");
        assertEquals(spellingOf(ww.publishedEntries, 1000), "samqwan");
    });
});
