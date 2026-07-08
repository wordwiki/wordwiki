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

5. `WordWiki.workingSite()` = site(currentWorkingOrthography ?? PUBLIC).
   POLICY SPLIT: editor REPORTS about the dictionary content
   (categoriesDirectory, entriesForCategory) follow the editor's working
   orthography (with a visible "showing your working orthography (mm-sf)"
   note when non-default); public-site FEATURES (publish, word-a-day
   picker, activity report's public markers, the publishedEntries-family
   delegates) stay PINNED to site() — they are about THE public site,
   whoever is looking. Differential test in working-orthography_test.ts.

6. `wordwiki/reports.ts` — EditorReports under wordwiki.editorReports.*
   (categoriesDirectory, entriesForCategory, todoReport,
   entriesByTwitterPostStatus, wordADayPicker, entriesByPDMPage(Directory),
   importReport(Fragment)). Ctor takes the NARROW ReportsApp interface
   (store, site(), workingSite(), categories, entryCountByPage) — WordWiki
   satisfies it structurally; this is the dep-narrowing pattern for future
   modules. entryCountByPage STAYS on WordWiki (publish.ts consumes it
   too). wordwiki.entry(id) route kept — committed findings reports link
   to it. wordwiki.ts is 915 lines (was 2488).

7. `wordwiki/site-config.ts` — the de-Mi'kmaq seam: typed SiteConfig
   literal (editorName/editorSubtitle, publicSiteOrthography,
   collationLocale, primarySourceBook). entry-schema's
   PUBLIC_SITE_ORTHOGRAPHY + getSpellings defaultVariant, SiteView's
   collator, navbar brand, and the login card read it. Home's Reference
   Books come from the scanned_document table (selectAllScannedDocuments).
   PDM reports parameterized: wordwiki.editorReports.entriesByBookPage(Directory)
   (book, ...) and WordWiki.entryCountByPage(book) (Map cache per book;
   publish passes its publicBookId). The literal module is the STEPPING
   STONE to db-sourced config (see [[wordwiki-archival-publish-model]]) —
   its interface is the future config-table schema; when swapped, derived
   consts (PUBLIC_SITE_ORTHOGRAPHY) must become getters.

**Known residuals (deliberately not done):**
- username→display-name lookups still read the entry-schema `users` seed
  map in 6 modules (change-feed, lexeme-editor, recent-words, reports/todo);
  converting to users-TABLE-driven names (cached) is a self-contained
  follow-up. entry.users stays as the V1 import SEED regardless (frozen for
  cutover). entry.todos = legacy todo vocabulary, display-only.
- publish.ts public-site CONTENT is still Mi'kmaq-specific (about-us,
  renderBookPageTopNote's PDM prose) — belongs to the publish-from-JSON
  phase, not a config pass.
- per-orthography spelling-lane SORT in SiteView (all views sort by
  spelling[0]; changing it diffs the public site — needs dz review).

Relates to [[fix-orthographies]], [[publication-approval-model]].

**Namespace conventions (dz 2026-07-08):** getter/field = lowerCamel of the
class name (wordwiki.editorReports / activityReport / spellingReports /
variantReports / transliterationReports — 'reports' vs 'report' was
unreadable). LIFECYCLE RULE: the memoized namespace instances are ROUTE
NAMESPACES, never dropped on invalidation, so they must hold NO data state
— every data cache belongs in DictionaryStore/SiteView (dropped on every
mutation). Convention documented at the getter block in wordwiki.ts;
audited clean. Non-report namespaces (lexeme, feed, pages, audio, publish)
kept their short names.
