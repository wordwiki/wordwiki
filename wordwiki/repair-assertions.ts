// deno-lint-ignore-file no-explicit-any
/**
 * Structural repairs of the persisted assertion store — fixes for corruption
 * surfaced by versioned-db-validate.ts, applied as idempotent, re-runnable
 * migration steps so the eventual production cutover runs exactly the flow we
 * rehearse against every dev pull (migrateDevDb.sh).
 *
 * These are STRUCTURAL repairs (chain-linkage metadata), not content edits:
 * they touch `replaces_assertion_id` directly rather than appending versions —
 * the same way the model already mutates `valid_to` in place. Each is a no-op
 * on a clean db, so re-running is safe and `verify-workspace` proves the
 * result.
 */
import { db } from "../liminal/db.ts";
import * as timestamp from "../liminal/timestamp.ts";

export interface RepairStats {
    danglingChainHeadsFixed: number;
    legacyPublishedPlaceholdersCleared: number;
    orphanedChildrenTombstoned: number;
}

/**
 * Cascade-complete missed deletions: a LIVE fact whose parent is not live is a
 * dangling child of a deleted parent (pre-publication-model deletes in the old
 * system did not cascade to children).  It is already invisible under the
 * top-down prune in BOTH views, but violates the tree invariant "a live fact
 * has a live parent" (versioned-db-validate.ts), and the born-approve backfill
 * would publish it into a published-orphan.  So we finish the delete: tombstone
 * the child in place (valid_to = valid_from) and clear any publication stamp.
 *
 * Pure SQL, pre-workspace-load (the invariant now blocks the load), and BEFORE
 * the backfill so no published-orphan ever forms.  Runs to a fixpoint:
 * tombstoning a child can orphan ITS children.  Idempotent - a re-run finds no
 * live-under-dead facts (they are tombstones now).  Safe because the write-time
 * gates (lexeme-ops tree-ordering) make new orphans impossible, so this only
 * ever meets legacy danglers, never live editing intent.
 */
export function repairOrphanedLiveChildren(opts: { log?: (m: string) => void } = {}): number {
    const log = opts.log ?? (() => undefined);
    // Live-current rows (valid_to = END_OF_TIME): id, valid_from, and the full
    // id-path so we can find each fact's parent id.
    const rows = db().all<{ assertion_id: number; id: number; valid_from: number;
                            id1: number|null; id2: number|null; id3: number|null;
                            id4: number|null; id5: number|null; ty: string }, { eot: number }>(
        `SELECT assertion_id, id, valid_from, id1, id2, id3, id4, id5, ty
           FROM dict WHERE valid_to = :eot`, { eot: timestamp.END_OF_TIME });
    const live = new Map<number, typeof rows[number]>();
    for (const r of rows) live.set(r.id, r);   // one live version per fact (the tip)

    const parentIdOf = (r: typeof rows[number]): number | undefined => {
        const path = [r.id1, r.id2, r.id3, r.id4, r.id5].filter((x): x is number => x != null);
        const i = path.lastIndexOf(r.id);
        return i > 0 ? path[i - 1] : undefined;   // undefined = top-level (parent is the root)
    };

    let total = 0;
    db().transaction(() => {
        for (;;) {
            const orphans = [...live.values()].filter(r => {
                const pid = parentIdOf(r);
                return pid !== undefined && !live.has(pid);   // parent deleted or absent
            });
            if (orphans.length === 0) break;
            for (const o of orphans) {
                db().execute(
                    `UPDATE dict SET valid_to = valid_from, published_from = NULL, published_to = NULL
                       WHERE assertion_id = :aid`, { aid: o.assertion_id });
                live.delete(o.id);   // now a tombstone; may orphan its own children next pass
                total++;
                log(`  tombstoned orphaned live ${o.ty}:${o.id} (parent gone)`);
            }
        }
    });
    return total;
}

/**
 * Clear the legacy `published_*` placeholder: `published_from =
 * BEGINNING_OF_TIME` (a 2020 epoch-ms constant left on ~151k rows by an old
 * experiment, in a different time-space than valid_from; published_to was
 * END_OF_TIME). It violates the publication invariants (published-before-valid,
 * tombstone-published, ...), so it must be cleared BEFORE any workspace load -
 * which is why it lives here in the pure-SQL repair pass that runs first, not
 * in the (post-import, workspace-using) born-approve backfill.
 *
 * Idempotency subtlety: most facts carry `valid_from = BEGINNING_OF_TIME` (the
 * predecessor import's initial timestamp), so a born-approved row's
 * `published_from = valid_from` can ALSO be BEGINNING_OF_TIME — byte-identical
 * to a placeholder sitting on such a fact. We therefore key on the
 * UNAMBIGUOUS, invariant-VIOLATING placeholder: `published_from = BOT` with
 * `valid_from != BOT`. While any of those remain the db is pre-Phase-0 and the
 * whole `published_from = BOT` set is junk (clear it all); once born-approve
 * has run there are none, so a re-run clears nothing and never clobbers a
 * born-approved fact.
 */
export function clearLegacyPublishedPlaceholder(opts: { log?: (m: string) => void } = {}): number {
    const bot = timestamp.BEGINNING_OF_TIME;
    const violating = db().required<{ n: number }, { b: number }>(
        `SELECT COUNT(*) AS n FROM dict WHERE published_from = :b AND valid_from != :b`, { b: bot }).n;
    if (violating === 0) return 0; // already cleared / never present / post-born-approve
    const n = db().required<{ n: number }, { b: number }>(
        `SELECT COUNT(*) AS n FROM dict WHERE published_from = :b`, { b: bot }).n;
    db().execute(
        `UPDATE dict SET published_from = NULL, published_to = NULL WHERE published_from = :b`, { b: bot });
    (opts.log ?? (() => undefined))(`  cleared ${n} legacy published placeholder rows`);
    return n;
}

/**
 * Dangling chain heads: a fact's EARLIEST version whose `replaces_assertion_id`
 * points at an assertion that does not exist — the fact was born referencing a
 * never-persisted "version 0", or its original head was removed by a since-gone
 * path (see the investigation in the publication-model pre-project). The head
 * should replace nothing, so we null the pointer; no data is lost (the missing
 * predecessor is already gone — this just stops the head claiming it existed).
 *
 * Defensive: a dangling `replaces_assertion_id` on a NON-earliest version is a
 * real MID-CHAIN break (a missing predecessor inside a chain), which nulling
 * would paper over by silently splitting the chain — so we refuse and throw,
 * surfacing it for investigation rather than "repairing" it.
 */
export function repairDanglingChainHeads(opts: { log?: (m: string) => void } = {}): { danglingChainHeadsFixed: number } {
    const log = opts.log ?? (() => undefined);

    const dangling = db().all<{ assertion_id: number; replaces: number; id: number; ty: string }, {}>(`
        SELECT a.assertion_id, a.replaces_assertion_id AS replaces, a.id, a.ty
          FROM dict a
         WHERE a.replaces_assertion_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM dict b WHERE b.assertion_id = a.replaces_assertion_id)`, {});

    let fixed = 0;
    db().transaction(() => {
        for (const d of dangling) {
            // The chain head is the earliest version of the fact (the load
            // orders by valid_from); only a head may legitimately replace
            // nothing.
            const head = db().required<{ assertion_id: number }, { id: number }>(
                `SELECT assertion_id FROM dict WHERE id = :id ORDER BY valid_from, assertion_id LIMIT 1`,
                { id: d.id });
            if (head.assertion_id !== d.assertion_id)
                throw new Error(
                    `dangling replaces_assertion_id ${d.replaces} on a NON-head assertion ` +
                    `${d.assertion_id} (fact ${d.ty}:${d.id}): a mid-chain break, not a ` +
                    `born-dangling head — refusing to auto-repair (investigate).`);
            db().execute(`UPDATE dict SET replaces_assertion_id = NULL WHERE assertion_id = :aid`,
                         { aid: d.assertion_id });
            fixed++;
            log(`  nulled dangling replaces on head ${d.assertion_id} (${d.ty}:${d.id}, was -> ${d.replaces})`);
        }
    });
    return { danglingChainHeadsFixed: fixed };
}

/** Run every structural repair (idempotent). Returns the combined counts. */
export function repairAssertions(opts: { log?: (m: string) => void } = {}): RepairStats {
    return {
        ...repairDanglingChainHeads(opts),
        legacyPublishedPlaceholdersCleared: clearLegacyPublishedPlaceholder(opts),
        orphanedChildrenTombstoned: repairOrphanedLiveChildren(opts),
    };
}
