---
name: wordwiki-archival-publish-model
description: "dz's 4-stage archival philosophy + the publish-via-JSON-intermediate proposal and customization strategy (floated 2026-07-08, not yet approved to build)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 61972dfd-5245-4f6c-8442-1149dcc1ee7b
---

dz's design philosophy (2026-07-08): the system KNOWS it will lose
functionality over time — the cultural data's timeframe is (hopefully)
thousands of years. Graceful-degradation stages: 1) live editor
(decades; fluent elders aging out), 2) generated static artifacts
(.html/.mp3/.pdf) viewable in future browsers (longer, finite), 3) NEUTRAL
DATA FILES convertible to any future medium (unbounded) — both simplified
(no history) and full versions, linked FROM the site, cleanly licensed, so
they get archived, 4) paper via .pdf (survives computing, loses audio).

**STAGE 6 BUILT (2026-07-09): multi-orthography publish** (doc of record:
repo-root multi-ortho-publish.md, status section). One run, all
publishable orthographies: /li + /sf full trees sharing root
content/derived/resources via ../ (Publish options.treePrefix + sharedUp;
'' = historical single-tree, byte-compatible); segments = orthography
table abbreviations riding in the bundle (orthographySegment/Name).
publishMultiTree: peer navbar links w/ existence rule + per-tree public
ids; ONE union-manifest prune; root static orthography CHOOSER
index.html (file:// works); GENERATED data/caddy-redirects.conf (301 /
and legacy paths → /li/); /servlet forwarders stay at ROOT (primary
tree, /li targets, rendered as tree-pages-at-root). ACCEPTANCE = link
checker: 1.81M relative refs all resolve (file:// operable); caught a
pre-existing book-page ../ overshoot (web-clamped, file-broken).
CAUTION for future me: publish.ts got truncated to 0 bytes by a
self-truncating python line (open-for-write before read) and deno check
of an EMPTY file passes - always wc -l after scripted edits.

**STAGE 5 BUILT (2026-07-08): the site carries its own seed.** Every
publish writes data/publish-source.json (the EXACT bundle used; no
timestamp on live builds so unchanged republish rewrites nothing; --from
passes the dump's generatedAt through as provenance) +
data/publish-source-format.md + data/index.html (data page w/ the site's
actual license: CC BY-NC 4.0 — NOT share-alike; dz pointed at publish.ts'
existing license link). about-us links it ("Dictionary Data" section).
'data' publish target; always in a full publish. Remaining: full-history
dump on data/, standalone generator example.

**STAGE 4 BUILT (2026-07-08): orthography-selected bundles.**
buildPublishSource(app, {orthographies: ['mm-sf',...], variantContent:
'all'|'selected'}); entries public in ANY selected (union), FIRST is
primary (public ids/defaultVariant); 'selected' filters variant-tagged
tuples to the chosen lanes via a schema-driven walk (filterEntryVariants),
EXCEPT the new $sourceOrthography VariantFlag (provenance — declared on
the 4 document_reference variant fields: transliteration/source_as_entry/
normalized_source_as_entry/foreign_reference) and $notVariant relics;
'mm'/blank pass everywhere (variantMatches). CLI:
dump-publish-source --orthographies=a,b --variant-content=selected.
Real-data checks: sf bundle = 0 entries (no sf gates yet — truthful);
both = 6973; selected li drops 352 non-li spelling lanes, keeps all 687
provenance ref transliterations. Default publish byte-unchanged; entries
identity kept only for the default single/'all' shape.

**STAGE 3 BUILT (2026-07-08): scan renders bundle-ized — publish --from
needs NO DATABASE.** Scan renders split into serializable structs +
loaders + pure renderers (render-page-editor.ts: GroupScanData/
BookPageScanData, loadGroupScanData/loadBookPageScanData,
renderStandaloneGroupFromData/renderAnnotatedPageFromData). Annotated
page = true load+pure split (one code path); standalone group = MIRRORED
pure twin (live one embeds a tile promise in sync markup — change both;
the full-site byte-diff is the drift alarm). Bundle: scans[] (1,585
groups, tile urls resolved at build) + books[].pageScans (1,995 pages) +
taggingLayerId (get-or-create moved to BUILD; publishing read-only);
31.6MB, 4s dump. renderDocumentReference takes ctx.scanRenderers
(bundle-backed injection). buildPublishSource is ASYNC now. VERIFIED:
full site (16,046 files) byte-identical live vs from-dump; a bare dir
with only content/+derived/ symlinks + the dump publishes with NO
database dir present. Publisher = pure function of (bundle, resource
files); audio resolution reads the content-addressed resource trees.

**STAGE 2 BUILT (2026-07-08): publish --from=<dump.json>.**
`./wordwiki.sh publish --from=ps.json [targets] [--root=...]` — the DATA
comes entirely from the dumped bundle (publish log records the dump's
generatedAt as provenance); scan renders still read the instance db, so
run from the same instance dir. VERIFIED: the ENTIRE site (16,046 html
files — all entries, categories, book pages) publishes BYTE-IDENTICALLY
from the dump vs the live db; also a unit round-trip file-equivalence
test. Full CLI publish ≈ 30s. Remaining: bundle-ize scan renders/media
manifest (then --from needs no db), site links its own dumps + licensing,
standalone generator example.

**STAGE 1 BUILT (2026-07-08): the PublishSource bundle.**
publish-source.ts (PublishSource formatVersion 1 + buildPublishSource +
publishSourceFromJson); Publish's ctor takes ONLY the bundle (no app/site
param); derived indexes via site-view.ts's shared pure functions
(entriesByCategoryOf etc.) so dump-driven and live publishes cannot drift;
`./wordwiki.sh dump-publish-source [path.json]` writes it (generatedAt
stamped at dump time only — in-memory bundles stay deterministic). Doc of
record: wordwiki/publish-source.md (format table + the REMAINING db/fs
touch enumeration: entry-scan snippets, book-page render, audio fs checks,
style constants, dict schema). Verified byte-identical publish.
RESOLVED (dz, same day): book-page info boxes render PUBLIC entries only
(non-public groups get the historical "Unknown group id" fallback; dz
accepts that the info-box render itself is unversioned). The bundle also
DENORMALIZES-ON-EXPORT (the standalone-file rule): a `users` section
(user_id/username/name/region — user.region is a new user-table column)
resolves recording speakers in-file; category rows/book rows already did
this for slugs/friendly-ids. Lookup SECTIONS, not inline copies — the
entries array stays the renderers' own projection (identity + no drift).

**Publish-via-JSON proposal (dz floated, Claude endorsed; stage 1 above
built, rest NOT yet):**
publish flow becomes (a) dump everything the public site needs to .json
files, (b) a standalone generator loads the JSONs and emits the site. Two
rationales: the stage-3 artifact is GUARANTEED CORRECT because it is
load-bearing (exports nothing consumes rot; the production pipeline can't),
and communities profoundly care about their public site's look — a small
standalone generator over documented JSON is customizable by casual/LLM-
assisted programmers with no upstream coupling (works even on free SAAS:
they run their generator on their own dump). Key convergence: SiteView
.publicEntries IS the reduced projection, already JSON-shaped. Staging:
enumerate publish's remaining db touches (entryCountByPage, category
table, audio paths, bounding-group scan rendering — the hard one) → define
the PublishSource bundle → Publish consumes only it → dump-publish-source
subcommand → publish-from-json → site links its own dumps + license.
Emit the dump ONTO the generated site (every published copy carries its
own seed). JSON schema needs a version field + written schema doc +
conservative evolution. Media via the content-addressed shared store →
dump + media dir is a self-contained archive unit. PDF/paper = another
consumer of the same dump (hub-and-spokes: db → dump → {html, pdf, ...}).

**Customization strategy:** primary = data/config in the DB (SAAS-friendly;
site-config.ts literal is the stepping stone — its interface is the future
config-table schema). Deep customization = `class MikMaq extends WordWiki`
overriding the FACTORY GETTERS the decomposition created (get lexeme/
reports, site(), store) — Claude recommended AGAINST adopting the
mytitan1c.ts nested-namespace virtual-class trick (archived-ww repo): it
freezes every nested class boundary as public API, which conflicts with
dz's periodic-major-rev maintenance style, and the JSON generator removes
most of the demand (the public site is where people want deep control).
dz has not ruled on this recommendation.

Relates to [[wordwiki-decomposition]], [[wordwiki-data-licensing]],
[[wordwiki-shared-store-layout]].
