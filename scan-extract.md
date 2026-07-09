# Scan → extract: a cached, generic structured-extraction substrate

A liminal-level capability for turning **images of documents into structured data**
with an LLM, shared across apps.  Driven by four real, very different consumers:

| consumer | app | shape | stages | target |
|---|---|---|---|---|
| PDM historical dictionary | wordwiki | **single image** per bounding group; user-drawn boxes | transcribe → transliterate | annotate existing `dict` entries |
| English→Mi'kmaq dictionary | wordwiki | printed, cleaner | extract | create new `dict` rows |
| old service records | rabid | **batch** of scanned pages; loose/inconsistent | extract | create `service` rows |
| daily volunteer attendance | rabid | batch of tables | extract | create attendance rows |
| (a required-form upload) | any | **single image**, but wants the full flow | extract | create/annotate |

The consumers differ wildly in rules, stages, schema, and human workflow, so the
generic layer owns only the **mechanism**; everything domain-specific (prompts,
schema, stage graph, review UI, how rows get written) is a per-consumer **recipe**.
This mirrors how gallery/tasks stay generic via `tableByName`/owner descriptors.

## Anchor case: ongoing paper service records (rides existing machinery)

The **primary, ongoing** use is not a special scan pipeline — it's the piece we
already shipped.  Volunteers keep collecting service records **on paper** (the
clipboard clients and volunteers are comfortable with), and at the end of a shift
they **photograph the sheets into the event's photo gallery** (`gallery_photo`
attached to the event — done).  A deferred, batch **extract** then turns those
photos into `service` rows on the same event — so no one retypes a season of data
for reports.

This means, for the anchor case:
- **Ingestion is already built** — the source images are the event's gallery photos.
  No upload/normalise UI to add for this case.
- **Target + context are trivial** — `target_kind='service'`, `target_context={event_id}`
  (the event that owns the photos); it lands exactly the `service.event_id` we have.
- **Provenance is a `gallery_photo`** — a landed `service` points back at the photo it
  came from; retract-a-sheet = delete its services.
- **Capture and extract are decoupled in time** — this is a feature.  The photo is the
  durable record: teams can **start photographing sheets into event galleries this
  season immediately** (works today), and extraction can come later and be **re-run**
  as the prompt improves.  You're never worse off than "we have the sheets."
- **You control the paper form** — so design the record sheet to be extraction-
  friendly (boxed fields, consistent layout, maybe the event on it) and co-design it
  with the prompt.  This is a big accuracy lever the messy *historical* records don't
  have; keep the two cases separate in your head (clean ongoing sheets vs loose old
  records — same substrate, very different recipes/quality).

## Two layers (the load-bearing split)

**Layer 1 — the cached extraction derivation (the primitive).**  A pure,
content-addressed function `(image-region, stage, prompt_version, model) → result`,
memoised in the derived content store — exactly like the derived crop store.  It
**owns no images**: it takes a *reference* (content hash + rect(s)).  No job, no UI,
no tables of its own.  A consumer that already owns its images (PDM: the dict's page
scans + hand-drawn bounding groups) uses Layer 1 **directly** as a read-through
derived attribute — `transliterate(transcribe(region))`, each stage cached.

**Layer 2 — the flow (ingestion + job + review + filing).**  Everything Layer 1
deliberately isn't: the **image lifecycle** (upload, normalise/rotate/deskew via
`convert` in a derived store, retract), the **extraction job** (orchestration,
per-stage status, liveness), **review + commit**, and **filing rows into a target
table with provenance + retract**.

**Batch vs single is a Layer-2 property, not the layer boundary.**  A job may drive
one image (a required form) or a thousand pages; either way it's Layer 2 if it needs
ingest/review/commit.  The boundary is *"do you own the image and just want the
cached extraction" (L1)* vs *"do you need the flow" (L2)* — not the count.

```
                 ┌───────────────── Layer 2: the flow ─────────────────┐
  upload/rotate ─┤ source_page → page_region → extraction_job(+stages) │→ land → target table
   (derived)     │            review · commit · retract · provenance    │      (+ provenance FK)
                 └───────────────────────────┬─────────────────────────┘
                                             │ calls, per stage
                 ┌───────────────────────────┴─────────────────────────┐
  PDM uses this ─┤ Layer 1: cache  (image-ref, stage, prompt_version)   │
   directly      │   → derived content store (memoised, per stage)      │
                 └──────────────────────────────────────────────────────┘
```

## Layer 1 — the cache

- **Key = `hash(region-image) + model + prompt_version + stage`.**  Per-stage keys
  are essential: re-running the transliterate prompt must reuse every cached
  transcription.  `prompt_version` is the explicit invalidation knob (bump to
  re-run/re-grade); the prompt template lives in the closure.  Caller-supplied prompt
  bits are allowed **only if output-irrelevant** — anything that changes the output
  belongs in the versioned/keyed part, or you silently serve stale extractions.
- **Region image** is produced by cropping the (optionally normalised) source image
  to the rect(s) via the existing content-addressed crop store — so the cropped
  input is itself cached and content-addressed.
- **A stage recipe** is `{name, model, prompt_template (versioned), output_schema}`.
  A consumer's Layer-1 recipe is just an ordered list of stages; the runner feeds
  each stage's output as the next stage's input.
- **Output** is validated JSON (the stage's `output_schema`).  A stage may also
  return **regions** (sub-boxes it used), which Layer 2 stores for per-row review
  crops.
- **Standalone use (PDM):** no job, no generic tables — the consumer holds its own
  image refs and reads the cached derivation like any derived value.  This is the
  Layer-1 reference consumer and the first thing to build.

## Layer 2 — the flow

- **Image ingestion / normalisation.**  Upload → a `source_page` (content-addressed
  original) → derivations, whose params are part of the Layer-1 cache key.  Retraction
  removes the page + its landed rows.  (Only here — Layer 1 never ingests.)  **Pipeline
  order matters:**
  - **Rotate/deskew the full-res original FIRST** (`convert`) → a `rotated` derivation.
    Rotating a downscaled image loses quality irrecoverably, and correct orientation is
    what both the LLM and the human viewer want, so this is the shared first step.
  - **LLM path:** `rotated` → **only if it exceeds the model's size limits**, a
    `downscale` derived step → LLM.  **Never crop for the LLM** — it needs the whole
    sheet.  The only crops are the *post-extraction* per-line review crops (bboxes),
    which are display, not input.
  - **Display path** (the gallery card) branches off the same `rotated`: a **contain-
    fit** to a manageable box (not the current cover-crop, which clips a portrait sheet
    into an unreadable strip).  ⇒ needs a new PhotoService "contain" mode.
- **`page_region`** — regions on a page, each a **bbox = a *set* of rects** (margin
  notes ⇒ non-contiguous), with the region's own provenance (hand-drawn / model-
  detected / table-line-split).  Region *producers* are pluggable; reconcile with the
  bbox tooling wordwiki already has for PDM.
- **`extraction_job`** — the orchestration + progress record: the source page(s), the
  `target_kind`, the `target_context` (below), per-stage status, the **staged output
  JSON** (extracted-but-not-yet-committed rows), and errors.  It carries **liveness**
  (shape/row key) so status updates and placeholder rows render live, and concurrent
  jobs are just concurrent rows.  Batch concerns (concurrency cap, retry, resumable,
  rate-limit) live in the job runner.
- **Review** is per-shape and thin (a keyboard grid for tabular targets; a per-entry
  form for dict).  Don't over-generalise it — generalise the *data* (staged rows) and
  the per-row **review crop** (`region.bbox` → cached crop), not the screen.

### Filing against a target table (the part that was unclear) — proposal

Two filing shapes, both supported:

- **Create-new-rows** (service / attendance / new-dict): the extraction produces new
  domain rows filed into a target table, with provenance + retract.
- **Annotate-existing** (PDM): the extraction is a derived value of an existing
  record that owns the region — usually read-through from Layer 1, optionally
  committed onto the record after review.

Make filing generic with **three pieces**:

1. **`target_kind` + `target_context` on the job.**  `target_kind` selects the recipe
   (stages + landing).  `target_context` is domain anchors set when the import is
   created — e.g. service `{event_id}`, attendance `{date}`, new-dict `{orthography,
   dictionary_id}`.  The "start an import" UI collects these.  This is how the
   generic layer supplies the fixed fields a domain row needs without knowing the
   schema.
2. **A per-`target_kind` `land(rows, context, provenance) → landedKeys` recipe.**
   Resolved like `tableByName`; it does the domain write (plain insert / versioned
   assertion / dedup / required-fields-from-context) and stamps provenance.  A
   **default adapter** covers the plain tabular case (map extracted fields → columns,
   merge `target_context`, insert); targets override with a function when they need
   versioning or dedup (dict).  The generic layer never sees a domain schema.
3. **A provenance-column convention** so *retract* is generic even though *land* is
   not: landable tables carry a nullable `extraction_job_id` (and optionally
   `page_region_id`) FK.  `land` sets it; generic retract = delete/void where
   `extraction_job_id = :job`.  Also gives the per-row "which scan / which page" badge
   and the review crop for free.

So: **land is a recipe (domain-specific), retract + provenance are a convention
(generic).**  PDM's "annotate-existing" recipe writes the transcription/
transliteration onto its dict entry (or is pure read-through and lands nothing).

## Generic schema sketch

Layer 1 has **no tables** (it's the derived store keyed by content).  Layer 2:

```
source_page:     page_id, image (content path), normalize_params, uploaded_by, kind, ...
page_region:     region_id, page_id, rects (json: [{x,y,w,h}...]), origin ('drawn'|'model'|'lines')
extraction_job:  job_id, target_kind, target_context (json), page_id|region_set,
                 recipe_version, status, stage_status (json), staged_output (json),
                 error, created_by, created_time                         -- carries liveness
-- convention on landable domain tables:
service:  ... , extraction_job_id? (fk), page_region_id?      -- provenance; NULL for manual rows
dict:     ... , extraction_job_id?, page_region_id?
```

A **recipe registry** keyed by `target_kind` supplies `{stages[], land, retract?}`.

## PDM as the Layer-1 reference consumer

PDM is the ideal first vertical because it **isolates Layer 1**: it owns its images
and bounding groups (no ingestion), needs the two-stage cache (transcribe →
transliterate), and — crucially — you have **hand-done answers** to grade against.
Build Layer 1 + a **grading harness** (per-stage extracted-vs-hand, scored) here, so
the model / phone-vs-scanner / rotation experiments produce numbers, not vibes.

## Build order

1. **Layer 1** — content-addressed, per-stage, `prompt_version`ed derivation cache on
   the derived store; recipe = ordered stages.  Prove on **PDM** with the grading
   harness.  No job, no generic tables, no UI.
2. **Layer 2** — the `extraction_job` + `target_kind`/`target_context`/`land`/
   provenance filing + a thin review grid + the job runner (batch: concurrency/retry).
   First L2 consumer: the **anchor case** (ongoing service sheets) — and note it
   needs **no ingestion tables** (`source_page`/`page_region` upload/normalise), since
   its images are already event `gallery_photo`s.  Ingestion + drawn regions come with
   the *later*, harder consumers (historical records, PDM's own tooling).
3. Generalise the recipe interface + review shapes only once **two** L2 consumers
   exist (grid vs per-entry), so the abstraction is drawn from real difference.

Note on the L1 vertical: PDM is the cleanest *layer-isolation* test (L1 only, big
hand-graded corpus, multi-stage) — but the **service sheets are the cleanest input**
(you design the form) and the **primary value**, and are also gradeable (photograph N
sheets, hand-key the answers).  Reasonable to prove L1 on the service sheets first
(sheet-image → JSON, graded) and keep PDM as the harder handwritten/multi-stage
validation — or do both; they share the cache.

## Open questions (for dz)

- **Landing interface exactly:** is `land(rows, context, provenance)` returning keys
  enough, or do some targets need a two-phase (validate → commit) hook?
- **PDM commit vs read-through:** does the transliteration get *stored* onto the dict
  entry (a new assertion) after review, or stay a live derived value?  (Affects
  whether PDM ever touches Layer 2's filing at all.)
- **Region tables for PDM:** does PDM map its existing bounding groups into
  `page_region`, or keep its own and only borrow Layer 1?  (Leaning: keep its own;
  Layer 1 needs only image-ref + rects.)
- **Review-crop source of truth:** `page_region.rects` on the *normalised* image vs
  the original — pick one so crops and the LLM see the same pixels.
- **Batch policy:** desired concurrency + rate-limit against the Anthropic key, and
  resumability granularity (per page? per stage?).
- **Which gallery photos are record sheets?** (anchor case)  We dropped `photo_kind`
  when genericising the gallery, so an event's photos mix action shots with record
  sheets.  Options: a lightweight per-photo "record sheet" marker, a **separate
  gallery scope** on the event (e.g. `renderGallery('event-service-sheets', id)` — a
  second generic gallery instance), or the extraction job just selects photos.
  Leaning: a separate gallery scope, so sheets don't mix with action photos and the
  extractor's inputs are unambiguous.
- **Extract the ORIGINAL, not the display crop:** the gallery keeps the full-res
  content-addressed original (the "Original photo" link); the extractor must read that,
  not the landscape thumbnail/crop.
