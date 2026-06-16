// fieldPickerOptions backs every foreign-key picker - the type-ahead <select>
// in edit forms loads its options from it as the user types.  Two regressions
// this guards:
//   1. timesheet_entry.volunteer_id must resolve to volunteer NAMES (the FK's
//      labelField), not raw numeric ids.
//   2. the route must be reachable under routeterp:strict.  It was undeclared,
//      so a GET 404'd (RouteUndeclaredError) and type-ahead search silently
//      returned nothing while the picker still showed its current option.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertRejects } from "../liminal/testing/assert.ts";
import { withTestDb, renderRoute, asUser, asAnon } from "./testing.ts";
import { getRabid } from "./rabid.ts";
import { routePermissionOf, routeIsMutation } from "../liminal/security.ts";

const PICKER = `rabid.timesheet_entry.fieldPickerOptions('volunteer_id',queryArgs)`;
type Option = { id: any, label: any };
const pick = (m: unknown) => m as unknown as Option[];

test("fieldPickerOptions is a declared, non-mutation (GET) route", () => {
    const t = getRabid().timesheet_entry;
    assert(routePermissionOf(t, "fieldPickerOptions") !== undefined,
        "fieldPickerOptions must be a declared route (else it 404s under strict)");
    assertEquals(routeIsMutation(t, "fieldPickerOptions"), false,
        "it's a read - GET must be allowed");
});

test("fieldPickerOptions: the volunteer picker returns names, not ids", () =>
    withTestDb(({ bob }) => asUser(bob, async () => {
        const opts = pick(await renderRoute(PICKER));
        assert(opts.length > 0);
        for(const o of opts) {
            assertEquals(typeof o.label, "string");
            assert((o.label as string).length > 0);
            assert(Number.isFinite(Number(o.id)));
            // The whole point: the label is a name, not the stringified id.
            assertEquals(String(o.id) === String(o.label), false);
        }
        assert(opts.some(o => o.label === "Bob Shares"),
            "the picker should list volunteers by name");
    })));

test("fieldPickerOptions: the q term filters by word-prefix on the label", () =>
    withTestDb(({ bob }) => asUser(bob, async () => {
        const opts = pick(await renderRoute(PICKER, { queryArgs: { q: "Carol" } }));
        assertEquals(opts.map(o => o.label), ["Carol Private"]);
        // '' returns everyone (the four fixture volunteers).
        const all = pick(await renderRoute(PICKER, { queryArgs: { q: "" } }));
        assertEquals(all.length, 4);
    })));

test("fieldPickerOptions: anonymous is denied (authenticated route)", () =>
    withTestDb(() => asAnon(() =>
        assertRejects(() => renderRoute(PICKER)))));
