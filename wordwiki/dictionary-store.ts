// deno-lint-ignore-file no-explicit-any
/**
 * The DICTIONARY STORE: the versioned assertion store (the `dict` table)
 * loaded into a validated in-memory workspace, the transaction machinery
 * that mutates it, and the cached orthography-AGNOSTIC projections derived
 * from it (the full entry JSON and its lookup maps).
 *
 * Extracted from the WordWiki app class (2026-07-08) so that:
 *  - the model layer is usable and testable without the HTTP app, and
 *  - the per-orthography SITE VIEWS (fix-orthographies.md) can be forked
 *    per orthography on top of ONE shared base projection.
 *
 * Orthography-DEPENDENT caches (the public-site entries, by-category maps,
 * collation) deliberately do NOT live here - they belong to the per-
 * orthography site view.  The store tells its owner when the derived
 * projections were invalidated (onDerivedInvalidated) so those downstream
 * caches can be dropped in the same breath.
 */

import * as model from './model.ts';
import * as entry from './entry-schema.ts';
import {dictSchemaJson} from './entry-schema.ts';
import * as workspace from './workspace.ts';
import {VersionedDb} from './workspace.ts';
import * as timestamp from '../liminal/timestamp.ts';
import * as utils from '../liminal/utils.ts';
import {db} from '../liminal/db.ts';
import {Assertion, updateAssertion, highestTimestamp, selectAllAssertions} from './assertion.ts';
import {assertVersionedDbValid} from './versioned-db-validate.ts';
import {SiteView, entriesByReferenceGroupIdOf} from './site-view.ts';

export class DictionaryStore {
    readonly dictSchema: model.Schema;
    /** The one place the assertion table's name is known. */
    readonly assertionTable = 'dict';

    #workspace: VersionedDb|undefined = undefined;
    #entries: entry.Entry[]|undefined = undefined;
    #entriesById: Map<number, entry.Entry>|undefined = undefined;
    #entriesByReferenceGroupId: Map<number, entry.Entry>|undefined = undefined;
    #publishedProjection: entry.Entry[]|undefined = undefined;
    #siteViews: Map<string, SiteView> = new Map();
    #entriesWithContentIn: Map<string, Set<number>> = new Map();
    #lastAllocatedTxTimestamp: number|undefined;

    constructor(private opts: {onDerivedInvalidated?: () => void} = {}) {
        this.dictSchema = model.Schema.parseSchemaFromCompactJson(
            this.assertionTable, dictSchemaJson);
    }

    get workspace(): VersionedDb {
        return this.#workspace ??= (()=>{

            // --- Create workspace
            const ws = new VersionedDb([this.dictSchema]);

            // --- Do load of dictionary
            const assertions = selectAllAssertions(this.assertionTable).all();
            assertions.forEach((a:Assertion)=>ws.untrackedApplyAssertion(a));

            // --- Fail loud on a structurally broken store rather than letting
            //     derivations (and more edits) pile on top of corruption. The
            //     incremental apply above catches chain/overlap/dup-id; this
            //     adds the global/tail invariants (orphans, dangling heads,
            //     containment). Run repair-assertions / verify-workspace if it
            //     fires. (One O(n) sweep per full load - startup and post-
            //     failed-tx reload, not per edit.)
            assertVersionedDbValid(ws);

            return ws;
        })();
    }

    requestWorkspaceReload() {
        this.#workspace = undefined;
        this.requestEntriesJSONReload();
    }

    requestEntriesJSONReload() {
        this.#entries = undefined;
        this.#entriesById = undefined;
        this.#entriesByReferenceGroupId = undefined;
        this.#publishedProjection = undefined;
        // The site views are built over these projections: drop them
        // WHOLESALE (never reuse an instance), so view identity == projection
        // freshness - the publish staleness check depends on this.
        this.#siteViews = new Map();
        this.#entriesWithContentIn = new Map();
        // Owner caches built over these projections drop in the same breath.
        this.opts.onDerivedInvalidated?.();
    }

    /** The entry ids having ANY current fact tagged EXACTLY this
     *  orthography - PENDING facts included: this is EDITORIAL PRESENCE in
     *  a lane ("has ortho-content tagged with that ortho", dz 2026-07-09),
     *  so a word under edit belongs to its lane's editor views without
     *  anyone explicitly transitioning it.  Deliberately EXACT (not
     *  variantMatches): wildcard/'mm' content is every-lane by definition
     *  and would make the filter vacuous.  One indexed query, lazily
     *  cached per orthography, dropped with the projections.  The PUBLIC
     *  notion stays entryIsPublicIn (the pub gate) - two different
     *  questions. */
    entriesWithContentIn(orthography: string): Set<number> {
        let s = this.#entriesWithContentIn.get(orthography);
        if(s === undefined) {
            s = new Set(db().all<{id1: number}, {v: string}>(
                `SELECT DISTINCT id1 FROM ${this.assertionTable}
                  WHERE valid_to = ${timestamp.END_OF_TIME} AND variant = :v`,
                {v: orthography}).map(r => r.id1));
            this.#entriesWithContentIn.set(orthography, s);
        }
        return s;
    }

    /** The per-orthography site view (site-view.ts): created on demand,
     *  dropped wholesale on invalidation. */
    site(orthography: string): SiteView {
        let v = this.#siteViews.get(orthography);
        if(v === undefined)
            this.#siteViews.set(orthography, v = new SiteView(this, orthography));
        return v;
    }

    /** The VALID projection: every entry built from its currently-valid
     *  facts, pending edits and all orthographies included.  This is the
     *  editor world's view of the data. */
    get entries(): entry.Entry[] {
        return this.#entries ??=
            new workspace.CurrentTupleQuery(this.workspace.getTableByTag('dct')).toJSON().entry;
    }

    /**
     * The PUBLISHED projection of the dictionary (publication-model.md): every
     * entry built from its published-current facts (published_to=END_OF_TIME),
     * not its valid-current facts. After the Phase 0 backfill this equals the
     * valid projection for approved data; once pending edits exist it diverges
     * (the public sees the last approved value, not the in-flight one).
     */
    get publishedProjection(): entry.Entry[] {
        return this.#publishedProjection ??=
            new workspace.PublishedTupleQuery(this.workspace.getTableByTag('dct')).toJSON().entry ?? [];
    }

    get entriesById(): Map<number, entry.Entry> {
        return this.#entriesById ??=
            new Map(this.entries.map(e=>[e.entry_id, e]));
    }

    get entriesByReferenceGroupId(): Map<number, entry.Entry> {
        return this.#entriesByReferenceGroupId ??=
            entriesByReferenceGroupIdOf(this.entries);
    }

    get lastAllocatedTxTimestamp() {
        // TODO as we add more tables, this will need to be extended.
        return this.#lastAllocatedTxTimestamp ??= highestTimestamp(this.assertionTable);
    }

    allocTxTimestamps(count: number=1, opts: {quiet?: boolean} = {}) {
        const lastTxTimestamp = this.lastAllocatedTxTimestamp;
        const nextTxTimestamp = timestamp.nextTime(lastTxTimestamp);
        utils.assert(count>=1);
        this.#lastAllocatedTxTimestamp = nextTxTimestamp + count - 1;
        if(!opts.quiet)
            console.info('alloced timestamp', {last: lastTxTimestamp, next: nextTxTimestamp, next_txt: timestamp.formatTimestampAsLocalTime(nextTxTimestamp)});
        return nextTxTimestamp;
    }

    applyTransactions(assertions: Assertion[]) {

        // --- Partition assertions into txes by valid_from
        const txIds = assertions.map(a=>a.valid_from);
        utils.assert(txIds.join(',') === txIds.toSorted((a,b)=>a-b).join(','),
                     'assertions in a tx group must be in valid_from order');
        const transactionsById = Map.groupBy(assertions, a=>a.valid_from);

        try {
            db().transaction(()=>{
                Array.from(transactionsById.values()).forEach(a=>this.applyTransaction(a));
            });
        } catch (e) {
            // --- Request workspace reload
            this.requestWorkspaceReload();
            throw e;
        }
    }

    applyTransaction(assertions: Assertion[], opts: {quiet?: boolean} = {}) {

        if(!opts.quiet)
            console.info('Applying TX',
                         JSON.stringify(assertions, undefined, 2));

        // --- Allocate a new server timestamp for this tx
        //     TODO we may want to allocate multiple here to give client new base.
        const serverTimestamp = this.allocTxTimestamps(1, opts);

        // --- No assertions can be trivially applied (we check this
        //     because our consistency checks can't handle this case)
        if(assertions.length === 0)
            return;

        // ---- Validate that this is a single tx (all assertions have the same
        //      valid_from)
        // THIS WILL NOT BE TRUE FOR OUR NEW SAVE FEATURE, IT CONSISTS OF MULTIPLE TXes.
        // (with potential repeated writes to the same assertion).
        // HOW TO HANDLE THIS:
        //  - they will be in order - do we want to break it down into separate txes
        //    (or have that be part of the update protocol so we don't have to reverse
        //    engineer it.
        //  - do we want applying all the TXes to be one DB transaction? - if not, we can
        //    just break it down into multiple Txes and apply them separately.
        //  - this is probably fine for now (we can wrap the whole outer thing in a DB tx
        //    to ...)

        const clientTimestamp = assertions[0].valid_from;
        assertions.forEach(a=>{
            if(a.valid_from !== clientTimestamp)
                throw new Error(`All assertions in a transaction must have the same timestamp`);
            if(!(a.valid_to === timestamp.END_OF_TIME || a.valid_to === clientTimestamp))
                throw new Error(`Assertions can either be valid to the tx time (a delete tombstone) or valid till the end of time`);
        });

        try {
            // --- Rewrite client timestamps to our newly allocated server timestamp
            assertions.forEach(a=>{
                if(a.valid_from === clientTimestamp)
                    a.valid_from = serverTimestamp;
                if(a.valid_to === clientTimestamp)
                    a.valid_to = serverTimestamp;
            });

            if(!opts.quiet)
                console.info('Applying TX after advancing to server timestamp',
                             serverTimestamp,
                             JSON.stringify(assertions, undefined, 2));

            // --- Apply assertions to workspace (throwing exception if incompatible)
            // TODO swith to an apply method that gives us enough info to update the valid_to
            //      on the prev record.
            const updatedPrevAssertions =
                assertions.map(a=>this.workspace.applyProposedAssertion(a));

            // --- Apply assertions to DB (in a TX) doing some confirmation as we go.
            db().transaction(()=>{
                // Trick here is that we need prev txids - workspace can give us those.
                // Then can load them an confirm that their valid_to matches, then update.
                // We can get the whole prev anyway.
                // For now, just persist as they are.
                updatedPrevAssertions.forEach(p=>
                    p && updateAssertion(this.assertionTable, p.assertion_id, ['valid_to'], {valid_to: p.valid_to}));
                assertions.forEach(a=>
                    db().insert<Assertion, 'assertion_id'>(this.assertionTable, a, 'assertion_id'));
            });

            // --- Request rebuld of entries JSON
            this.requestEntriesJSONReload();

        } catch (e) {
            // --- Request workspace reload
            this.requestWorkspaceReload();
            throw e;
        }
    }
}
