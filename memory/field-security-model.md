---
name: field-security-model
description: "How field-level read/edit privacy works in rabid, and Red Raccoon's open-books privacy stance"
metadata: 
  node_type: memory
  type: project
  originSessionId: 576fa148-8a4a-46dc-9b84-a3b32f7ca4cb
---

Red Raccoon is a volunteer-run, volunteer-controlled, **open-books** org: almost all data is visible to every volunteer. The private surface is small — chiefly **volunteer phone (the primary private field)**, plus email and emergency contact. So the security model favors *redaction* over hiding/erroring, and per-volunteer opt-in/opt-out for contact info.

**Roles** (from the volunteer's `permissions` field): the elevated-visibility role is **`host`** — NOT `staff`. Deliberate: the org is volunteer-controlled and shouldn't bake staff primacy into the model; hosts run events (volunteer nights) and are keyholders. `host` (or `admin`, the system-control role) can see private contact fields. **Hosts can also EDIT volunteer records ("and pretty much anything") — dz revised this 2026-06**: `recordEdit`/`defaultFieldEdit` are selfOrHost; only role management (the `permissions` field) stays admin-only.

Implementation (`liminal/security.ts` + wiring), enforced LOW so a careless route can't bypass it:
- A **Permission** is a predicate over `{ctx, record, ownerId}`. Combinators: `anyone/never/loggedIn/isSelf/hasRole(r)/recordFlag(field)` + `or/and/not`. Actor (`{actorId, roles}`) is resolved once per request in `rabid.rpcHandler` (roles from the volunteer's `permissions` field) and carried ambiently via `AsyncLocalStorage` (`security.enterWith`); `runSystem` bypasses (login lookups, tooling, fake_data).
- Fields declare `view`/`edit`/`redact`; `Table` has `ownerId(record)` + `defaultFieldView`/`defaultFieldEdit` (permissive by default → security is opt-in per table). **edit ⊆ view**.
- **Row level (2026-06)**: `Table.recordEdit` (getter, defaults to `defaultFieldEdit`; declare explicitly on security-sensitive tables) + `canEditRecord(record)` gate whether a record presents an edit affordance at all. Consumed at render (list rows + detail pencil), `renderForm` (refuses to generate the form), and `parseForm` (row gate before the per-field check). UI consequence: lists render **two self-describing row species** — editable surface (pencil, tap edits) vs. navigable item (chevron, whole row is an `<a>` to detail; no nested links so values are plain text) — so tap behaviour follows what the row visibly is, never the viewer's role. Row-level *view* deliberately not built: that's a query concern (WHERE), with `guardResult` as backstop.
- Three field enforcement points: (1) **query layer** — `Table.prepare` tags queries; `PreparedQuery.all/.first` → `Table.guardResult` *redacts* a non-viewable field to the `REDACTED` symbol (shown as a muted `***` with an "ask a host" tooltip via `renderFieldValue`), or **throws** `ReadPermissionError` if the field isn't `redact`-able; (2) **renderForm** only emits inputs for editable fields; (3) **parseForm** rejects writes to non-editable fields (crafted-POST backstop).
- `***` ≠ blank: redacted means "hidden from you, ask a host"; blank means "nothing on file."

**Auth (2026-06):** bcrypt $2b$ cost 12; sessions server-revocable; Secure cookie flag on production. Password-reset = host-issued single-use links (`password_reset` table stores only the SHA-256 of the token; redeeming consumes ALL outstanding tokens + kills all sessions + auto-logs-in; generic invalid message, no enumeration). Bulk onboarding: `deno run -A rabid/rabid.ts reset-links <baseUrl> <out.csv>` (server stopped). **Gmail integration is planned** (then self-serve forgot-password reuses the same tokens). Known-open audit items (deliberately deferred): no login rate limiting (bcrypt cost also = cheap CPU-DoS), login error messages enumerate accounts, sessions never expire server-side, `last_ip` unfilled, session tokens plaintext at rest.

Volunteer policy (`rabid/volunteer.ts`): open by default; `phone` opt-in (`phone_number_visible_to_all_volunteers`, private by default), `email` opt-out (`email_visible_to_all_volunteers`, shared by default), emergency contact self-or-host — all `redact:true`; `permissions` admin-only to edit. Schema changes during prototyping: edit the table fields, then run `create_fake_data.sh` (drops + rebuilds the DB from `rabid.tables` DML and repopulates). See [[ui-mutation-model]].
