// deno-lint-ignore-file no-explicit-any
/**
 * Publish-as-final-validation warnings: a missing recording publishes the
 * page (renderAudio degrades to a calm marker) and surfaces as a WARNING -
 * never an error, which reads as "the site is broken".
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, as, TestTimeline, mkEntry, mkChild, bornApprove, type Fixture } from "./testing.ts";
import { buildPublishSource } from "./publish-source.ts";
import { Publish, PublishStatus, publishMessageText, publishMessageEntryId, publishStatus } from "./publish.ts";
import { renderAudio } from "./audio.ts";
import { markupToString } from "../liminal/markup.ts";

test("renderAudio: null/empty recording renders a calm marker, not a crash", () => {
    for(const v of [null, undefined, ''] as any[]) {
        const m = markupToString(renderAudio(v, '🔉 Listen'));
        assertStringIncludes(m, 'recording missing');
        assertStringIncludes(m, '<i');               // italic marker, no Error object
    }
});

// An entry with: an entry-level recording with NO audio file, and an example
// whose recording also has none.
function seedEntryWithMissingRecordings(ww: any): void {
    const tl = new TestTimeline();
    const e = mkEntry(1000, tl.next());
    ww.applyTransaction([e], {quiet: true});
    ww.applyTransaction([mkChild(e, 'spl', 1010, tl.next(),
                                 {attr1: 'samqwan', order_key: '0.5'})], {quiet: true});
    ww.applyTransaction([mkChild(e, 'sta', 1020, tl.next(),
                                 {attr1: 'Completed', order_key: '0.5'})], {quiet: true});
    ww.applyTransaction([mkChild(e, 'rec', 1030, tl.next(),
                                 {attr1: null, attr2: 'djz', order_key: '0.5'})], {quiet: true});
    const s = mkChild(e, 'sub', 1100, tl.next(), {order_key: '0.5'});
    ww.applyTransaction([s], {quiet: true});
    const ex = mkChild(s, 'exa', 1200, tl.next(), {order_key: '0.5'});
    ww.applyTransaction([ex], {quiet: true});
    ww.applyTransaction([mkChild(ex, 'erc', 1300, tl.next(),
                                 {attr1: null, order_key: '0.5'})], {quiet: true});
}

test("warnMissingRecordings: warnings (not errors), once per entry", async () => {
    await withTestDb((fx: Fixture) => {
        as(fx, 'djz', () => {
            seedEntryWithMissingRecordings(fx.ww);
            bornApprove(fx.ww);  // the public site is the published projection now
            const status = new PublishStatus();
            status.start();
            const pub = new Publish(status, buildPublishSource(fx.ww));

            const entry = fx.ww.publishedEntries.find((e: any) => e.entry_id === 1000)!;
            pub.warnMissingRecordings(entry);
            pub.warnMissingRecordings(entry);   // deduped: still 2 warnings

            assertEquals(status.errors, []);
            assertEquals(status.warnings.length, 2);
            assertStringIncludes(publishMessageText(status.warnings[0]),
                "Entry 'samqwan': recording by djz has no audio file");
            assertStringIncludes(publishMessageText(status.warnings[1]),
                "Entry 'samqwan': example recording has no audio file");
            // Each warning is tagged with the lexeme it is about, so the status
            // page can link to that lexeme's editor.
            assertEquals(publishMessageEntryId(status.warnings[0]), 1000);
            assertEquals(publishMessageEntryId(status.warnings[1]), 1000);

            // start() resets warnings like the other channels.
            status.end();
            status.start();
            assertEquals(status.warnings, []);
        });
    });
});

test("publishStatus page: lexeme messages link to that lexeme's editor", () => {
    const status = new PublishStatus();
    status.start();
    status.warnings.push({text: "Entry 'samqwan': recording has no audio file", entryId: 1000});
    status.errors.push('books/PDM/page-0101: boom');   // not a lexeme -> no link
    status.log.push({text: 'Publishing Entry samqwan', entryId: 1000});
    status.end();

    const html = markupToString(publishStatus(false, status));
    // The lexeme warning carries an editor link...
    assertStringIncludes(html, '/ww/wordwiki.lexeme.entryPage(1000)');
    assertStringIncludes(html, 'edit lexeme');
    // ...but neither the non-lexeme error nor the Recent Tasks log entry does
    // (an edit link next to every published word is just noise) - so exactly
    // one editor link on the page.
    const links = html.match(/wordwiki\.lexeme\.entryPage\(/g) ?? [];
    assertEquals(links.length, 1);
});
