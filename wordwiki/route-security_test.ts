// deno-lint-ignore-file no-explicit-any
/**
 * Route-security declarations for the lexeme editor (the wordwiki side of the
 * @route(perm) migration).  Under the strict routeterp policy, only methods
 * tagged @route are URL-reachable; everything else 404s.  This pins WHICH
 * editor members are routes (all need a logged-in user - finer edit/approve
 * checks live inside the methods) and, just as importantly, that the internal
 * builders are NOT exposed.  Inert under the jsterp pin wordwiki currently runs.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertThrows } from "../liminal/testing/assert.ts";
import { routePermissionOf, routeIsMutation, authenticated, hostOrAdmin } from "../liminal/security.ts";
import { evalRouteExprSrc, RouteUndeclaredError, RouteDeniedError } from "../liminal/routeterp.ts";
import { withTestDb, as, TestTimeline, mkEntry } from "./testing.ts";
import { LexemeEditor } from "./lexeme-editor.ts";
import { PageRoutes } from "./render-page-editor.ts";
import { WordWiki } from "./wordwiki.ts";

// Every URL-reachable editor route (an hx-get fragment, a dialog url, or a tx
// expr) - all behind `authenticated`.
const EDITOR_ROUTES = [
    "entryPage", "renderEntry", "renderRelationFragment", "renderTupleFragment",
    "renderReviewGroupFragment", "renderReviewPending",
    "editDialog", "insertDialog", "historyDialog", "deletedDialog",
    "revertDialog", "commentDialog",
    "saveTuple", "reviewApprove", "submitRevert", "submitComment",
    "move", "deleteTuple", "restoreVersion", "addDocumentReference",
];

// Public, but NOT routes - called only from server code / tests, so they must
// stay unreachable by URL.
const EDITOR_INTERNALS = ["factChangeEvents", "lexemeChangeEvents", "lexemeChangeGroups"];

test("lexeme editor: every URL route is @route-declared", () => {
    for(const name of EDITOR_ROUTES)
        assert(routePermissionOf(LexemeEditor.prototype, name) !== undefined,
               `route '${name}' must be @route-declared`);
});

test("lexeme editor: internal builders are NOT exposed as routes", () => {
    for(const name of EDITOR_INTERNALS)
        assertEquals(routePermissionOf(LexemeEditor.prototype, name), undefined,
                     `'${name}' must not be a route`);
});

test("the lexeme namespace getter is a declared route", () => {
    assert(routePermissionOf(WordWiki.prototype, "lexeme") !== undefined,
           "wordwiki.lexeme must be @route @path");
    // lexemeOps is an internal verb holder, not a dispatch namespace.
    assertEquals(routePermissionOf(WordWiki.prototype, "lexemeOps"), undefined);
});

// End-to-end through the STRICT route interpreter (wordwiki runs jsterp today,
// but this proves the annotations gate correctly when it flips).
test("routeterp strict: editor route resolves for an authed user", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const tl = new TestTimeline();
            fx.ww.applyTransaction([mkEntry(1000, tl.next())], {quiet: true});
            const scope = {wordwiki: fx.ww};
            const page = evalRouteExprSrc(scope, "wordwiki.lexeme.entryPage(1000)", "strict");
            assert(page, "a declared, authorized route should resolve");
        });
    });
});

test("routeterp strict: editor route is DENIED for anon", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => fx.ww.applyTransaction([mkEntry(1000, new TestTimeline().next())], {quiet: true}));
        as(fx, "anon", () => {
            assertThrows(
                () => evalRouteExprSrc({wordwiki: fx.ww}, "wordwiki.lexeme.entryPage(1000)", "strict"),
                RouteDeniedError);
        });
    });
});

test("routeterp strict: an internal builder is UNDECLARED (404s)", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            const scope = {wordwiki: fx.ww};
            assertThrows(
                () => evalRouteExprSrc(scope, "wordwiki.lexeme.lexemeChangeGroups(1000, 0, 0)", "strict"),
                RouteUndeclaredError);
        });
    });
});

// ----- The scanned-document / page editor (wordwiki.pages.*) ----------------
// These used to be bare top-level scope functions, which routeterp does NOT
// gate (an Identifier callee is trusted by being in scope) - so under strict
// they would have been anonymously reachable.  They now live behind the
// @route-gated `wordwiki.pages` namespace, split by sensitivity.

const PAGE_VIEW_ROUTES = [
    "pageEditor", "renderStandaloneGroupAsSvgResponse", "renderPageEditorByPageNumber",
    "renderPageEditorByPageId", "renderTextSearchResults", "forwardToSingleBoundingGroupEditorURL",
];
const PAGE_MUTATION_ROUTES = [
    "updateBoundingBoxShape", "createNewEmptyBoundingGroupForFriendlyDocumentId",
    "newBoundingBoxInNewGroup", "newBoundingBoxInExistingGroup", "copyRefBoxToNewGroup",
    "copyRefBoxToExistingGroup", "copyBoxToExistingGroup", "removeBoxFromGroup", "migrateBoxToGroup",
];

test("the wordwiki.pages namespace getter is a declared route", () => {
    assert(routePermissionOf(WordWiki.prototype, "pages") !== undefined,
           "wordwiki.pages must be @route @path");
});

test("page editor: view routes are authenticated and stay GET-reachable", () => {
    for(const name of PAGE_VIEW_ROUTES) {
        assertEquals(routePermissionOf(PageRoutes.prototype, name), authenticated,
                     `view route '${name}' must be @route(authenticated)`);
        assertEquals(routeIsMutation(PageRoutes.prototype, name), false,
                     `view route '${name}' must NOT be mutates (it is GET-navigated)`);
    }
});

test("page editor: mutation routes are hostOrAdmin and POST-only", () => {
    for(const name of PAGE_MUTATION_ROUTES) {
        assertEquals(routePermissionOf(PageRoutes.prototype, name), hostOrAdmin,
                     `mutation route '${name}' must be @route(hostOrAdmin)`);
        assert(routeIsMutation(PageRoutes.prototype, name),
               `mutation route '${name}' must be mutates (POST-only, closes GET-CSRF)`);
    }
});

test("routeterp strict: the pages namespace resolves for an authenticated non-host", async () => {
    await withTestDb((fx) => {
        as(fx, {actorId: 999, roles: []}, () => {
            const ns = evalRouteExprSrc({wordwiki: fx.ww}, "wordwiki.pages", "strict");
            assert(ns instanceof PageRoutes, "wordwiki.pages should resolve to the PageRoutes holder");
        });
    });
});

test("routeterp strict: a page MUTATION is DENIED for an authenticated non-host", async () => {
    await withTestDb((fx) => {
        as(fx, {actorId: 999, roles: []}, () => {
            // The perm check throws before removeBoxFromGroup runs - no db touched.
            assertThrows(
                () => evalRouteExprSrc({wordwiki: fx.ww}, "wordwiki.pages.removeBoxFromGroup(1)", "strict"),
                RouteDeniedError);
        });
    });
});

test("routeterp strict: a page mutation is allowed for an admin (djz)", async () => {
    await withTestDb((fx) => {
        as(fx, "djz", () => {
            // Authorized: navigation + the hostOrAdmin perm both pass for djz, so
            // it reaches the call.  (We don't assert the result - the bounding
            // box doesn't exist - only that it is NOT a RouteDeniedError.)
            let denied = false;
            try { evalRouteExprSrc({wordwiki: fx.ww}, "wordwiki.pages.removeBoxFromGroup(1)", "strict"); }
            catch(e) { denied = e instanceof RouteDeniedError; }
            assert(!denied, "an admin must not be route-denied a page mutation");
        });
    });
});
