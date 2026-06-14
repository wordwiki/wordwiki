# Wordwiki Architecture Proposal — the Publication / Approval Model

*Status: **PROPOSAL** (written 2026-06-12, revised 2026-06-13, from a design
conversation between dz and Claude). Nothing here is built yet. This is the
design we converged on for the `published_from`/`published_to` dimension and
the review/approval workflow that hangs off it. It extends, and assumes, the
existing [assertion model](assertion-model.md).*

*Design posture (dz): this versioned model is already complex, and its
durability rests on two people — a future archivist reconstructing it cold
from the data, and a solo volunteer who will only keep shipping if the system
stays small. So **every special case has to earn its keep.** Where this
document chooses the more uniform option over the cleaner-feeling abstraction,
that is why.*

## 1. Goal

Let **untrusted contributors** edit the dictionary, and require **every
change — including brand-new entries — to be approved by one other senior
person**, with a durable audit trail. This must hold even for trusted
editors: no one publishes their own work unreviewed.

The hard constraint is the editor's character: it is a **live editor**. Each
fact goes into the `dict` table and is editorially live the instant it is
asserted — there is no "load a lexeme, work on a private copy, submit it as a
unit" model. So approval cannot gate *editing*. It gates **publication**: what
the public site shows, and what the curated export contains.

## 2. The core idea — two currency dimensions over one version chain

Today an assertion carries one interval, `valid_from`/`valid_to`, expressing
**editorial currency**: the version the editors' workspace treats as live.
Versions chain (`replaces_assertion_id`; one version's `valid_to` becomes its
replacement's `valid_from`); the last is open to `END_OF_TIME` or closed by a
retraction (a tombstone, `valid_from === valid_to`). The editor/workspace view
is `valid_to = END_OF_TIME`.

We add a second, independent interval on the same rows,
`published_from`/`published_to`, expressing **approval currency**: the span
during which that version was the *published truth*. The public view is
`published_to = END_OF_TIME`.

**The two intervals are NOT nested — that is the whole point.** A version can
be editorially superseded but still published (an approved value, while a new
edit sits pending on top of it); a version can be editorially current but not
published (a pending edit). They decouple completely, which is exactly what
lets the public site keep showing approved content while edits accumulate
live — with no draft-copy machinery.

Both are cheap indexed predicates (`= END_OF_TIME` for "current"), and both
support **point-in-time queries**: "what did the editors believe on date X"
(`valid_from ≤ X < valid_to`) and "what was published on date X"
(`published_from ≤ X < published_to`), at range-scan cost.

**Everything is one row shape.** Assert, approve, reject, comment — all are
ordinary version rows on the chain. A single field, `change_action`,
discriminates what kind of event each row is. This uniformity is deliberate
(see the design posture): one structure plus one label is far cheaper to
reconstruct against, and to maintain, than several row species.

### Worked example

Fact F holds a category value. Times advance t0 < t1 < t2 < t3.

- **t0 — assert.** A contributor writes `v1` ("water"). `change_action='assert'`,
  `change_by = contributor`. `valid = [t0, ∞)`, `published = none`. Editors see
  "water" (pending); the public sees nothing yet.
- **t1 — approve.** A senior (≠ the contributor) approves by **re-asserting**
  the value: `v2` ("water"), `change_action='approved'`, `change_by = senior`.
  `v1.valid_to` closes to t1; `v2.valid = [t1, ∞)`, `v2.published = [t1, ∞)`.
  The approval *is* a row, authored by the approver — that is the "approved-by,
  on the chain." Now editors and public both see "water"; the chain records who
  proposed it (`v1`) and who approved it (`v2`).
- **t2 — comment.** Anyone writes `v3` ("water", `change_action='comment'`,
  note: "should we add the SF spelling?"). It re-asserts the value, carries the
  discussion in `change_note`, and is **never approved or published**
  (`published = none`). `v2.valid_to` closes to t2; `v3.valid = [t2, ∞)`;
  `v2.published` stays `[t1, ∞)` — *the comment does not touch the published
  dimension at all.* Public still sees "water" (via `v2`, still
  published-current); the discussion rides in the full record.
- **t3 — edit + approve.** A contributor edits to "liquid" (`v4`, assert,
  pending); a senior approves (`v5`, "liquid", approved). `v2.published_to`
  closes to t3; `v5.published = [t3, ∞)`. The whole story — proposal, approval,
  discussion, re-edit, re-approval — is a single readable chain.

## 3. The columns (new on `dict`)

| column | meaning |
|---|---|
| `published_from` | when this version became published truth (null while unpublished) |
| `published_to` | when it stopped (`END_OF_TIME` while currently published) |
| `change_action` | what kind of event this row is: `assert` (default), `approved`, `reverted`, `comment` (see §4) |
| `change_note` | free text; **required** for `reverted` and `comment`, optional otherwise |

`change_by_username` already exists (the row's author). **There is no separate
`approved_by` column** — because approval re-asserts (§4), the *approver is the
approval row's `change_by_username`*. "Who approved the current published
value of F" is simply F's published-current row's author; "who proposed the
content" is found by walking back the chain to its originating `assert`. Two
lookups, no redundant column — the uniform-row model pays off immediately.

**Mutation discipline.** Content and identity fields stay immutable, as today.
The only mutable cells are **interval ends** (`valid_to`, `published_to`),
which move exactly once, `END_OF_TIME → a concrete time`, and are never
reopened. Approval, reject, comment all *add rows*; nothing rewrites a row's
content. The store stays append-mostly.

## 4. The operations

Each is one of the three UI mutation forms (immediate / confirm /
modal-of-arguments), implemented as a `LexemeOps` verb (server-side, stamped,
permission-checked there — the verbs are callable from any page). Each appends
a version row; `change_action` labels it.

1. **Assert** *(any editor, incl. untrusted)* — a new content version.
   `change_action='assert'`, `published_from` null (pending). The valid chain
   advances. Needs approval.

2. **Approve** *(a user with **approve-permission**, ≠ the author of the change
   being approved)* — **re-assert** the pending value with
   `change_action='approved'`; the new row becomes valid-current and
   published-current, and the predecessor's `published_to` closes at the same
   instant (gap-free, overlap-free). The approval row's author is the approver.
   (dz's model: every fact edit is naturally two rows — the assert and the
   approve — and "approved-by" lives on the chain as that second row.)
   **The workaround** (dz, after the language team): the "≠ the contributor"
   half has an escape hatch — a user granted a **self-approve permission** may
   approve their own content (a sole approver on a small project). It is
   self-documenting: an `approved` version whose author equals the content's
   author *is* a recorded single-signature approval, queryable in the audit.
   The two layers: the *permission* checks (holds approve-permission; may
   self-approve) live in the production verb (`LexemeOps` + `security`); the
   *two-person* rule is an overridable guard in the model itself
   (`approve(…, {allowSelfApprove})`), so the spec expresses it and the
   property test checks both implementations enforce it identically.

3. **Revert** *(senior ≠ author)* — undo a change by **re-asserting a prior
   published value**, `change_action='reverted'`, **required note**,
   auto-published under the carve-out (§6). This is *one* operation for the two
   situations a reviewer meets: declining a *pending* edit (what the review UI
   calls "reject" — re-assert the last published value, so workspace and public
   re-converge on the known-good content) and rolling back an *already-published*
   value later judged wrong (re-assert a still-earlier published value). The
   reverted version stays in history. (Declining a *brand-new*, never-published
   fact has no value to restore → a tombstone authored by the senior, required
   note.)

4. **Comment** *(anyone)* — **re-assert the current value** with
   `change_action='comment'` and the text in `change_note`. The instant it is
   written it is a fact; it is **never approved and never published**
   (`published_from` stays null). It therefore appears in the full-history
   export and is **automatically absent** from the published-only export, with
   no special handling. See §5.

Deletion is not a new operation: a delete is an asserted tombstone (pending),
and **approving a deletion** closes the predecessor's `published_to` with *no*
successor published interval — the fact leaves the public view. The approving
senior is the author of the approving row.

`change_action` enum, then, is the whole type system for the chain:
`assert | approved | reverted | comment` (a deletion is a tombstone whose
`change_action` is `assert` when proposed, `approved`/`reverted` when a
reviewer acts on it). One field; four values; the entire model reads off it.

## 5. Comments — on the chain, unapproved

Comments are how a declined contribution gets discussed and a contributor argues back, and
for a language being *recovered* (not merely recorded) that discussion — the
evidence, the competing readings, the reasoning behind a reconstruction — is
itself valuable: it belongs in the durable record. Earlier drafts of this
document modelled comments as separate annotation facts, on the theory that a
comment needs its own approval lifecycle. **It does not** — dz's decision: a
comment is never approved, never part of the published version; the instant
someone writes it, it is simply a fact. That removes the only argument for
separating it out, so a comment is just a version row:

- `change_action='comment'`, value re-asserted (so the editor view and diffs
  read the value off it with no filtering), discussion text in `change_note`;
- `published_from`/`published_to` null — never published, so it is in the
  full-history export and absent from the published-only export *for free*
  (the `published_to = END_OF_TIME` projection skips it because it has no
  published interval);
- a reject-reason and a standalone comment are now the **same shape** —
  `change_note` on a marked event — so the symmetry dz wanted is achieved by
  bringing comments *down* onto the chain, not by lifting reasons off it.

**The one special case, and where it is contained.** Because a comment is
never approved, it must not make a settled fact *look* like it has a pending
edit (there would be no approval action that could ever clear it from the
review queue). So "pending" is defined over the latest **content** version —
the latest row that is not a comment:

> `isPending(fact)` = the latest non-`comment` version of the fact has
> `published_from` null. `latestContentVersion(fact)` = the value-bearing tip,
> ignoring comments.

That is the **only** place comment-awareness is needed. Display reads the
value off valid-current (the comment carries it); the published projection
excludes comments by their null interval; diffs work because a comment's
predecessor carries the prior value. Just the queue predicate needs the label,
so it lives in one helper (`latestContentVersion`/`isPending`), documented
there. This was the choice between (a) a comment as a non-chain point-event
(cheap queue, but a new row category and an overloaded `valid_from===valid_to`)
and (b) a comment as an ordinary chain version filtered in one query. We chose
**(b)**: one filter in one place earns its keep; fracturing "every row is a
chain link" does not.

**Content vs. process — the clean line.** If a piece of reasoning belongs *in
the dictionary* (a usage note, a reconstruction note a reader should see), it
is authored as **content** — an ordinary note fact that is approved and
published like any value. If it is *process* discussion, it is a **comment** —
unpublished, full-history only. "The discussion is part of the artifact" thus
means: it survives in the durable record, and the subset that is genuinely
dictionary content is promoted to real, approved notes. The two never blur,
and nothing is approval-gated that should not be.

## 6. Invariants (machine-checkable)

In the `verify-migration` spirit — write these the week the columns go live.

- **I1** — at most one version per fact has `valid_to = END_OF_TIME`. *(today)*
- **I2** — at most one version per fact has `published_to = END_OF_TIME`. Zero
  is legal (deleted/unpublished).
- **I3** — a fact's published intervals are **disjoint**; at a value-replacement
  handoff (approve / revert) they are **gap-free**
  (`old.published_to === new.published_from`). Deletions intentionally leave no
  open published interval.
- **I4 — the two-person rule** *(a WRITE-TIME check, not a stored-data
  invariant — the data carries no roles, so this is enforced in the production
  verb, not by the validator).* An `approved` version is legitimate iff its
  author **holds approve-permission** and **differs from the author of the
  change being approved** — *unless* the author holds the **self-approve
  permission** (the workaround), in which case a single-signature self-approval
  is allowed and recorded (approver === content author). A `reverted` version
  re-publishes a *previously-published* value — no new value enters publication
  — so it needs only the reverter's own authority (the carve-out). Grandfathered
  rows (below) are exempt: they predate the system and have no approver.
- **I5** — the publishing row's author holds approve-permission (write-time).
- **I6** — `published_from ≥ valid_from`.
- **I7** — tombstones (`valid_from === valid_to`) carry no published interval; a
  retraction publishes by *closing the predecessor's* `published_to`.
- **I8 — comments are inert in publication.** A `comment` row has
  `published_from`/`published_to` null, and `isPending` ignores it.
- **Grandfather** — backfilled legacy data (§9) is published `assert` rows with
  no approving successor; I4 exempts them ("published before the approval
  system existed, not individually reviewed"). This structural signature needs
  no extra column.

## 7. Derived queries (the payoff)

- **Public view** = the published projection **AND** the status filter (dz,
  after the language team): the `status`-`Completed` gate is *kept* (it means
  "the whole lexeme is ready"), and the per-fact published dimension
  (`published_to = END_OF_TIME`) is ANDed on top. So `publishedEntries` is the
  `PublishedTupleQuery` projection filtered by `isPublished`. Approval runs even
  while a lexeme is in-progress, so an in-progress entry may carry published
  facts but stays off the public site until its status reaches Completed. The
  editor views stay on the valid-current projection. *(Built — Phase 1.)*
- **Review queue** = facts where `isPending` (latest content version
  unpublished), plus pending deletions (latest content version is a tombstone
  whose predecessor is still published). Index it on day one — it is the
  seniors' worklist and runs every time they look.
- **The review diff is trivial**: the pending version's predecessor is the
  published one; old-published vs new-pending values are right there.
- **Per-lexeme change view** (dz's chosen review surface): everything changed
  in a lexeme, interact piecemeal (approve or revert individual facts) or
  bulk-approve. **Bulk approve is UI sugar** that expands to per-fact approvals,
  each checked against *that fact's* author — a bulk containing the reviewer's
  own edits skips those with an "N still need another senior" notice (refusing
  would punish collaboration). **Structural dependency rule**: approving a fact
  implies approving its pending ancestors; reverting a parent implies its
  pending descendants (else a gloss publishes under an unpublished subentry).
  The diff view should preview the post-partial-approval public entry so a
  reviewer makes a mixed old/new state with eyes open.
- **CLI publish gets an exact dirty set**: entries whose published intervals
  changed since the last publish. The 2-second targeted publish becomes a
  precise incremental one.

## 8. The two exports and the two phases

The project exports its data in **two forms**, and they are exactly the two
currency dimensions made concrete:

- **Published-only** = the `published_to = END_OF_TIME` projection. This is
  what the static-site generator bakes, and what eventually prints. Comments
  and pending/rejected work are absent by construction.
- **Full-history** = the complete record: every version, every interval, the
  provenance (who proposed, who approved, the rejections-with-reasons, the
  discussion). This is the archival hedge — the form designed to outlive the
  software and be parsed cold by someone who never met us, so its legibility
  matters more than the live db's.

So the approval machinery is not overhead bolted onto a dictionary; the
published interval is the formal definition of *the curated edition* versus
*the complete record*, and both are first-class deliverables.

**The project has two phases, and the dimensions serve both.** In the **active
collecting** phase — urgent now, with the last speakers who grew up with the
language in their 70s and 80s — the cardinal sin is letting review latency
strand a contribution. The `valid`/`published` split makes that impossible:
the instant a fact is asserted it is *already in the full-history record*,
captured and safe, even though unpublished. **Curation can run arbitrarily
behind capture** with nothing at risk, because the durable record never waits
for approval; only the edition does. In the **archival** phase the same two
intervals invert in emphasis — throughput stops mattering, curation is
everything — without any change to the model. And the archival edition mints
itself: pick a freeze date T and export the published projection as of T
(`published_from ≤ T < published_to`) — a citable, frozen reference edition,
the thing you print.

**What must survive is the data-with-provenance, not the workflow.** The review
queue, the approval UI, the per-lexeme diff are ephemeral software, free to be
as crummy and disposable as anything else. Their *output* — the two exports and
the provenance the chain carries — is what is treasured at 50 and 100 years.
Invest durability there; spend nothing making the review *system* portable.

## 9. Trust and the live workspace (the main open question)

Approval gates publication, not editing — so a pending edit is *really* in
`dict` and editorial-current in the shared workspace immediately, for everyone.
That is the existing live-collaborative model; pending = unpublished sits on
top of it cleanly. The open product question: **do truly-untrusted
contributors' edits go live in the shared editor workspace too**, or are they
quarantined until reviewed? Fully live means an untrusted user can disrupt
other editors' *working* view (never the public site — that is always
approval-gated). It is recoverable (reject/revert) and fully audited, but it is
a real call. A middle path — a trust tier that flags brand-new users' edits in
the review queue without blocking the shared workspace — changes no schema
(policy on top of the model), so it can be decided later; but it shapes how
aggressively to open the doors.

## 10. Backfill and phased rollout

This lands on live data with editors working, so — as with the category
migration — **backfill first, preserving equivalence, then change behavior**:

- **Phase 0 — columns + backfill (no behavior change).** The columns already
  exist on `dict`, **and they are NOT empty**: a pre-existing experiment left
  legacy placeholder data on ~151k of 226k rows — a single constant
  `published_from = published_to = 1577836800000` (2020-01-01 in *epoch-ms*, a
  different time-space than `valid_from`). So Phase 0 must **first clear this
  placeholder** (`UPDATE dict SET published_from = NULL, published_to = NULL`
  where it equals the constant — verified by `verify-workspace`-style checks),
  then **born-approve the existing dictionary by MUTE-IN-PLACE — NOT by adding
  approval rows** (dz, after the language team: the predecessor system already
  approved this data via its `status` field; adding an `approved` re-assertion
  to every chain would roughly *double* the ~226k rows for no benefit). So for
  every fact under a `status`-`Completed`/`CompletedAsPDMOnly` entry, **stamp**
  `published_from = valid_from`, `published_to = END_OF_TIME` directly onto its
  **current** version — in place, like the category mute. (Only the current
  version: the predecessor carried no per-version publish timestamps, so
  historical published intervals are unknowable and left empty — the public
  view needs only the current published state.) In-progress entries are left
  unstamped → correctly *pending* in the new model ("most, not all"). A
  born-approved row is then a *published row that is not an `approved`/`reverted`
  re-assertion* — exactly the **grandfather signature** (§6), which I4 exempts:
  its audit reads "imported as approved," not "approved by *X*" (the
  predecessor's status is its approval record). After this the public query
  (`published_to = END_OF_TIME`) is *equivalent* to today's status filter. Run
  I1–I8. (Clear-then-stamp is a new idempotent `repair-assertions`-style
  migration step, rehearsed against every dev pull like the rest of the flow.)
- **Phase 1 — dual-run.** *(Built.)* Public renderer switches to the published
  projection **AND** status (`PublishedTupleQuery` filtered by `isPublished`;
  equivalent post-backfill — verified 6973 = 6973 on the dev pull). New edits
  set the published dimension correctly; to avoid blocking the team before the
  queue UI exists, trusted editors may **auto-approve their own** edits
  transitionally (a logged, temporary relaxation of I4).
- **Phase 2 — the review surface.** Build the review queue + per-lexeme change
  view + approve/revert/comment verbs. Turn auto-approve **off**:
  approval now requires a second senior.
- **Phase 3 — open to untrusted contributors** (with §9 decided).

Comments can land any time the `comment` `change_action` exists.

## 11. What's new vs. what exists today

**Exists:** the valid chain, `replaces_assertion_id`, `change_by_username`,
tombstones, the live editor + workspace, restore, the `~` automation-identity
convention + restore barrier, the migration/verify machinery, two-form export.

**New:** the `published_from`/`published_to`/`change_action`/`change_note`
columns; the approve/revert/comment verbs (all re-assertions on the
chain); the published projection ANDed with the status filter; the review queue +
per-lexeme change view + diff UI; the `latestContentVersion`/`isPending`
helper; the I1–I8 invariant checks.

**Connects to recent work:** the automation identity and history-folding UI
extend naturally — a production batch migration sets the published dimension
(auto-publish) but its approving rows name a **human senior**, so even
automation satisfies the two-person audit while `change_by_username` stays the
`~` automation account. Published/pending badges layer onto the existing
history view, which already shows the chain (comments now appear inline in it,
chronologically — the discussion in the timeline).

## 12. Deferred / open

- **Moderation unpublish** — "remove from public *now*, faster than a
  replacement can be approved": close `published_to` with no successor, required
  rationale. dz did not ask for it; if added, the rationale rides a `comment`
  row at the same point (the comment mechanism already exists for exactly this
  kind of on-chain note). Deferring it costs nothing.
- **Post-hoc edit sessions** — grouping a user's changes over a period into a
  reviewable unit. The write-time `proposal` object was dropped because every
  assertion already carries author + time, so sessions are a *query*,
  backfillable over all history whenever wanted. Later work.
- **Trust tiers** (§9), **comment threading depth**, **whether any comment ever
  surfaces publicly** — all policy-on-schema, decidable later.

---

*Decision lineage (the cuts, and why each was right): the write-time **proposal
object** was dropped — sessions are reconstructible post-hoc, so the grouping
never needed to exist at write time. The **action-log table** was dropped —
revert-as-re-assertion makes the undo row its own audit record, and
approval needs no `approved_by` column once it is itself a row. **Reject and
revert** collapsed into one operation — re-asserting a prior published value,
whether the value being undone was pending or already published. **Comments as
separate facts** was dropped — that rested on comments having an independent
approval lifecycle, and dz removed it (comments are never approved), so a
comment is just a `comment`-tagged version on the chain. The **point-event
comment** (option a) was dropped in favor of an ordinary chain version (option
b) — one filter in one query earns its keep where a new row category and
overloaded interval semantics do not. The through-line, the same as the
category mute: keep one mechanism, keep the data self-contained and
reconstructible, and do not encode at write time — or in extra columns or row
species — what the data already lets you derive. Every special case must earn
its keep, because the artifact's survival depends on someone reconstructing it
cold and someone solo continuing to ship it.*
