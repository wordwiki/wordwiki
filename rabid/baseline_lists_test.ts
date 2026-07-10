// Sales, service and timesheets in the standard navigable-item markup: one
// row species for every viewer (tap drills in), the pencil - the only edit
// affordance - gated per table (structured views come later).
//   sale/service: host/admin-edit;  timesheet: self-or-host (ownerId).
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, renderRoute, invoke, asUser, asSystem } from "./testing.ts";
import { find, byClass, tagOf, attr, hasText } from "../liminal/testing/markup-assert.ts";
import { rabid } from "./rabid.ts";

// A minimal event to hang sales/services off - every activity record is now
// event-bound (the day's Ad-hoc catch-all would do too; a plain event is fine here).
function newEvent(): number {
    return asSystem(() => rabid.event.insert({
        event_kind: 'shopTime', description: 'Shop day', location_description: '',
        location_url: '', is_remote_event: 0, volunteer_only: 0,
        start_time: '2026-06-13 10:00:00', end_time: '2026-06-13 20:00:00',
        total_cash_collected: 0, notes: '',
    }));
}

function insertSale(by: number): number {
    const event_id = newEvent();
    return asSystem(() => rabid.sale.insert({
        event_id, sale_time: '2026-06-13 14:00:00', sale_recorded_by: by,
        sale_kind: 'bike', description: 'Blue commuter', amount: 80,
        payment_method: 'cash', notes: undefined,
    }));
}

function insertService(): number {
    const event_id = newEvent();
    return asSystem(() => rabid.service.insert({
        event_id, client_name: 'Jo Client',
        client_phone: '(555) 999-0000',
        service_kind: 'diy', bike_description: 'Blue commuter', service_description: 'Flat tire',
    }));
}

function insertTimesheet(volunteer_id: number): number {
    return asSystem(() => rabid.timesheet_entry.insert({
        volunteer_id,
        start_time: '2026-06-13 18:00:00', end_time: '2026-06-13 21:00:00',
        notes: '', km_driven_for_reimbursement: 0, km_driven_processed: 0,
        is_paid_time: 0, paid_time_processed: 0,
    }));
}

test("sale rows: pencil for hosts only; saveForm host-gated", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const id = insertSale(alice);

        const bobRow = await asUser(bob, () => renderRoute(`rabid.sale.renderSaleRowById(${id})`));
        assertEquals(tagOf(bobRow as any), "div");                 // navigable species
        assert(!!find(bobRow, byClass("lm-nav-chevron")));
        assert(!find(bobRow, byClass("lm-edit-pencil")));
        assert(hasText(bobRow, "Blue commuter"));
        assert(hasText(bobRow, "$80.00"));

        const aliceRow = await asUser(alice, () => renderRoute(`rabid.sale.renderSaleRowById(${id})`));
        assert(!!find(aliceRow, byClass("lm-edit-pencil")));

        await asUser(bob, () => assertRejects(
            () => invoke("rabid.sale.saveForm($arg0)", {
                sale_id: String(id), amount: "1", "before-amount": "80"}),
            Error, "Not permitted to edit this sale"));
        const res = await asUser(alice, () => invoke("rabid.sale.saveForm($arg0)", {
            sale_id: String(id), amount: "90", "before-amount": "80"}));
        assertEquals(res.action, "reload");
    });
});

test("service rows: edit ☰ for hosts only; client phone redacted for regulars", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const id = insertService();

        const bobRow = await asUser(bob, () => renderRoute(`rabid.service.renderServiceRowById(${id})`));
        assertEquals(tagOf(bobRow as any), "li");                  // a flat numbered <ol>/<li> row
        assert(!hasText(bobRow, "Add before"), "a regular gets no edit menu");
        assert(!find(bobRow, byClass("lm-edit-pencil")), "a regular gets no pencil");
        assert(hasText(bobRow, "Jo Client"));

        const aliceRow = await asUser(alice, () => renderRoute(`rabid.service.renderServiceRowById(${id})`));
        assert(hasText(aliceRow, "Add before") && hasText(aliceRow, "Delete"), "host gets the ☰ menu");
        assert(!!find(aliceRow, byClass("lm-edit-pencil")), "host gets the pencil beside the ☰");

        // Client PII: phone redacted for a regular volunteer, visible to a host.
        const bobDetail = await asUser(bob, () => renderRoute(`rabid.service.detailPage(${id})`));
        assert(!hasText(bobDetail, "(555) 999-0000"));
        assert(hasText(bobDetail, "***"));
        const aliceDetail = await asUser(alice, () => renderRoute(`rabid.service.detailPage(${id})`));
        assert(hasText(aliceDetail, "(555) 999-0000"));

        await asUser(bob, () => assertRejects(
            () => invoke("rabid.service.saveForm($arg0)", {
                service_id: String(id), client_name: "Hijacked", "before-client_name": "Jo Client"}),
            Error, "Not permitted to edit this service"));
    });
});

test("timesheet rows: self-or-host edit (a volunteer manages their OWN time)", async () => {
    await withTestDb(async ({ alice, bob, carol }) => {
        const bobsEntry = insertTimesheet(bob);
        const carolsEntry = insertTimesheet(carol);

        // bob: his own entry carries the pencil, carol's doesn't (same
        // navigable species either way).
        const own = await asUser(bob, () => renderRoute(`rabid.timesheet_entry.renderTimesheetRowById(${bobsEntry})`));
        assert(!!find(own, byClass("lm-edit-pencil")));
        assert(hasText(own, "3.0 hrs"));
        const others = await asUser(bob, () => renderRoute(`rabid.timesheet_entry.renderTimesheetRowById(${carolsEntry})`));
        assertEquals(tagOf(others as any), "div");
        assert(!find(others, byClass("lm-edit-pencil")));

        // bob edits his own; carol's is rejected; the host edits anyone's.
        const res = await asUser(bob, () => invoke("rabid.timesheet_entry.saveForm($arg0)", {
            timesheet_entry_id: String(bobsEntry), notes: "fixed brakes", "before-notes": ""}));
        assertEquals(res.action, "reload");
        await asUser(bob, () => assertRejects(
            () => invoke("rabid.timesheet_entry.saveForm($arg0)", {
                timesheet_entry_id: String(carolsEntry), notes: "x", "before-notes": ""}),
            Error, "Not permitted to edit this timesheet_entry"));
        const hostRes = await asUser(alice, () => invoke("rabid.timesheet_entry.saveForm($arg0)", {
            timesheet_entry_id: String(carolsEntry), notes: "host note", "before-notes": ""}));
        assertEquals(hostRes.action, "reload");
    });
});

test("the three top-level pages render their (empty or seeded) standard lists", async () => {
    await withTestDb(async ({ alice, bob }) => {
        insertSale(alice);
        const sales = await asUser(bob, () => renderRoute(`sales`));
        assert(hasText(sales, "Sales"));
        assert(hasText(sales, "Blue commuter"));

        const service = await asUser(bob, () => renderRoute(`service`));
        assert(hasText(service, "No service records yet."));

        insertTimesheet(bob);
        const timesheets = await asUser(bob, () => renderRoute(`timesheets`));
        assert(hasText(timesheets, "3.0 hrs"));
    });
});
