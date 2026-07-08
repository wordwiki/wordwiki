// deno-lint-ignore-file no-explicit-any
/**
 * Duplicate-spelling detection (spelling-duplicates.ts): the pure pair rule,
 * the indexed probe over current dict rows, the editor warning (inside the
 * entry root fragment), and the whole-dictionary report (via dispatch).
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, as, TestTimeline, mkEntry, mkChild, mkTombstone,
         renderRoute, type Fixture } from "./testing.ts";
import { markupToString } from "../liminal/markup.ts";
import { conflictingSpellings, findDuplicateEntries, findAllDuplicateGroups,
         type Spelling } from "./spelling-duplicates.ts";
import * as entrySchema from "./entry-schema.ts";

const li = (text: string): Spelling => ({text, variant: 'mm-li'});
const sf = (text: string): Spelling => ({text, variant: 'mm-sf'});

// --- the pure pair rule ------------------------------------------------------

test("dup rule: a same-orthography collision always warns", () => {
    const c = conflictingSpellings([li("samqwan")], [li("samqwan"), sf("samkwan")]);
    assertEquals(c, [{text: "samqwan", myVariant: 'mm-li', otherVariant: 'mm-li'}]);
});

test("dup rule: no shared text, no warning", () => {
    assertEquals(conflictingSpellings([li("samqwan")], [li("plamu")]), []);
});

test("dup rule: a cross-orthography coincidence is FINE when a shared orthography distinguishes", () => {
    // gopit(li) == gopit(sf-of-other-word), but both words are written in
    // both orthographies and differ in each - distinguishable.
    const c = conflictingSpellings([li("gopit"), sf("kopit")],
                                   [sf("gopit"), li("gopitju")]);
    assertEquals(c, []);
});

test("dup rule: a cross-orthography collision with NO shared orthography warns", () => {
    const c = conflictingSpellings([li("samqwan")], [sf("samqwan")]);
    assertEquals(c, [{text: "samqwan", myVariant: 'mm-li', otherVariant: 'mm-sf'}]);
});

test("dup rule: 'mm' vs a specific orthography is a SAME-orthography collision", () => {
    // 'mm' renders in every orthography (variant-policy variantsOverlap), so
    // this is not a distinguishable cross-orthography coincidence.
    const c = conflictingSpellings([{text: "samqwan", variant: 'mm'}], [li("samqwan")]);
    assertEquals(c, [{text: "samqwan", myVariant: 'mm', otherVariant: 'mm-li'}]);
});

test("dup rule: a legacy blank variant collides as every orthography", () => {
    const c = conflictingSpellings([{text: "samqwan", variant: null}], [sf("samqwan")]);
    assertEquals(c, [{text: "samqwan", myVariant: null, otherVariant: 'mm-sf'}]);
});

// --- db probe + editor warning + report --------------------------------------

// Two colliding entries (same text, same orthography), one bystander.
function seed(fx: Fixture) {
    const tl = new TestTimeline();
    const mk = (entry_id: number, splId: number, spellings: Spelling[]) => {
        const e = mkEntry(entry_id, tl.next());
        fx.ww.applyTransaction([e], {quiet: true});
        const spls = spellings.map((s, i) => {
            const spl = mkChild(e, "spl", splId + i, tl.next(),
                                {attr1: s.text, variant: s.variant ?? undefined,
                                 order_key: `0.${5 + i}`});
            fx.ww.applyTransaction([spl], {quiet: true});
            return spl;
        });
        return {e, spls};
    };
    const e1 = mk(1000, 1010, [li("samqwan")]);
    const e2 = mk(2000, 2010, [li("samqwan")]);
    const e3 = mk(3000, 3010, [li("plamu")]);
    return {tl, mk, e1, e2, e3};
}

test("dup probe: finds the colliding entry, not the bystander; tombstoned spellings drop out", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, e2} = seed(fx);
            const hits = findDuplicateEntries(1000, [li("samqwan")]);
            assertEquals(hits.map(h => h.entry_id), [2000]);
            assertEquals(hits[0].conflicts[0].text, "samqwan");

            // Deleting the other word's spelling ends the warning: a deleted
            // fact has no END_OF_TIME row, so "current" excludes it for free.
            fx.ww.applyTransaction([mkTombstone(e2.spls[0], 9010, tl.next())], {quiet: true});
            assertEquals(findDuplicateEntries(1000, [li("samqwan")]), []);
        });
    });
});

test("dup warning: rendered atop the editor entry, linking the other word; clean entry has none", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            seed(fx);
            const page = markupToString(fx.ww.lexeme.renderMetaEntry(1000));
            assertStringIncludes(page, "lm-dup-spelling");
            assertStringIncludes(page, "Possible duplicate word");
            assertStringIncludes(page, "wordwiki.entry(2000)");
            assertStringIncludes(page, "Listuguj");

            assertEquals(markupToString(fx.ww.lexeme.renderMetaEntry(3000))
                         .includes("lm-dup-spelling"), false);
        });
    });
});

test("dup warning: a distinguishable cross-orthography pair does not warn", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {mk} = seed(fx);
            mk(5000, 5010, [li("gopit"), sf("kopit")]);
            mk(6000, 6010, [sf("gopit"), li("gopitju")]);
            assertEquals(markupToString(fx.ww.lexeme.renderMetaEntry(5000))
                         .includes("lm-dup-spelling"), false);
        });
    });
});

test("dup: archiving one side resolves the duplicate (both directions, probe/warning/report)", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, e2} = seed(fx);
            // Archive word 2000 - with the NEW status, which must join the
            // exclusion via the 'Archived' prefix convention.
            fx.ww.applyTransaction(
                [mkChild(e2.e, "sta", 2900, tl.next(),
                         {attr1: "ArchivedDuplicate", order_key: "0.9"})], {quiet: true});

            // The live word no longer warns about it...
            assertEquals(findDuplicateEntries(1000, [li("samqwan")]), []);
            assertEquals(markupToString(fx.ww.lexeme.renderMetaEntry(1000))
                         .includes("lm-dup-spelling"), false);
            // ...and the archived word's own page is quiet too.
            assertEquals(findDuplicateEntries(2000, [li("samqwan")]), []);
            assertEquals(markupToString(fx.ww.lexeme.renderMetaEntry(2000))
                         .includes("lm-dup-spelling"), false);
            // The report group is gone (only one live collider remains).
            assertEquals(findAllDuplicateGroups(), []);
        });
    });
});

test("archived marking: the presentation line and title say ARCHIVED", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, e2} = seed(fx);
            fx.ww.applyTransaction(
                [mkChild(e2.e, "sta", 2900, tl.next(),
                         {attr1: "Archived", order_key: "0.9"})], {quiet: true});
            const archived = fx.ww.entriesById.get(2000)!;
            const live = fx.ww.entriesById.get(1000)!;
            assertStringIncludes(markupToString(
                entrySchema.renderEntryCompactSummary(archived)), "ARCHIVED");
            assertStringIncludes(entrySchema.renderEntryTitle(archived), "[ARCHIVED]");
            assertEquals(markupToString(
                entrySchema.renderEntryCompactSummary(live)).includes("ARCHIVED"), false);
        });
    });
});

test("dup report: groups colliding words by text, via dispatch", async () => {
    await withTestDb(async (fx) => {
        as(fx, "djz", () => {
            const s = seed(fx);
            s.mk(5000, 5010, [li("gopit"), sf("kopit")]);     // distinguishable pair:
            s.mk(6000, 6010, [sf("gopit"), li("gopitju")]);   // ...must stay OUT
        });
        const groups = as(fx, "djz", () => findAllDuplicateGroups());
        assertEquals(groups.map(g => g.text), ["samqwan"]);
        assertEquals(groups[0].entries.map(e => e.entry_id), [1000, 2000]);

        const page = markupToString(await as(fx, "djz", () =>
            renderRoute(fx.ww, 'wordwiki.spellingReports.duplicatesReport()')));
        assertStringIncludes(page, "lm-data-section");
        assertStringIncludes(page, "samqwan");
        assertStringIncludes(page, "wordwiki.entry(1000)");
        assertStringIncludes(page, "wordwiki.entry(2000)");
        assertEquals(page.includes("gopit"), false);
    });
});
