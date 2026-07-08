# The publish source (doc of record)

*Status 2026-07-08: `publish --from=<dump.json>` needs NO DATABASE - the
scan renders are bundle-ized.  Verified: the full site (16,046 html files)
publishes byte-identically from the dump vs the live db, and a bare
directory holding only the content/derived resource trees plus the dump
publishes correctly with no database present.  The publisher is now a pure
function of (bundle, resource files).  Linking the dumps from the
generated site is the next stage.*

## Why this exists (the archival model)

This dictionary's data must outlive the software.  The planned degradation
stages: (1) the live editor works and collects the language (decades),
(2) the generated static artifacts (.html/.mp3/.pdf) stay viewable in
whatever can still read today's web (longer, finite), (3) NEUTRAL-FORMAT
data files are converted to whatever the future speaks (unbounded),
(4) paper, via .pdf (survives computing; loses the recordings).

The publish source is the stage-3 artifact: the reduced, simplified,
history-free projection of the dictionary - "the words, their spellings
per orthography, glosses, examples, recordings, categories, source books"
- with none of the versioned-assertion machinery a reader would need the
software to understand.  The full-history dump exists separately; both
must eventually be linked FROM the public site with clean open licensing
(CC share-alike, the founding decision), so every archived copy of the
site carries its own seed.

**The correctness guarantee**: the LIVE publish is driven off this same
bundle.  An export nothing consumes rots silently; a load-bearing one
cannot - the site existing is the proof the bundle is complete.

A second dividend: communities profoundly care about the look and shape of
their public site.  A standalone site generator that consumes ONLY this
bundle (no imports from the editor/server code) is within reach of casual
or LLM-assisted programmers, with no coupling to upstream evolution.

## Format (formatVersion 1)

Defined in `publish-source.ts` (`PublishSource`).  JSON-serializable;
`dump-publish-source` writes it with `generatedAt` stamped (in-memory
builds omit it so the bundle stays deterministic and dumps diff cleanly).

| field | contents |
|---|---|
| `formatVersion` | `1`; readers gate on it (`publishSourceFromJson`) |
| `generatedAt` | ISO timestamp, dump-time only |
| `orthography` | the PRIMARY orthography (= `orthographies[0]`): drives the entry-page public ids and the publisher's defaultVariant |
| `orthographies` | the pub-gate SELECTION set: the bundle contains the entries public in ANY of these (`dump-publish-source --orthographies=mm-sf[,mm-li]`; default = the public site's orthography) |
| `variantContent` | `all` (default): each entry carries every orthography's content. `selected`: variant-tagged tuples are filtered to the selected lanes — EXCEPT `$sourceOrthography` provenance fields (the reference transliteration/source-as-entry family: the variant records the HISTORICAL SOURCE's orthography, never a display lane) and `$notVariant` locale relics; `'mm'`-wildcard and legacy-blank variants match every lane (`variantMatches`).  Filtering builds new entry objects, so the live entries-identity applies only to the default single-orthography/`all` shape |
| `collationLocale` | `Intl.Collator` locale for source-language sorting |
| `dbPurpose` | the building db's marker, logged into the publish |
| `entries` | the PUBLISHED public projection as plain entry JSON — published facts only, no history, no pending edits, only entries public in `orthography` |
| `categories` | the category vocabulary rows in display (theme) order |
| `users` | the human users (`user_id`, `username`, `name`, `region`) — automation `~` identities excluded, disabled users included (history references former staff forever) |
| `books` | per reference book: the `scanned_document` metadata row, `totalPages`, `entryCountByPage` ([page, dictionary-reference count]), `taggingLayerId` (resolved — and created if missing — at BUILD time, so publishing itself is read-only), and `pageScans` (per page: dimensions, image url, the tagging groups + boxes) |
| `scans` | per bounding group referenced by the entries' document references: the standalone scan render data — per-page box geometry with resolved content-addressed `tiles_url`s, plus the precomputed public book-page path and description |

**Denormalize-on-export (the standalone-file rule)**: every reference KEY
stored in the data (a recording's `speaker` username, a category slug, a
book's friendly id) must resolve WITHIN the file - the bundle carries the
referenced records alongside the data, and the reference keeps its
original stored form.  This is deliberately a lookup section rather than
inline copies at each reference: the entries in the bundle are the exact
projection the renderers consume (and, in-memory, the very same array the
staleness check compares), so enriched inline copies could silently drift
from what actually renders.  It also removes the pressure for
"meaningful" foreign keys in the data model: if the data later moves from
slugs/usernames to ids, the bundle keeps resolving in-file and only the
key column changes.

Derived indexes (by-category, category counts, by-reference-group, public
ids, collation) are NOT serialized: consumers compute them with the shared
pure functions in `site-view.ts` (`entriesByCategoryOf` etc.), the same
ones the live site views use - so a dump-driven publish cannot drift from
the live one.

**Evolution discipline**: this format is becoming the project's most
important API, and future consumers cannot file bug reports.  Bump
`formatVersion` for breaking changes; strongly prefer additive ones;
document every field here.

## What the publisher touches OUTSIDE the bundle

Everything the publisher consumes beyond the bundle is now RESOURCE FILES
or code - no database:

1. **RESOLVED: entry-page scan snippets and book pages render from the
   bundle** (2026-07-08).  The scan renders were split into serializable
   data structs + loaders + pure renderers (render-page-editor.ts:
   GroupScanData / BookPageScanData, loadGroupScanData /
   loadBookPageScanData, renderStandaloneGroupFromData /
   renderAnnotatedPageFromData).  The annotated-page render is a true
   load+pure split (one code path); the standalone-group render keeps its
   sync-with-embedded-tile-promise live form and has a MIRRORED pure twin
   (change both - the full-site byte-diff is the drift alarm).
   Image-tile paths are content-addressed and resolved (generating if
   missing) at BUILD time, as is the Tagging layer id (the old render
   path's get-or-create write) - publishing itself is read-only.
2. **Audio: derived-store resolution + missing-recording warnings** —
   `renderAudio` resolves the content-addressed compressed audio from the
   content/derived resource trees at render time; this is a resource-file
   read, within the "pure function of (bundle, resource files)" goal.
   (An explicit media manifest in the bundle remains possible later.)
3. **RESOLVED (dz ruling 2026-07-08): book-page info boxes render PUBLIC
   entries only.**  Historically the lookup used the full editor
   projection, so a public book page could render the current facts of a
   not-yet-public entry (caught by this phase's byte-diff verification).
   A non-public entry's group gets the same "Unknown group id" fallback a
   never-worked group always got.  Known acceptable imperfection (dz):
   the info-box render itself is not versioned.
4. **Style/branding constants** — `config.bootstrapCssLink`,
   `config.bootstrapScriptTag`, `config.googleTagId`, and the Mi'kmaq
   public-site prose (about-us, `renderBookPageTopNote`'s PDM text): code
   constants, not db; they move to the standalone generator (which is the
   per-community artifact) rather than into the bundle.
5. **The dict schema** — `entryschema.parsedDictSchema()` drives the
   metadata renderer.  It parses a code literal (`dictSchemaJson`), so it
   is code the generator imports, not a db touch; a future formatVersion
   may embed the compact schema JSON in the bundle instead.

## Publishing from a dump

    ./wordwiki.sh dump-publish-source ps.json
    ./wordwiki.sh publish --from=ps.json [targets] [--root=...]

The publish needs NO DATABASE: the data comes entirely from the file (the
publish log records the dump's generatedAt as provenance), and the only
other inputs are the content/derived resource trees (audio resolution) -
a bare directory holding those two symlinks plus the dump publishes the
site.  Verified byte-identical to a live publish across the FULL site
(16,046 html files), and covered by the round-trip test in
publish-source_test.ts.  The entries-identity staleness check does not
apply to dump-driven runs (by design: a dump IS a snapshot).

## Orthography-selected bundles

    ./wordwiki.sh dump-publish-source sf.json --orthographies=mm-sf
    ./wordwiki.sh dump-publish-source both.json --orthographies=mm-li,mm-sf
    ./wordwiki.sh dump-publish-source li.json --variant-content=selected

The `$sourceOrthography` annotation lives on the variant FIELD in the
schema (`model.ts` VariantFlags; declared in `entry-schema.ts` on the
document-reference `transliteration` / `source_as_entry` /
`normalized_source_as_entry` / `foreign_reference` variants) - an explicit
declaration, not guessed from values or publish state, and available to
the editor's working-orthography lens later for the same purpose.

## Next stages

1. The generated site links its own dumps (reduced + full-history) with
   licensing - every archived copy carries its seed.
2. The standalone generator example a community can fork (imports the
   bundle reader + pure renderers only - now genuinely possible, since
   the publisher is a pure function of the bundle + resource files).
