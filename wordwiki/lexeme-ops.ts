// deno-lint-ignore-file no-explicit-any
/**
 * LexemeOps - the assertion-mutation core, as reusable domain operations.
 *
 * The lexeme editor (lexeme-editor.ts) and the liminal-style table pages
 * (category.ts, lexical-form.ts) live in different worlds: the editor
 * mutates the versioned assertion data (the dict table), the tables are
 * straight rows.  Increasingly the table pages need buttons that mutate
 * assertion data ("remove this entry from this category") - and the two
 * worlds already share the client protocol (tx`expr` -> {action:'reload',
 * targets}), so the only seam needed is here: assertion mutations as
 * domain verbs that return OUTCOMES, not UI directives.  Each caller (the
 * editor, a table page) translates outcomes into its own alerts and
 * reload targets.
 *
 * Everything here preserves the assertion model's guarantees (see
 * assertion-model.md): mutations are new assertions (delete = tombstone
 * with valid_from === valid_to), history is never overwritten, every
 * assertion is stamped with change_by_username from the session, and
 * races against other editors degrade to typed outcomes (deleting an
 * already-deleted fact is idempotent, never a double tombstone).
 */
import {VersionedTuple} from './workspace.ts';
import {Assertion, updateAssertion, getAssertionPath, assertionPathToFields} from './assertion.ts';
import * as entrySchema from './entry-schema.ts';
import * as timestamp from '../liminal/timestamp.ts';
import {panic} from '../liminal/utils.ts';
import {db} from '../liminal/db.ts';
import * as security from '../liminal/security.ts';
import * as publicationOps from './publication-ops.ts';
import {latestContentVersion} from './versioned-model.ts';
import type {WordWiki} from './wordwiki.ts';

// New fact/assertion ids use the same scheme as the rest of the system (see
// the id-allocation TODOs in assertion-model.md) - allocated in one place,
// on the server.
export function newId(): number {
    return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

// Placeholder tx time: applyTransaction rewrites every assertion in the tx to
// a freshly allocated server timestamp (it only requires the tx's assertions
// to share this placeholder, and tombstones to have valid_to === valid_from).
export function placeholderTxTime(): number {
    return timestamp.nextTime(timestamp.BEGINNING_OF_TIME);
}

// A tombstone marks a deletion: a version whose valid period is empty.
export function isTombstone(a: Assertion): boolean {
    return a.valid_from === a.valid_to;
}

// A freshly proposed edit is NOT yet approved.  Builders that start from a copy
// of a prior version (which, post-backfill, is usually PUBLISHED) must drop its
// publication interval and approval/comment metadata, or the new version would
// be born-published - leaving two published-current versions on the fact (an I2
// violation the load-time validator throws on).  Spread this AFTER `...prev` so
// it overrides the inherited values; the publication verbs (approve/revert) set
// these deliberately and do NOT use it.  See publication-model.md.
export const unapprovedDimension: Partial<Assertion> = {
    published_from: undefined, published_to: undefined,
    change_action: undefined, change_arg: undefined, change_note: undefined,
};

export type SupersedeOutcome =
    // The fact was current; a new version with the changed fields is asserted.
    | {outcome: 'updated', assertion: Assertion, replaced: Assertion}
    // The fact was deleted since the caller looked: re-asserting would
    // silently RESURRECT it - refuse instead.
    | {outcome: 'already-deleted'};

// The result of a publication verb (approve/revert/comment).  The work is
// done; the editor's review mode turns this into a reload directive.
export type PublicationOutcome = {outcome: 'approved' | 'reverted' | 'commented'};

// The publish-gate verbs' outcomes (idempotent against races/double-clicks).
export type MakePublicOutcome = {outcome: 'made-public' | 'already-public'};
export type WithdrawOutcome = {outcome: 'withdrawn' | 'not-public'};

export type TombstoneOutcome =
    // The fact was current and is now tombstoned.
    | {outcome: 'removed', tombstone: Assertion, replaced: Assertion}
    // Someone else got there first (or the caller is stale): nothing to do.
    | {outcome: 'already-deleted', mostRecent: Assertion|undefined}
    // The fact still has non-deleted children (children-first rule).
    | {outcome: 'has-children'};

export class LexemeOps {

    constructor(public app: WordWiki) {
    }

    // ------------------------------------------------------------------------
    // --- Tuple addressing -----------------------------------------------------
    // ------------------------------------------------------------------------

    entryTuple(entry_id: number): VersionedTuple {
        const dict = this.app.workspace.getTableByTag(entrySchema.DictTag);
        return dict.childRelations[entrySchema.EntryTag]?.tuples.get(entry_id)
            ?? panic('entry not found', entry_id);
    }

    // Tuples are addressed as (entry_id, fact_id) so the search is scoped to
    // the entry's (small) subtree rather than the whole dictionary.
    findTupleInEntry(entry_id: number, fact_id: number): VersionedTuple {
        const entryTuple = this.entryTuple(entry_id);
        if(fact_id === entry_id) return entryTuple;
        return entryTuple.findRequiredVersionedTupleById(fact_id);
    }

    // ------------------------------------------------------------------------
    // --- Tree-ordering (the publication tree must stay a tree) ----------------
    // ------------------------------------------------------------------------
    //
    // The valid tree and the published tree are each pruned top-down at render
    // time (Current*/Published* queries), so a child can never join a tree its
    // parent is not in without becoming invisible.  These helpers let the
    // mutation verbs REFUSE the operations that would create such an orphan,
    // with a clear message, so the invariant "published child => published
    // parent" (and its live analogue) holds by construction (versioned-db-
    // validate.ts checks it; publication-model.md).

    /** The parent FACT tuple of `tuple`, or undefined when its parent is the
     *  versionless table root (a top-level entry fact, always "present"). */
    parentFactTuple(tuple: VersionedTuple): VersionedTuple | undefined {
        const a = tuple.mostRecentTuple?.assertion;
        if(!a) return undefined;
        const parentRelation = this.app.workspace.getVersionedTupleParentRelation(
            getAssertionPath(a));
        return parentRelation.parent.id === 0 ? undefined : parentRelation.parent;
    }

    /** Does the parent have a currently-published version (the last-approved
     *  value, which legitimately parents published children even when a newer
     *  edit sits pending on top)?  True at the root (top-level facts). */
    private parentIsPublished(tuple: VersionedTuple): boolean {
        const parent = this.parentFactTuple(tuple);
        return !parent || parent.tupleVersions.some(v => v.isPublished);
    }

    /** Is the fact's parent currently live (its most-recent version not a
     *  tombstone)?  True at the root.  Public: the restore verb (gate #4,
     *  in lexeme-editor.ts) refuses to un-delete a child under a dead parent. */
    parentIsLiveOf(tuple: VersionedTuple): boolean {
        const parent = this.parentFactTuple(tuple);
        return !parent || parent.mostRecentTuple?.isCurrent === true;
    }

    /** Any descendant with a currently-published version (approving this
     *  fact's DELETION while one exists would orphan it - see gate #3). */
    private hasPublishedDescendant(tuple: VersionedTuple): boolean {
        let found = false;
        tuple.forEachVersionedTuple(t => {
            if(t !== tuple && t.tupleVersions.some(v => v.isPublished)) found = true;
        });
        return found;
    }

    // ------------------------------------------------------------------------
    // --- Stamping -------------------------------------------------------------
    // ------------------------------------------------------------------------

    changeStamp(): Pick<Assertion, 'change_by_username'> {
        return {change_by_username: this.app.currentUsername()};
    }

    // Mutating verbs are callable from any page, so they enforce this
    // themselves rather than relying on a caller's route gate.
    private requireUsername(): string {
        return this.app.currentUsername()
            ?? panic('lexeme mutations require a logged-in user');
    }

    // ------------------------------------------------------------------------
    // --- Primitives -----------------------------------------------------------
    // ------------------------------------------------------------------------

    /** Delete = a tombstone assertion (valid_from === valid_to).  Children
     *  must be deleted first (same rule as the old editor).  Idempotent
     *  against races: deleting an already-deleted fact reports
     *  'already-deleted' rather than chaining a tombstone onto a tombstone. */
    tombstoneFact(entry_id: number, fact_id: number): TombstoneOutcome {
        this.requireUsername();
        const tuple = this.findTupleInEntry(entry_id, fact_id);
        if(tuple.findNonDeletedChildTuples().length > 0)
            return {outcome: 'has-children'};
        const mostRecent = tuple.mostRecentTuple;
        if(!mostRecent || !mostRecent.isCurrent)
            return {outcome: 'already-deleted', mostRecent: mostRecent?.assertion};
        const current = mostRecent.assertion;

        const t = placeholderTxTime();
        const tombstone: Assertion = {
            ...current,
            assertion_id: newId(),
            replaces_assertion_id: current.assertion_id,
            valid_from: t,
            valid_to: t,
            ...this.changeStamp(),
            ...unapprovedDimension,
        };
        this.app.applyTransaction([tombstone]);
        return {outcome: 'removed', tombstone, replaced: current};
    }

    /** Re-assert a fact with some fields changed (a new version chained
     *  onto the current one).  The single-field edit primitive for verbs
     *  that change a value in place (vs tombstoneFact for deletion). */
    supersedeFields(entry_id: number, fact_id: number,
                    fields: Partial<Assertion>): SupersedeOutcome {
        this.requireUsername();
        const tuple = this.findTupleInEntry(entry_id, fact_id);
        const mostRecent = tuple.mostRecentTuple;
        if(!mostRecent || !mostRecent.isCurrent)
            return {outcome: 'already-deleted'};
        const current = mostRecent.assertion;

        const assertion: Assertion = {
            ...current,
            ...fields,
            assertion_id: newId(),
            replaces_assertion_id: current.assertion_id,
            valid_from: placeholderTxTime(),
            valid_to: timestamp.END_OF_TIME,
            ...this.changeStamp(),
            ...unapprovedDimension,
        };
        this.app.applyTransaction([assertion]);
        return {outcome: 'updated', assertion, replaced: current};
    }

    // ------------------------------------------------------------------------
    // --- Domain verbs ---------------------------------------------------------
    // ------------------------------------------------------------------------

    /** The fact ids of an entry's CURRENT category tuples with the given
     *  slug.  More than one is possible (the same category on multiple
     *  subentries). */
    currentCategoryFactIds(entry_id: number, slug: string): number[] {
        const e = this.app.entriesById.get(entry_id);
        if(!e) return [];
        return e.subentry.flatMap(s =>
            s.category.filter(c => c.category === slug).map(c => c.category_id));
    }

    /** Remove an entry from a category: tombstone EVERY current cat tuple
     *  with this slug across the entry's subentries (the button means "the
     *  entry leaves the category", wherever it is tagged).  Races where
     *  someone else already removed a tuple count as not-removed-by-us;
     *  the net state is what the user asked for either way. */
    removeEntryFromCategory(entry_id: number, slug: string): {removed: number} {
        this.requireUsername();
        let removed = 0;
        for(const fact_id of this.currentCategoryFactIds(entry_id, slug)) {
            const r = this.tombstoneFact(entry_id, fact_id);
            if(r.outcome === 'removed') removed++;
        }
        return {removed};
    }

    // ------------------------------------------------------------------------
    // --- Publication verbs (publication-model.md) ----------------------------
    // ------------------------------------------------------------------------
    //
    // The app-level wrappers over the pure publication operations
    // (publication-ops.ts): they enforce permissions, allocate a server
    // timestamp + id, run the op against the workspace, and persist the
    // applied/updated set (mirroring applyTransaction). The pure ops are
    // property-tested against the reference oracle; these add the production
    // wiring.

    // Approve-permission gates approval and revert (both publish). 'admin'
    // implies it (so existing admins can review); a dedicated 'approve' role
    // can be granted to non-admin reviewers.
    private requireApprovePermission(action: string): void {
        if(!this.hasApprovePermission())
            throw new Error(`${action} requires approve permission`);
    }

    /** Whether the current actor may approve/revert at all (the review UI uses
     *  this to decide whether to offer those items). */
    hasApprovePermission(): boolean {
        const roles = security.current()?.roles;
        return !!roles && (roles.has('approve') || roles.has('admin'));
    }

    /** Whether the current actor may approve content authored by `author`:
     *  approve-permission AND the two-person rule (author ≠ self), unless they
     *  may self-approve.  The review UI hides Approve when this is false (the
     *  op still enforces it server-side). */
    mayApprove(author: string|null): boolean {
        return this.hasApprovePermission()
            && (author !== this.app.currentUsername() || this.canSelfApprove());
    }

    // The self-approve workaround (a sole approver): 'admin' may approve their
    // own content. (A dedicated 'self-approve' role could be added.)
    private canSelfApprove(): boolean {
        return security.current()?.roles.has('admin') ?? false;
    }

    /** Approve a fact's pending content (publishes it). Requires approve
     *  permission and an approver ≠ the content's author, unless the approver
     *  may self-approve.  Returns the typed outcome; the caller (the editor's
     *  review mode) decides what to reload. */
    approveFact(fact_id: number): PublicationOutcome {
        const approver = this.requireUsername();
        this.requireApprovePermission('approving');

        // Tree-ordering gates (the published tree must stay a tree - see the
        // tree-ordering helpers).  Approving a CONTENT change publishes it, so
        // its parent must already be published (top-down); approving a
        // DELETION unpublishes, so it must have no still-published descendants
        // (bottom-up - approve the contents' deletions first).
        const tuple = this.app.workspace.getTableByTag(entrySchema.DictTag)
            .getTupleById(fact_id) ?? panic('no fact', fact_id);
        const content = latestContentVersion(tuple.tupleVersions.map(v => v.assertion));
        const isDeletion = !!content && content.valid_from === content.valid_to;
        if(isDeletion) {
            if(this.hasPublishedDescendant(tuple))
                throw new Error(
                    'Approve the deletion of this item’s contents first — a published ' +
                    'child cannot be left under a removed parent.');
        } else if(!this.parentIsPublished(tuple)) {
            throw new Error(
                'This item’s parent has not been approved yet — approve the parent ' +
                'first, so the published dictionary stays a complete tree.');
        }

        this.runPublicationOp((now, aid) =>
            publicationOps.approve(this.app.workspace, fact_id, approver, now, aid,
                                   {allowSelfApprove: this.canSelfApprove()}));
        return {outcome: 'approved'};
    }

    /** Revert a fact to its last published value (declining a pending edit or
     *  rolling back an approved one). Requires approve permission + a note. */
    revertFact(fact_id: number, note: string): PublicationOutcome {
        const reverter = this.requireUsername();
        this.requireApprovePermission('reverting');
        if(!note?.trim()) throw new Error('a revert requires a note');
        this.runPublicationOp((now, aid) =>
            publicationOps.revert(this.app.workspace, fact_id, reverter, note, now, aid));
        return {outcome: 'reverted'};
    }

    /** Add a discussion comment to a fact (any logged-in editor; never
     *  published). Requires a note. */
    commentFact(fact_id: number, note: string): PublicationOutcome {
        const commenter = this.requireUsername();
        if(!note?.trim()) throw new Error('a comment requires a note');
        this.runPublicationOp((now, aid) =>
            publicationOps.comment(this.app.workspace, fact_id, commenter, note, now, aid));
        return {outcome: 'commented'};
    }

    // ------------------------------------------------------------------------
    // --- The per-orthography publish gate (fix-orthographies.md "Status") -----
    // ------------------------------------------------------------------------
    //
    // `pub` facts are NORMAL DATA: proposed, approved, deleted and reviewed
    // through the standard assertion + publication machinery (any editor can
    // propose one via the generic editor; it queues for review like any
    // fact).  THE GATE IS THE PUBLISHED DIMENSION: a word is public in O iff
    // a pub fact for O is published-current - a pending proposal gates
    // nothing.  makePublic/withdraw below are one-click SUGAR for approvers:
    // they compose the normal ops (insert + approve / tombstone + approve),
    // with self-approval allowed because the verb itself is approve-gated
    // and a presence-only gate has no content for the two-person rule to
    // protect.  Everything shows up in history/changes/review for free.

    /** The entry's pub-gate fact tuples (every state: published, pending
     *  proposal, pending withdrawal, withdrawn). */
    publicGateTuples(entry_id: number): VersionedTuple[] {
        const rel = this.entryTuple(entry_id).childRelations[entrySchema.PublicTag];
        return rel ? [...rel.tuples.values()] : [];
    }

    /** The gate tuple for one orthography (matching on the most recent
     *  version's variant), or undefined. */
    private gateTupleFor(entry_id: number, orthography: string): VersionedTuple | undefined {
        return this.publicGateTuples(entry_id).find(t =>
            t.mostRecentTuple?.assertion.variant === orthography);
    }

    /** The entry's CURRENT publish-gate facts - one per orthography the word
     *  is public in (published-current pub facts: THE gate). */
    currentPublicGates(entry_id: number): Assertion[] {
        return this.publicGateTuples(entry_id)
            .map(t => t.tupleVersions.find(v => v.isPublished)?.assertion)
            .filter((a): a is Assertion => a !== undefined);
    }

    /** Make the entry public in `orthography` - approver sugar over the
     *  normal ops: approve the pending proposal if one exists, else insert a
     *  proposal and approve it.  One attributed act per step, all of it in
     *  the review/history machinery. */
    makePublic(entry_id: number, orthography: string): MakePublicOutcome {
        this.requireUsername();
        this.requireApprovePermission('making a word public');
        if(!(orthography in entrySchema.variants) || orthography === 'mm')
            throw new Error(`'${orthography}' is not an orthography a word can be public in`);
        const tuple = this.gateTupleFor(entry_id, orthography);
        if(tuple && tuple.tupleVersions.some(v => v.isPublished))
            return {outcome: 'already-public'};
        // Tree-ordering gate, checked BEFORE inserting anything (approve
        // would refuse anyway - this fails fast with the clear message).
        if(!this.entryTuple(entry_id).tupleVersions.some(v => v.isPublished))
            throw new Error('This word itself has not been approved yet - approve its ' +
                            'pending content before making it public.');

        let fact_id: number;
        if(tuple && tuple.mostRecentTuple?.isCurrent) {
            fact_id = tuple.id;   // a pending proposal exists: approve it
        } else {
            // Insert a NORMAL pending proposal (no publication stamps).
            const id = newId();
            const a: Assertion = {
                ...assertionPathToFields([[entrySchema.DictTag, 0],
                                          [entrySchema.EntryTag, entry_id],
                                          [entrySchema.PublicTag, id]]),
                assertion_id: id, id, ty: entrySchema.PublicTag,
                valid_from: placeholderTxTime(), valid_to: timestamp.END_OF_TIME,
                order_key: '0.5',
                variant: orthography,
                ...this.changeStamp(),
            } as Assertion;
            this.app.applyTransaction([a], {quiet: true});
            fact_id = id;
        }
        const approver = this.requireUsername();
        this.runPublicationOp((now, aid) =>
            publicationOps.approve(this.app.workspace, fact_id, approver, now, aid,
                                   {allowSelfApprove: true}));
        return {outcome: 'made-public'};
    }

    /** Withdraw the entry's publish gate for `orthography` - approver sugar:
     *  tombstone the gate fact (a normal pending deletion) and approve that
     *  deletion, which closes the published interval through the standard
     *  op.  A pending PROPOSAL (never published) is simply tombstoned - a
     *  never-published deletion is already settled. */
    withdraw(entry_id: number, orthography: string): WithdrawOutcome {
        this.requireUsername();
        this.requireApprovePermission('withdrawing a word');
        const tuple = this.gateTupleFor(entry_id, orthography);
        if(!tuple) return {outcome: 'not-public'};
        const published = tuple.tupleVersions.some(v => v.isPublished);
        const live = tuple.mostRecentTuple?.isCurrent === true;

        if(!published) {
            if(!live) return {outcome: 'not-public'};
            this.tombstoneFact(entry_id, tuple.id);   // decline own proposal: settled
            return {outcome: 'withdrawn'};
        }
        if(live) {
            const r = this.tombstoneFact(entry_id, tuple.id);
            if(r.outcome === 'has-children') panic('pub facts have no children');
        }
        // Approve the (new or already-pending) deletion: the standard op
        // closes the published interval (I7).
        const approver = this.requireUsername();
        this.runPublicationOp((now, aid) =>
            publicationOps.approve(this.app.workspace, tuple.id, approver, now, aid,
                                   {allowSelfApprove: true}));
        return {outcome: 'withdrawn'};
    }

    // Allocate a server timestamp + id, run the op (mutating the workspace in
    // place), and persist the result in one db transaction: UPDATE predecessors
    // whose valid_to/published_to changed, INSERT the new version. On any error,
    // reload the workspace from the db (discarding the partial mutation), like
    // applyTransaction.
    private runPublicationOp(run: (now: number, assertionId: number) => publicationOps.OpResult): void {
        const now = this.app.allocTxTimestamps(1, {quiet: true});
        const assertionId = newId();
        try {
            const result = run(now, assertionId);
            db().transaction(() => {
                for(const u of result.updated)
                    updateAssertion('dict', u.assertion_id, ['valid_to', 'published_to'],
                                    {valid_to: u.valid_to, published_to: u.published_to});
                for(const a of result.applied)
                    db().insert<Assertion, 'assertion_id'>('dict', a, 'assertion_id');
            });
            this.app.requestEntriesJSONReload();
        } catch(e) {
            this.app.requestWorkspaceReload();
            throw e;
        }
    }
}
