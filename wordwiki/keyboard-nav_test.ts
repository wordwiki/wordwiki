// deno-lint-ignore-file no-explicit-any
/**
 * Keyboard-driven editing (keyboard-driven-editing.md): the SERVER-side
 * stamps.  The meta editor marks each tuple surface and each action-bearing
 * empty slot as a keyboard stop (lm-kbd-stop + roving tabindex="-1" + the
 * stable data-kbd identity focus restoration finds after a swap), and each
 * ☰ verb with its lm-act-* dispatch class.  The traversal/dispatch mechanism
 * itself is client-side (liminal-scripts.js) - browser-verified, not
 * render-testable.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, as, TestTimeline, mkEntry, mkChild, bornApprove,
         type Fixture } from "./testing.ts";
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
    bornApprove(fx.ww);
    return {tl, e, spl, sub, gls};
}

// The pretty-printer wraps a tag's attributes across lines - compare
// whitespace-normalized (the DOM doesn't care).
const norm = (s: string) => s.replace(/\s+/g, " ");

test("keyboard stops: tuple surfaces carry lm-kbd-stop + tabindex + data-kbd", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            seed(fx);
            const html = norm(markupToString(fx.ww.lexeme.renderMetaEntry(1000)));
            // The gloss row is a stop with the fact identity (class, then the
            // roving -1, then the identity - the tupleSurface attr order).
            assertStringIncludes(html,
                "lm-kbd-stop lm-me-editable d-flex align-items-start gap-1' "
                + "tabindex='-1' data-kbd='fact-1200'");
            // Every stop renders -1: the roving 0 is client-assigned, so
            // fragment re-renders stay byte-identical to the full render.
            assert(!html.includes("tabindex='0'"), "no server-assigned tabindex=0");
        });
    });
});

test("keyboard stops: an editable EMPTY slot is a stop keyed to the slot", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            seed(fx);
            const html = norm(markupToString(fx.ww.lexeme.renderMetaEntry(1000)));
            // The subentry (1100) has empty child relations rendered as slots
            // (e.g. the translation); each action-bearing one is a stop.
            assertStringIncludes(html,
                "lm-kbd-stop lm-editable lm-me-editable' "
                + "tabindex='-1' data-kbd='rel-1100-tra-empty'");
        });
    });
});

test("keyboard dispatch: the ☰ verbs carry their lm-act-* classes", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            seed(fx);
            const html = markupToString(fx.ww.lexeme.renderMetaEntry(1000));
            for (const cls of ["lm-act-insert-before", "lm-act-insert-after",
                               "lm-act-move-up", "lm-act-move-down",
                               "lm-act-history", "lm-act-delete"])
                assertStringIncludes(html, `dropdown-item ${cls}`);
        });
    });
});

test("keyboard stops: fragment re-renders keep the same stamps (byte identity)", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            seed(fx);
            const norm = (s: string) => s.replace(/\s+/g, " ");
            const full = norm(markupToString(fx.ww.lexeme.renderMetaEntry(1000)));
            const row = norm(markupToString(fx.ww.lexeme.renderMetaTupleFragment(1000, 1200)));
            assertStringIncludes(row, "data-kbd='fact-1200'");
            assert(full.includes(row), "stamped tuple fragment must equal its slice of the full render");
        });
    });
});
