// deno-lint-ignore-file no-explicit-any
/**
 * Working orthography (fix-orthographies.md): the user record's
 * primary_orthography defaults the variant of NEW content in the insert
 * dialog; unset applies no default.
 */
import { test } from "../liminal/testing/test.ts";
import { assert } from "../liminal/testing/assert.ts";
import { markupToString } from "../liminal/markup.ts";
import { withTestDb, as, renderRoute, TestTimeline, mkEntry } from './testing.ts';
import * as security from '../liminal/security.ts';

test("insert dialog: variant defaults from the user's primary_orthography", async () => {
    await withTestDb(async (fx) => {
        const tl = new TestTimeline();
        fx.ww.applyTransaction([mkEntry(1000, tl.next())]);

        // djz has no primary_orthography: the variant select has NO default.
        const before = markupToString(await as(fx, 'djz', () =>
            renderRoute(fx.ww, `wordwiki.lexeme.insertDialog(1000, 1000, 'spl')`)));
        assert(!/value=.?mm-\w+.? selected/.test(before), 'no default when unset');

        security.runSystem(() =>
            fx.ww.users.updateNamedFields(fx.userIds['djz'],
                ['primary_orthography'], {primary_orthography: 'mm-sf'} as any));

        const after = markupToString(await as(fx, 'djz', () =>
            renderRoute(fx.ww, `wordwiki.lexeme.insertDialog(1000, 1000, 'spl')`)));
        assert(/value=.?mm-sf.? selected/.test(after),
               'new spelling defaults to the editor\'s working orthography');
    });
});
