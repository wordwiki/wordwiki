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
