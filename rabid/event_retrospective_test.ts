// Event retrospectives: volunteer feedback (markdown), optionally anonymous.
// Open to ALL logged-in volunteers to add; author-or-host to edit/delete; going
// anonymous clears the recorded author.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertRejects } from "../liminal/testing/assert.ts";
import { withTestDb, renderRoute, invoke, asUser, asSystem } from "./testing.ts";
import { hasText } from "../liminal/testing/markup-assert.ts";
import { rabid } from "./rabid.ts";

function insertEvent(): number {
    return asSystem(() => rabid.event.insert({
        event_kind: 'public', description: 'Repair Night', location_description: '',
        location_url: '', is_remote_event: 0, volunteer_only: 0,
        start_time: '2026-06-20 19:00:00', end_time: '2026-06-20 21:30:00',
        total_cash_collected: 0, notes: '',
    }));
}
const add = (viewer: number, event_id: number, feedback: string, anon: boolean) =>
    asUser(viewer, () => invoke(`rabid.event_retrospective.addRetrospective($arg0)`,
        {event_id, feedback, is_anonymous: anon ? 'on' : undefined}));
const rowsFor = (event_id: number) =>
    asSystem(() => rabid.event_retrospective.forEvent.all({event_id}));

test("any logged-in volunteer can add a retrospective; attributed by default", async () => {
    await withTestDb(async ({ bob }) => {
        const id = insertEvent();
        await add(bob, id, 'Ran smoothly; more stands next time', false);
        const rows = rowsFor(id);
        assertEquals(rows.length, 1);
        assertEquals(rows[0].created_by, bob);
        assertEquals(rows[0].is_anonymous, 0);
        const section = await asUser(bob, () => renderRoute(`rabid.event.renderEventRetrospectives(${id})`));
        assert(hasText(section, 'Ran smoothly'));
        assert(hasText(section, 'Retrospectives'));
    });
});

test("an anonymous retrospective records no author and shows 'Anonymous'", async () => {
    await withTestDb(async ({ bob }) => {
        const id = insertEvent();
        await add(bob, id, 'Felt understaffed and a bit chaotic', true);
        const r = rowsFor(id)[0];
        assertEquals(r.is_anonymous, 1);
        assertEquals(r.created_by ?? null, null);
        const row = await asUser(bob, () =>
            renderRoute(`rabid.event_retrospective.renderRowById(${r.event_retrospective_id})`));
        assert(hasText(row, 'Anonymous'));
    });
});

test("edit is author-or-host; a peer cannot; going anonymous clears the author", async () => {
    await withTestDb(async ({ alice, bob, carol }) => {
        const id = insertEvent();
        await add(bob, id, 'Original note', false);
        const rid = rowsFor(id)[0].event_retrospective_id;

        // A peer (neither author nor host) may not edit or delete.
        await asUser(carol, () => assertRejects(() =>
            invoke(`rabid.event_retrospective.saveRetrospective($arg0)`,
                {event_retrospective_id: rid, feedback: 'hijack', is_anonymous: undefined})));
        await asUser(carol, () => assertRejects(() =>
            invoke(`rabid.event_retrospective.remove($arg0)`, rid)));

        // The author edits it to anonymous -> created_by cleared.
        await asUser(bob, () => invoke(`rabid.event_retrospective.saveRetrospective($arg0)`,
            {event_retrospective_id: rid, feedback: 'On reflection, understaffed', is_anonymous: 'on'}));
        const r = asSystem(() => rabid.event_retrospective.getById(rid));
        assertEquals(r.is_anonymous, 1);
        assertEquals(r.created_by ?? null, null);

        // Now anonymous, bob is no longer the author; only a host can remove it.
        await asUser(bob, () => assertRejects(() =>
            invoke(`rabid.event_retrospective.remove($arg0)`, rid)));
        await asUser(alice, () => invoke(`rabid.event_retrospective.remove($arg0)`, rid));
        assertEquals(rowsFor(id).length, 0);
    });
});

test("the event page shows Retrospectives, its +, the explanatory note, and a section nav", async () => {
    await withTestDb(async ({ bob }) => {
        const id = insertEvent();
        const page = await asUser(bob, () => renderRoute(`rabid.event.detailPage(${id})`));
        assert(hasText(page, 'Retrospectives'));
        assert(hasText(page, 'All feedback is welcome'), 'the explanatory note');
        const s = JSON.stringify(page);
        assert(s.includes('#retrospectives') && s.includes('#services') && s.includes('#tasks'),
               'section jump-links');
        assert(s.includes('newRetrospectiveDialog'), 'the add "+" is open to all');
    });
});
