// deno-lint-ignore-file no-explicit-any
/**
 * machineSync - THE reconcile primitive of the machine-contributors model
 * (machine-contributors-design.md §2.3): a feature computes the set of
 * facts it CURRENTLY asserts; sync diffs that against the dictionary and
 * writes only the difference, under the fact-granular OWNERSHIP predicate:
 *
 *   A fact is MACHINE-OWNED iff every version in its history is authored
 *   by a system user ('~'-prefixed).  Any human version FREEZES it.
 *
 * The case table (diff-first is load-bearing - an unchanged re-run writes
 * ZERO rows; no history churn, no feed noise):
 *   computed, absent                    -> assert
 *   computed, open, machine, identical  -> nothing
 *   computed, open, machine, differs    -> supersede (new version, same id)
 *   computed, open, HUMAN               -> skip (+ FROZEN-STALE report when
 *                                          the computed content differs)
 *   computed, dead, any human row       -> skip (never reassert a human
 *                                          retraction/rejection)
 *   computed, dead, machine-only        -> reassert (the feature computes
 *                                          it again; its own old retraction
 *                                          does not stick)
 *   existing by `author`, machine-owned,
 *   open, NOT computed                  -> retract (tombstone)
 *
 * Deterministic CONTENT-KEYED fact ids are the caller's job (they are
 * what make "is this the fact a human deleted last year?" an id lookup) -
 * see sfm-import.ts contentKeyId.  Scope = (author, relation tags): facts
 * by OTHER machine authors in the same relations are never touched.
 *
 * Direct row writes in ONE transaction (the transform's idiom - LexemeOps
 * per-call invalidation rebuilds derived state per fact, hours at batch
 * scale); the store reloads once at the end.
 */
import { db } from '../liminal/db.ts';
import * as timestamp from '../liminal/timestamp.ts';
import * as orderkey from '../liminal/orderkey.ts';
import { highestTimestamp, type Assertion } from './assertion.ts';
import { contentKeyId } from './sfm-import.ts';
import type { DictionaryStore } from './dictionary-store.ts';

/** One fact as the feature currently computes it.  `path` is the full
 *  ancestor chain incl. the fact itself: [[rootTag,0],[entTag,entry_id],
 *  ...,[relTag,id]]; `fields` are the bind-level values (attr1..,
 *  variant, note...). */
export interface ComputedFact {
    id: number;                    // deterministic content-keyed
    path: [string, number][];
    ty: string;
    fields: Partial<Assertion>;
    order_key?: string;
}

export interface MachineSyncResult {
    asserted: number;
    superseded: number;
    unchanged: number;
    retracted: number;
    reasserted: number;
    skippedHumanOwned: number;
    skippedHumanTombstoned: number;
    frozenStale: Array<{id: number, ty: string}>;
}

const isSystemAuthor = (u: string|null|undefined) => (u ?? '').startsWith('~');

/** Compare a computed fact's fields against an existing row: only the
 *  keys the feature SETS are compared (absent keys are the feature's
 *  don't-cares); null and undefined are the same absence. */
function contentIdentical(fields: Partial<Assertion>, row: any): boolean {
    for(const [k, v] of Object.entries(fields)) {
        const a = v ?? null, b = row[k] ?? null;
        if(a !== b) return false;
    }
    return true;
}

export function machineSync(store: DictionaryStore, author: string,
                            scopeTags: string[], computed: ComputedFact[]): MachineSyncResult {
    if(!isSystemAuthor(author))
        throw new Error(`machineSync author must be a system user ('~...'): '${author}'`);
    const table = store.assertionTable;
    const result: MachineSyncResult = {
        asserted: 0, superseded: 0, unchanged: 0, retracted: 0, reasserted: 0,
        skippedHumanOwned: 0, skippedHumanTombstoned: 0, frozenStale: []};
    if(scopeTags.length === 0) return result;

    // --- Existing facts in scope, grouped by fact id -------------------------
    interface FactState { rows: any[]; open: any|undefined; anyHuman: boolean;
                          byAuthor: boolean; }
    const params = Object.fromEntries(scopeTags.map((tag, i) => [`t${i}`, tag]));
    const marks = scopeTags.map((_tag, i) => `:t${i}`).join(',');
    const rows = db().all<any, any>(
        `SELECT * FROM ${table} WHERE ty IN (${marks})`, params);
    const facts = new Map<number, FactState>();
    for(const r of rows) {
        let f = facts.get(r.id);
        if(!f) facts.set(r.id, f = {rows: [], open: undefined, anyHuman: false, byAuthor: false});
        f.rows.push(r);
        if(r.valid_to === timestamp.END_OF_TIME) f.open = r;
        if(!isSystemAuthor(r.change_by_username)) f.anyHuman = true;
        if(r.change_by_username === author) f.byAuthor = true;
    }

    const t = timestamp.nextTime(highestTimestamp(table));
    const inserts: Assertion[] = [];
    const closes: Array<{assertion_id: number}> = [];

    const versionRow = (c: ComputedFact, replaces: number|undefined): Assertion => {
        const pathFields: any = {};
        c.path.forEach(([ty, id], i) => {
            pathFields[`ty${i}`] = ty;
            if(i > 0) pathFields[`id${i}`] = id;
        });
        return {
            ...pathFields,
            assertion_id: contentKeyId(['msync', author, c.id, t]),
            replaces_assertion_id: replaces,
            id: c.id, ty: c.ty,
            valid_from: t, valid_to: timestamp.END_OF_TIME,
            order_key: c.order_key ?? orderkey.new_range_start_string,
            ...c.fields,
            change_by_username: author,
        } as Assertion;
    };

    const computedIds = new Set<number>();
    for(const c of computed) {
        if(computedIds.has(c.id)) continue;         // first wins (defensive)
        computedIds.add(c.id);
        const f = facts.get(c.id);
        if(f === undefined) {
            inserts.push(versionRow(c, undefined));
            result.asserted++;
        } else if(f.open !== undefined) {
            if(f.anyHuman) {
                result.skippedHumanOwned++;
                if(!contentIdentical(c.fields, f.open))
                    result.frozenStale.push({id: c.id, ty: c.ty});
            } else if(contentIdentical(c.fields, f.open)) {
                result.unchanged++;
            } else {
                closes.push({assertion_id: f.open.assertion_id});
                inserts.push(versionRow(c, f.open.assertion_id));
                result.superseded++;
            }
        } else {                                     // dead (tombstoned/closed)
            if(f.anyHuman) {
                result.skippedHumanTombstoned++;
            } else {
                const last = f.rows.toSorted((a, b) => b.valid_from - a.valid_from)[0];
                inserts.push(versionRow(c, last?.assertion_id));
                result.reasserted++;
            }
        }
    }

    // --- Retractions: this author's live machine facts no longer computed ----
    for(const [id, f] of facts) {
        if(computedIds.has(id) || f.open === undefined) continue;
        if(f.anyHuman || !f.byAuthor) continue;      // human-frozen / not ours
        closes.push({assertion_id: f.open.assertion_id});
        inserts.push({
            ...Object.fromEntries(Object.entries(f.open).filter(([k, _v]) =>
                /^(ty\d*|id\d+)$/.test(k))),
            assertion_id: contentKeyId(['msync-tomb', author, id, t]),
            replaces_assertion_id: f.open.assertion_id,
            id, ty: f.open.ty,
            valid_from: t, valid_to: t,              // the tombstone shape
            order_key: f.open.order_key,
            change_by_username: author,
        } as Assertion);
        result.retracted++;
    }

    if(closes.length + inserts.length > 0) {
        db().transaction(() => {
            for(const c of closes)
                db().execute(`UPDATE ${table} SET valid_to = :t WHERE assertion_id = :a`,
                             {t, a: c.assertion_id});
            for(const a of inserts)
                db().insert<Assertion, 'assertion_id'>(table, a, 'assertion_id');
        });
        store.requestWorkspaceReload();
        store.requestEntriesJSONReload();
    }
    return result;
}

export function machineSyncReportLines(r: MachineSyncResult): string[] {
    return [
        `asserted ${r.asserted}; superseded ${r.superseded}; unchanged ${r.unchanged}; ` +
        `retracted ${r.retracted}; reasserted ${r.reasserted}`,
        ...(r.skippedHumanOwned > 0
            ? [`human-owned skipped: ${r.skippedHumanOwned} (frozen-stale: ${r.frozenStale.length})`] : []),
        ...(r.skippedHumanTombstoned > 0
            ? [`human tombstones respected: ${r.skippedHumanTombstoned}`] : []),
    ];
}
