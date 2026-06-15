// Route-security audit tripwire.  The PUBLIC (anonymous-reachable) surface is
// the highest-risk part of the route model, so pin it exactly: adding a new
// publicRoute anywhere on the app object breaks this test and forces a review.
// Also spot-checks that sensitive routes are NOT public and that internal/query
// members stay unexposed (undeclared -> unreachable under strict).
import { test } from "../liminal/testing/test.ts";
import { assertEquals, assert } from "../liminal/testing/assert.ts";
import { getRabid } from "./rabid.ts";
import { routePermissionOf, publicRouteReason } from "../liminal/security.ts";

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
});

test("internal + query members are unexposed (unreachable under strict)", () => {
    const rabid = getRabid();
    const undeclared = (obj: any, name: string) =>
        assertEquals(routePermissionOf(obj, name), undefined, `${name} must stay unexposed`);
    undeclared(rabid, "passwordHash");                 // internal auth table getter
    undeclared(rabid, "volunteerLoginSession");        // internal session table
    undeclared(rabid.event, "allEvents");              // a @path query getter (data via .all)
});
