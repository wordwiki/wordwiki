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
import {Assertion} from './assertion.ts';
import * as entrySchema from './entry-schema.ts';
import * as timestamp from '../liminal/timestamp.ts';
import {panic} from '../liminal/utils.ts';
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

export type SupersedeOutcome =
    // The fact was current; a new version with the changed fields is asserted.
    | {outcome: 'updated', assertion: Assertion, replaced: Assertion}
    // The fact was deleted since the caller looked: re-asserting would
    // silently RESURRECT it - refuse instead.
    | {outcome: 'already-deleted'};

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

    /** The fact ids of an entry's CURRENT subentries whose part_of_speech
     *  is the given slug (the POS is a FIELD of the subentry tuple - attr1 -
     *  not a child tuple, so 'removing' it means clearing the field). */
    currentSubentryIdsWithPartOfSpeech(entry_id: number, slug: string): number[] {
        const e = this.app.entriesById.get(entry_id);
        if(!e) return [];
        return e.subentry.filter(s => s.part_of_speech === slug)
            .map(s => s.subentry_id);
    }

    /** Clear a subentry's part of speech - IF it still has the expected
     *  value (a race where someone re-tagged it concurrently is a no-op:
     *  blindly clearing would discard their edit).  The subentry survives
     *  with no part of speech (one more for the empty-POS worklist). */
    clearSubentryPartOfSpeech(entry_id: number, subentry_id: number,
                              expectedSlug: string): {changed: boolean} {
        this.requireUsername();
        const tuple = this.findTupleInEntry(entry_id, subentry_id);
        const current = tuple.mostRecentTuple;
        if(!current || !current.isCurrent || current.assertion.attr1 !== expectedSlug)
            return {changed: false};
        const r = this.supersedeFields(entry_id, subentry_id, {attr1: null});
        return {changed: r.outcome === 'updated'};
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
}
