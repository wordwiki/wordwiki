// Route-security audit tripwire.  The PUBLIC (anonymous-reachable) surface is
// the highest-risk part of the route model, so pin it exactly: adding a new
// publicRoute anywhere on the app object breaks this test and forces a review.
// Also spot-checks that sensitive routes are NOT public and that internal/query
// members stay unexposed (undeclared -> unreachable under strict).
import { test } from "../liminal/testing/test.ts";
import { assertEquals, assert, assertRejects } from "../liminal/testing/assert.ts";
import { getRabid, rabid } from "./rabid.ts";
import { routePermissionOf, routeIsMutation, publicRouteReason } from "../liminal/security.ts";
import { withTestDb, renderRoute, invoke, asUser, asSystem } from "./testing.ts";

// Every public route declared directly on the app object (walking its prototype
// chain): the name of any method/getter whose @route permission is a publicRoute.
function publicAppRoutes(app: any): string[] {
    const out = new Set<string>();
    for(let o = app; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
        for(const name of Object.getOwnPropertyNames(o)) {
            const perm = routePermissionOf(app, name);
            if(perm && publicRouteReason(perm) !== undefined) out.add(name);
        }
    }
    return [...out].sort();
}

test("the public route surface is exactly the auth entry points", () => {
    const rabid = getRabid();
    // GOLDEN: the complete set of anonymous-reachable app routes.  Update this
    // list ONLY with a deliberate, reviewed decision to expose a new public route.
    assertEquals(publicAppRoutes(rabid), [
        "login",
        "loginRequest",
        "logout",
        "resetPassword",
        "resetPasswordRequest",
    ]);
});

test("sensitive routes are declared but NOT public", () => {
    const rabid = getRabid();
    const notPublic = (obj: any, name: string) => {
        const perm = routePermissionOf(obj, name);
        assert(perm !== undefined, `${name} should be a declared route`);
        assertEquals(publicRouteReason(perm), undefined, `${name} must NOT be public`);
    };
    notPublic(rabid, "resetLinkDialog");               // host-only (mints reset links)
    notPublic(rabid.event_checkin, "checkIn");         // host-only (check others in)
    notPublic(rabid.volunteer, "detailPage");          // authenticated
    notPublic(rabid.event, "saveForm");                // authenticated (base Table)
    notPublic(rabid.photo, "upload");                  // authenticated (photo upload rpc)
    notPublic(rabid.photo, "serve");                   // authenticated (sized <img> route)
});

test("internal + query members are unexposed (unreachable under strict)", () => {
    const rabid = getRabid();
    const undeclared = (obj: any, name: string) =>
        assertEquals(routePermissionOf(obj, name), undefined, `${name} must stay unexposed`);
    undeclared(rabid, "passwordHash");                 // internal auth table getter
    undeclared(rabid, "volunteerLoginSession");        // internal session table
    undeclared(rabid.event, "allEvents");              // a @path query getter (data via .all)
    undeclared(rabid.photo, "sizedPhotoPath");         // internal resize helper (not a route)
    undeclared(rabid.photo, "resizePhotoCmd");         // internal ImageMagick shell-out
});

test("mutations are POST-only; reads are not (CSRF axis)", () => {
    const r = getRabid();
    // Writes flagged as mutations (reached only via POST).
    assert(routeIsMutation(r.event_checkin, "checkSelfIn"));
    assert(routeIsMutation(r.event_checkin, "checkOut"));
    assert(routeIsMutation(r.volunteer_time, "addTimesheet"));
    assert(routeIsMutation(r.event, "saveForm"));          // base Table.saveForm
    assert(routeIsMutation(r.photo, "upload"));            // photo upload writes to content store
    // Reads / dialogs are NOT mutations (GET is fine).
    assert(!routeIsMutation(r.event, "detailPage"));
    assert(!routeIsMutation(r.event_checkin, "checkInDialog"));
    assert(!routeIsMutation(r.event, "renderEventRowById"));
    assert(!routeIsMutation(r.photo, "serve"));            // sized <img> src is a GET
});

test("a mutation route reached via GET is rejected; POST works", () => {
    return withTestDb(async ({ bob }) => {
        const id = asSystem(() => rabid.event.insert({
            event_kind: 'public', description: 'Repair Night', location_description: '',
            location_url: '', is_remote_event: 0, volunteer_only: 0,
            start_time: '2026-06-20 19:00:00', end_time: '2026-06-20 21:30:00',
            total_cash_collected: 0, notes: '',
        }));
        // renderRoute dispatches as GET -> the mutation is refused.
        await asUser(bob, () => assertRejects(
            () => renderRoute(`rabid.event_checkin.checkSelfIn(${id})`),
            Error, "must be POST"));
        // invoke dispatches as POST -> it goes through.
        const res = await asUser(bob, () => invoke(`rabid.event_checkin.checkSelfIn($arg0)`, id));
        assertEquals(res.action, "reload");
    });
});
