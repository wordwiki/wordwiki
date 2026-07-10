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

> **Status of this doc.** A build spec, grounded in the existing code (file:line refs
> throughout).  **BUILT (2026-07-09):** the LLM client (`liminal/llm.ts`), Layer 1
> (`liminal/extract.ts`), and the Layer-2 anchor case end-to-end — `extraction_job`
> table + `JsonField` + `service` provenance, the recipe registry + `service` recipe
> (`rabid/extraction_targets.ts`), the job runner + live review UI
> (`rabid/extraction_job.ts`), and the "Import scanned records…" menu item.  Proven on a
> real sheet against the live API (4 rows, correct `service_kind` mapping).  Deferred:
> editable staged rows, PDM Layer-1 grading harness, ingestion tables (`source_page`/
> `page_region`) — those come with the later, harder consumers.

## Anchor case: ongoing paper service records (rides existing machinery)

The **primary, ongoing** use is not a special scan pipeline — it's the piece we
already shipped.  Volunteers keep collecting service records **on paper** (the
clipboard clients and volunteers are comfortable with), and at the end of a shift
they **photograph the sheets into the event's photo gallery** — the `service-sheets`
scoped `gallery_photo` gallery on the event (`rabid/gallery.ts`, `scope='service-sheets'`,
`renderGallery('event', id, 'service-sheets', 'Service Record Sheets')`; **done**).
A deferred, batch **extract** then turns those photos into `service` rows on the same
event — so no one retypes a season of data for reports.

This means, for the anchor case:
- **Ingestion is already built** — the source images are the event's `service-sheets`
  gallery photos.  No upload/normalise UI, and **no `source_page`/`page_region`
  tables**, for this case.
- **Target + context are trivial** — `target_kind='service'`, `target_context={event_id}`
  (the event that owns the photos); it lands exactly the `service.event_id` we have.
- **Provenance is a `gallery_photo`** — a landed `service` points back (`extraction_job_id`
  + `source_gallery_photo_id`) at the photo it came from; retract-a-sheet = delete its
  services.
- **Capture and extract are decoupled in time** — a feature.  The photo is the durable
  record: teams can **start photographing sheets into event galleries this season
  immediately** (works today), and extraction can come later and be **re-run** as the
  prompt improves.  You're never worse off than "we have the sheets."
- **You control the paper form** — so design the record sheet to be extraction-friendly
  (boxed fields, consistent layout, the event pre-printed).  A big accuracy lever the
  messy *historical* records don't have; keep the two cases separate (clean ongoing
  sheets vs loose old records — same substrate, very different recipes/quality).

## Two layers (the load-bearing split)

**Layer 1 — the cached extraction derivation (the primitive).**  A pure,
content-addressed function `(image-region, stage, prompt_version, model) → result`,
memoised in the derived content store — exactly like the derived crop store.  It
**owns no images and no tables**: it takes a *reference* (content hash + optional
rect(s)).  A consumer that already owns its images (PDM: the dict's page scans +
hand-drawn bounding groups) uses Layer 1 **directly** as a read-through derived
attribute — `transliterate(transcribe(region))`, each stage cached.

**Layer 2 — the flow (ingestion + job + review + filing).**  Everything Layer 1
deliberately isn't: the **image lifecycle** (upload, normalise/rotate via `convert`
in a derived store, retract), the **extraction job** (orchestration, per-stage status,
liveness), **review + commit**, and **filing rows into a target table with provenance
+ retract**.

**Batch vs single is a Layer-2 property, not the layer boundary.**  A job may drive
one image (a required form) or a thousand pages; either way it's Layer 2 if it needs
ingest/review/commit.  The boundary is *"do you own the image and just want the cached
extraction" (L1)* vs *"do you need the flow" (L2)* — not the count.

```
                 ┌───────────────── Layer 2: the flow ─────────────────┐
  upload/rotate ─┤ source images → extraction_job(+stages) → staged     │→ land → target table
   (derived)     │            review · commit · retract · provenance    │      (+ provenance FK)
                 └───────────────────────────┬─────────────────────────┘
                                             │ calls, per stage (cached)
                 ┌───────────────────────────┴─────────────────────────┐
  PDM uses this ─┤ Layer 1: cache  (image-ref, stage, prompt_version)   │
   directly      │   → derived content store (memoised, per stage)      │
                 └──────────────────────────────────────────────────────┘
```

## Grounded in existing infrastructure

Everything below rides code that already exists.  Key anchors:

| need | existing mechanism | ref |
|---|---|---|
| memoised, content-addressed derivation | `content.getDerived(store, {fn}, closureKey[], ext)` — fn may **return a string/Uint8Array** that's written to the `ext` file | `liminal/content-store.ts:156` |
| content hash | SHA-256 of `JSON.stringify(closureKey)`; fs paths kept out of the key | `content-store.ts:165` |
| the original photo bytes | `parsePhotoValue(value).path` → `content/photos/…`; fs path `${contentDir}/${contentRef}` | `liminal/photo.ts:155,446` |
| a rotated, size-bounded JPEG for the model | `containedPhotoPath(path, 1600, 1600, rotate)` (derived, cached) | `photo.ts:318` |
| credential loading (degrade, never crash) | `loadMailer(appName)` reads `${appName}-mail-credential.json` | `liminal/mail.ts:155` |
| new table = interface + `class extends Table` + `createDMLString()` + register in `rabid.tables` | `GalleryPhotoTable` | `rabid/gallery.ts:40,68,339`; `rabid/rabid.ts:70,106` |
| nullable FK-to-source (provenance) | `ManagedForeignKeyField(name, table, col, {nullable,indexed}, label)` | `rabid/task.ts:107,999` |
| retract by FK | `DELETE FROM t WHERE fk = :id` | `rabid/group.ts:210` |
| a fragment that re-renders on cross-actor activity | `liveReloadableProps(keys[], url)` + emit matching key | `liminal/table.ts:2091`; `gallery.ts:157` |
| the service row to write | `service.insert({event_id, client_name, …})` — only those two required | `rabid/service.ts:125,168` |

Two facts that shape the design:

1. **The derived store already reads/writes JSON.**  `getDerived`'s fn can `return`
   a JSON string, written under a `.json` extension, keyed by the closure hash.  So a
   cached extraction is a file, and Layer 1 needs **no tables**.  (There is no built-in
   *reader* — we add a 3-line `readDerived` helper.)
2. **`dirty.record` is a no-op outside a request.**  A background job that updates
   status over time has no ambient dirty collector, so it must append the liveness key
   **directly to the shared `app.liveLog`** (`liminal.ts:742`, `live.ts:76`).  This is
   the single non-obvious wiring in the runner.

## Layer 1 — the cache (`liminal/extract.ts`, new; no tables)

A **stage recipe** and the cached primitive:

```ts
// A single extraction stage.  Ordered lists of these are a recipe; stage k's
// output feeds stage k+1's input.  prompt_version is the explicit invalidation knob.
export interface ExtractStage {
    name: string;               // 'transcribe' | 'extract' | 'transliterate'
    model: string;              // 'claude-opus-4-8'  (participates in the cache key)
    promptVersion: number;      // bump to re-run / re-grade  (in the cache key)
    imageBox: number;           // longest edge fed to the model (default 1600); a GRADEABLE
                                // knob — in the cache key, so sizes cache side-by-side.
    schema: JsonSchema;         // output_schema; the result is validated against it
    // Build the prompt from the prior stage's output.  MUST only use output-relevant
    // bits — anything that changes the output but isn't in (name, model, promptVersion,
    // imageBox, input) silently serves stale extractions.
    prompt(input: unknown): string;
}
export type ExtractRecipe = ExtractStage[];

// The primitive.  Key = hash([ 'extract', imageContentRef, model, promptVersion,
// imageBox, stageName, inputHash ]).  The IMAGE is referenced by content hash (never
// bytes in the key); the prior stage's output participates via its own hash, so
// re-running a later stage reuses every earlier cached stage.
export async function extractStage(
    cfg: ExtractConfig, imageContentRef: string, rotate: number,
    stage: ExtractStage, input: unknown): Promise<unknown>
{
    const box = stage.imageBox || 1600;
    const inputHash = await digestString(JSON.stringify(input ?? null));
    const ref = await content.getDerived(
        `${cfg.derivedDir}/extractions`,
        { extract: async (_target: string) => {
            // rotate-FIRST, then contain to `box` (never crop for the LLM) — both via the
            // existing contained-photo derivation, itself cached & content-addressed.  box
            // may exceed 1600 iff sheet originals are kept full-res (capture exception).
            const jpeg = await cfg.photo.containedBytes(imageContentRef, box, box, rotate);
            const raw  = await cfg.llm.extract(stage.model, stage.prompt(input),
                                               {bytes: jpeg, mediaType: 'image/jpeg'});
            return JSON.stringify(validateJson(stage.schema, raw));   // string → written .json
        }},
        ['extract', imageContentRef, stage.model, stage.promptVersion, box, stage.name, inputHash],
        'json');
    return JSON.parse(await readDerived(cfg.derivedDir, ref));
}

// Run a whole recipe over one image, each stage cached independently.
export async function extractAll(
    cfg: ExtractConfig, imageContentRef: string, rotate: number,
    recipe: ExtractRecipe): Promise<unknown>
{
    let out: unknown = null;
    for (const stage of recipe) out = await extractStage(cfg, imageContentRef, rotate, stage, out);
    return out;
}

// getDerived returns only a contentId; add the missing reader.
async function readDerived(derivedDir: string, contentId: string): Promise<string> {
    return Deno.readTextFile(posix.join(derivedDir, contentId));
}
```

- **Per-stage keys are essential**: re-running the transliterate prompt must reuse
  every cached transcription.  `promptVersion` is the invalidation knob; the prompt
  template lives in `prompt()`.
- **Region image** (PDM): the same primitive, but `imageContentRef` is first cropped
  to the rect(s) via the existing crop store, so the cropped input is itself cached.
  For the anchor case there are **no regions** — the whole sheet is the input.
- **Standalone use (PDM):** no job, no tables — hold your own image refs and read the
  cached derivation like any derived value.  This is the Layer-1 reference consumer.

### The LLM client (`liminal/llm.ts`, new — nothing exists today)

There is **no** LLM/Anthropic client, SDK, or API-key handling anywhere in the repo.
Build a minimal one, mirroring `loadMailer`'s degrade-don't-crash credential pattern:

```ts
export interface LlmImage { bytes: Uint8Array; mediaType: 'image/jpeg' | 'image/png'; }

export interface Llm {
    // Returns validated JSON (via the model's tool-use / structured-output mode).
    extract(model: string, prompt: string, image: LlmImage): Promise<unknown>;
}

// Reads `${appName}-anthropic-credential.json`  ({ apiKey, defaultModel? }).
// Missing/broken → a DisabledLlm whose extract() throws a clear error, so a JOB fails
// visibly (status 'failed', error surfaced) rather than the server crashing.
export function loadLlm(appName: string): Llm;

// AnthropicLlm.extract: POST https://api.anthropic.com/v1/messages
//   headers: x-api-key, anthropic-version
//   content: [ {type:'image', source:{type:'base64', media_type, data}}, {type:'text', text: prompt} ]
//   structured output via a single output tool whose input_schema = stage.schema.
```

Credential file (git-ignored, one per app, mirrors the mail credential):
`rabid-anthropic-credential.json` = `{ "apiKey": "sk-ant-…", "defaultModel": "claude-opus-4-8" }`.

**Image sizing note.**  Photo originals are already capped at ~1600px on the long edge
(`LM_PHOTO_MAX_DIM`, `photo.ts`), and `ALLOWED_CONTAIN_BOXES` already includes 1600².
So `containedBytes(ref, 1600, 1600, rotate)` is "the whole sheet, oriented, ≤1600, JPEG"
— exactly the LLM input we want, and cached.  *Open lever:* dense handwriting may want
more than 1600px; that means raising the **capture** cap, not just the box — flagged
below.

## Layer 2 — the flow

### `extraction_job` (`rabid/extraction_job.ts`, new)

The orchestration + progress record.  Follows the standard table conventions
(`gallery.ts` shape; register in `rabid.tables`).  JSON columns are plain `TEXT`
(`StringField`) serialized/parsed at the call sites — there is no framework JSON field
type; a thin `JsonField extends StringField` marks intent and carries `parse`/`format`
static helpers (model on `MarkdownField extends StringField`, `table.ts:1371`).

```ts
export interface ExtractionJob {
    extraction_job_id: number;
    target_kind:    string;   // recipe-registry key: 'service' | 'attendance' | …
    target_context: string;   // JSON domain anchors, e.g. {"event_id":42}
    status:         string;   // job_status_enum (below)
    stage_status:   string;   // JSON: per-source progress   {"<gallery_photo_id>":{stage,status,error}}
    staged_output:  string;   // JSON: extracted-but-not-committed rows, per source, editable in review
    error:          string;   // top-level failure message (default '')
    created_by:     number;   // ManagedForeignKeyField → volunteer
    created_time:   string;   // ManagedDateTimeField
}

export const job_status_enum: Record<string, string> = {
    pending:   'Pending',       // created, queued
    running:   'Running',       // LLM in flight
    review:    'Needs review',  // extracted; staged_output awaiting a human
    landed:    'Landed',        // rows written to the target table
    failed:    'Failed',        // see error / stage_status
    retracted: 'Retracted',     // landed rows deleted; job kept for history
};
```

Table:

```ts
super('extraction_job', [
    new PrimaryKeyField('extraction_job_id', {}),
    new StringField('target_kind', {edit: security.never}),
    new JsonField('target_context', {default: '{}', edit: security.never}),
    new EnumField('status', job_status_enum, {default: 'pending'}),
    new JsonField('stage_status', {default: '{}'}),
    new JsonField('staged_output', {default: '{}'}),
    new StringField('error', {default: ''}),
    new ManagedForeignKeyField('created_by', 'volunteer', 'volunteer_id', {nullable: true}),
    new ManagedDateTimeField('created_time', {}),
]);
```

The job carries **liveness** on its `rowKey` so status/staged-rows render live; concurrent
jobs are just concurrent rows.  Its source set is **not a column** for the anchor case —
the runner selects the event's `service-sheets` gallery photos from `target_context.event_id`
at run time.  (Ingestion tables `source_page`/`page_region` arrive with the later
upload/drawn-region consumers, per build order.)

### Provenance convention on landable tables

`land` is domain-specific; **retract + "which scan" are generic** via a nullable FK
convention.  For the anchor case, add to `service` (mirrors `from_template_task_id`):

```ts
new ManagedForeignKeyField('extraction_job_id',      'extraction_job', 'extraction_job_id', {nullable: true, indexed: true}),
new ManagedForeignKeyField('source_gallery_photo_id','gallery_photo',  'gallery_photo_id',  {nullable: true}),
```

- `land` stamps both; manual rows leave them NULL.
- Generic retract: `DELETE FROM service WHERE extraction_job_id = :job` (`group.ts:210`
  pattern).
- Free per-row badge ("from Sheet 3 · scan #7") and the review crop (from the source
  photo) fall out of `source_gallery_photo_id`.

### The recipe registry (`target_kind` → recipe)

Resolved like `tableByName`.  `land` is the only domain-specific piece; the generic layer
never sees a domain schema.

```ts
export interface ExtractionTarget {
    kind: string;                     // 'service'
    label: string;                    // 'Service records'
    // What "start an import" collects into target_context (e.g. the event_id).
    contextFields: ContextFieldSpec[];
    stages: ExtractRecipe;            // Layer-1 stages; final stage outputs an array of rows
    // Write extracted rows to the domain table; stamp provenance; return landed keys.
    // Plain-tabular targets can use the default adapter (map fields → columns, merge
    // context, insert); versioned/dedup targets (dict) supply their own.
    land(rows: unknown[], context: Record<string, unknown>,
         prov: {extraction_job_id: number; source_gallery_photo_id: number}): number[];
    retract?(jobId: number): void;    // default: DELETE WHERE extraction_job_id = job
    reviewShape: 'grid' | 'form';     // hint for the thin review UI
}
export const extractionTargets: Record<string, ExtractionTarget>;   // registry
```

**The `service` target** (anchor case):

```ts
extractionTargets['service'] = {
    kind: 'service', label: 'Service records', reviewShape: 'grid',
    contextFields: [{name: 'event_id', kind: 'event'}],   // set when the import is created
    stages: [{
        name: 'extract', model: 'claude-opus-4-8', promptVersion: 1,
        schema: serviceSheetSchema,      // array of {client_name, service_kind, bike_description,
                                         //           service_description, client_postal, client_phone}
        prompt: () => SERVICE_SHEET_PROMPT,   // "here is a photographed paper service-record sheet…"
    }],
    land(rows, {event_id}, prov) {
        return rows.map(r => rabid.service.insert({
            event_id,
            client_name: r.client_name || '(from scan)',
            service_kind: normalizeServiceKind(r.service_kind),   // → diy | full | other
            bike_description: r.bike_description ?? '',
            service_description: r.service_description ?? '',
            client_postal: r.client_postal ?? '',
            client_phone: r.client_phone ?? '',
            extraction_job_id: prov.extraction_job_id,
            source_gallery_photo_id: prov.source_gallery_photo_id,
        } as service.ServiceOpt));
    },
};
```

Only `event_id` + `client_name` are strictly required by `service.insert`; everything
else defaults (`service.ts:141`), so a sparse extraction still lands.

### The job runner (`rabid/extraction_job.ts` methods + a background worker)

Generic orchestration; batch concerns live here.

- **Resolve** the recipe from `target_kind`; **gather sources** (anchor: the event's
  `service-sheets` photos via `gallery_photo.forOwner`).
- **Per source, per stage** call Layer 1 (`extractAll`) — **cached**, so the derived
  store IS the resumability + re-run mechanism: a killed job re-runs and every already
  computed stage is a cache hit; improving the prompt (bump `promptVersion`) re-extracts
  only what changed.
- **Concurrency + retry**: cap concurrent LLM calls (propose 3), retry transient errors
  (propose 2× with backoff).  Rate-limit against the key.
- **Write staged_output** (not the domain table) and set `status='review'`.
- **Liveness (the one non-obvious bit):** the worker runs outside a request, so after
  each stage/status write it must
  `app.liveLog.append([sel(rabid.extraction_job.rowKey(jobId))])` directly — a bare
  `dirty.record` would be dropped (`live.ts:76`, `liminal.ts:742`).  The event page's job
  section registers that exact `rowKey` via `liveReloadableProps`, so progress ticks live.
- **Land** (a `@routeMutation`, in-request → normal dirty flow): for each reviewed staged
  row call `target.land(...)`, stamping provenance; set `status='landed'`.  Landed
  services now appear in the event's Services/activity, each with a "from scan · Sheet N"
  badge linking back to the source photo.
- **Retract** (`@routeMutation`): `DELETE FROM service WHERE extraction_job_id = :job`;
  set `status='retracted'`.

### Review — per-shape and thin

Don't over-generalise the *screen*; generalise the *data* (staged rows) and the per-row
**review crop** (source photo, or `region.bbox` when regions exist).  The `service`
target's `reviewShape:'grid'` is a keyboard grid of staged rows (edit/accept/drop) beside
the source sheet; the dict target will be a per-entry form.  Generalise the review
interface only once **two** L2 consumers exist (grid vs form), so the abstraction is
drawn from real difference.

## Anchor-case UI wiring (rabid/event + gallery)

The `service-sheets` gallery header is **already a ☰ menu** built to host this
(`gallery.ts:renderGalleryAdd`, item "Add photo…").  Add:

- **"Import scanned records…"** menu item → creates an `extraction_job`
  `{target_kind:'service', target_context:{event_id}}` and kicks the runner.
- A **job section** on the event page (below the sheets gallery), `liveReloadableProps`
  on the job `rowKey`: shows per-sheet progress while running, then the review grid, then
  **Land** / **Retract**.
- Landed `service` rows render in the existing Services/activity section with a scan badge
  (`source_gallery_photo_id` → sheet thumbnail + link).

## Generic schema sketch (recap)

Layer 1: **no tables** (the derived store, keyed by content).  Layer 2:

```
extraction_job:  extraction_job_id, target_kind, target_context(json), status,
                 stage_status(json), staged_output(json), error, created_by, created_time
-- provenance convention on landable domain tables (nullable; NULL for manual rows):
service:  … , extraction_job_id? (fk), source_gallery_photo_id? (fk)
dict:     … , extraction_job_id?, page_region_id?
-- deferred, arrive with upload/drawn-region consumers (NOT the anchor case):
source_page:  page_id, image, normalize_params, uploaded_by, kind, …
page_region:  region_id, page_id, rects(json), origin('drawn'|'model'|'lines')
```

## PDM as the Layer-1 reference consumer

PDM isolates Layer 1: it owns its images + bounding groups (no ingestion), needs the
two-stage cache (transcribe → transliterate), and — crucially — has **hand-done answers**
to grade against.  Build Layer 1 + a **grading harness** (per-stage extracted-vs-hand,
scored) here, so model / phone-vs-scanner / rotation experiments produce numbers, not
vibes.  The **service sheets are the cleanest input** (you design the form) and the
primary value, and are also gradeable — reasonable to prove L1 on service sheets first
and keep PDM as the harder handwritten/multi-stage validation; they share the cache.

## Build order

1. **LLM client** (`liminal/llm.ts`) + credential loader — net-new, mirrors `loadMailer`;
   a `DisabledLlm` default so no-key installs degrade cleanly.
2. **Layer 1** (`liminal/extract.ts`) — `extractStage`/`extractAll` + `readDerived` on the
   derived store; stage recipe type; JSON-schema validation.  Prove on the **service
   sheets** (sheet-image → rows JSON, hand-graded) — no job, no tables, no UI.  Add the
   PDM grading harness in parallel/after.
3. **Layer 2 — anchor case only**: `extraction_job` table (+ register in `rabid.tables`);
   `JsonField`; `service` provenance columns; the `service` recipe + registry; the job
   runner (concurrency/retry/liveLog) ; the thin review grid; the event-page wiring +
   the "Import scanned records…" menu item.  **No** ingestion tables.
4. **Generalise** the recipe interface + review shapes only once a **second** L2 consumer
   exists (grid vs per-entry form), so the abstraction is drawn from real difference.
   Ingestion (`source_page`/`page_region`, upload/normalise/drawn regions) arrives with
   the later, harder consumers (historical records, PDM tooling).

## Resolved / open questions

**Resolved by the survey:**
- *Which gallery photos are record sheets?* → the separate **`service-sheets` gallery
  scope** (built).  Extractor inputs are unambiguous.
- *Extract the original, not the display crop?* → yes; the LLM input is
  `containedBytes(original, 1600, 1600, rotate)` (whole sheet, oriented, ≤1600), a cached
  derivation of the **content-addressed original**, never the landscape card crop.
- *Landing = `land(rows, context, provenance) → keys`?* → yes, single-phase; the
  "validate → commit" two-phase is provided naturally by `staged_output` (extract → edit
  staged rows in review → `land`).  No separate validate hook.
- *Review-crop source of truth?* → the **rotated, contained** image — the same pixels the
  LLM sees.

**Resolved by dz:**
- **Batch policy** → concurrency **3**, retry 2× backoff.  Resumability is
  per-stage-for-free via the cache.
- **Capture / image resolution** → storage is a non-issue (few sheet images), so the
  real question is *LLM cost vs accuracy at larger sizes* — **unknown, so make it a
  gradeable knob.**  Consequences baked into the design:
  - The **image box size is a stage/recipe parameter** (default 1600), and — because it's
    in the Layer-1 cache key — different sizes are cached side-by-side and graded against
    the hand answers.  Don't hardcode 1600 in the primitive.
  - To let the knob range **above 1600**, sheet captures must not be pre-downscaled to
    `LM_PHOTO_MAX_DIM`.  Keep `service-sheets` originals at full resolution (a per-scope
    capture exception / higher cap), so the extractor can request a larger box when
    grading says it helps.  Display still uses the contained-1024 card.
- **PDM commit vs read-through** → **experiment first.**  Near-term PDM deliverable is
  Layer 1 + the **grading harness only**: batch-scan a whack of already-hand-transcribed
  entries and measure how it does.  Nothing lands; no commit UI.  Design the UI *after*
  the result proves useful.
- **Region tables for PDM** → undecided, so **defer.**  PDM keeps its own bounding groups
  and borrows only Layer 1 (image-ref + rects); no generic `page_region` yet.
