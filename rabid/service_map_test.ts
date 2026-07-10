// Integration for the services-by-area map: the Reports page + the per-event
// footer, verified VIA DISPATCH (the route-undeclared lesson - a page/fragment
// reached by URL must actually route).  The map MATH is covered by the pure
// tests in servicemap/servicemap_test.ts; here we just prove the wiring.
import { test } from "../liminal/testing/test.ts";
import { assert } from "../liminal/testing/assert.ts";
import { withTestDb, renderRoute, asUser, asSystem } from "./testing.ts";
import { find, tagOf, hasText } from "../liminal/testing/markup-assert.ts";
import { rabid } from "./rabid.ts";
import * as date from "../liminal/date.ts";

// An event in the CURRENT calendar year, so it falls inside the map page's
// default (this-year) window.
function eventThisYear(desc = 'Repair Night'): number {
    const y = date.orgNow().year;
    return asSystem(() => rabid.event.insert({
        event_kind: 'shopTime', description: desc, location_description: '', location_url: '',
        is_remote_event: 0, volunteer_only: 0,
        start_time: `${y}-06-15 10:00:00`, end_time: `${y}-06-15 20:00:00`,
        total_cash_collected: 0, notes: '',
    }));
}

function addService(event_id: number, postal: string): void {
    asSystem(() => rabid.service.insert({
        event_id, client_name: 'Jo Client', client_postal: postal,
        service_kind: 'diy', bike_description: 'Blue commuter', service_description: 'Flat tire',
    }));
}

test("services-by-area page renders the map + summary, and routes", async () => {
    await withTestDb(async ({ alice }) => {
        const e = eventThisYear();
        for(const p of ['N2G', 'N2G', 'N2L', 'N1R', 'K1A', '']) addService(e, p);

        const page = await asUser(alice, () => renderRoute('serviceMap'));
        assert(!!find(page, n => tagOf(n) === 'svg'), 'renders the choropleth svg');
        assert(hasText(page, 'Services by area'));
        assert(hasText(page, 'Kitchener'));
        assert(hasText(page, 'In Region of Waterloo'));
        assert(hasText(page, 'No postal code given'), 'the blank postal is counted');
        assert(hasText(page, 'Statistics Canada'), 'licence attribution');

        // Its filter-dialog route dispatches (else strict routeterp 404s it).
        await asUser(alice, () => renderRoute('rabid.service.serviceMapFilterDialog()'));
    });
});

test("per-event footer map: shows once a postal is captured, absent before", async () => {
    await withTestDb(async ({ alice }) => {
        // No services yet -> the fragment routes but draws no map.
        const empty = eventThisYear('Empty');
        const before = await asUser(alice, () => renderRoute(`rabid.service.renderEventServiceMap(${empty})`));
        assert(!find(before, n => tagOf(n) === 'svg'), 'no map before any postal is captured');

        // A service with a real FSA -> the compact map appears.
        const e = eventThisYear('Busy');
        addService(e, 'N2G');
        addService(e, '');   // a blank one doesn't count as "located"
        const after = await asUser(alice, () => renderRoute(`rabid.service.renderEventServiceMap(${e})`));
        assert(!!find(after, n => tagOf(n) === 'svg'), 'the small map renders');
        assert(hasText(after, 'Where clients came from'));
    });
});
