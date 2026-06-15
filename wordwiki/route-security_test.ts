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
import { routePermissionOf } from "../liminal/security.ts";
import { evalRouteExprSrc, RouteUndeclaredError, RouteDeniedError } from "../liminal/routeterp.ts";
import { withTestDb, as, TestTimeline, mkEntry } from "./testing.ts";
import { LexemeEditor } from "./lexeme-editor.ts";
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
