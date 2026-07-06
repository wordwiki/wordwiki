// Events in the standard navigable-item markup: one row species for every
// viewer (tap drills in); host/admin-only editing (recordEdit) drives the
// pencil, the only edit affordance.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, renderRoute, invoke, asUser, asSystem } from "./testing.ts";
import { find, findAll, byClass, hasClass, tagOf, attr, hasText, text, findByTestId } from "../liminal/testing/markup-assert.ts";
import { rabid } from "./rabid.ts";
import * as date from "../liminal/date.ts";

// A datetime `days` ago, for landing fixtures inside the 30-day active window.
const daysAgo = (days: number) => date.temporalToSqliteDateTime(date.orgNow().subtract({days}));

// Make a volunteer "active in the last 30 days" via a recent timesheet entry.
function makeActive(volunteer_id: number): void {
    asSystem(() => rabid.timesheet_entry.insert({
        volunteer_id, start_time: daysAgo(3), end_time: daysAgo(3), notes: '',
        is_paid_time: 0, km_driven_for_reimbursement: 0,
        km_driven_processed: 0, paid_time_processed: 0,
    }));
}

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

test("event form has the three photo upload controls (shop before/after + event)", async () => {
    await withTestDb(async ({ alice }) => {
        const id = insertEvent();
        const form = await asUser(alice, () =>
            renderRoute(`rabid.event.renderForm(rabid.event.getById(${id}))`));
        for(const name of ['shop_before_photo', 'shop_after_photo', 'event_photo']) {
            const hidden = findAll(form, (m: any) =>
                Array.isArray(m) && m[0] === 'input' && (m[1] as any)?.name === name);
            assertEquals((hidden[0] as any[])?.[1]?.type, 'hidden', `${name}: hidden path input`);
            const file = findAll(form, (m: any) =>
                Array.isArray(m) && m[0] === 'input' && (m[1] as any)?.type === 'file'
                && String((m[1] as any)?.onchange).includes(`"${name}"`));
            assertEquals(file.length, 1, `${name}: one file picker wired to lmPhotoFieldChange`);
            assertStringIncludes((file[0] as any[])[1].onchange, 'rabid.photo');
        }
    });
});

test("event detail shows present photos with headlines, and nothing when absent", async () => {
    await withTestDb(async ({ bob }) => {
        const id = insertEvent();

        // No photos set -> no photo section at all.
        const bare = await asUser(bob, () => renderRoute(`rabid.event.detailPage(${id})`));
        assertEquals(findByTestId(bare, 'event-photos'), undefined);

        // Set two of the three; the unset one is skipped.
        const before = `content/photos/3ab/3ab${'0'.repeat(61)}.jpg`;
        const evt = `content/photos/3ac/3ac${'0'.repeat(61)}.jpg`;
        asSystem(() => rabid.event.update(id, {shop_before_photo: before, event_photo: evt}));

        const detail = await asUser(bob, () => renderRoute(`rabid.event.detailPage(${id})`));
        const section = findByTestId(detail, 'event-photos');
        assert(section, 'photo section present');
        assert(hasText(section, 'Shop before'));
        assert(hasText(section, 'Event photo'));
        assert(!hasText(section, 'Shop after'), 'unset photo has no headline');
        const imgs = findAll(section, (m: any) => Array.isArray(m) && m[0] === 'img');
        assertEquals(imgs.length, 2);
        assertStringIncludes((imgs[0] as any[])[1].src, 'rabid.photo.serve');
        assertStringIncludes((imgs[0] as any[])[1].src, before);
        assertStringIncludes((imgs[1] as any[])[1].src, evt);
    });
});

test("event detail offers hosts an Add Photo affordance for missing shop before/after", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const id = insertEvent();   // no photos yet
        // A host (can edit the event) gets an "Add Photo" affordance per slot -
        // including the shop before/after that aren't set - opening the editor.
        const host = await asUser(alice, () => renderRoute(`rabid.event.detailPage(${id})`));
        const section = findByTestId(host, 'event-photos');
        assert(section, 'host sees photo slots to fill');
        assert(hasText(section, 'Shop before') && hasText(section, 'Shop after'));
        assert(hasText(section, 'Add Photo'));
        assert(JSON.stringify(section).includes('renderPhotoEditForm'), 'opens the photo editor');
        // A regular volunteer sees no empty slots / Add affordance.
        const regular = await asUser(bob, () => renderRoute(`rabid.event.detailPage(${id})`));
        assertEquals(findByTestId(regular, 'event-photos'), undefined);
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
        // (A non-remote event shows no location line - it's at our shop; the
        // summary's always-present sign-up row stands in as the summary check.)
        assert(hasText(bobDetail, "Signed up"));
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
        // Emits the event fk key (the check-in editor's registration) AND the
        // volunteer fk key (bob's time fragment's registration, cross-context).
        assert(res.targets.includes(`.-event_checkin-event_id-${id}-`));
        assert(res.targets.includes(`.-event_checkin-volunteer_id-${bob}-`));
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
            Error, "not permitted"));   // route layer (@route hostOrAdmin) denies first
        await asUser(bob, () => assertRejects(
            () => renderRoute(`rabid.event_checkin.checkInDialog(${id})`),
            Error, "not permitted"));

        // alice (host) checks carol in; bob still can't check her out.
        await asUser(alice, () => invoke(`rabid.event_checkin.checkIn($arg0)`,
            {event_id: String(id), volunteer_id: String(carol)}));
        assertEquals(asSystem(() => rabid.event_checkin.checkinsForEvent.all({event_id: id}))
            .map(c => c.volunteer_name), ["Carol Private"]);
        await asUser(bob, () => assertRejects(
            () => invoke(`rabid.event_checkin.checkOut($arg0,$arg1)`, id, carol),
            Error, "not permitted"));   // route layer (@route or(hostOrAdmin, selfArg)) denies first
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
        assert(hasText(after, "Bob"));
        assert(!hasText(after, "Check me in"));
        assert(hasText(after, "Check me out"));

        // The host gets the management verbs (check someone in, check others out).
        const hostView = await asUser(alice, () => renderRoute(`rabid.event_checkin.renderCheckinEditor(${id})`));
        assert(hasText(hostView, "Check someone in…"));
        assert(hasText(hostView, "Check out Bob"));
        assert(hasText(hostView, "Edit Bob's check-in…"));
    });
});

test("display names: a curated short_name shows in the check-in editor; the full name stays on the volunteer's page", async () => {
    await withTestDb(async ({ alice, bob }) => {
        // A curated short_name that is NOT just the first word, to prove it's honored.
        asSystem(() => rabid.volunteer.update(bob, {short_name: "Bobby Q"} as any));
        const id = insertEvent();
        await asUser(bob, () => invoke(`rabid.event_checkin.checkSelfIn($arg0)`, id));

        // The check-in editor (attendee list + ☰ menu) uses the short name.
        const editor = await asUser(alice, () => renderRoute(`rabid.event_checkin.renderCheckinEditor(${id})`));
        assert(hasText(editor, "Bobby Q"));
        assert(hasText(editor, "Check out Bobby Q"));
        assert(!hasText(editor, "Bob Shares"));        // the full name does NOT appear here

        // But the volunteer's OWN detail page keeps the full name (the boundary).
        const page = await asUser(bob, () => renderRoute(`rabid.volunteer.detailPage(${bob})`));
        assert(hasText(page, "Bob Shares"));
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

test("check-in editor: host gets recent-volunteer quick-adds; regulars don't", async () => {
    await withTestDb(async ({ alice, bob, carol }) => {
        const id = insertEvent();
        makeActive(carol);   // carol is active in the last 30 days

        // The host sees a one-tap "Check in Carol" (active, not yet in).
        const hostView = await asUser(alice, () => renderRoute(`rabid.event_checkin.renderCheckinEditor(${id})`));
        assert(hasText(hostView, "Check in Carol"));

        // A regular volunteer gets only their own self verb, no host quick-adds.
        const bobView = await asUser(bob, () => renderRoute(`rabid.event_checkin.renderCheckinEditor(${id})`));
        assert(!hasText(bobView, "Check in Carol"));

        // Tapping it checks carol in; the quick-add gives way to her check-out verb.
        await asUser(alice, () => invoke(`rabid.event_checkin.checkInVolunteer($arg0,$arg1)`, id, carol));
        assertEquals(asSystem(() => rabid.event_checkin.checkinsForEvent.all({event_id: id}))
            .map(c => c.volunteer_name), ["Carol Private"]);
        const after = await asUser(alice, () => renderRoute(`rabid.event_checkin.renderCheckinEditor(${id})`));
        assert(!hasText(after, "Check in Carol"));
        assert(hasText(after, "Check out Carol"));
    });
});

test("check-in editor: per-person verbs are action-primary (all check-outs, then all edits)", async () => {
    await withTestDb(async ({ alice, bob, carol }) => {
        const id = insertEvent();
        await asUser(alice, () => invoke(`rabid.event_checkin.checkInVolunteer($arg0,$arg1)`, id, bob));
        await asUser(alice, () => invoke(`rabid.event_checkin.checkInVolunteer($arg0,$arg1)`, id, carol));

        const view = await asUser(alice, () => renderRoute(`rabid.event_checkin.renderCheckinEditor(${id})`));
        const labels = findAll(view, n => tagOf(n) === 'button' && hasClass(n, 'dropdown-item'))
            .map(b => text(b).trim());
        // Grouped by ACTION, not by person: both check-outs (alpha), then both edits.
        assertEquals(labels.filter(l => l.startsWith('Check out')),
            ['Check out Bob', 'Check out Carol']);
        assertEquals(labels.filter(l => l.startsWith('Edit')),
            ["Edit Bob's check-in…", "Edit Carol's check-in…"]);
        // Every check-out precedes every edit.
        assert(labels.lastIndexOf('Check out Carol')
               < labels.indexOf("Edit Bob's check-in…"),
               'all check-outs come before all edits');
    });
});

// --- Event sign-up (commitment) editor -----------------------------------------

test("sign-up: self-signup is always allowed, idempotent, and removable", async () => {
    await withTestDb(async ({ bob }) => {
        const id = insertEvent();
        // A regular volunteer signs themselves up (no host role needed).
        const res = await asUser(bob, () => invoke(`rabid.event_commitment.commitSelf($arg0)`, id));
        assertEquals(res.action, "reload");
        assert(res.targets.includes(`.-event_commitment-event_id-${id}-`));
        // Idempotent: signing up again is a no-op (one row).
        await asUser(bob, () => invoke(`rabid.event_commitment.commitSelf($arg0)`, id));
        assertEquals(asSystem(() => rabid.event_commitment.commitmentsForEventWithVolunteerName
            .all({event_id: id})).map(c => c.volunteer_name), ["Bob Shares"]);
        // ...and they can remove their own sign-up.
        await asUser(bob, () => invoke(`rabid.event_commitment.uncommit($arg0,$arg1)`, id, bob));
        assertEquals(asSystem(() => rabid.event_commitment.commitmentsForEvent.all({event_id: id})).length, 0);
    });
});

test("sign-up: signing OTHERS up/removing needs host/admin", async () => {
    await withTestDb(async ({ alice, bob, carol }) => {
        const id = insertEvent();
        // bob (regular) may not sign carol up, nor open the dialog.
        await asUser(bob, () => assertRejects(
            () => invoke(`rabid.event_commitment.commit($arg0)`,
                         {event_id: String(id), volunteer_id: String(carol)}),
            Error, "not permitted"));   // route layer (@route hostOrAdmin) denies first
        await asUser(bob, () => assertRejects(
            () => renderRoute(`rabid.event_commitment.commitDialog(${id})`),
            Error, "not permitted"));

        // alice (host) signs carol up; bob still can't remove her.
        await asUser(alice, () => invoke(`rabid.event_commitment.commit($arg0)`,
            {event_id: String(id), volunteer_id: String(carol)}));
        assertEquals(asSystem(() => rabid.event_commitment.commitmentsForEventWithVolunteerName
            .all({event_id: id})).map(c => c.volunteer_name), ["Carol Private"]);
        await asUser(bob, () => assertRejects(
            () => invoke(`rabid.event_commitment.uncommit($arg0,$arg1)`, id, carol),
            Error, "not permitted"));   // route layer (@route or(hostOrAdmin, selfArg)) denies first
        await asUser(alice, () => invoke(`rabid.event_commitment.uncommit($arg0,$arg1)`, id, carol));
        assertEquals(asSystem(() => rabid.event_commitment.commitmentsForEvent.all({event_id: id})).length, 0);
    });
});

test("sign-up editor: self verb for everyone, host verbs only for hosts", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const id = insertEvent();

        // Logged-in non-signee: "Sign me up", but NOT the host's "Sign someone up…".
        const before = await asUser(bob, () => renderRoute(`rabid.event_commitment.renderCommitmentEditor(${id})`));
        assert(!!find(before, byClass("lm-action-menu")));
        assert(hasText(before, "Sign me up"));
        assert(!hasText(before, "Sign someone up…"));

        // Once signed up, the self verb flips to "Remove me".
        await asUser(bob, () => invoke(`rabid.event_commitment.commitSelf($arg0)`, id));
        const after = await asUser(bob, () => renderRoute(`rabid.event_commitment.renderCommitmentEditor(${id})`));
        assert(hasText(after, "Bob"));
        assert(!hasText(after, "Sign me up"));
        assert(hasText(after, "Remove me"));

        // The host gets the management verbs (sign someone up, remove others).
        const hostView = await asUser(alice, () => renderRoute(`rabid.event_commitment.renderCommitmentEditor(${id})`));
        assert(hasText(hostView, "Sign someone up…"));
        assert(hasText(hostView, "Remove Bob"));
    });
});

test("sign-up editor: host gets recent-volunteer quick-adds; regulars don't", async () => {
    await withTestDb(async ({ alice, bob, carol }) => {
        const id = insertEvent();
        makeActive(carol);   // carol is active in the last 30 days

        // The host sees a one-tap "Sign up Carol" (active, not yet signed up).
        const hostView = await asUser(alice, () => renderRoute(`rabid.event_commitment.renderCommitmentEditor(${id})`));
        assert(hasText(hostView, "Sign up Carol"));

        // A regular volunteer gets only their own self verb, no host quick-adds.
        const bobView = await asUser(bob, () => renderRoute(`rabid.event_commitment.renderCommitmentEditor(${id})`));
        assert(!hasText(bobView, "Sign up Carol"));

        // Tapping it signs carol up; the quick-add gives way to her remove verb.
        await asUser(alice, () => invoke(`rabid.event_commitment.commitVolunteer($arg0,$arg1)`, id, carol));
        const after = await asUser(alice, () => renderRoute(`rabid.event_commitment.renderCommitmentEditor(${id})`));
        assert(!hasText(after, "Sign up Carol"));
        assert(hasText(after, "Remove Carol"));
    });
});

test("the event detail page renders the sign-up and check-in editors", async () => {
    await withTestDb(async ({ bob }) => {
        const id = insertEvent();
        const detail = await asUser(bob, () => renderRoute(`rabid.event.detailPage(${id})`));
        assert(hasText(detail, "Signed up:"));
        // Both editors are reachable on the detail page (their fragments
        // present, registered under their event fk keys).
        assert(!!find(detail, byClass(`-event_commitment-event_id-${id}-`)));
        assert(!!find(detail, byClass(`-event_checkin-event_id-${id}-`)));
    });
});
