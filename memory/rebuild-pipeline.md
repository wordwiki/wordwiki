---
name: rebuild-pipeline
description: "4-phase rebuild pipeline (pull/migrate/derive/push) — clean repo → working system, each phase reruns on its own trigger; rebuildAll.sh is the one-command orchestrator"
metadata: 
  node_type: memory
  type: project
  originSessionId: 61972dfd-5245-4f6c-8442-1149dcc1ee7b
---

The wordwiki upgrade/rebuild is split into 4 PHASES (restructured 2026-08-02 from the single importWordWikiV1Db.sh bundle, dz's design). Invariant: **clean repo → working system in ONE command** (rebuildAll.sh), while each phase is ALSO runnable alone so a rerun only redoes what its trigger changed.

- **Phase 1 `pullLiveSnapshot.sh`** — the ONLY outside-container/network step. Union-pulls the whole content-addressable store (content/derived/imports, no --delete — hash-addressed so merge is safe; via pullSharedContent.sh) + rsyncs the live db to a PRISTINE `live-v1.db` (NOT db.db). Trigger: refresh the source. Because the snapshot is untouched, Phase 2 re-runs without re-pulling.
- **Phase 2 `importWordWikiV1Db.sh`** — the IDEMPOTENT migration. Copies live-v1.db→db.db + post-pull (seed users, mark dev), then the migration passes (repair, ensure-dict-config, categories, lexical-forms, twitter-posts, backfill-publication, normalize-dates, migrate-status, migrate-variants, auto-publish-sf — each with an --expect-no-changes PROOF) + rand DATA import/transform, verify-migration, verify-workspace, serve+smoke. Ends RUNNABLE + smoke-tested. `--in-place` skips the copy/post-pull = the production CUTOVER shape (migrate the db already there); `--allow-production` passes through. Trigger: schema/migration change. (17 numbered steps; report → import-report.md.)
- **Phase 3 `rebuildDerived.sh`** — rebuild DERIVED data (re-derivable from canonical data + primed store): rand printed-pages, rand binding (cached-only) + gallery, pm-li taxonomy, verify-workspace. Trigger: rules/derivation change. Content-keyed/idempotent. NO-AI when the store is primed (`touch <instance>/no-llm-calls` → any real LLM call throws = proof cache-served); extending coverage is a deliberate PAID run without --cached-only, once per input, then shipped in the store. Report → derived-report.md.
- **Phase 4 `updateStaging.sh`** — push db + generated review artifacts (resources/generated/, gitignored) + the whole content store (union, no --delete) to staging (mikmaqonline.org:mmo-staging). Trigger: deploy. Same host as live, different dir/domain (caddy).

**`rebuildAll.sh`** runs 1→2→3, `--push` adds 4, `--no-pull` skips 1, `--in-place --allow-production` = cutover shape. NO-AI proof: touch the flag, run rebuildAll — a clean run proves phases 2+3 are fully cache-served.

Store lives at `../mmo-shared-content/` (sibling of the repo, 71G: content 7.6G, derived 15G, imports 49G), symlinked into mmo/ via mmo-use-shared-content.sh. Generated review artifacts (pm-li-taxonomy.html, rand-binder-review.html) are in resources/generated/ (gitignored, rsync'd — NOT committed, to avoid churn). See [[wordwiki-shared-store-layout]], [[wordwiki-toplevel-upgrade]], [[server-restart-protocol]]. Old pullWordWikiV1Db.sh retired (its db-pull → Phase 1 as live-v1.db, its post-pull → Phase 2).
