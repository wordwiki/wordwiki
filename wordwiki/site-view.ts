/**
 * The per-orthography SITE VIEW (fix-orthographies.md): the dictionary as
 * the public sees it IN ONE ORTHOGRAPHY - which entries are on the site,
 * how they group into categories, and how the source language collates.
 *
 * One SiteView per orthography, created on demand by
 * DictionaryStore.site(orthography) and dropped wholesale whenever the
 * store's projections are invalidated - so the Entry objects are SHARED
 * with the store's base projection (a view forks only arrays/maps of
 * references, not the entries themselves), and holding a view across a
 * mutation never mixes old and new data: the stale view keeps its already-
 * built arrays, and fresh data only arrives via a fresh view.
 *
 * Everything orthography-DEPENDENT that used to live as li-only caches on
 * the WordWiki app class belongs here; the orthography-agnostic projections
 * stay on the store.
 */

import * as entry from './entry-schema.ts';
import type {DictionaryStore} from './dictionary-store.ts';

export class SiteView {
    #publicEntries: entry.Entry[]|undefined = undefined;
    #entriesByCategory: Map<string, entry.Entry[]>|undefined = undefined;

    /** Source-language collation for this orthography.
     *  TODO make configurable (per orthography, from config) XXX */
    readonly collator = Intl.Collator('en');

    constructor(readonly store: DictionaryStore, readonly orthography: string) {}

    /**
     * The entries the public site renders - the COMPOSITION RULE
     * (fix-orthographies.md "Status"): the base projection is the PUBLISHED
     * one (per-fact approval), and an entry is on the site iff it is public
     * in this view's orthography - lifecycle not Archived* AND the
     * per-orthography pub gate is set (entryIsPublicIn).  Approval is used
     * while building too, so an in-progress entry may carry published facts,
     * but stays off the public site until someone makes it public.
     */
    get publicEntries(): entry.Entry[] {
        return this.#publicEntries ??=
            Array.from(this.store.publishedProjection.filter(
                e => entry.entryIsPublicIn(e, this.orthography)));
    }

    get entriesByCategory(): Map<string, entry.Entry[]> {
        return this.#entriesByCategory ??= (()=>{
            const entriesByCategoryArray: [string, entry.Entry][] =
                this.publicEntries.flatMap(e=>e.subentry.flatMap(s=>
                    s.category.flatMap(c=>c.category).map(category=>[category, e] as [string, entry.Entry])));

            const entriesByCategory1: Map<string, [string, entry.Entry][]> =
                Map.groupBy(entriesByCategoryArray, a=>a[0])

            const entriesByCategory2: [string, entry.Entry[]][] =
                Array.from(entriesByCategory1.entries()).map(([category, ent])=>
                    [category, ent.map(e=>e[1])
                        .toSorted((a: entry.Entry, b: entry.Entry) =>
                            // TODO: pick spelling for sort better! (+locale etc)
                            this.collator
                                .compare((a.spelling[0]?.text)??'',
                                         (b.spelling[0]?.text)??''))]);

            return new Map(entriesByCategory2);
        })();
    }

    /** Every category value in use, with its public-entry count, in
     *  collation order. */
    categoryCounts(): Map<string, number> {
        return new Map(Array.from(Map.groupBy(this.publicEntries.
            flatMap(e=>
                e.subentry.flatMap(s=>
                    s.category.flatMap(c=>
                        c.category))), category=>category)
            .entries()).map(([category, insts]) => [category, insts.length] as [string, number])
            .toSorted((a: [string, number], b: [string, number])=>
                this.collator
                    .compare(a[0]??'', b[0]??'')));
    }

    entriesForCategory(category: string): entry.Entry[] {
        return category === '' ? [] :
            this.publicEntries.filter(
                entry=>entry.subentry.some(
                    subentry=>subentry.category.some(
                        cat=>cat.category === category)));
    }
}
