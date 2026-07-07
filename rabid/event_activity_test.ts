// The event page as an activity log: services + sales recorded at an event, an
// Add affordance (host/admin), and NO attendance on a catch-all ("Ad-hoc") day.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertRejects } from "../liminal/testing/assert.ts";
import { withTestDb, renderRoute, invoke, asUser, asSystem } from "./testing.ts";
import { hasText } from "../liminal/testing/markup-assert.ts";
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

const detail = (viewer: number, event_id: number) =>
    asUser(viewer, () => renderRoute(`rabid.event.detailPage(${event_id})`));

test("addServiceForEvent binds the service to the event; it renders in Activity", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const eid = insertEvent();
        // The mutation returns a reload directive (NOT a bare id) so the client's
        // tx handler refreshes the Activity section in place.
        const res = await asUser(alice, () => invoke(`rabid.service.addServiceForEvent($arg0)`,
            {event_id: eid, client_name: 'Fred Client', service_kind: 'full',
             service_description: 'Trued rear wheel'}));
        assertEquals(res.action, 'reload');
        assert(res.targets.includes(`.-service-event_id-${eid}-`));

        const rows = asSystem(() => rabid.service.servicesForEvent.all({event_id: eid}));
        assertEquals(rows.length, 1);
        assertEquals(rows[0].event_id, eid);
        assertEquals(rows[0].client_name, 'Fred Client');

        const page = await detail(bob, eid);
        assert(hasText(page, 'Activity'));
        assert(hasText(page, 'Services'));
        assert(hasText(page, 'Fred Client'));
    });
});

test("addSaleForEvent binds the sale + stamps time/recorder; renders under Sales", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const eid = insertEvent();
        const res = await asUser(alice, () => invoke(`rabid.sale.addSaleForEvent($arg0)`,
            {event_id: eid, sale_kind: 'free-bike', description: 'Blue kids bike', amount: 0}));
        assertEquals(res.action, 'reload');
        assert(res.targets.includes(`.-sale-event_id-${eid}-`));

        const rows = asSystem(() => rabid.sale.salesForEvent.all({event_id: eid}));
        assertEquals(rows.length, 1);
        assertEquals(rows[0].event_id, eid);
        assertEquals(rows[0].sale_recorded_by, alice);   // stamped from the actor
        assert(rows[0].sale_time, 'sale_time stamped');

        const page = await detail(bob, eid);
        assert(hasText(page, 'Sales & giveaways'));
        assert(hasText(page, 'Blue kids bike'));
    });
});

test("adding activity is host/admin only", async () => {
    await withTestDb(async ({ bob }) => {
        const eid = insertEvent();
        // A regular volunteer can neither add a service nor a sale.
        await asUser(bob, () => assertRejects(() =>
            invoke(`rabid.service.addServiceForEvent($arg0)`,
                {event_id: eid, client_name: 'X', service_description: 'y'})));
        await asUser(bob, () => assertRejects(() =>
            invoke(`rabid.sale.addSaleForEvent($arg0)`,
                {event_id: eid, sale_kind: 'bike', amount: 10})));
    });
});

test("the Add ☰ shows for a host, not a regular volunteer", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const eid = insertEvent();
        const host = await detail(alice, eid);
        assert(hasText(host, 'Add service'));
        assert(hasText(host, 'Add sale'));

        const regular = await detail(bob, eid);
        assert(!hasText(regular, 'Add service'));
        assert(!hasText(regular, 'Add sale'));
        // ...but a regular still sees the Activity log itself.
        assert(hasText(regular, 'Activity'));
    });
});

test("a catch-all (Ad-hoc) day: Activity log, titled by date, NO attendance", async () => {
    await withTestDb(async ({ alice }) => {
        const day = '2026-07-06';
        const eid = asSystem(() => rabid.event.catchAllForDate(day, true)!);
        await asUser(alice, () => invoke(`rabid.service.addServiceForEvent($arg0)`,
            {event_id: eid, client_name: 'Walk-in Wanda', service_description: 'Flat fix'}));

        const page = await detail(alice, eid);
        // Titled by its day, not "Untitled Event".
        assert(hasText(page, 'Ad-hoc'));
        assert(!hasText(page, 'Untitled Event'));
        // The log is there...
        assert(hasText(page, 'Activity'));
        assert(hasText(page, 'Walk-in Wanda'));
        // ...but NO sign-up / check-in rows (attendance would corrupt reporting).
        assert(!hasText(page, 'Signed up'));
        assert(!hasText(page, 'Checked in'));
    });
});

test("a catch-all is never listed on the Events page (even the undated section)", async () => {
    await withTestDb(async ({ alice }) => {
        insertEvent();   // a normal, dated event
        asSystem(() => rabid.event.catchAllForDate('2026-07-06', true));
        // Widest view: in-shop shown (away_only off), volunteers-only shown
        // (public_only off), past back to 2000.  A catch-all (NULL times, in-shop)
        // would otherwise surface in the "No date set" section - it must not.
        const page = await asUser(alice, () =>
            renderRoute(`events({away_only:false, public_only:false}, {from:"2000-01-01"})`));
        assert(!hasText(page, 'Ad-hoc'), 'the catch-all is not listed as a scheduled event');
    });
});

test("renderEventActivity registers both service and sale event fk keys", async () => {
    await withTestDb(async ({ bob }) => {
        const eid = insertEvent();
        const section = await asUser(bob, () => renderRoute(`rabid.event.renderEventActivity(${eid})`));
        // The reload wrapper carries both fk keys so an add to EITHER refreshes it.
        assert(hasText(section, 'Activity'));
        const cls = String((section as any)[1]?.class ?? '');
        assert(cls.includes(rabid.service.fkKey('event_id', eid)), 'service fk key present');
        assert(cls.includes(rabid.sale.fkKey('event_id', eid)), 'sale fk key present');
    });
});
