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
FLAGGED FOR DZ: book-page info boxes render entries from the FULL editor
projection (incl. NOT-public entries' current facts) — historical behavior
preserved via an explicit getWordWiki() touch in
renderDocumentReferenceInfoBox; caught by the byte-diff.

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
