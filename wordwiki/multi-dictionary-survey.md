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
anything.  Caveat (dz 2026-07-24): it is still fairly raw — "sort of
works, needs more fiddling" — so Phase 4 budgets hardening time, and
it brings forward two requirements of its own (§2.8).

### 2.8 Requirements the site editor brings forward (dz 2026-07-24)

**Dumps are THE publish interface — protect and extend this.**  That
publish runs on the dumped json files delivers two strategic
benefits: (1) it continuously PROVES the dumps are complete; (2) it
is the final escape hatch for other language projects.  Other
communities will plausibly adopt the editor, but for many it will be
a deal-breaker not to have absolute control over the final site's
look and feel (or a phone app, etc.).  The customization ladder:
stylesheets → site builder → fork a SIMPLE REFERENCE IMPLEMENTATION
— a static site generator that imports very little and renders the
.json dumps to a site, usable as the basis for a fully custom
generator.  (This is the "standalone generator" already parked in
publish-source.md, with its rationale now elevated: it is a core
adoption requirement, not an archival nicety.)  Consequence for this
project: every publish input — including the per-dictionary bundles
AND the cross-dictionary projection artifact — must remain simple,
documented json; outside consumers (peer dictionaries, other
projects' generators) live off these files, never off wordwiki
internals.

**Pages must also publish LIVE (preview).**  Today public pages are
only rendered by the file-writing publish.  The site-editor workflow
is awkward/broken without preview-rendering every page (and preview
is independently good).  This is cheap by construction: the dumps
ARE the in-process data structures (bundle build runs from the live
projections; renderers consume bundle shapes) — so live preview is a
route family that builds/reuses an in-memory PublishSource and
renders ONE page to the response instead of a file.  One first-touch
cost: bundle build resolves derived media (compressed audio, scan
tiles) eagerly; those are content-addressed and cached, so only new
media pays at preview time.

The edition:'full'|'preview' flag is the established pattern for
per-tree feature gating; PeerTree (hasEntry/entryPath/peerPath) is
the cross-tree link machinery to extend from orthography-peers to
dictionary-peers.

### 2.7 Search

- Public: the home page IS the search engine — all entries rendered
  hidden with normalized-term CSS classes + an inline term array;
  resources/search.js rewrites a stylesheet selector.  DECIDED (dz
  2026-07-24): this mechanism gets REPLACED, but the offline
  invariant stays — search must survive the application server dying
  and work from a bare directory (the archival requirement).  The
  CSS version's original virtues (progressive render as the page
  parses) no longer pay for its costs: an expressiveness ceiling,
  30K-entry scale, and recent browser CSP tightening apparently
  breaking dynamic stylesheet manipulation on file:// URLs (i.e. it
  is now an ARCHIVAL regression).  Replacement shape: a client-side
  JS index — note file:// also blocks fetch(), so the index ships as
  <script src="search-index.js"> defining a global (lazily
  injectable on first use to keep the home page light).  A JS index
  buys per-orthography normalization (retiring the ASCII Latin
  assumption; becomes a schema-role concern), substring matching,
  ranking, and the cross-dictionary merge with dictionary badges.
  SEPARABLE: this can land as a standalone improvement BEFORE Phase
  4; Phase 4 then extends it to merge peer projections.
- Editor: server-side regex scan over typed spelling/gloss fields
  (wordwiki.ts:1013-1090) — becomes a role-driven scan.


### 2.9 The SAAS end-state (dz 2026-07-24)

The long-term goal behind the generalization arc: run this system as
a FREE, OPEN-SOURCE SAAS — hosting is too much of a barrier for many
language groups.  Most of the missing generalities have been tackled
project-by-project; multi-dictionary + schema-as-data covers most of
the rest.  Operational implications this project's choices must
honor:

- **Tenancy = instance.**  One community = one instance directory
  (SQLite db file + content-addressed stores) — the natural unit
  given instance-dir/wordwiki.sh.  Provisioning is mkdir + seed,
  backup is rsync, and EXIT is a copy of the directory.  Data
  sovereignty is a feature, not an ops detail, for indigenous
  language data — the dump/archival model doubles as the portability
  guarantee.  (SQLite is a SAAS advantage here, not a limitation.)
- **Storage choices stay per-tenant portable**: no cross-tenant
  shared stores (even at dedup cost), no external services in the
  serving path.
- **Hosted customization is DATA-ONLY.**  Schema documents (now
  strictly validated), site-editor blocks, stylesheets — but NO
  tenant-authored JS running in the hosted editor or on hosted
  origins (a tenant's script on the shared service is an XSS
  liability).  The absolute-control escape hatch (§2.8) lives
  OUTSIDE the SAAS boundary: take your dumps, run/fork the reference
  generator, host the static output anywhere — static hosting was
  never the barrier, the editor/server is.
- **Upgrades: one binary, N instances** — every migration must be
  automatic at boot (the ensure/upgrade discipline, with the
  remaining hand-run steps automated away).
- The publication model's pending "open to untrusted" work gains
  urgency (a hosted community will want public contributions under
  review).

## 3. Choices to make

1. **Registry + schema storage — CONVERGED (dz + review 2026-07-24).**
   The schema lives IN the db: each dictionary is a TABLE PAIR —
   `mmo` (assertions) + `mmo_config` (name/value pairs, one of which
   is the schema JSON).  Rationale (dz): SQLite's virtue is the
   self-contained file; schema in external files must move/stay in
   sync with the db file — a recipe for sadness; schema-as-SQL-rows
   is possible (the entry-schema style would even suit the editor)
   but overkill now.  Per-table config (vs one global) makes
   dictionaries SEPARABLE, at some editor ugliness cost.
   Refinements: (a) NO registry table — discovery by convention
   (tables with an `X_config` peer holding a `schema` key); ALL
   per-dictionary metadata (slug, display name, LICENSE/ATTRIBUTION,
   default orthography) as more config pairs, so a dictionary is
   fully contained in its pair (drop the two tables into a db =
   it appears); instance-level concerns (primary dictionary, search
   order) in the global `config` table.  (b) Schema edits: edit the
   JSON (or .typ); the load gate = the phase-0 strict style
   validator + the workspace validator run over the data AT REST
   under the proposed schema (add-field passes; remove/rename with
   data fails with findings); phase-0's completed round trip makes
   dump→edit→reload lossless.  (c) Imported dictionaries stash the
   original .typ as a `source_typ` config pair (provenance).
   (d) MMO needs no table rename: `dict` + `dict_config`, slug
   'mmo' as a config value.  Licensing settled for the Watson
   dictionaries: same CC-share-alike as MMO, kept separate,
   ATTRIBUTION TO WATSON — the license/attribution config pairs are
   load-bearing from day one.
   Vocab tables (categories, tags, orthographies, lexical forms,
   users) stay SHARED across an instance's dictionaries (dz) — for
   RAND↔MMO shared categorization is a feature; if tag/todo
   vocabularies ever want separation, that's a nullable dictionary
   column later.  How .typ markers acquire TYPES stays open (manual
   for RAND).
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
  STATUS (2026-07-24): PHASE 1 COMPLETE — $role in model.ts (7
  roles, strict parse, round trip, relationsByRole) + declared in
  the MMO literal; schema-roles.ts is the generic access layer;
  entry-schema helpers delegate; site-view derivations, editor
  search, $vocab field bindings (new $style key), hideRelationTags/
  refresh keys, ALL of LexemeOps, publish's typed walks (warnings
  sweep = every audio-bearing relation; public ids strict-lane;
  category/link/tier walks), category/tag curation scans, and
  publication-ops (rootTable(vdb), no literal 'dct') are role/
  schema-driven.  Locked twice at every step: suite green + publish
  --from=dump byte-identical (16,341 pages).  Deliberately left: the
  ~tier-* Top Words slugs (instance content), the typed Entry
  interfaces themselves (leaf reports keep them; core no longer
  needs them - the phase-2/3 store work decides their fate).
- **Phase 2 — schema-as-data (M).**  The config table pair (§3.1);
  DictionaryStore reads its schema from it; entry-schema.ts shrinks
  to the MMO schema document + leaf helpers; per-dictionary
  singletons die; site-config splits.
  STATUS (2026-07-24): FOUNDATION DONE — dictionary-config.ts (the
  X + X_config pair; ensure creates + syncs the schema row from the
  literal transitional, seeds metadata once; read/write; discovery
  by convention, FTS shadow tables correctly rejected);
  DictionaryStore.dictSchema is lazy from the stored row (literal
  fallback), dropped on reload; checkProposedSchema is the
  compatibility gate (strict parse + attr-usage-vs-binds scan + full
  workspace load under the proposal) with dump-schema / load-schema
  [--apply] CLI; explicit ensure-dict-config pass (step 4/16) in
  importWordWikiV1Db.sh.  PHASE 2 COMPLETE (2026-07-24 late):
  PublishSource formatVersion 2 EMBEDS the schema (v1 readable,
  literal fallback) - Publish renders everything from the bundle's
  own schema (verified: v2 bundle publishes byte-identical except
  the data/publish-source.json artifacts themselves); the pure site
  derivations take the schema explicitly (SiteView = the store's,
  Publish = the bundle's); per-dictionary site config
  (public_site_orthography/collation_locale/primary_source_book) as
  seeded CONFIG PAIRS with WordWiki accessors.
  Deliberately deferred to phase 3: the remaining
  siteConfig.primarySourceBook reads in editor-report/template
  prompts (cosmetic, app-reachable), entry-schema's typed-helper
  default lane (PUBLIC_SITE_ORTHOGRAPHY/defaultVariant - the typed
  MMO helpers keep the literal default; core paths pass the lane
  explicitly), and the entry-schema.ts file split (cosmetic re-org,
  zero-churn via re-exports whenever wanted).
- **Phase 3 — multi-store + routes (L, widest churn).**  Store map +
  lazy loading; DDL loop over the registry; thread the table name
  through the ~14 raw-SQL files; dict() route facade + lexemeLink
  parameterization; vocabulary dictionary-scoping; permissions.
  Second dictionary demo: a toy schema loaded from data, edited live.
  STATUS (2026-07-24): STEP 1 DONE — DictionaryStore(assertionTable
  option), WordWiki.assertionTable seam, every LIVE raw-SQL path
  interpolates the table (queries stay PREPARED: the db layer
  memoizes by SQL text, one statement per query x table),
  newLexemeAction schema-driven, ensure DDL-loops the discovered
  dictionaries.  One-shot V1 migration tools stay 'dict' by design.
  NEXT: the store map (Map<table, DictionaryStore> from discovery,
  default-delegating), then the dict() facade + new-dictionary CLI +
  the toy-second-dictionary live-edit demo.
- **Phase 4 — publish + cross-search (M-L).**  Per-dictionary peer
  trees; per-dictionary home/about content via the site editor
  (components package — budget hardening, it's raw); LIVE PREVIEW
  routes for public pages (§2.8 — separable, can land earlier since
  the site editor wants it regardless); projection artifact + the
  merged public search (the JS-index search replacement of §2.7,
  also separable/earlier); peer links + shared-store audio.
- **Phase 5 — shoebox .typ import (M).**  Port the java .typ parser;
  marker → field-kind + $bind allocation convention; LENIENT and
  LITERAL importer with an import report (real shoebox data violates
  its own .typ: undeclared/repeated/out-of-order markers, legacy
  encodings) — no reshaping in the importer; raw RAND loaded as-is
  into its own dictionary.
- **Then:** the dictionary→dictionary transform facility (raw-rand →
  reshaped-rand, §4), copy-with-provenance UI, batch matching,
  starring, and the reference-implementation static generator
  (§2.8 — the few-imports json→site renderer other projects fork) —
  each its own feature project.

Rough total: phases 0-3 are on the order of the publication-model
project; 4-5 together on the order of publish-source/scan-extract.
No architectural risk surfaced — the risk is churn breadth (routes +
raw SQL threading), which is mechanical but wide, and the two
regression oracles (test suite + byte-identical publish) cover it
well.


## 6. The Watson drop (2026-07-24): parser + data recon

dz dropped wordwiki/Sfm.java (his shoebox parser) and watson/ (the
researcher's dictionaries + MDF.typ).

**Sfm.java** (~600 lines, self-contained): SfmReader = backslash-
marker lexer with pushback (continuation lines = content runs until
newline+backslash; CR stripped; shoebox-identical trailing-newline
handling); SfmSchema reads the .typ (+mkr records; mkrOverThis →
parent; root 'lx'); applySchema is the essential algorithm — SFM has
NO close tags, so nesting is inferred: stack-based, pop to the
nearest ancestor per the .typ hierarchy, SYNTHESIZING missing
intermediate levels as empty fields.  Port note (MANDATORY change):
the Java version reads everything as ISO-8859-1 — the watson DATA
files are UTF-8 with real multi-byte diacritics (the Java version
would mangle them today) while MDF.typ itself is cp1252-ish; the
port takes encoding per file.

**Existing-parser scan (2026-07)**: no TS/JS SFM/.typ parser exists.
Open alternatives are SIL::Shoe (Perl, mature, .typ-aware),
goodmami/toolbox + clldutils.sfm + nltk.toolbox (Python, flat
field-list parsing — the .typ hierarchy inference, the actual hard
bit, is mostly NOT in them).  Using one would bolt a Perl/Python
stage onto the flow — recreating the retired offline-pipeline
pattern.  DECISION LEAN: port Sfm.java (small, battle-tested on this
data lineage, keeps import in-process).

**The data**: RAND = 29,097 records, proper `\_sh v3.0 325 MDF 4.0`
header, ~24 distinct markers (all standard MDF; MDF.typ defines 102).
Per-record shape: \lx transliterated headword (Listuguj-style),
\lsf Smith-Francis (28,680 present), \ps rich paradigm-class codes
("W5 ni ei", "T3 vai si" — hundreds of distinct values → vocabulary
table at reshape), \ge/\de English, \xv RAND'S ORIGINAL 1888
DIACRITIC ORTHOGRAPHY (āān, ĕnagā — a THIRD lane) + \xe, \so source
citations (541 distinct: mostly "Rand 1888, p N" — PAGE-LEVEL
provenance, feeding the future image↔entry document-reference
matching directly — plus Clark 1902, place names, stray codes and
typos like "Claek 1902" — exactly the in-system cleanup material),
\nt notes, \dt dates Nov 2024–Jul 2026 (actively worked).  151,100
EMPTY field lines (marker, no content — template records): importer
choice — keep literally vs drop-with-report.

**Decoded by watson/watson.txt (Watson's own description)**: the
project is FOUR dictionaries, and the drop is a WORK-IN-FLIGHT
PIPELINE, not three independent dictionaries:

1. **mmolistuguj2024** (6,816 entries) — almost certainly a version
   of MIGMAQONLINE ITSELF from before its wordwiki import (MMO was
   shoebox + a java static-site generator — Sfm.java's main() reads
   mmo.typ/mmo.txt; MMO in turn descends from Watson's dictionary of
   ~25 years ago).  Not a new dictionary to host; at most a
   comparison artifact.
2. **RandMigEngDict** — the big Rand transcription, ORIGINALLY
   33,276 entries, now 29,096: entries LEAVE it as they are
   processed (shoebox Database>Move is destructive).  The drop's
   "Rand Mig Eng Dictt 29097" is this remaining raw queue.
3. **RandMigmFinal2000** = drop file Ng20726 (2,498) — processed
   entries, headword in the "Ng" g-system (Listuguj-style:
   agnutas'g), with \lsf carrying the k-system form.
4. **RandMikmFinal2000** = drop file Lk20726 (2,497) — THE SAME
   ENTRIES duplicated for the "Lk" k-system community (Smith-
   Francis-style: aknutasɨk promoted to \lx, \lsf then deleted —
   by hand: "put the cursor before the e … hit backspace until the
   word is in \lx").  So Ng/Lk are not diverged copies to
   reconcile; they are a two-orthography FORK maintained manually
   because shoebox has no orthography lanes.

Implications: (a) the reshape stage REUNIFIES raw-queue + Ng + Lk
into ONE dictionary whose entries carry both lanes — wordwiki's
variant model dissolves Watson's entire fork-and-backspace workflow
(one entry, li+sf lanes, per-orthography publish; the existing
SiteView/auto-transliteration machinery is exactly this).  This is
the adoption story for Watson himself, not just an import
convenience.  (b) Provenance must record WHICH partition each
imported entry came from (raw/Ng/Lk) so the reunification is
auditable.  (c) Standard MDF markers are REPURPOSED (\lsf is
"lexical function" in MDF but "the other system's spelling" here) —
the schema comes from Watson's usage, never from MDF.typ's doc
strings.  (d) Counts don't quite sum (29,097+2,498+2,497 = 34,092 vs
33,276 original) — some growth/duplication to survey at import.
Neither Final file has a \_sh header and both open with a BLANK
TEMPLATE record (bare markers) — importer leniency cases.

## 7. Open questions for dz

1. ANSWERED (landed 2026-07-24, same day): the site editor is the
   `components` package, built on rabid — see §2.6 update.  Phase 4
   adopts it for per-dictionary home/about content.
2. Schema storage: registry blob + file import/export (recommended)
   or file-per-dictionary as source of truth?
3. RAND's orthography: new orthography row (recommended) — name/slug?
4. Published RAND: subtree of mikmaqonline.org (recommended, shared
   stores) or its own domain eventually?
5. ANSWERED (dz 2026-07-24): skip scaling the CSS mechanism — replace
   the public search with an offline JS-index search (§2.7); still
   static-site/file://-capable, richer matching, cross-dictionary
   ready.
