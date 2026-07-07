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
 * Phase 0 runs ONCE PER DB.  It is a CUTOVER act - blessing pre-publication-
 * model data - so once a db has been through it, re-running must be a hard
 * no-op: on a db with live v2 editing activity, re-stamping would silently
 * "approve" pending edits (and double-publish a fact whose predecessor is
 * still published-current - the load-time validator rejects that state; this
 * bit an importWordWikiV1Db.sh --no-pull re-run, 2026-07-07).  Two guards:
 *
 *  1. a `publication-backfill-done` CONFIG MARKER, set on completion - it
 *     lives in the db, so it travels with rsync copies and vanishes with a
 *     fresh V1 pull (which SHOULD be backfilled);
 *  2. structurally, a fact whose chain already carries ANY published
 *     interval is never touched - it is under new-system management and its
 *     pending versions belong to the review queue.
 */
import { db } from "../liminal/db.ts";
import * as timestamp from "../liminal/timestamp.ts";

export interface BackfillStats {
    bornApproved: number;
    /** True when the config marker said this db was already backfilled. */
    skippedByMarker?: boolean;
}

export const BACKFILL_DONE_KEY = 'publication-backfill-done';

/** Minimal view of the config table (wordwiki.ts passes ww.config); absent
 *  in low-level tests, which then exercise the structural guard alone. */
export interface BackfillConfig {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
}

export function backfillPublication(opts: { log?: (m: string) => void,
                                            config?: BackfillConfig } = {}): BackfillStats {
    const log = opts.log ?? (() => undefined);
    const EOT = timestamp.END_OF_TIME;

    const done = opts.config?.get(BACKFILL_DONE_KEY);
    if(done) {
        log(`publication backfill: already done on this db (${BACKFILL_DONE_KEY}=${done}) - skipping`);
        return { bornApproved: 0, skippedByMarker: true };
    }

    // Every current live version of a fact not yet carrying a published interval,
    // regardless of its entry's status. valid_to = EOT selects the current live
    // version (a tombstone's valid_to is finite, so excluded); `published_from
    // IS NULL` keeps it idempotent and never re-stamps a new-system publication;
    // comments are never publishable (I8); a fact with ANY published version in
    // its chain is under new-system management (guard 2 above) - its unstamped
    // current version is a PENDING EDIT, not unblessed offline data.
    const where =
        `valid_to = :eot AND published_from IS NULL
         AND COALESCE(change_action, '') != 'comment'
         AND (id, ty) NOT IN (SELECT id, ty FROM dict WHERE published_from IS NOT NULL)`;

    const stats: BackfillStats = { bornApproved: 0 };
    db().transaction(() => {
        stats.bornApproved = db().required<{ n: number }, { eot: number }>(
            `SELECT COUNT(*) AS n FROM dict WHERE ${where}`, { eot: EOT }).n;
        db().execute(
            `UPDATE dict SET published_from = valid_from, published_to = :eot WHERE ${where}`,
            { eot: EOT });
    });
    opts.config?.set(BACKFILL_DONE_KEY, new Date().toISOString());

    log(`publication backfill: born-approved ${stats.bornApproved} facts ` +
        `(mute-in-place, no approval rows)`);
    return stats;
}
