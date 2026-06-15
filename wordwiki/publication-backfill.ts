// deno-lint-ignore-file no-explicit-any
/**
 * Phase 0 of the publication model (publication-model.md §10): born-approve the
 * existing, predecessor-approved dictionary into the published dimension WITHOUT
 * adding an approval row to every chain (which would roughly double the ~226k
 * rows). Mute-in-place: stamp `published_from = valid_from`, `published_to =
 * END_OF_TIME` directly onto the CURRENT live version of each fact.
 *
 * THE CUTOVER blesses the WHOLE accepted state, whatever the entry's status: the
 * team edited on top of the import for years with an OFFLINE approval process,
 * so forcing manual re-approval of any of it is pointless. `published` means
 * "approved" (out of the review queue); the separate `status = Completed` gate
 * still decides the public site, so this makes a non-Completed (Archived,
 * InProcess, …) fact *approved-but-not-public* — exactly the offline reality.
 * A born-approved row is then a *published row that is not an approved/reverted
 * re-assertion* — the grandfather signature; its audit reads "grandfathered at
 * cutover" (the predecessor + offline process is its approval record).
 * Tombstones and comments are never published: a fact deleted offline has no
 * published baseline, so it is already a settled (hidden) deletion - nothing to
 * bless.
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

    // Every current live version of a fact not yet carrying a published interval,
    // regardless of its entry's status. valid_to = EOT selects the current live
    // version (a tombstone's valid_to is finite, so excluded); `published_from
    // IS NULL` keeps it idempotent and never re-stamps a new-system publication;
    // comments are never publishable (I8).
    const where =
        `valid_to = :eot AND published_from IS NULL
         AND COALESCE(change_action, '') != 'comment'`;

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
