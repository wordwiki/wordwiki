---
name: wordwiki-decomposition
description: "WordWiki class decomposition plan — phase A (cli.ts, dead code, DictionaryStore) landed; SiteView per orthography is next"
metadata: 
  node_type: memory
  type: project
  originSessionId: 61972dfd-5245-4f6c-8442-1149dcc1ee7b
---

dz approved (2026-07-08) a staged decomposition of the grab-bag WordWiki class,
motivated by: accreted mess, multi-orthography (the one li-only cached
projection breaks it), de-Mi'kmaq-ifying the code for other language groups,
and "now is the time" (mid-major-refactor). Internal editor URL compatibility
explicitly does NOT matter — only the generated public site's URLs do.

**Done (phase A, 2026-07-08):**
1. `wordwiki/cli.ts` — the whole import.meta.main subcommand switch moved
   verbatim; wordwiki.ts remains the entry point wordwiki.sh runs and
   delegates via `import('./cli.ts').then(...)`. GOTCHA: a top-level
   `await import('./cli.ts')` DEADLOCKS (cli.ts statically imports
   wordwiki.ts, which is paused at that await) — Deno reports "Top-level
   await promise never resolved". `.then()` is the fix.
2. Dead routes/commented blocks deleted (entriesByPronunciation had live
   navbar+home links but threw on entry).
3. `wordwiki/dictionary-store.ts` — DictionaryStore: schema, workspace
   load+validate, tx timestamps, applyTransaction(s), and the
   orthography-AGNOSTIC projections (entries, entriesById,
   entriesByReferenceGroupId, publishedProjection). WordWiki keeps thin
   delegates (~380 consumer/test references unchanged); the store's
   onDerivedInvalidated callback clears WordWiki's remaining
   #entryCountByPage cache.
4. `wordwiki/site-view.ts` — SiteView per orthography: publicEntries
   (entryIsPublicIn), entriesByCategory, categoryCounts(),
   entriesForCategory(), collator. Store holds Map<orth, SiteView>, dropped
   WHOLESALE on invalidation (never reused) so view identity == projection
   freshness — the publish mid-run staleness check
   (`publish.entries !== wordWiki.publishedEntries`) depends on this.
   Entry objects are shared with the base projection. WordWiki.site(orth =
   PUBLIC_SITE_ORTHOGRAPHY) + delegates (publishedEntries etc.) preserve the
   old surface. Publish ctor now takes the SiteView (entries snapshotted at
   construction; defaultVariant = site.orthography, replacing the 'mm-li'
   hardcode).

**Remaining plan (dz-approved shape, not yet requested to build):**
5. render-time selection via currentWorkingOrthography. 6. report routes
   into namespace modules (wordwiki.reports.* etc.) with narrowed dep
   interfaces. 7. config pass on Mi'kmaq-specific constants (reference books
   from scanned_document table, PDM report parameterized, login branding,
   collator per orthography, entry.users/entry.todos maps).

Relates to [[fix-orthographies]], [[publication-approval-model]].
