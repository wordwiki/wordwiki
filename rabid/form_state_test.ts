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

function insertServiceDiy(): number {
    const event_id = asSystem(() => rabid.event.insert({
        event_kind: 'public', description: 'Night', location_description: '', location_url: '',
        is_remote_event: 0, volunteer_only: 0, start_time: '2026-06-20 19:00:00',
        end_time: '2026-06-20 21:00:00', total_cash_collected: 0, notes: ''} as any));
    return asSystem(() => rabid.service.insert(
        {event_id, client_name: 'Jo', service_kind: 'diy', bike_description: 'Red mtb'} as any));
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
