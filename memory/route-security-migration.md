---
name: route-security-migration
description: Staged plan to move request/route security onto the field/table Permission model (routeterp permissive→strict)
metadata: 
  node_type: memory
  type: project
  originSessionId: 0fca39c7-a1e6-4240-b730-70d32e34def8
---

Extending the same `security.Permission` vocabulary (`or`/`hasRole`/`isSelf`,
see [[field-security-model]]) from fields and tables to **routes**. rabid is the
test bed; wordwiki stays on jsterp until rabid is done, then migrates too.

**COMPLETE (commit 7b360d5): jsterp is unhooked — `routeterp` is the only
router.** evalRoute always uses routeterp; the `LIMINAL_ROUTE_EVAL`/
`RABID_ROUTE_EVAL` mode switch and the env exports in rabid.sh/wordwiki.sh are
gone. Policy still reads `LIMINAL_ROUTE_POLICY` (default `strict`, fail-closed;
`permissive` only for debugging). jsterp.ts is KEPT (untouched, with its
self-test) but imported nowhere live; markup.ts's disabled jsTerp render feature
was removed too. jsterp never backed `/eval` (that's native eval via evalServer,
dev-only). Verified live: env-free rabid → strict (anon→login, GET-mutation→405).
`@safe` is also DELETED (commit fff7050) — `@route` is the sole capability+authz
marker. **MIGRATION COMPLETE**: both apps on routeterp:strict; jsterp + @safe
retired (jsterp.ts file kept but imported nowhere). Possible future work only:
SameSite/CSRF-token hardening, an optional verify-routes CLI.

History — two interpreters used to evaluate route expressions: `jsterp` (full,
unsafe — the hole) and `routeterp` (restricted safe grammar). routeterp has
`LIMINAL_ROUTE_POLICY=permissive|strict`.

Staged migration (each step strictly safer than the last):
1. **DONE (commit 5429e54)** — routeterp `permissive` policy: undeclared members
   allowed but logged once (`ROUTE-SECURITY undeclared member: Class.member`) =
   the annotation worklist. `rabid.sh` defaults to `routeterp:permissive`. Proves
   the safe grammar runs the whole site before any annotations (all 193 tests +
   live site clean, zero grammar throws). Permissive already kills jsterp's
   arbitrary-JS hole.
2. **DONE** — `@route(perm)` mechanism (commit 14cf119) + full annotation
   (commit 4f01026). `@route` reuses the Permission vocab and is args-aware
   (`selfArg(pick)` reads the call args, so arg-subject routes express "self"
   pre-record-load). Annotation set = static scan of emitted route strings
   (tx``/dialogUrl/pageLink/reload) ∪ runtime worklist (scan caught
   reachable-but-untested routes). Coarse vocab: `publicRoute(reason)` (login/
   reset), `hostOrAdmin` (create/manage-others), `or(hostOrAdmin, selfArg(...))`
   (own time/check-out), `authenticated` (everything else; base Table
   getById/renderForm/saveForm/renderRowById covers subclasses via proto walk).
   Permissive worklist now EMPTY; default+permissive suites green (193). NB
   `@route` ≠ exposure-via-`@path`: only `@route`/`@safe` expose to routeterp;
   `@path` query getters stay unreachable, and query DATA is guarded at
   `.all`/`.first` (ambient ctx + field tags), not at the route.
3. **DONE (commit a853d69)** — rabid runs `routeterp:strict` (rabid.sh).
   Dispatcher (liminal rpcHandler): RouteUndeclaredError → 404; RouteDeniedError
   → anonymous bounces to login, authenticated-insufficient → 403. The
   `rewriteUnauthenticatedRoute` string allowlist is GONE — replaced by a
   `loginRouteFor()` hook used only on an anonymous denial; the public surface is
   now `@route(publicRoute(...))`. Page routes are bare identifiers (auto-invoked,
   NOT @route-gated), so rabid wraps each to require a login. `setRouteEval()`
   lets the test harness run strict (testing.ts opts in), so the suite tests the
   shipped config; the 5 deny-path assertions now expect the route-layer message.
   Golden tripwire: rabid/route_security_test.ts pins the exact public set
   (login/loginRequest/logout/resetPassword/resetPasswordRequest). 196 green
   under strict; live smoke verified (anon→login no leak, authed→pages,
   undeclared→404).
4. **DONE (commit 9ff4685)** — GET-vs-POST / CSRF axis: `@route(perm,{mutates})`
   / `routeMutation(perm)` marks a state-changing route POST-only; routeterp
   (strict) throws RouteMethodError on a GET to a mutates route (checked before
   auth, not bypassed by system ctx), liminal → 405. HTTP method threaded
   request→rpcHandler→dispatch→evalRoute (default POST); test harness sends
   renderRoute as GET, invoke as POST. Every write flagged routeMutation
   (saveForm, check*/editCheckin, addTimesheet/checkIntoEvent, member add/remove,
   task/subtask actions, resetPasswordRequest). loginRequest + logout stay
   GET-able on purpose (dev URL-login shortcut; harmless logout-CSRF). 198 green.
5. **In progress (wordwiki side, still jsterp-pinned)**: annotate wordwiki, then
   flip wordwiki.sh off jsterp, then delete jsterp + `@safe`.
   - DONE: lexeme editor (`wordwiki.lexeme.*`, all 20 URL routes `@route`'d;
     internal builders left undeclared), login surface (`loginRouteFor` rename +
     `@route(publicRoute(..))` on login/loginRequest/logout, commits 9284378), and
     a production GET-login guard re-added in requestHandler (c2231ee).
   - DONE: **page editor** namespaced under `wordwiki.pages.*` (commit 3aae103).
     It was bare top-level scope fns (updateBoundingBoxShape, newBoundingBox*, …)
     — routeterp does NOT gate a bare Identifier callee (trusted by being in
     scope), so they'd be anon-reachable under strict. Wrapped in a `PageRoutes`
     holder (thin delegators): view/render routes `authenticated`, mutations
     `hostOrAdmin`+mutates (tightens old blanket-authenticated). All call sites
     (navbar, lexeme-editor embeds, internal URL builders, page-editor.ts rpc``)
     → `wordwiki.pages.*`. Public /page/<Book>/<N>.html viewer untouched (calls
     pageEditor() directly, pre-gate). page-editor.ts is the browser bundle
     (transpile.sh→~/mmo/scripts, run by wordwiki.sh on start) — restart ships it.
   - DONE: **audio + publish** namespaced under `wordwiki.audio.*` /
     `wordwiki.publish.*` (commit 543b2a0) — the last bare top-level route
     tables. audio=authenticated (uploadRecording +mutates); publish=hostOrAdmin
     (startPublish/publishStatus stay GET-able, NOT mutates - navbar link + a GET
     status view). The root route scope now binds ONLY `wordwiki` (verified live:
     bare `/ww/publishStatus(false)` → 400 "unbound identifier", namespaced → 200).
   - DONE (commit 7215144): the Table `@path` getters on WordWiki
     (`config`/`users`/`categories`/`lexicalForms` → authenticated;
     passwordHash/userSession left unexposed), category.ts/lexical-form.ts verbs
     (reads authenticated, newDialog admin), the WordWiki page/report/entry routes
     (home/*Page/*Directory/entriesBy*/entry/search*/todoReport → authenticated;
     newLexemeAction → routeMutation), and the base liminal test-bridge routes
     (testClient*/runBrowserTests → authenticated; also fixed a latent rabid gap).
   - **DONE (commit d05b47b) — FLIPPED**: wordwiki.sh now defaults
     routeterp:strict; wordwiki/testing.ts opts the suite into strict (renderRoute
     GET, invoke POST). Permissive worklist empty; 179 green under strict; no
     bare-identifier route tables left (root scope binds only `wordwiki`).
     LIVE-SMOKED on wordwiki 2026-06-15 (restarted onto strict, full suite 377
     green): undeclared route → `routeterp: unbound identifier` (was `jsterp:`);
     anon hit on `wordwiki.lexeme.entryPage(1)` → login page, no data leak;
     authed djz → home / publish status (hostOrAdmin) / categoriesPage (table
     getter) all 200.
   - **Remaining cleanup**: delete jsterp + `@safe` now that both apps use
     routeterp. CHECK FIRST whether jsterp still backs the /eval endpoint before
     removing. Optional `verify-routes` CLI. Further CSRF hardening: SameSite
     cookies / CSRF token (POST-only is step one).

Design decisions (dz approved):
- Route perms are **coarse**: `public(reason)` / `authenticated` / role-floor.
  Per-record (self/owner) and per-field redaction STAY where they are — route
  perms run before the record loads (only see `ctx`). Reads default to
  `authenticated`; safe because field-layer redaction backstops sensitive fields
  (open-books: any volunteer sees most everything; only anon-vs-logged-in matters).
- `public` is explicit, noisy, greppable, **never default** (fail-closed).
- Encode read-vs-mutate and bind to HTTP method (GET side-effect-free; mutations
  POST-only) — closes a CSRF class orthogonal to authz. (planned)
- Shared `liminal/` `@route` annotations must be inert under jsterp so wordwiki
  keeps working mid-migration. [[server-restart-protocol]]
