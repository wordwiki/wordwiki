---
name: scan-extract-feature
description: scan→extract substrate BUILT (LLM client + Layer 1 cache + Layer 2 job runner); anchor case = service sheets → service rows
metadata: 
  node_type: memory
  type: project
  originSessionId: 33098663-f83f-4a3d-b467-be218996ac1e
---

Scan → extract (images of documents → structured data via LLM) is BUILT and working in-browser (landed 2026-07-09). Doc of record: repo-root `scan-extract.md` (build spec, marked BUILT).

**Layers:**
- `liminal/llm.ts` — Anthropic structured-extraction client (forced output tool via `tool_choice`); `loadLlm(app)` reads `<app>-anthropic-credential.json`, degrades to `DisabledLlm`. Key lives in gitignored `rabid-anthropic-credential.json` (`{apiKey, defaultModel}`) — the ONLY copy; copy by hand to new checkouts. `rabid.llm` getter/setter (mirrors mailer; test-injectable).
- `liminal/extract.ts` — Layer 1: `extractStage`/`extractAll` memoise `(image, stage, promptVersion, model, imageBox, rotate, input)→JSON` in the derived store (getDerived, `.json`). Per-stage keys ⇒ cache IS the resumability. No tables. `PhotoService.containedBytes` feeds oriented ≤box JPEG.
- Layer 2 (rabid): `extraction_job` table + `JsonField` ([[wordwiki-decomposition]] table conventions); `service.extraction_job_id`/`source_gallery_photo_id` provenance (retract = delete where fk). `extraction_targets.ts` = recipe registry keyed by target_kind; `extraction_job.ts` = runner (startServiceImport→detached run, land, retract, renderEventImports live section).

**Anchor flow:** photograph paper sheets into an event's Service Record Sheets gallery (scope `service-sheets`) → ☰ "Import scanned records…" → live review section → Land → service rows (each stamped w/ source sheet). Ties into [[event-centric-activity-model]] + [[ui-mutation-model]].

**Liveness gotcha:** the runner is detached (outside a request) so `dirty.record` is a no-op there — it appends selector-form dep keys (`.`+key) straight to `rabid.liveLog`; the imports section is live on a per-event key `-extraction_job-event-<id>-`.

**Also fixed here:** `liminal/db.ts` `PRAGMA journal_mode=TRUNCATE` — the fake-data regen was crashing 100% on a wasm-VFS journal-delete race; TRUNCATE avoids the unlink. See [[wordwiki-db-location]].

Deferred: editable staged rows (corrections happen post-land on real records), PDM Layer-1 grading harness, ingestion tables (`source_page`/`page_region`) for the harder consumers (historical records, PDM).
