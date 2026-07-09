// Conditional field visibility (FieldOptions.showWhen): a field is wrapped, in
// the rendered form, with data-show-when state tokens; the client (liminal-
// scripts.js) hides it while the form's state classes don't match.  See
// liminal.md § Conditional field visibility.  (Server-side coverage; the actual
// show/hide is client JS, exercised live via the test client.)
import { test } from "../liminal/testing/test.ts";
import { assert, assertThrows } from "../liminal/testing/assert.ts";
import { withTestDb, renderRoute, asUser, asSystem } from "./testing.ts";
import { StringField } from "../liminal/table.ts";
import { rabid } from "./rabid.ts";

function insertEvent(): number {
    return asSystem(() => rabid.event.insert({
        event_kind: 'public', description: 'Night', location_description: '', location_url: '',
        is_remote_event: 0, volunteer_only: 0, start_time: '2026-06-20 19:00:00',
        end_time: '2026-06-20 21:00:00', total_cash_collected: 0, notes: ''} as any));
}
function insertServiceDiy(): number {
    return asSystem(() => rabid.service.insert(
        {event_id: insertEvent(), client_name: 'Jo', service_kind: 'diy', bike_description: 'Red mtb'} as any));
}

test("showWhen renders a field inside a data-show-when wrapper carrying its state token", () => {
    // Generic: a field with showWhen produces the wrapper attrs; unsafe values throw.
    const f = new StringField('drop_off_notes', {default: '', showWhen: {field: 'service_kind', in: ['full']}});
    const attrs = f.conditionalWrapperAttrs()!;
    assert(attrs['data-show-when'] === 'enum__service_kind__full', 'encodes the state token');
    assert((attrs.style || '').includes('display:contents'), 'transparent wrapper');

    const plain = new StringField('client_name', {});
    assert(plain.conditionalWrapperAttrs() === undefined, 'unconditional field: no wrapper');

    assertThrows(() => new StringField('x', {showWhen: {field: 'k', in: ['not safe!']}}).conditionalWrapperAttrs(),
                 Error, 'CSS-identifier-safe');
});

test("service form: drop-off fields render for ANY kind, wrapped to reveal only for 'full'", () =>
    withTestDb(async ({ alice }) => {
        const sid = insertServiceDiy();   // a DIY service - drop-off still RENDERS (client hides it)
        const form = await asUser(alice, () => renderRoute(`rabid.service.renderServiceForm(${sid})`));
        const s = JSON.stringify(form);

        // The driver + core fields are present as usual.
        assert(s.includes('service_kind') && s.includes('client_name'), 'driver + core fields render');
        // Drop-off fields are in the form regardless of kind...
        assert(s.includes('drop_off_notes') && s.includes('drop_off_ready_call_done'), 'drop-off fields render');
        // ...each wrapped with the token that reveals it when service_kind is 'full'.
        assert(s.includes('data-show-when') && s.includes('enum__service_kind__full'),
               'drop-off fields carry the reveal token');
    }));

test("add dialog is the SAME form as edit: drop-off fields present + wrapped (hide/show works on add too)", () =>
    withTestDb(async ({ alice }) => {
        const eid = insertEvent();
        const dialog = await asUser(alice, () => renderRoute(`rabid.service.newServiceForEventDialog(${eid})`));
        const s = JSON.stringify(dialog);
        assert(s.includes('service_kind') && s.includes('client_name'), 'driver + core fields');
        assert(s.includes('drop_off_notes') && s.includes('drop_off_ready_call_done'),
               'the add dialog now carries the drop-off fields too');
        assert(s.includes('data-show-when') && s.includes('enum__service_kind__full'),
               'wrapped for reveal - hide/show works on add, not just edit');
    }));

// --- Sale: money fields conditional on paid kinds; phone on the loan kind -------

function insertSale(kind: string, actor: number): number {
    return asSystem(() => rabid.sale.insert({
        event_id: insertEvent(), sale_time: '2026-06-20 14:00:00', sale_recorded_by: actor,
        sale_kind: kind, description: 'Blue commuter', amount: kind === 'bike' ? 80 : 0,
        payment_method: 'cash'} as any));
}

test("sale edit form: amount/payment wrapped for paid kinds, phone for the loan; auto fields omitted", () =>
    withTestDb(async ({ alice }) => {
        const sid = insertSale('bike', alice);
        const form = await asUser(alice, () => renderRoute(`rabid.sale.renderForm(rabid.sale.getById(${sid}))`));
        const s = JSON.stringify(form);
        // edit:never auto fields don't appear as inputs in the editor.  (The field
        // names still show inside dirty-key selectors in the dispatch, so check for
        // an actual input name, not the bare substring.)
        assert(!s.includes('"name":"sale_recorded_by"') && !s.includes('"name":"sale_time"'),
               'sale_time / sale_recorded_by are not editable inputs');
        // amount + payment reveal for the PAID kinds (derived from isFreeSaleKind).
        assert(s.includes('data-show-when') && s.includes('enum__sale_kind__bike'),
               'money fields carry the paid-kind reveal token');
        // client_phone reveals only for a balance-bike loan.
        assert(s.includes('enum__sale_kind__balance-bike-loan'), 'phone carries the loan reveal token');
        // client_name is unconditional (always shown - no wrapper token needed).
        assert(s.includes('client_name'), 'client_name always present');
    }));

test("sale add menu is per-kind: a loan dialog has name+phone (no money); a bike has name+money", () =>
    withTestDb(async ({ alice }) => {
        const eid = insertEvent();
        const loan = JSON.stringify(await asUser(alice, () =>
            renderRoute(`rabid.sale.newSaleForEventDialog(${eid}, 'balance-bike-loan')`)));
        assert(loan.includes('client_name') && loan.includes('client_phone'), 'loan: name + phone');
        assert(!loan.includes('"name":"amount"'), 'loan: no amount');

        const bike = JSON.stringify(await asUser(alice, () =>
            renderRoute(`rabid.sale.newSaleForEventDialog(${eid}, 'bike')`)));
        assert(bike.includes('client_name') && bike.includes('"name":"amount"'), 'bike: name + amount');
        assert(!bike.includes('client_phone'), 'bike: no phone');
    }));
