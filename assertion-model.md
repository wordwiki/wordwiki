# Wordwiki Architecture Notes — the Assertion Model

*(Written 2026-06-10 as a shared understanding baseline for ongoing liminal/wordwiki work.)*

Wordwiki is the software behind https://mikmaqonline.org/ — a spoken dictionary of
Mi'gmaq/Mi'kmaq with extensive support for transcribing entries from scanned
handwritten dictionaries. The editor runs at `http://localhost:9000/ww/`
(restart with `./publishHomePageAndServe.sh`).

## The big picture

Wordwiki is two data worlds in one SQLite db:

1. **Plain SQL tables** (`user`, `scanned_document`, `scanned_page`, `layer`,
   `bounding_group`, `bounding_box` + FTS — see `wordwiki/scanned-document.ts`) — the
   transcription workflow: scanned dictionaries (PDM, Rand, Clark…) are tagged
   with bounding boxes grouped into bounding groups, organized in layers (OCR
   reference layers like textract that get copied into work layers,
   table-of-contents layers, per-word secondary-resource layers). Dictionary
   entries link to source evidence via `document_reference.bounding_group_id`.
   These tables were written with an older version of liminal.
2. **The Assertion meta-model** — all lexeme data lives in one `dict` table of
   assertions, interpreted through a soft schema.

The editor is the live tool; `wordwiki/publish.ts` bakes the public site as
static HTML + simple export formats, deliberately so the *artifacts* outlive
the software (static HTML + recordings should remain usable in 1000 years,
long after the editor stops being runnable). The public-site generation
process takes a while to complete.

### Why a meta-model

1. The model was intended to be customizable per language without changing
   code (not currently exercised).
2. The system is intended to support community-based dictionary building
   (bazaar vs cathedral) — very few speakers remain for many native languages,
   so non-expert users must be able to contribute, with an approval/undo
   process that makes this safe.
3. Dictionaries shared by related communities with slightly different dialects
   need the ability to assert facts that apply to only one community
   (extremely common in these languages).
4. *(So far unrealized, but should inform future model evolution)* Offline
   field collection with later merge. Many dictionary projects go out into the
   field to collect information — often away from cell access. The model is
   intended to be later extended so that dictionary forks can be merged: a
   field researcher comes home at the end of the day and uploads their
   (proposed) assertions, most of which will not conflict. The
   assertion-as-immutable-proposal design (fact ids vs assertion ids, HLC
   timestamps, `replaces_assertion_id` chains, proposed-assertion flow) is the
   substrate for this.

## The assertion model

**One row = one immutable version of one fact.** A fact (tuple) has a durable
`id`; each edit inserts a new row with a fresh `assertion_id` and
`replaces_assertion_id` chaining to the version it supersedes. Nothing is ever
destructively updated except stamping the predecessor's `valid_to`. This is
what makes "bazaar" community contribution safe: full history, auditability,
and undo are structural, not bolted on.

**Time.** `valid_from`/`valid_to` are hybrid-logical-clock timestamps (33 bits
seconds since a 2020 epoch + 20-bit counter, monotonic — see
`liminal/timestamp.ts`). The current version of a fact has
`valid_to = END_OF_TIME`; a delete is a tombstone with
`valid_from === valid_to`. `valid_from` doubles as the transaction id —
`applyTransaction` (in `wordwiki/wordwiki.ts`) groups assertions by client
timestamp, rewrites them to a server-allocated timestamp, and applies
workspace + db insert in one SQLite tx. A second interval,
`published_from`/`published_to`, is reserved for the publish/approval
lifecycle but isn't really wired up yet (the "NEED SOME MODEL CHANGE SO CAN
INDEX LATEST PUBLISHED" comment, commented-out indexes); today "published" is
effectively `status === 'Completed'` filtering at site-generation time
(`isPublished` in `wordwiki/entry-schema.ts`).

**Tree shape via materialized path.** Facts form a tree (dict → entry →
subentry → gloss/example/document_reference → …, max depth 6). Instead of a
parent pointer there's a denormalized flattened path: `ty0` (root table tag,
id implicitly 0), `(ty1,id1)…(ty5,id5)`, with `ty`/`id` repeating the leaf. So
a whole entry subtree is one indexed query (`WHERE id1 = :entry_id` —
`selectAssertionsForTopLevelFact`), and you can query at any ancestor level.
Deleting a parent doesn't cascade-delete children's rows; child visibility is
governed by traversal from a live parent.

**Payload & ordering.** `attr1..attr15` are untyped columns interpreted per
`ty` by the soft schema. `order_key` is a fractional-indexing string ordering
siblings within (parent, ty) — `generateBefore/After/AtEndOrderKey` (in
`wordwiki/workspace.ts`, on top of `liminal/orderkey.ts`) compute keys without
renumbering peers. Plus `tags`, `note`, `confidence_expr` (the hook for
low-confidence community-sourced facts), and change metadata
(`change_by_username/action/arg/note`) as the substrate for the
approval/review workflow.

**Variants (dialects).** `variant` is a locale expression (`mm-li` Listuguj,
`mm-sf` Smith-Francis, `mm-mp` Modified Pacifique, `mm-pm` Pacifique
Manuscript, `mm` = all). Variant-able relations (spelling, translation,
example_text, recordings…) can carry per-community facts so related
communities share one dictionary while overriding where dialects differ.
`target_variant` is the half-built counterpart for facts in the *target*
language (e.g., which English gloss applies). Rendering currently hard-codes
`defaultVariant = 'mm-li'`, so the override/resolution machinery is modeled
but not yet exercised.

**The soft schema** (`wordwiki/model.ts` + `wordwiki/entry-schema.ts`): a
`Schema`/`RelationField`/`ScalarField` class tree parsed from compact JSON
(`dictSchemaJson`). Each relation has a 3-letter `$tag` (= the `ty` values),
exactly one `primary_key`, and scalar fields with `$bind: 'attrN'` mapping
field names to assertion columns (`variant` fields bind to the `variant`
column). `$style` carries UI hints (`$shape`: containerRelation /
inlineListRelation / compactInlineListRelation, `$options`, widths). This is
the per-language customizability and the reason fields aren't hard columns.

**The workspace** (`wordwiki/workspace.ts`): the whole assertion table is
loaded into RAM as `VersionedDb` → `VersionedTable` → `VersionedRelation` (per
tag) → `VersionedTuple` (per fact id) → `TupleVersion[]` (versions in time
order). `CurrentTupleQuery`/`CurrentRelationQuery` project the "now" view —
filter to `isCurrent` (`valid_to === END_OF_TIME`), sort siblings by
order_key — and `toJSON()` produces the typed `Entry` objects everything
renders from (memoized as `WordWiki.entries`, invalidated on each tx).
Mutations flow as proposed assertions: the client editor builds them,
`applyProposedAssertion` validates the replaces-chain and monotonic time and
returns the predecessor needing its `valid_to` stamped, then everything
persists via `applyTransactions`. The `RemoteDb` continuous-sync layer and
`applyServerAssertion` are mostly aspirational scaffolding.

## Known rough edges (updated after the 2026-06-10 workspace cleanup —
## see workspace-audit.md for the full audit and what was fixed)

- New fact ids come from `Math.floor(Math.random() * MAX_SAFE_INTEGER)` (the
  comments acknowledge the distributed-id question is open) — but id
  uniqueness per table is now ENFORCED at fact creation, and the per-table id
  index makes lookups O(1).
- The `current_..._by_id_ty*` partial indexes are fixed in the DML
  (`WHERE valid_to = END_OF_TIME`), but an existing db keeps its old empty
  `valid_to = NULL` indexes until they are dropped by hand.
- `'dict'` table name is hardcoded at the apply/persist sites despite the
  design intent of multiple attached dictionary tables.
- The workspace's global-time gate (one total order of edits) is the seam the
  future offline-fork/merge work must relax.
