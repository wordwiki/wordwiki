// deno-lint-ignore-file no-explicit-any
/**
 * Phase 0 of the publication model (publication-model.md §10): born-approve the
 * existing, predecessor-approved dictionary into the published dimension WITHOUT
 * adding an approval row to every chain (which would roughly double the ~226k
 * rows). Mute-in-place: stamp `published_from = valid_from`, `published_to =
 * END_OF_TIME` directly onto the CURRENT live version of each fact under a
 * `Completed`/`CompletedAsPDMOnly`-status entry. A born-approved row is then a
 * *published row that is not an approved/reverted re-assertion* — the
 * grandfather signature; its audit reads "imported as approved" (the
 * predecessor's status is its approval record). In-progress entries are left
 * pending; tombstones and comments are never published.
 *
 * This runs AFTER the vocabulary imports (so the re-categorized current tuples
 * get born-approved, while the old tuples those imports tombstoned do not — a
 * tombstone is never current-live, so it is skipped). The legacy `published_*`
 * placeholder is cleared earlier, by repair-assertions, because it must be gone
 * before any workspace load (it violates the publication invariants); see
 * clearLegacyPublishedPlaceholder there.
 *
 * Re-running is a no-op (born-approved rows already carry a published interval;
 * new-system publications are skipped). Rehearsed against every dev pull
 * (migrateDevDb.sh) so the production cutover holds no surprises.
 */
import { db } from "../liminal/db.ts";
import * as timestamp from "../liminal/timestamp.ts";

export interface BackfillStats {
    bornApproved: number;
}

export function backfillPublication(opts: { log?: (m: string) => void } = {}): BackfillStats {
    const log = opts.log ?? (() => undefined);
    const EOT = timestamp.END_OF_TIME;

    // The current live version of a fact under a published-status entry, not yet
    // carrying a published interval. valid_to = EOT selects the current live
    // version (a tombstone's valid_to is finite, so excluded); `published_from
    // IS NULL` keeps it idempotent and never re-stamps a new-system publication;
    // comments are never publishable (I8). The entry's id is `id1` on every fact
    // under it, so the non-correlated subquery (computed once) selects whole
    // entries by current status.
    const where =
        `valid_to = :eot AND published_from IS NULL
         AND COALESCE(change_action, '') != 'comment'
         AND id1 IN (SELECT DISTINCT id1 FROM dict
                     WHERE ty = 'sta' AND valid_to = :eot
                       AND attr1 IN ('Completed', 'CompletedAsPDMOnly'))`;

    const stats: BackfillStats = { bornApproved: 0 };
    db().transaction(() => {
        stats.bornApproved = db().required<{ n: number }, { eot: number }>(
            `SELECT COUNT(*) AS n FROM dict WHERE ${where}`, { eot: EOT }).n;
        db().execute(
            `UPDATE dict SET published_from = valid_from, published_to = :eot WHERE ${where}`,
            { eot: EOT });
    });

    log(`publication backfill: born-approved ${stats.bornApproved} facts ` +
        `(mute-in-place, no approval rows)`);
    return stats;
}
