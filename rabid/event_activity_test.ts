// The event page as an activity log: services + sales recorded at an event, an
// Add affordance (host/admin), and NO attendance on a catch-all ("Ad-hoc") day.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertRejects } from "../liminal/testing/assert.ts";
import { withTestDb, renderRoute, invoke, asUser, asSystem } from "./testing.ts";
import { hasText, find, attr } from "../liminal/testing/markup-assert.ts";
import { rabid } from "./rabid.ts";

// The services quick-add is a + button (icon, no text): find it by its title.
const hasAddService = (m: any): boolean =>
    !!find(m, (n: any) => Array.isArray(n) && String(attr(n as any, 'title') ?? '') === 'Add service');

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
        assert(res.targets.includes(`.-service-event_id-${eid}-shape-`));

        const rows = asSystem(() => rabid.service.servicesForEvent.all({event_id: eid}));
        assertEquals(rows.length, 1);
        assertEquals(rows[0].event_id, eid);
        assertEquals(rows[0].client_name, 'Fred Client');

        const page = await detail(bob, eid);
        assert(hasText(page, 'Services'));
        assert(hasText(page, 'Fred Client'));
    });
});

test("compact service row: numbered, DIY badge suppressed, We-Repair due + postal surfaced", async () => {
    await withTestDb(async ({ alice }) => {
        const eid = insertEvent();
        const s1 = asSystem(() => rabid.service.insert({event_id: eid, client_name: 'Ada',
            service_kind: 'diy', bike_description: 'Red mtb', service_description: 'flat tire',
            client_postal: 'B3H'} as any));
        const s2 = asSystem(() => rabid.service.insert({event_id: eid, client_name: 'Alan',
            service_kind: 'full', bike_description: 'Blue road', service_description: 'tune-up',
            drop_off_scheduled_pick_up_time: '2026-06-20 14:30:00'} as any));

        // The whole list is a numbered <ol> (the "N)" is a CSS counter, browser-owned).
        const services = asSystem(() => rabid.service.servicesForEvent.all({event_id: eid}));
        const list = asUser(alice, () => rabid.service.renderServiceList(services));
        const listStr = JSON.stringify(list);
        assert(listStr.includes('"ol"') && listStr.includes('lm-svc-list'), 'flat numbered <ol>');
        assert(listStr.includes('lm-svc-num'), 'each row has the counter slot');

        const row1 = await asUser(alice, () => renderRoute(`rabid.service.renderServiceRowById(${s1})`));
        const r1 = JSON.stringify(row1);
        assert(r1.includes('"li"'), 'a row is an <li> (a natural keyboard stop)');
        assert(hasText(row1, 'Ada') && hasText(row1, 'B3H'), 'name + postal (QC column)');
        assert(!r1.includes('DIY'), 'no badge for the common DIY case');

        const row2 = await asUser(alice, () => renderRoute(`rabid.service.renderServiceRowById(${s2})`));
        assert(hasText(row2, 'WE REPAIR'), 'We-Repair badge shown');
        assert(hasText(row2, '2:30 PM'), 'needed-by time surfaced in the badge');
    });
});

test("addSaleForEvent binds the sale + stamps time/recorder; renders under Sales", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const eid = insertEvent();
        const res = await asUser(alice, () => invoke(`rabid.sale.addSaleForEvent($arg0)`,
            {event_id: eid, sale_kind: 'free-bike', description: 'Blue kids bike', amount: 0}));
        assertEquals(res.action, 'reload');
        assert(res.targets.includes(`.-sale-event_id-${eid}-shape-`));

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

test("add affordances show for a host, not a regular volunteer", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const eid = insertEvent();
        const host = await detail(alice, eid);
        assert(hasAddService(host), 'services + button for host');
        assert(hasText(host, 'Add Bike Sale'), 'sales menu for host');

        const regular = await detail(bob, eid);
        assert(!hasAddService(regular), 'no services + for a regular');
        assert(!hasText(regular, 'Add Bike Sale'), 'no sales menu for a regular');
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
        assert(hasText(page, 'Services'));
        assert(hasText(page, 'Walk-in Wanda'));
        // ...but NO attendance UI: no sign-up row, no check-in face grid (a bare
        // "Checked in" still appears once - in the section jump-nav - so check the
        // grid section itself is absent, not the word).
        assert(!hasText(page, 'Signed up'));
        assert(!JSON.stringify(page).includes('renderCheckinGrid'), 'no check-in grid on a catch-all');
        assert(!hasText(page, 'No one checked in'), 'no check-in section content');
    });
});

test("services: add-after and move reorder the event's service rows", async () => {
    await withTestDb(async ({ alice }) => {
        const eid = insertEvent();
        const order = () => asSystem(() =>
            rabid.service.servicesForEvent.all({event_id: eid}).map(s => s.service_id));
        const addSvc = (name: string) => asUser(alice, () =>
            invoke(`rabid.service.addServiceForEvent($arg0)`,
                {event_id: eid, client_name: name, service_description: 'x'}));
        await addSvc('A'); await addSvc('B');
        const [A, B] = order();

        // Add-after A (via the intake dialog's submit handler) -> [A, C, B].
        await asUser(alice, () => invoke(`rabid.service.addServiceRelative($arg0)`,
            {anchor_id: A, position: 'after', client_name: 'C', service_description: 'x'}));
        let ids = order();
        assertEquals(ids.length, 3);
        assertEquals(ids[0], A);
        assertEquals(ids[2], B);

        // Move B up -> [A, B, C].
        await asUser(alice, () => invoke(`rabid.service.moveUp($arg0)`, B));
        assertEquals(order()[1], B);
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

test("a service row is a LIVE fragment on its row key (an edit propagates cross-browser)", async () => {
    await withTestDb(async ({ alice }) => {
        const eid = insertEvent();
        await asUser(alice, () => invoke(`rabid.service.addServiceForEvent($arg0)`,
            {event_id: eid, client_name: 'Fred', service_description: 'x'}));
        const sid = asSystem(() => rabid.service.servicesForEvent.all({event_id: eid})[0].service_id);
        const row = await asUser(alice, () => renderRoute(`rabid.service.renderServiceRowById(${sid})`));
        const cls = String((row as any)[1]?.class ?? '');
        assert(cls.includes('lm-live'), 'the row joins the long-poll');
        assert(cls.includes(`-service-${sid}-`), 'keyed on its own row key (edit reloads just it)');
    });
});

test("Services and Sales are independent reloadable fragments (own fk key each)", async () => {
    await withTestDb(async ({ alice }) => {
        const eid = insertEvent();
        // A host sees both sub-sections even when empty (they carry the Add menu).
        const svc = await asUser(alice, () => renderRoute(`rabid.event.renderEventServices(${eid})`));
        const svcCls = String((svc as any)[1]?.class ?? '');
        assert(svcCls.includes(rabid.service.fkKey('event_id', eid)), 'Services keyed on service fk');
        assert(!svcCls.includes(rabid.sale.fkKey('event_id', eid)), 'Services NOT keyed on sale fk');
        assert(hasAddService(svc), 'services + present');

        const sale = await asUser(alice, () => renderRoute(`rabid.event.renderEventSales(${eid})`));
        const saleCls = String((sale as any)[1]?.class ?? '');
        assert(saleCls.includes(rabid.sale.fkKey('event_id', eid)), 'Sales keyed on sale fk');
        assert(!saleCls.includes(rabid.service.fkKey('event_id', eid)), 'Sales NOT keyed on service fk');
        assert(hasText(sale, 'Add Bike Sale'));
    });
});

test("the Sales menu has one Add item per sale kind; a giveaway dialog omits amount", async () => {
    await withTestDb(async ({ alice }) => {
        const eid = insertEvent();
        const sales = await asUser(alice, () => renderRoute(`rabid.event.renderEventSales(${eid})`));
        for(const label of ['Add Bike Sale', 'Add Free Adult Bike', 'Add Free Kids Bike',
                             'Add Free Helmet', 'Add Balance Bike Loan', 'Add Parts Sale', 'Add Other Sale'])
            assert(hasText(sales, label), `menu has "${label}"`);

        // A paid kind's dialog collects payment (the payment-method select shows
        // 'Cash'); a giveaway/loan dialog has neither amount nor payment.
        const bikeForm = await asUser(alice, () =>
            renderRoute(`rabid.sale.newSaleForEventDialog(${eid}, 'bike')`));
        assert(hasText(bikeForm, 'Add Bike Sale'));
        assert(hasText(bikeForm, 'Cash'), 'paid dialog has a payment-method field');

        const helmetForm = await asUser(alice, () =>
            renderRoute(`rabid.sale.newSaleForEventDialog(${eid}, 'free-helmet')`));
        assert(hasText(helmetForm, 'Add Free Helmet'));
        assert(!hasText(helmetForm, 'Cash'), 'giveaway dialog has no payment-method field');
    });
});

test("a giveaway (amount 0) hides amount/payment; kind+recorder share a line; edit form omits event_id", async () => {
    await withTestDb(async ({ alice }) => {
        const eid = insertEvent();
        await asUser(alice, () => invoke(`rabid.sale.addSaleForEvent($arg0)`,
            {event_id: eid, sale_kind: 'free-helmet', description: 'Kids helmet'}));
        const id = asSystem(() => rabid.sale.salesForEvent.all({event_id: eid})[0].sale_id);

        const view = await asUser(alice, () => renderRoute(`rabid.sale.renderSaleDetail(${id})`));
        assert(hasText(view, 'recorded by'), 'kind line names the recorder');
        assert(!hasText(view, 'Amount'), 'no amount row for a giveaway');
        assert(!hasText(view, 'Payment'), 'no payment row for a giveaway');
        assert(!hasText(view, 'Notes'), 'no notes row when empty');

        const rowMk = await asUser(alice, () => renderRoute(`rabid.sale.renderSaleRowById(${id})`));
        assert(!hasText(rowMk, '$'), 'no $ figure on a giveaway row');

        // A sale is bound to its event: the edit form has no event_id field.
        const form = await asUser(alice, () => rabid.sale.renderForm(asSystem(() => rabid.sale.getById(id))));
        const hasEventField = !!find(form, (n: any) =>
            Array.isArray(n) && String(attr(n as any, 'name') ?? '') === 'event_id');
        assert(!hasEventField, 'edit form omits event_id');
    });
});
