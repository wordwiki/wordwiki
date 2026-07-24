# Multi-dictionary wordwiki — system survey

2026-07-24.  This doc records what a full survey of the system found:
what is already generic, what is still hard-coded to the MMO
dictionary layout, the choices that need making, and a staged plan
with rough sizes.  (multi-dictionary-support.md predates the direct
discussion and is MOSTLY SUPERSEDED — notably its dictionary_id-on-
entry sketch; the decision is separate tables per dictionary.  Its
motivation/feature list — copy with back-links, batch AI joining,
transliteration, starring, RAND image matching — still stands and is
mapped in §4.)

Goal restated: N dictionaries on ONE application server, each in its
OWN assertion table, each with its OWN soft schema (loaded as data,
not a .ts module), each publishing its own static site — with
cross-dictionary search on the public sites, entry copying with
provenance links, and eventually shoebox .typ import so an external
dictionary can be loaded and edited directly.

The separate-tables decision is treated as made (dz, 2026-07-24;
entry-schema.ts:274 records the same conclusion: "dictionary_id
column — BAD IDEA: I think separate tables is better").


## 1. Where the system already is (the good news)

The years of soft-schema migration have paid off.  Found generic,
needing only threading:

- **The assertion SQL layer is fully table-name parameterized**,
  index names included: createAssertionDml(tableName),
  ensureAssertionColumns, selectAllAssertions, updateAssertion,
  highestTimestamp (assertion.ts:357-518).  A second dictionary's
  table is `createAssertionDml('dict_rand')` — byte-for-byte the same
  DDL generator.
- **VersionedDb takes Schema[]** and the whole workspace/tuple/query
  layer is tag-driven with zero literals (workspace.ts:63).
- **DictionaryStore is one constructor argument away** from
  multi-instance: everything inside goes through this.assertionTable
  and this.dictSchema; the single hard-code is
  `assertionTable = 'dict'` (dictionary-store.ts:35) plus two
  `getTableByTag('dct')` that should read this.dictSchema.tag
  (:156,:180).  It is already lazily loaded with wholesale
  invalidation — N lazy stores is a Map behind a registry.
- **The schema literal is already 100% data.**  dictSchemaJson
  (entry-schema.ts:263-762) is JSON-serializable as-is once ~5
  string-map constants (states/users/partsOfSpeech/
  GrammaticalFormDescriptions/todos) are inlined.  The parser
  (model.Schema.parseSchemaFromCompactJson, model.ts:1071) IS the
  data loader, with real parse-time validation.
- **The generic document renderer is already the public renderer**
  (render-entry-meta.ts, wired at publish.ts:1631-1637, dz
  2026-07-05): field-kind dispatch + $view metadata + injected hooks
  (valueLabel, renderBoundingGroup, resolveAudioUrl, orthography
  badges).  A new schema renders with no code change.
- **PublishSource is nearly generic**: variant filtering and
  internal-relation stripping walk the parsed schema
  (publish-source.ts:174,220); publish --from=dump needs no DB and is
  verified byte-identical — which makes it a ready-made regression
  oracle for the refactor (publish before/after, diff the tree).
- **Vocabularies are tables already**: tag, category, orthography,
  lexical_form — with the static maps demoted to fallbacks.
- **Books-from-db is the registry precedent**: home() lists reference
  books straight from scanned_document; "another community's books
  are a data change" — the dictionary registry is the exact analogue.
- **Route namespaces are audited-stateless**, so they can be
  instantiated per dictionary or handed a store per call without
  cache surprises; Permission predicates take Access.args, so
  dictionary-scoped roles ('edit:rand') fit the existing model.
- **Media are content-addressed and site-relative**: audio/scan
  artifacts resolve into the shared content/derived stores with
  relative hrefs; peer trees under one publish root share them
  automatically (this is how the per-orthography peer trees already
  work — publish.ts PeerTree :317-327 is the existing analog of a
  peer dictionary).


## 2. The remaining hard-coding

### 2.1 The typed Entry world (the bulk of the work)

The generic store becomes typed at exactly three choke points: the
`entries` / `publishedProjection` getters in dictionary-store.ts
(:154-181 — generic toJSON() cast to Entry[] via literal 'dct' +
'.entry'), and the dump-load path (publish-source.ts:129).  From
there ~half the app traverses `e.subentry[].gloss[]` etc. by name.

Core consumers that must become schema/role-driven:

- **publish.ts** — the heaviest: entry public links, search-term
  index, public ids (spelling[0] in defaultVariant), category pages,
  top-words (hard-coded ~tier-* slugs), missing-recording warnings,
  and the LAST use of the hand-written typed renderer (book-page info
  boxes, :2157 → entry-schema renderEntry :1172-1440).
- **site-view.ts** — pure derivations (entriesByCategoryOf etc.) walk
  subentry/category/spelling/document_reference shapes (:27-68).
- **wordwiki.ts** — editor search walks spelling/gloss literally
  (:1044-1062); newLexemeAction hand-builds assertions with literal
  'dct'/'ent'/'sub' (:369-387); tag/log panes.
- **lexeme-editor.ts** — machinery is schema-driven, but per-tag
  special cases remain: vocab-table widget bindings keyed on
  CategoryTag/TagTag/SubentryTag+fieldname (:308-328), variants
  fallback map, hideRelationTags:[TagTag,LogTag], per-tag refresh
  keys, headword via renderEntrySpellingsSummary.
- **lexeme-ops.ts** — tag-coupled not type-coupled: paths built from
  tag constants; public-gate verbs on PublicTag; generalizes once
  tags come from a schema descriptor.
- **category.ts / tag.ts** — entry-scan halves walk typed shapes.
- publication-ops.ts / versioned-model.ts — literal "dct" root tags
  (cosmetic).

LEAF consumers the owner accepts staying MMO-typed: reports.ts (incl.
word-a-day), recent-words, spelling-duplicates, auto-transliterate,
the migrations/verifiers, category/lexical-form/twitter importers,
PDM features.  (importer/import-mmo.ts is a COMPLETED one-shot — the
end stage of the old java-dump → python-cleanup pipeline; the MMO
data has lived in this system for years and it will never run again.
It no longer compiles; retire it as a historical artifact.  RAND
deliberately does NOT get an equivalent offline pipeline — see §4.)

Tests: 34/62 test files touch MMO tags, but shallowly — literal tag
strings through generic builders; only mkEntry hard-codes
'ent'/'dct' (testing.ts:147-149) and two suites use dictSchemaJson as
their fixture schema.

### 2.2 Semantic ROLES hardwired to MMO relation names

This is the crisp list of what "schema-generic core" actually needs
declared in schema data instead of found by name/tag in code:

1. **headword** — spellings relation + default orthography
   (getSpellings, renderEntrySpellingsSummary, public ids, sorts).
   $view.titleRole:'headword' already exists.
2. **gloss** — titleRole:'gloss' exists; search + compact summaries
   use it by name.
3. **lifecycle/status** — the `Archived*` slug-prefix convention
   (isArchivedEntry) is a semantic contract in code; needs an
   explicit archival flag on the vocabulary or a declared lifecycle
   role.
4. **publish gate** — entryIsPublicIn hardwires relations
   status+public (entry-schema.ts:992-995).
5. **search-term sources** — computeNormalizedSearchTerms =
   spellings+gloss words, ASCII-normalized (Latin assumption, also in
   resources/search.js normalization).
6. **featured recording** — getStableFeaturedRecording.
7. **workflow relations (tag/log)** — found via TagTag/LogTag
   constants + hideRelationTags; bornApproved is already schema
   metadata (the model to copy).
8. **category relation** — site-view/category pages/word-a-day.
9. **document references / bounding groups** — the ref relation +
   attr1 group id (feeds, entries-by-page, publish books).
10. **vocab-table field bindings** — widgetFor's three tag-matched
    cases → a declarative `$vocab: '<table>'` field property.
11. **publisher permission** — canUserPublish hardcodes 'djz'/'dmm'
    ("XXX MORE HACK") → role.

### 2.3 Singletons and per-dictionary config

- Module singletons that must become per-dictionary registry objects:
  parsedDictSchema(), bornApprovedTags(), DictTag,
  PUBLIC_SITE_ORTHOGRAPHY, defaultVariant (entry-schema.ts:979,1010 —
  siteConfig baked into schema-layer functions is the nastiest bit).
- site-config.ts splits: instance-global (editorName/subtitle) vs
  per-dictionary (publicSiteOrthography, collationLocale,
  primarySourceBook) → registry columns.
- The WordWiki delegate surface (wordwiki.ts:119-172: dictSchema,
  workspace, entries, site(), workingEntries()...) implicitly means
  "the one dictionary" — becomes app.dict(slug).* or a store handle
  passed to consumers.  #entryCountByPage cache moves into the store.
- getWordWiki() singleton reads in publish.ts (3 sites) and
  render-page-editor.ts (1) — bare route functions need the
  dictionary handle.
- Constructor-time provider injections (publicness/orthography/
  book-feed hooks, wordwiki.ts:78-101) need dictionary context.

### 2.4 Raw `dict` SQL

~14 files bypass the store's assertionTable: change-feed.ts,
activity-report.ts, recent-words.ts, spelling-duplicates.ts,
variant-scan.ts, reports.ts:400, wordwiki.ts:637/:1108,
lexeme-ops.ts:654/:657 (the publication persist path!), transcribe.ts,
creation-dates.ts, assertion-mute.ts, publication-backfill.ts,
status-migrate.ts, migration-verify.ts, auto-transliterate.ts.
Mechanical threading (most already have app/store in reach;
migrations take a --dict arg), but it's the widest churn.

### 2.5 Routes and URLs

≈163 decorated route methods under /ww/, of which ~110-120 are
dictionary-scoped via entry/fact ids or dict SQL.  ~150 inline
'/ww/wordwiki.…' URL literals (templates.ts 39 — but
templates.lexemeLink is the single highest-leverage function: it
builds most entry links for all reports).  Two R-prefix constants
exist (lexeme-editor, activity-report).

Cheapest structural move given routeterp: a dictionary facade in the
route scope — `wordwiki.dict('rand').lexeme.entryPage(1000)` — with
the existing stateless namespaces hanging off the facade unchanged,
while the DEFAULT dictionary keeps today's URLs.

### 2.6 Publish content, branding, and the site chrome

All public-site prose is code constants in publish.ts: home body,
about-us story, 404, data page, navbar (five books hard-coded),
publicSiteDomain, the PDM page-0307 entry point, root chooser.
publish-source.md explicitly parks these in "the standalone
generator (the per-community artifact)".  UPDATE (2026-07-24, landed
the same day as this survey): the SITE EDITOR now exists — the
`components` package (block-kind registry, one block table with
FieldSet-over-JSON payloads, SiteView with app-subclassed brand
chrome, click-to-edit branded view, publish + anonymous /p/<slug>
serving), built on rabid as the testbed and designed to be shared
with wordwiki (see memory/site-editor-design.md).  It is the natural
Phase 4 mechanism for per-dictionary home/about content; Phase 4
should start by wiring wordwiki onto it rather than inventing
anything.

The edition:'full'|'preview' flag is the established pattern for
per-tree feature gating; PeerTree (hasEntry/entryPath/peerPath) is
the cross-tree link machinery to extend from orthography-peers to
dictionary-peers.

### 2.7 Search

- Public: the home page IS the search engine — all entries rendered
  hidden with normalized-term CSS classes + an inline term array;
  resources/search.js rewrites a stylesheet selector.  Cross-
  dictionary public search therefore means merging peer projections
  into that page (or replacing the mechanism).  Scale check: RAND's
  30K entries as hidden li's would roughly 5x the home page — the
  mechanism may need pagination/lazy-loading or a JS index instead;
  measure before committing.
- Editor: server-side regex scan over typed spelling/gloss fields
  (wordwiki.ts:1013-1090) — becomes a role-driven scan.


## 3. Choices to make

1. **Registry + schema storage.**  A `dictionary` table peer to
   orthography (slug, assertion table name, display name, public
   orthography, collation, primary book, license/attribution,
   ordering-for-search).  Where does the schema JSON live: (a) file
   per dictionary in the repo, (b) blob column in the registry row.
   Recommend (b) — data end-to-end, and a .typ import just writes a
   row — WITH cli import/export-to-file so schemas stay diffable in
   git.  Requires finishing the schemaToCompactJson round-trip
   ($style/$view are currently dropped on emit, model.ts:311 TODO)
   and a strict Style/$view validator (validateStyle is vestigial;
   typos ride through silently today).
2. **Role declarations** — the §2.2 list; probably $view-style keys
   on relations/fields (titleRole is the precedent) plus an archival
   flag in the status vocabulary.  Also new parser needs: $immutable
   (anticipated in the literal's comments; today any unknown
   relation-level $-key is a parse error), a schema formatVersion
   stamp, per-schema orthography config (a shoebox import likely has
   NO orthography dimension — variant fields must be optional per
   schema).
3. **URL scheme.**  Default dictionary keeps current URLs (public
   mikmaqonline.org links and editor bookmarks survive); other
   dictionaries get the dict() facade segment.  Session
   working-dictionary picker (like the orthography override) for the
   editor navbar, but the dictionary stays explicit in URLs.
4. **Vocabulary scoping.**  category/tag/lexical_form gain a
   dictionary column (RAND's todos/categories are its own);
   orthography stays instance-global (it's a property of the
   language, and RAND's slightly-different Listuguj is best modeled
   as ANOTHER ORTHOGRAPHY ROW — which buys the auto-transliteration
   machinery for free); users/sessions stay global.
5. **Publish layout.**  Peer dictionary trees under ONE publish root
   (shared content/derived stores + relative media URLs then work
   as-is, and RAND pages can play MMO recordings directly).  Separate
   domains later would need an absolute-URL mechanism that doesn't
   exist today.
6. **Cross-dictionary search interchange.**  Each dictionary's
   publish emits a small projection artifact (headword text by
   orthography, short gloss, public URL, audio hrefs, peer links);
   peers consume projections, never each other's schemas.  Primary
   dictionary first = registry ordering; foreign hits badged.
7. **Typed-Entry boundary.**  Entry interfaces + hand helpers survive
   only for LEAF MMO reports; core goes through the EntryNode seam /
   schema-driven traversal.  The hand renderer's last production use
   (book info boxes) retires onto the meta renderer.
8. **fix-orthographies sequencing.**  Less of a collision than
   feared: stages 1-4 are BUILT; the $-variant flags are already
   declarative schema data and the orthography table move shares this
   project's charter.  Finish the production migration first; the
   later $notVariant drop becomes schema-version 2 of the MMO schema
   document (hence the formatVersion stamp).
9. **Permissions.**  Dictionary-suffixed roles ('edit:rand') via the
   existing free-form role strings + an Access.args-keyed predicate.


## 4. The cross-dictionary features, mapped

- **Copy with provenance** — a copied-from reference role
  (dictionary slug + entry id + source assertion id) written on the
  destination; doubles as the peer link and enables "what changed at
  the source since we copied" deltas later.  The
  "which RAND entries are already pulled" report is the shepherding
  view for this corpus (analogous to the PDM page filter).
- **Public cross-search** — projection merge into the primary home
  index (choice 6), foreign entries linking over to their own tree.
- **Batch AI matching / joining** — a batch job reading both stores,
  writing peer-link facts; enabled by the registry + link role, out
  of core scope.
- **Orthography difference** — RAND's Listuguj variant as an
  orthography row + auto-transliterate (existing machinery), keeping
  both forms.
- **Starring for recording priority** — its own later feature
  (public interaction infrastructure), unblocked but not part of
  core.
- **RAND images → document references** — the scanned-book world is
  already book-generic and shared across dictionaries; RAND scans are
  just another scanned_document.
- **Raw import, then IN-SYSTEM reshape (dz 2026-07-24).**  Unlike the
  MMO import (java dump → python surveys/cleanups/reshaping → the
  one-shot import-mmo), RAND cleanup happens INSIDE this system:
  import the .typ/.db data LITERALLY as-is into a raw-rand
  dictionary, then run a rand → reshaped-rand TRANSFORM into a fresh
  dictionary using the tools this project builds.  Consequences:
  (a) the .typ importer stays dumb-literal (its schema mirrors the
  marker structure; no cleanup logic in the importer);
  (b) the system needs a dictionary→dictionary batch-transform
  facility (read source store, write destination assertions with
  entry-level provenance links — the same copied-from role, which
  also makes transforms re-runnable/diffable);
  (c) creating/dropping a dictionary must be CHEAP CEREMONY (a
  registry row + a table), because raw-rand and reshaped-rand
  coexist and transform outputs may be regenerated several times
  before one is kept.


## 5. Staged plan (each phase lands independently, suite-green)

- **Phase 0 — grout (S).**  Complete schemaToCompactJson round-trip;
  strict $view/Style validator; retire the hand renderer's info-box
  use onto the meta renderer; retire the users/variants fallback
  maps; retire importer/import-mmo.ts (completed one-shot, no longer
  compiles).
- **Phase 1 — roles (M).**  Add role declarations to the schema
  data; rewrite the core helpers role-driven (entryIsPublicIn,
  getSpellings, search terms, featured recording, site-view
  derivations, editor search, lexeme-editor special cases,
  lexeme-ops tag descriptor).  Behavior-identical: locked by the
  suite AND by publish-tree byte-comparison via publish --from=dump.
- **Phase 2 — schema-as-data (M).**  dictionary registry table with
  one row (mmo); DictionaryStore(tableName, schemaJson, config);
  entry-schema.ts shrinks to the MMO schema document + leaf helpers;
  per-dictionary singletons die; site-config splits.
- **Phase 3 — multi-store + routes (L, widest churn).**  Store map +
  lazy loading; DDL loop over the registry; thread the table name
  through the ~14 raw-SQL files; dict() route facade + lexemeLink
  parameterization; vocabulary dictionary-scoping; permissions.
  Second dictionary demo: a toy schema loaded from data, edited live.
- **Phase 4 — publish + cross-search (M-L).**  Per-dictionary peer
  trees; per-dictionary home/about content (mechanism TBD — see the
  site-editor question); projection artifact + merged public search
  (with the 30K-entry scale check); peer links + shared-store audio.
- **Phase 5 — shoebox .typ import (M).**  Port the java .typ parser;
  marker → field-kind + $bind allocation convention; LENIENT and
  LITERAL importer with an import report (real shoebox data violates
  its own .typ: undeclared/repeated/out-of-order markers, legacy
  encodings) — no reshaping in the importer; raw RAND loaded as-is
  into its own dictionary.
- **Then:** the dictionary→dictionary transform facility (raw-rand →
  reshaped-rand, §4), copy-with-provenance UI, batch matching,
  starring — each its own feature project.

Rough total: phases 0-3 are on the order of the publication-model
project; 4-5 together on the order of publish-source/scan-extract.
No architectural risk surfaced — the risk is churn breadth (routes +
raw SQL threading), which is mechanical but wide, and the two
regression oracles (test suite + byte-identical publish) cover it
well.


## 6. Open questions for dz

1. ANSWERED (landed 2026-07-24, same day): the site editor is the
   `components` package, built on rabid — see §2.6 update.  Phase 4
   adopts it for per-dictionary home/about content.
2. Schema storage: registry blob + file import/export (recommended)
   or file-per-dictionary as source of truth?
3. RAND's orthography: new orthography row (recommended) — name/slug?
4. Published RAND: subtree of mikmaqonline.org (recommended, shared
   stores) or its own domain eventually?
5. Public cross-search scale: is 38K hidden entries in one home page
   acceptable to try first, or do we jump straight to a JS-index
   search?
