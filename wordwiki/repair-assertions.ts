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
    };
}
