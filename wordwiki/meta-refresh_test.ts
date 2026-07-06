// deno-lint-ignore-file no-explicit-any
/**
 * Fine-grained refresh for the metadata editor (meta-editor-refresh-design.md):
 * every relation rendering is a SHAPE-keyed fragment, every tuple surface a
 * self-refreshing -fact- fragment, the <h1> a title fragment, the changes
 * bar an activity fragment - each with its own re-render route that produces
 * byte-identical markup to the same element in a full render.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, as, TestTimeline, mkEntry, mkChild, mkTombstone,
         bornApprove, type Fixture } from "./testing.ts";
import { markupToString } from "../liminal/markup.ts";

function seed(fx: Fixture) {
    const tl = new TestTimeline();
    const e = mkEntry(1000, tl.next());
    fx.ww.applyTransaction([e], {quiet: true});
    const spl = mkChild(e, "spl", 1010, tl.next(), {attr1: "samqwan", order_key: "0.5"});
    fx.ww.applyTransaction([spl], {quiet: true});
    const sub = mkChild(e, "sub", 1100, tl.next(), {order_key: "0.5"});
    fx.ww.applyTransaction([sub], {quiet: true});
    const gls = mkChild(sub, "gls", 1200, tl.next(), {attr1: "water bucket", order_key: "0.5"});
    fx.ww.applyTransaction([gls], {quiet: true});
    // An alternate grammatical form with a composed-in text child (the
    // compose-is-read-only cases).
    const alt = mkChild(sub, "alt", 1300, tl.next(),
                        {attr1: "vii-3p", attr2: "buckets of water", order_key: "0.5"});
    fx.ww.applyTransaction([alt], {quiet: true});
    const aft = mkChild(alt, "alx", 1310, tl.next(), {attr1: "samqwanl", order_key: "0.5"});
    fx.ww.applyTransaction([aft], {quiet: true});
    bornApprove(fx.ww);
    return {tl, e, spl, sub, gls, alt, aft};
}

test("meta refresh: the full render is built of shape/tuple/title/activity fragments", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            seed(fx);
            const html = markupToString(fx.ww.lexeme.renderMetaEntry(1000));
            // The gloss relation: a shape-keyed wrapper with its own route...
            assertStringIncludes(html, "-rel-1100-gls-shape-");
            assertStringIncludes(html, "renderMetaRelationFragment(1000, 1100, 'gls')");
            // ...containing the self-refreshing tuple row.
            assertStringIncludes(html, "-fact-1200-");
            assertStringIncludes(html, "renderMetaTupleFragment(1000, 1200)");
            // The title and activity fragments.
            assertStringIncludes(html, "-entry-1000-title-");
            assertStringIncludes(html, "renderMetaTitle(1000)");
            assertStringIncludes(html, "-entry-1000-activity-");
            assertStringIncludes(html, "metaChangesBarFragment(1000)");
            // An EMPTY relation still gets its wrapper (an insert must find it).
            assertStringIncludes(html, "-shape- lm-me-rel lm-me-rel-line");
        });
    });
});

test("meta refresh: the fragment routes re-render their elements identically", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            seed(fx);
            // markupToString's pretty-printing indents by nesting depth, so
            // compare whitespace-normalized (the DOM doesn't care).
            const norm = (s: string) => s.replace(/\s+/g, " ");
            const full = norm(markupToString(fx.ww.lexeme.renderMetaEntry(1000)));

            const rel = norm(markupToString(fx.ww.lexeme.renderMetaRelationFragment(1000, 1100, "gls")));
            assertStringIncludes(rel, "-rel-1100-gls-shape-");
            assertStringIncludes(rel, "water bucket");
            assert(full.includes(rel), "relation fragment must equal its slice of the full render");

            const row = norm(markupToString(fx.ww.lexeme.renderMetaTupleFragment(1000, 1200)));
            assertStringIncludes(row, "-fact-1200-");
            assertStringIncludes(row, "water bucket");
            assert(full.includes(row), "tuple fragment must equal its slice of the full render");

            const title = norm(markupToString(fx.ww.lexeme.renderMetaTitle(1000)));
            assertStringIncludes(title, "-entry-1000-title-");
            assertStringIncludes(title, "samqwan");
            assert(full.includes(title), "title fragment must equal its slice of the full render");
        });
    });
});

test("meta refresh: a deleted fact's tuple fragment renders NOTHING (removes itself)", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const {tl, gls} = seed(fx);
            fx.ww.applyTransaction([mkTombstone(gls, 2010, tl.next())], {quiet: true});
            assertEquals(markupToString(fx.ww.lexeme.renderMetaTupleFragment(1000, 1200)), "");
            // ...and the relation fragment re-renders as the empty slot.
            const rel = markupToString(fx.ww.lexeme.renderMetaRelationFragment(1000, 1100, "gls"));
            assertStringIncludes(rel, "empty");
        });
    });
});

test("meta refresh: buttons and dialogs declare txd speculation deps = the emission keys", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            seed(fx);
            const html = markupToString(fx.ww.lexeme.renderMetaEntry(1000));
            // The gloss row's Move/Delete speculate the SHAPE keys the
            // mutation will emit (changeKeys is the shared source).
            assertStringIncludes(html,
                'txd([".-fact-1100-",".-rel-1100-gls-",".-rel-1100-gls-shape-",'
                + '".-entry-1000-title-",".-entry-1000-activity-"])');
            // The edit dialog's save speculates the content keys.
            const dialog = markupToString(fx.ww.lexeme.editDialog(1000, 1200));
            assertStringIncludes(dialog,
                'txd([".-fact-1200-",".-rel-1100-gls-",'
                + '".-entry-1000-title-",".-entry-1000-activity-"])');
            // The insert dialog's save speculates the shape keys.
            const ins = markupToString(fx.ww.lexeme.insertDialog(1000, 1100, "gls"));
            assertStringIncludes(ins,
                'txd([".-fact-1100-",".-rel-1100-gls-",".-rel-1100-gls-shape-",'
                + '".-entry-1000-title-",".-entry-1000-activity-"])');
        });
    });
});

test("edit mode: compose is read-only - the composed-in text child stays editable", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            seed(fx);
            // (READ mode still composes the form into one phrase - covered by
            // the word-view tests.)  EDIT mode keeps the structure: the form's
            // own scalars are one editable surface, and the TEXT child (the
            // per-orthography transcriptions) is its own editable relation
            // with its own rows - dz: the compose optimization is simply
            // disabled in edit mode; making it editable composed would be far
            // more complicated than it is worth.
            const edit = markupToString(fx.ww.lexeme.renderMetaEntry(1000));
            assertStringIncludes(edit, "-fact-1300-");                       // the form itself
            assertStringIncludes(edit, "Gloss: ");                           // its labelled scalars
            assertStringIncludes(edit, "-rel-1300-alx-shape-");              // the text child's wrapper
            assertStringIncludes(edit, "-fact-1310-");                       // ...with its editable row
            assertStringIncludes(edit, "editDialog(1000, 1310)");            // ...and its own Edit
            assertStringIncludes(edit, "samqwanl");
        });
    });
});

test("edit mode: an empty container scalar renders as a labelled empty line", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            seed(fx);
            // The seed's subentry (1100) has NO part_of_speech - the
            // new-lexeme skeleton case (dz): the line must still say WHAT
            // it is, in the empty-relation slot look, not render as a bare
            // unlabelled line.
            const edit = markupToString(fx.ww.lexeme.renderMetaEntry(1000));
            const norm = edit.replace(/\s+/g, " ");
            assertStringIncludes(norm, "Part of speech: </b> <span class='text-muted fst-italic'>empty");
        });
    });
});

test("edit mode: the spelling section renders (title-only is a read convenience)", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            seed(fx);
            const edit = markupToString(fx.ww.lexeme.renderMetaEntry(1000));
            assertStringIncludes(edit, "Spelling: ");                        // the labelled row
            assertStringIncludes(edit, "-fact-1010-");                       // editable
            assertStringIncludes(edit, "editDialog(1000, 1010)");
            assertStringIncludes(edit, "-rel-1000-spl-shape-");              // its own wrapper
            // ...and the headword still renders in the title too.
            assertStringIncludes(edit, "-entry-1000-title-");
        });
    });
});

test("meta refresh: the changes flag rides every fragment's own re-render URL", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            seed(fx);
            const html = markupToString(fx.ww.lexeme.renderMetaEntry(1000, true));
            assertStringIncludes(html, "renderMetaRelationFragment(1000, 1100, 'gls', true)");
            assertStringIncludes(html, "renderMetaTupleFragment(1000, 1200, true)");
            assertStringIncludes(html, "renderMetaTitle(1000, true)");
            assertStringIncludes(html, "metaChangesBarFragment(1000, true)");
        });
    });
});
