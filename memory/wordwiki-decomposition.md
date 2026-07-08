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
   delegates (~380 consumer/test references unchanged) + the SITE-WORLD
   caches (publishedEntries, entriesByCategory, entryCountByPage,
   sourceLangCollator) which are cleared via the store's
   onDerivedInvalidated callback.

**Remaining plan (dz-approved shape, not yet requested to build):**
4. SiteView per orthography (store holds Map<orth, SiteView>; publicEntries
   via entryIsPublicIn, byCategory, collation; Entry objects shared with the
   base projection). Publish takes a SiteView. 5. render-time selection via
   currentWorkingOrthography. 6. report routes into namespace modules
   (wordwiki.reports.* etc.) with narrowed dep interfaces. 7. config pass on
   Mi'kmaq-specific constants (reference books from scanned_document table,
   PDM report parameterized, login branding, collator per orthography,
   entry.users/entry.todos maps).

Relates to [[fix-orthographies]], [[publication-approval-model]].
