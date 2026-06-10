// Sales, service and timesheets in the standard editable-item markup: the
// baseline row species + edit gating for each (structured views come later).
//   sale/service: host/admin-edit;  timesheet: self-or-host (ownerId).
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, renderRoute, invoke, asUser, asSystem } from "./testing.ts";
import { find, byClass, tagOf, attr, hasText } from "../liminal/testing/markup-assert.ts";
import { rabid } from "./rabid.ts";

function insertSale(by: number): number {
    return asSystem(() => rabid.sale.insert({
        sale_time: '2026-06-13 14:00:00', sale_recorded_by: by,
        sale_kind: 'bike', description: 'Blue commuter', amount: 80,
        payment_method: 'cash', notes: undefined,
    }));
}

function insertService(): number {
    return asSystem(() => rabid.service.insert({
        event_id: undefined, client_name: 'Jo Client', client_postal: undefined,
        client_phone: '(555) 999-0000', client_number_of_people_served: 1,
        service_kind: 'diy', service_description: 'Flat tire',
        service_check_in_time: '2026-06-13 13:00:00', service_done: 0,
        service_record_closed_time: undefined,
        will_pick_up: 0, scheduled_pick_up_time: undefined, pick_up_done: 0,
        work_start_time: undefined, work_end_time: undefined, work_stand_id: undefined,
        notes: undefined,
    }));
}

function insertTimesheet(volunteer_id: number): number {
    return asSystem(() => rabid.timesheet_entry.insert({
        volunteer_id, event_id: undefined,
        start_time: '2026-06-13 18:00:00', end_time: '2026-06-13 21:00:00',
        start_time_is_approximate: 0, end_time_is_approximate: 0, end_time_is_provisional: 0,
        notes: '', km_driven_for_reimbursement: 0, km_driven_processed: 0,
        is_paid_time: 0, paid_time_processed: 0, entry_creation_time: undefined,
    }));
}

test("sale rows: host edits, regular navigates; saveForm host-gated", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const id = insertSale(alice);

        const bobRow = await asUser(bob, () => renderRoute(`rabid.sale.renderSaleRowById(${id})`));
        assertEquals(tagOf(bobRow as any), "a");
        assert(!!find(bobRow, byClass("lm-nav-chevron")));
        assert(hasText(bobRow, "Blue commuter"));
        assert(hasText(bobRow, "$80.00"));

        const aliceRow = await asUser(alice, () => renderRoute(`rabid.sale.renderSaleRowById(${id})`));
        assert(!!find(aliceRow, byClass("lm-edit-pencil")));

        await asUser(bob, () => assertRejects(
            () => invoke("rabid.sale.saveForm($arg0)", {
                sale_id: String(id), amount: "1", "before-amount": "80"}),
            Error, "Not permitted to edit this bike_sale"));
        const res = await asUser(alice, () => invoke("rabid.sale.saveForm($arg0)", {
            sale_id: String(id), amount: "90", "before-amount": "80"}));
        assertEquals(res.action, "reload");
    });
});

test("service rows: host edits, regular navigates; client phone redacted for regulars", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const id = insertService();

        const bobRow = await asUser(bob, () => renderRoute(`rabid.service.renderServiceRowById(${id})`));
        assertEquals(tagOf(bobRow as any), "a");
        assert(hasText(bobRow, "Jo Client"));

        const aliceRow = await asUser(alice, () => renderRoute(`rabid.service.renderServiceRowById(${id})`));
        assert(!!find(aliceRow, byClass("lm-edit-pencil")));

        // Client PII: phone redacted for a regular volunteer, visible to a host.
        const bobDetail = await asUser(bob, () => renderRoute(`rabid.service.detailPage(${id})`));
        assert(!hasText(bobDetail, "(555) 999-0000"));
        assert(hasText(bobDetail, "***"));
        const aliceDetail = await asUser(alice, () => renderRoute(`rabid.service.detailPage(${id})`));
        assert(hasText(aliceDetail, "(555) 999-0000"));

        await asUser(bob, () => assertRejects(
            () => invoke("rabid.service.saveForm($arg0)", {
                service_id: String(id), service_done: "1", "before-service_done": "0"}),
            Error, "Not permitted to edit this service"));
    });
});

test("timesheet rows: self-or-host edit (a volunteer manages their OWN time)", async () => {
    await withTestDb(async ({ alice, bob, carol }) => {
        const bobsEntry = insertTimesheet(bob);
        const carolsEntry = insertTimesheet(carol);

        // bob: his own entry is an editable surface, carol's is navigable.
        const own = await asUser(bob, () => renderRoute(`rabid.timesheet_entry.renderTimesheetRowById(${bobsEntry})`));
        assert(!!find(own, byClass("lm-edit-pencil")));
        assert(hasText(own, "3.0 hrs"));
        const others = await asUser(bob, () => renderRoute(`rabid.timesheet_entry.renderTimesheetRowById(${carolsEntry})`));
        assertEquals(tagOf(others as any), "a");

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
