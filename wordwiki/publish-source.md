# The publish source (doc of record)

*Status 2026-07-08: the bundle exists and the live publisher is driven off
it for ALL DATA; the remaining db/fs touches are render-machinery, listed
below.  `dump-publish-source` writes the JSON artifact.  Publish-from-JSON
and linking the dumps from the generated site are the next stages.*

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
| `orthography` | the orthography this site renders (`mm-li` today) |
| `collationLocale` | `Intl.Collator` locale for source-language sorting |
| `dbPurpose` | the building db's marker, logged into the publish |
| `entries` | the PUBLISHED public projection as plain entry JSON — published facts only, no history, no pending edits, only entries public in `orthography` |
| `categories` | the category vocabulary rows in display (theme) order |
| `books` | per reference book: the `scanned_document` metadata row, `totalPages`, and `entryCountByPage` ([page, dictionary-reference count]) |

Derived indexes (by-category, category counts, by-reference-group, public
ids, collation) are NOT serialized: consumers compute them with the shared
pure functions in `site-view.ts` (`entriesByCategoryOf` etc.), the same
ones the live site views use - so a dump-driven publish cannot drift from
the live one.

**Evolution discipline**: this format is becoming the project's most
important API, and future consumers cannot file bug reports.  Bump
`formatVersion` for breaking changes; strongly prefer additive ones;
document every field here.

## What the publisher still touches OUTSIDE the bundle

Enumerated 2026-07-08; each is render machinery, to be migrated in the
publish-from-JSON stage (pre-resolved scan geometry/image references in the
bundle, media manifest for audio):

1. **Entry-page scan snippets** — `renderPageEditor.renderStandaloneGroup`,
   `singlePublicBoundingGroupEditorURL`, `imageRefDescription`
   (Publish.publicBoundingGroup): renders a document-reference's bounding
   group from db rows (groups, boxes, pages, image paths).
2. **Book pages** — `schema.getOrCreateNamedLayer` /
   `selectLayerByLayerName` / `selectScannedPageByPageNumber` +
   `renderPageEditor.renderAnnotatedPage` / `renderPageJumper`
   (Publish.publishBookPage): the annotated page scan render.  (Note
   `getOrCreateNamedLayer` can WRITE a missing Tagging layer - publishing
   should become strictly read-only when this migrates.)
3. **Audio file existence checks** — `Publish.warnMissingRecordings` stats
   recording files on disk to warn about missing audio.  Becomes a check
   against the (future) media manifest.
3b. **Book-page info boxes read the FULL editor projection** —
   `renderDocumentReferenceInfoBox` looks up the entry for each tagged
   group via `getWordWiki().store.entriesByReferenceGroupId` (ALL entries,
   not just public ones).  This is historical behavior, preserved
   byte-identically — but it means a public book page can render the
   CURRENT facts of a not-yet-public entry.  **Flagged as a
   publication-model question for dz**: if the answer is "info boxes only
   for public entries", the lookup moves onto the bundle (one line) and
   the affected book pages change; if non-public entries should show
   SOMETHING, the bundle needs a reduced/approved form of them.  (Caught
   by the byte-diff verification when this phase first derived the lookup
   from the bundle's public entries.)
4. **Style/branding constants** — `config.bootstrapCssLink`,
   `config.bootstrapScriptTag`, `config.googleTagId`, and the Mi'kmaq
   public-site prose (about-us, `renderBookPageTopNote`'s PDM text): code
   constants, not db; they move to the standalone generator (which is the
   per-community artifact) rather than into the bundle.
5. **The dict schema** — `entryschema.parsedDictSchema()` drives the
   metadata renderer.  It parses a code literal (`dictSchemaJson`), so it
   is code the generator imports, not a db touch; a future formatVersion
   may embed the compact schema JSON in the bundle instead.

## Next stages

1. Migrate touches 1-3 into the bundle (scan geometry + content-addressed
   image refs; media manifest) so `Publish` is a pure function of
   (bundle, resource files).
2. `publish --from=publish-source.json` (uses `publishSourceFromJson`; the
   entries-identity staleness check does not apply to dump-driven runs).
3. The generated site links its own dumps (reduced + full-history) with
   licensing - every archived copy carries its seed.
4. The standalone generator example a community can fork (imports the
   bundle reader + pure renderers only).
