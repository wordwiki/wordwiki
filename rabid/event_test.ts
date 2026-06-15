// Events in the standard navigable-item markup: one row species for every
// viewer (tap drills in); host/admin-only editing (recordEdit) drives the
// pencil, the only edit affordance.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, renderRoute, invoke, asUser, asSystem } from "./testing.ts";
import { find, byClass, hasClass, tagOf, attr, hasText } from "../liminal/testing/markup-assert.ts";
import { rabid } from "./rabid.ts";

function insertEvent(): number {
    return asSystem(() => rabid.event.insert({
        event_kind: 'public', description: 'Repair Night',
        location_description: 'The shop', location_url: '',
        is_remote_event: 0, volunteer_only: 0,
        start_time: '2026-06-20 19:00:00', end_time: '2026-06-20 21:30:00',
        total_cash_collected: 0, notes: '',
    }));
}

test("event rows: one navigable species; the pencil only for hosts", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const id = insertEvent();
        const row = (viewer: number) => asUser(viewer, () =>
            renderRoute(`rabid.event.renderEventRowById(${id})`));

        const bobRow = await row(bob);                       // regular volunteer
        assertEquals(tagOf(bobRow as any), "div");
        assertEquals(attr(bobRow as any, "onclick"), "lmNavigableClick(event)");
        const link = find(bobRow, byClass("lm-nav-link"));   // the delegation target
        assert(link);
        assertStringIncludes(String(attr(link, "href")), `detailPage(${id})`);
        assert(!!find(bobRow, byClass("lm-nav-chevron")));
        assert(!find(bobRow, byClass("lm-edit-pencil")));
        assert(hasText(bobRow, "Repair Night"));
        assert(hasText(bobRow, "Jun 20, 2026"));

        const aliceRow = await row(alice);                   // host
        assert(!!find(aliceRow, byClass("lm-edit-pencil")));
    });
});

test("event editing is host-gated at render and save", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const id = insertEvent();

        await asUser(bob, () => assertRejects(
            () => renderRoute(`rabid.event.renderForm(rabid.event.getById(${id}))`),
            Error, "Not permitted to edit this event"));
        await asUser(bob, () => assertRejects(
            () => invoke("rabid.event.saveForm($arg0)", {
                event_id: String(id), description: "Hacked", "before-description": "Repair Night",
            }),
            Error, "Not permitted to edit this event"));

        const res = await asUser(alice, () => invoke("rabid.event.saveForm($arg0)", {
            event_id: String(id), description: "Repair Night (moved)", "before-description": "Repair Night",
        }));
        assertEquals(res.action, "reload");
    });
});

test("the event detail page shows the summary; the pencil only for hosts", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const id = insertEvent();
        const bobDetail = await asUser(bob, () => renderRoute(`rabid.event.detailPage(${id})`));
        assert(hasText(bobDetail, "Repair Night"));
        assert(hasText(bobDetail, "The shop"));
        assert(!find(bobDetail, byClass("lm-edit-pencil")));

        const aliceDetail = await asUser(alice, () => renderRoute(`rabid.event.detailPage(${id})`));
        assert(!!find(aliceDetail, byClass("lm-edit-pencil")));
    });
});

test("the summary-card title links to the detail page - except ON the detail page (no self-link)", async () => {
    await withTestDb(async ({ bob }) => {
        const id = insertEvent();
        // standalone card (home upcoming-events): title is a working detail link
        const card = await asUser(bob, () => renderRoute(`rabid.event.renderEventSummary(${id})`));
        const link = find(card, n => tagOf(n) === "a" && hasClass(n, "card-title"));
        assert(link, "card title is a link");
        assertEquals(attr(link!, "href"), `/rabid.event.detailPage(${id})`);
        // on the detail page: plain text, no anchor
        const detail = await asUser(bob, () => renderRoute(`rabid.event.detailPage(${id})`));
        assert(!find(detail, n => tagOf(n) === "a" && hasClass(n, "card-title")));
    });
});

// --- Event check-in editor -----------------------------------------------------

test("check-in: self-signup is always allowed and idempotent", async () => {
    await withTestDb(async ({ bob }) => {
        const id = insertEvent();
        // A regular volunteer checks themselves in (no host role needed).
        const res = await asUser(bob, () => invoke(`rabid.event_checkin.checkSelfIn($arg0)`, id));
        assertEquals(res.action, "reload");
        assertEquals(res.targets, [`.-event_checkin-${id}-`]);
        // Idempotent: checking in again is a no-op (one row).
        await asUser(bob, () => invoke(`rabid.event_checkin.checkSelfIn($arg0)`, id));
        const checkins = asSystem(() => rabid.event_checkin.checkinsForEvent.all({event_id: id}));
        assertEquals(checkins.map(c => c.volunteer_name), ["Bob Shares"]);
        // ...and they can check themselves back out.
        await asUser(bob, () => invoke(`rabid.event_checkin.checkOut($arg0,$arg1)`, id, bob));
        assertEquals(asSystem(() => rabid.event_checkin.checkinsForEvent.all({event_id: id})).length, 0);
    });
});

test("check-in: checking OTHERS in/out needs host/admin", async () => {
    await withTestDb(async ({ alice, bob, carol }) => {
        const id = insertEvent();
        // bob (regular) may not check carol in, nor out once she's in.
        await asUser(bob, () => assertRejects(
            () => invoke(`rabid.event_checkin.checkIn($arg0)`,
                         {event_id: String(id), volunteer_id: String(carol)}),
            Error, "Not permitted to check volunteers into this event"));
        await asUser(bob, () => assertRejects(
            () => renderRoute(`rabid.event_checkin.checkInDialog(${id})`),
            Error, "Not permitted"));

        // alice (host) checks carol in; bob still can't check her out.
        await asUser(alice, () => invoke(`rabid.event_checkin.checkIn($arg0)`,
            {event_id: String(id), volunteer_id: String(carol)}));
        assertEquals(asSystem(() => rabid.event_checkin.checkinsForEvent.all({event_id: id}))
            .map(c => c.volunteer_name), ["Carol Private"]);
        await asUser(bob, () => assertRejects(
            () => invoke(`rabid.event_checkin.checkOut($arg0,$arg1)`, id, carol),
            Error, "Not permitted to check out this volunteer"));
        await asUser(alice, () => invoke(`rabid.event_checkin.checkOut($arg0,$arg1)`, id, carol));
        assertEquals(asSystem(() => rabid.event_checkin.checkinsForEvent.all({event_id: id})).length, 0);
    });
});

test("check-in: was_staff is snapshotted at check-in and never rewritten", async () => {
    await withTestDb(async ({ bob }) => {
        const id = insertEvent();
        asSystem(() => rabid.volunteer.update(bob, {is_staff: 1}));   // bob is staff now
        await asUser(bob, () => invoke(`rabid.event_checkin.checkSelfIn($arg0)`, id));
        assertEquals(asSystem(() => rabid.event_checkin.checkinsForEvent.all({event_id: id}))[0].was_staff, 1);

        // bob later stops being staff - the past check-in still counts as staff time.
        asSystem(() => rabid.volunteer.update(bob, {is_staff: 0}));
        assertEquals(asSystem(() => rabid.event_checkin.checkinsForEvent.all({event_id: id}))[0].was_staff, 1);
        const editor = await asUser(bob, () => renderRoute(`rabid.event_checkin.renderCheckinEditor(${id})`));
        assert(hasText(editor, "(staff)"));
    });
});

test("check-in editor: self verb for everyone, host verbs only for hosts", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const id = insertEvent();

        // Logged-in non-attendee: "Check me in", but NOT the host's "Check someone in…".
        const before = await asUser(bob, () => renderRoute(`rabid.event_checkin.renderCheckinEditor(${id})`));
        assert(!!find(before, byClass("lm-action-menu")));
        assert(hasText(before, "Check me in"));
        assert(!hasText(before, "Check someone in…"));

        // Once checked in, the self verb flips to "Check me out".
        await asUser(bob, () => invoke(`rabid.event_checkin.checkSelfIn($arg0)`, id));
        const after = await asUser(bob, () => renderRoute(`rabid.event_checkin.renderCheckinEditor(${id})`));
        assert(hasText(after, "Bob Shares"));
        assert(!hasText(after, "Check me in"));
        assert(hasText(after, "Check me out"));

        // The host gets the management verbs (check someone in, check others out).
        const hostView = await asUser(alice, () => renderRoute(`rabid.event_checkin.renderCheckinEditor(${id})`));
        assert(hasText(hostView, "Check someone in…"));
        assert(hasText(hostView, "Check out Bob Shares"));
        assert(hasText(hostView, "Edit Bob Shares's check-in…"));
    });
});

test("check-in editor: editing times/notes round-trips; blank clears the override", async () => {
    await withTestDb(async ({ alice, bob, carol }) => {
        const id = insertEvent();
        await asUser(bob, () => invoke(`rabid.event_checkin.checkSelfIn($arg0)`, id));
        const checkinId = asSystem(() =>
            rabid.event_checkin.checkinsForEvent.all({event_id: id})[0].event_checkin_id);

        // The owner edits their own times + notes.
        await asUser(bob, () => invoke(`rabid.event_checkin.editCheckin($arg0)`, {
            event_checkin_id: String(checkinId),
            start_time: '2026-06-20 19:30:00', end_time: '2026-06-20 21:00:00',
            notes: 'left early'}));
        let c = asSystem(() => rabid.event_checkin.getById(checkinId));
        assertEquals(c.start_time, '2026-06-20 19:30:00');
        assertEquals(c.end_time, '2026-06-20 21:00:00');
        assertEquals(c.notes, 'left early');

        // Blank time inputs clear the override (revert to the event's times).
        await asUser(bob, () => invoke(`rabid.event_checkin.editCheckin($arg0)`, {
            event_checkin_id: String(checkinId), start_time: '', end_time: '', notes: ''}));
        c = asSystem(() => rabid.event_checkin.getById(checkinId));
        assertEquals(c.start_time ?? null, null);
        assertEquals(c.end_time ?? null, null);

        // A different regular volunteer cannot edit it; a host can.
        await asUser(carol, () => assertRejects(
            () => invoke(`rabid.event_checkin.editCheckin($arg0)`,
                         {event_checkin_id: String(checkinId), notes: 'hax'}),
            Error, "Not permitted to edit this check-in"));
        await asUser(carol, () => assertRejects(
            () => renderRoute(`rabid.event_checkin.editCheckinDialog(${checkinId})`),
            Error, "Not permitted"));
        await asUser(alice, () => invoke(`rabid.event_checkin.editCheckin($arg0)`,
            {event_checkin_id: String(checkinId), notes: 'host note'}));
        assertEquals(asSystem(() => rabid.event_checkin.getById(checkinId)).notes, 'host note');
    });
});
