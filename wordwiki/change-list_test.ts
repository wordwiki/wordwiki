// deno-lint-ignore-file no-explicit-any
/**
 * The reusable change-list component (change-list.ts): the format helpers, and
 * that ONE renderer serves any context.  The lexeme/participant contexts are
 * covered in lexeme-review_test.ts; here we pin the single-fact context (the
 * same component, fed one fact's events) reads the same, plus the column
 * format (when+who leading, initials, compact date).
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, as, TestTimeline, mkEntry, mkChild, mkEdit, bornApprove,
         type Fixture } from "./testing.ts";
import { renderChangeList, renderGroupedChangeList, initials,
         type ChangeEvent, type ChangeGroup } from "./change-list.ts";
import { markupToString } from "../liminal/markup.ts";
import * as timestamp from "../liminal/timestamp.ts";

test("initials: first+last of a name, two letters of a code, sys for automated", () => {
    assertEquals(initials("djz", "David Ziegler"), "DZ");
    assertEquals(initials("mm", "Mary"), "MA");          // single token -> first two letters
    assertEquals(initials("djz", undefined), "DJ");      // no name -> the code
    assertEquals(initials("~category-import", "Category import"), "sys");
    assertEquals(initials(null), "—");
});

test("compact date: yy-MM-dd, empty at the sentinels", () => {
    assertEquals(timestamp.formatTimestampCompact(timestamp.BEGINNING_OF_TIME), "");
    assertEquals(timestamp.formatTimestampCompact(timestamp.END_OF_TIME), "");
    const d = timestamp.formatTimestampCompact(timestamp.nextTime(timestamp.BEGINNING_OF_TIME));
    assert(/^\d\d-\d\d-\d\d$/.test(d), `expected yy-MM-dd, got '${d}'`);
});

test("renderChangeList: when+who lead each line; change shows aligned from/to; subject toggles", () => {
    const events: ChangeEvent[] = [
        {when: timestamp.nextTime(timestamp.BEGINNING_OF_TIME),
         whoInitials: "MA", whoName: "Mary", field: "Spelling", kind: "baseline",
         value: ["span", {}, "samqwan"]},
        {when: timestamp.nextTime(timestamp.nextTime(timestamp.BEGINNING_OF_TIME)),
         whoInitials: "SP", whoName: "Sally", field: "Spelling", lexeme: "samqwan", kind: "changed",
         from: ["span", {}, "samqwan"], to: ["span", {}, "samqwann"], note: "Listuguj?"},
    ];
    // With subject (lexeme/global context): the fact is named on each line.
    const withSubj = markupToString(renderChangeList(events, {showSubject: true}));
    assertStringIncludes(withSubj, "lm-cl-when");
    assertStringIncludes(withSubj, "lm-cl-who");
    assertStringIncludes(withSubj, "MA");                 // initials in the who column
    assertStringIncludes(withSubj, "lm-cl-subject");
    assertStringIncludes(withSubj, "lm-cl-field");
    assertStringIncludes(withSubj, "lm-cl-lexeme");   // the lexeme qualifier
    assertStringIncludes(withSubj, "lm-cl-detail");       // the change's from/to block
    assertStringIncludes(withSubj, "lm-cl-from");
    assertStringIncludes(withSubj, "samqwann");           // the 'to' value
    assertStringIncludes(withSubj, "Listuguj?");          // the rationale sub-line

    // Without subject (single-fact context): same rows, no subject label.
    const noSubj = markupToString(renderChangeList(events, {showSubject: false}));
    assertEquals(noSubj.includes("lm-cl-subject"), false);
    assertStringIncludes(noSubj, "samqwann");             // still the same event log
});

test("renderChangeList: a comment renders inline (not a sub-line)", () => {
    const events: ChangeEvent[] = [
        {when: timestamp.nextTime(timestamp.BEGINNING_OF_TIME),
         whoInitials: "SP", whoName: "Sally", field: "Spelling", kind: "commented",
         note: "is this the Listuguj spelling?"},
    ];
    const html = markupToString(renderChangeList(events, {showSubject: true}));
    assertStringIncludes(html, "lm-cl-comment");
    assertStringIncludes(html, "is this the Listuguj spelling?");
    assertEquals(html.includes("lm-cl-note"), false);     // inline, not a sub-line
});

test("renderGroupedChangeList: headed blocks; the empty message when no groups", () => {
    const groups: ChangeGroup[] = [
        {header: ["span", {}, "Spelling"],
         events: [{when: timestamp.nextTime(timestamp.BEGINNING_OF_TIME),
                   whoInitials: "SP", whoName: "Sally", field: "Spelling", kind: "changed",
                   from: ["span", {}, "a"], to: ["span", {}, "b"]}]},
    ];
    const html = markupToString(renderGroupedChangeList(groups));
    assertStringIncludes(html, "lm-cl-group-header");
    assertStringIncludes(html, "Spelling");
    assertStringIncludes(html, "lm-cl-detail");
    // Within a group the per-line subject is dropped (it is the header).
    assertEquals(html.includes("lm-cl-subject"), false);

    assertStringIncludes(markupToString(renderGroupedChangeList([], "Nothing needs approving.")),
                         "Nothing needs approving.");
});

test("single-fact context: factChangeEvents feeds the same component", async () => {
    await withTestDb((fx: Fixture) => {
        as(fx, "djz", () => {
            const tl = new TestTimeline();
            const e = mkEntry(1000, tl.next());
            fx.ww.applyTransaction([e], {quiet: true});
            const spl = mkChild(e, "spl", 1010, tl.next(), {attr1: "samqwan", order_key: "0.5"});
            fx.ww.applyTransaction([spl], {quiet: true});
            fx.ww.applyTransaction([mkChild(e, "sta", 1020, tl.next(),
                                            {attr1: "Completed", order_key: "0.5"})], {quiet: true});
            bornApprove(fx.ww);
            fx.ww.applyTransaction([mkEdit(spl, 2010, tl.next(), {attr1: "samqwann"})], {quiet: true});

            // The single-fact change list: one fact's events, rendered by the
            // SAME renderChangeList (here without subject, as the fact is known).
            const tuple = fx.ww.lexemeOps.findTupleInEntry(1000, 1010);
            const events = fx.ww.lexeme.factChangeEvents(tuple.schema, tuple, false);
            const html = markupToString(renderChangeList(events, {showSubject: false}));

            assertStringIncludes(html, "samqwan");      // baseline value / the change's 'from'
            assertStringIncludes(html, "samqwann");     // the change's 'to'
            assertStringIncludes(html, "lm-cl-detail"); // the change's aligned from/to block
            assertEquals(events.length, 2);             // baseline + one edit, since published
        });
    });
});
