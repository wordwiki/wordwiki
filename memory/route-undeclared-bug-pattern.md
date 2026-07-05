---
name: route-undeclared-bug-pattern
description: "Recurring bug — a method reached via URL/hx-post/rpc but missing its @route decorator 404s \"not found\" under strict routeterp; direct-call tests miss it"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 5af7b4bf-e3c4-4084-a90c-b235feddb9df
---

Recurring bug class in this repo (bitten twice: photo `upload`/`serve`, and reset `resetLinkView` — both fixed 2026-07-05).

**Symptom:** a method reached from the client (rpc, `hx-post`, an `<img>` src route, etc.) returns 404 `{error:'not found'}` — surfaced in the UI as "… failed: not found". Under the strict routeterp policy (the default, pinned in tests), any member reached via URL that lacks a `@route`/`@routeMutation`/`@publicRoute` decorator throws `RouteUndeclaredError: '<Class>.<method>' is not an exposed route member` → 404.

**Why it slips through tests:** unit tests often call the method DIRECTLY (`svc.upload(...)`, `app.makeResetLinkPath(...)`), which bypasses the interpreter, so a missing decorator passes. Comments may even *call* it a route while the decorator is absent.

**How to catch/verify:** drive it through the real interpreter — `getRabid().dispatch('rabid.x.method(...)', {httpMethod})` or the `invoke`/`renderRoute` test helpers (rabid/testing.ts) under `asUser(...)`. Add a `route_security_test.ts` tripwire (`routePermissionOf`/`routeIsMutation`) pinning the decorator + mutation flag. Proof technique: temporarily remove the decorator and confirm the dispatch test fails with `RouteUndeclaredError`.

**Fix:** decorate mutations (writes, POST-only) with `@routeMutation(perm)` / `@route(perm,{mutates:true})`, reads with `@route(perm)`. Perms from `liminal/security.ts` (`authenticated`, `hostOrAdmin`, `publicRoute(...)`). Follow the wordwiki `AudioRoutes` delegator pattern. Related: [[route-security-migration]], [[liminal-mail-feature]].
