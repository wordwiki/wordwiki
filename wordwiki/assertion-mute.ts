// deno-lint-ignore-file no-explicit-any
/**
 * In-place value mutes for assertion data - the sanctioned mechanism for
 * IDENTIFIER RENAMES in the otherwise-immutable assertion store.
 *
 * The principle (dz, 2026-06-12): renames of identifier-valued data MUTE in
 * place, as one verified migration step; changes of CONTENT assert (new
 * versions, normal history).  Doing a rename as delete+create severs fact
 * identity - the history then claims a categorization ENDED and an
 * unrelated one BEGAN, when the truth is "same fact, value renamed" - which
 * is worse corruption than a scoped value substitution.  A mute rewrites
 * ALL rows (history and tombstones included), so after it, every
 * historical version of an affected fact carries a live identifier and is
 * safely restorable.
 *
 * Discipline, enforced here rather than left to callers:
 *   - the mapping is validated up front (no no-op pairs, no chains - a
 *     value that is also a key would make the result order-dependent);
 *   - the whole mute runs in ONE db transaction;
 *   - completeness is verified INSIDE the transaction (zero rows still
 *     carrying any old value) - any miss rolls the whole mute back;
 *   - workspace caches are invalidated after commit.
 *
 * A mute is genuinely irreversible: callers run under a backup discipline
 * (see importWordWikiV1Db.sh) and log the mapping somewhere durable (the
 * category import records each rename in the target category row).
 */
import { db } from '../liminal/db.ts';
import type { WordWiki } from './wordwiki.ts';

export interface AttrMuteSpec {
    /** Tuple type whose attr1 holds the identifier being renamed ('cat'). */
    ty: string;
    /** old value -> new value. */
    mapping: Map<string, string>;
}

export interface AttrMuteStats {
    /** Mapping entries that matched at least one row. */
    valuesRenamed: number;
    /** Rows rewritten, across ALL history (current, superseded, tombstones). */
    rowsUpdated: number;
}

export function muteAttr1Values(ww: WordWiki, spec: AttrMuteSpec,
                                opts: {log?: (msg: string) => void} = {}): AttrMuteStats {
    const log = opts.log ?? (() => undefined);
    const stats: AttrMuteStats = {valuesRenamed: 0, rowsUpdated: 0};
    if(spec.mapping.size === 0) return stats;   // idempotent re-run: nothing left

    // --- Validate the mapping as a whole before touching anything ----------
    const targets = new Set(spec.mapping.values());
    for(const [from, to] of spec.mapping) {
        if(typeof from !== 'string' || from === '')
            throw new Error(`mute: invalid source value ${JSON.stringify(from)}`);
        if(typeof to !== 'string' || to === '')
            throw new Error(`mute: invalid target value ${JSON.stringify(to)} for '${from}'`);
        if(from === to)
            throw new Error(`mute: no-op mapping '${from}' -> itself`);
        if(spec.mapping.has(to))
            throw new Error(`mute: chained mapping - target '${to}' (of '${from}') is also a ` +
                            `source; the result would depend on application order`);
    }
    void targets;

    // --- Apply, verify, and commit as one transaction ----------------------
    db().transaction(() => {
        for(const [from, to] of spec.mapping) {
            const n = db().required<{n: number}, {ty: string, v: string}>(
                `SELECT COUNT(*) AS n FROM dict WHERE ty = :ty AND attr1 = :v`,
                {ty: spec.ty, v: from}).n;
            if(n === 0) continue;
            db().execute(`UPDATE dict SET attr1 = :to WHERE ty = :ty AND attr1 = :from`,
                         {to, ty: spec.ty, from});
            stats.valuesRenamed++;
            stats.rowsUpdated += n;
            log(`  muted '${from}' -> '${to}' (${n} rows, history included)`);
        }
        // Completeness check inside the tx: a miss rolls everything back.
        for(const from of spec.mapping.keys()) {
            const left = db().required<{n: number}, {ty: string, v: string}>(
                `SELECT COUNT(*) AS n FROM dict WHERE ty = :ty AND attr1 = :v`,
                {ty: spec.ty, v: from}).n;
            if(left !== 0)
                throw new Error(`mute: ${left} rows still carry '${from}' after the update - ` +
                                `rolling back`);
        }
    });

    // The workspace and entry caches were built over the pre-mute values.
    ww.requestWorkspaceReload();
    return stats;
}
