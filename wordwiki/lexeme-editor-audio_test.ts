// deno-lint-ignore-file no-explicit-any
/**
 * The lexeme editor's recording dialogs (AudioUploadField + insertDialog
 * defaults): a NEW recording's speaker defaults to the logged-in user when
 * they are in the speaker vocabulary; identities outside it (robots, admins
 * who never record) get no default; an EDIT shows the stored speaker
 * untouched.  (The client-side save guard - stop/upload/await-in-flight on
 * submit - lives in lexeme-editor-scripts.js and is exercised in the
 * browser, not here.)
 */
import { test } from "../liminal/testing/test.ts";
import { assertEquals, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, as, TestTimeline, mkEntry, mkChild, type Fixture } from "./testing.ts";
import { markupToString } from "../liminal/markup.ts";

// An entry (1000) with one subentry (1100) carrying one example (1200) with
// one recording tuple (1300, speaker dmm) - the recording dialogs' habitat.
function seedEntry(fx: Fixture): void {
    const tl = new TestTimeline();
    const e = mkEntry(1000, tl.next());
    fx.ww.applyTransaction([e], {quiet: true});
    const s = mkChild(e, 'sub', 1100, tl.next(), {order_key: '0.5'});
    fx.ww.applyTransaction([s], {quiet: true});
    const x = mkChild(s, 'exa', 1200, tl.next(), {order_key: '0.5'});
    fx.ww.applyTransaction([x], {quiet: true});
    fx.ww.applyTransaction([mkChild(x, 'erc', 1300, tl.next(),
        {attr1: 'content/Recordings/x.wav', attr2: 'dmm', order_key: '0.5'})], {quiet: true});
}

test("new-recording dialog: speaker defaults to the logged-in user", async () => {
    await withTestDb((fx) => {
        as(fx, 'djz', () => {
            seedEntry(fx);
            const dialog = markupToString(fx.ww.lexeme.insertDialog(1000, 1200, 'erc'));
            assertStringIncludes(dialog, '<select name=speaker');
            assertStringIncludes(dialog, "<option value=djz selected=''>");
            // The audio widget rides along (eager upload + in-browser recorder).
            assertStringIncludes(dialog, 'lmAudioRecordToggle');
        });
    });
});

test("new-recording dialog: an identity outside the speaker vocabulary gets no default", async () => {
    await withTestDb((fx) => {
        // The 'test' robot is a real seeded user but not in the speaker
        // vocabulary (entrySchema.users) - it must not inject itself.
        as(fx, 'test', () => {
            seedEntry(fx);
            const dialog = markupToString(fx.ww.lexeme.insertDialog(1000, 1200, 'erc'));
            assertStringIncludes(dialog, '<select name=speaker');
            assertEquals(dialog.includes("selected=''>Dolly"), false);
            // No option is pre-selected (the blank nullable option is).
            assertEquals(/<option value=\w+ selected/.test(dialog), false);
        });
    });
});

test("edit-recording dialog: the stored speaker stays, never the editor", async () => {
    await withTestDb((fx) => {
        as(fx, 'djz', () => {
            seedEntry(fx);
            const dialog = markupToString(fx.ww.lexeme.editDialog(1000, 1300));
            assertStringIncludes(dialog, "<option value=dmm selected=''>");
            assertEquals(dialog.includes("<option value=djz selected"), false);
        });
    });
});
