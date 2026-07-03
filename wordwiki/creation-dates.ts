// deno-lint-ignore-file no-explicit-any
/**
 * Lexeme creation dates, across the legacy-import boundary.
 *
 * Every lexeme created IN wordwiki carries its true creation instant as the
 * `ent` fact's valid_from (the ent tag is never edited, so the date never
 * moves).  The 7.5k lexemes batch-imported from the legacy Shoebox system all
 * share ONE valid_from - BEGINNING_OF_TIME, the import instant - but almost
 * every one carries a `shoebox-date` attribute: the textual date the lexeme
 * was constructed in the legacy system (dd/Mon/yyyy, 2000-2024).
 *
 * WHY THE FIX IS NOT "rewrite valid_from from shoebox-date": the timestamp
 * encoding starts at the 2020 local epoch (timestamp.ts) - dates before it
 * are UNREPRESENTABLE (and even 2020-2024 rows must stay at the
 * BEGINNING_OF_TIME sentinel, which the feed/review UIs rely on to mean
 * "imported baseline").  So the creation date stays DATA: the shoebox-date
 * attribute is the source of truth for imported lexemes, valid_from for the
 * rest, resolved by parseShoeboxDate + the consumer (activity-report.ts).
 *
 * normalizeShoeboxDates is the migrateDevDb.sh / cutover step
 * (`wordwiki.sh normalize-shoebox-dates`): it rewrites every CURRENT
 * shoebox-date value to ISO yyyy-mm-dd, mute-in-place (the same pattern as
 * publication-backfill: a data-format migration of imported values, no new
 * assertion rows).  This validates the whole corpus loudly at migration time
 * (one production value holds two newline-separated dates; the first parseable
 * line wins), makes the values sortable, and leaves consumers a trivial parse.
 * Superseded versions keep their original text - they are the audit trail.
 * Re-running is a no-op (ISO values pass through the parser unchanged).
 */
import { db } from "../liminal/db.ts";
import * as timestamp from "../liminal/timestamp.ts";

export const SHOEBOX_DATE_ATTR = 'shoebox-date';

const MONTH_BY_NAME: Record<string, number> = {
    Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
    Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12};

/** Parse a shoebox-date value to ISO 'yyyy-mm-dd'.  Accepts the legacy
 *  dd/Mon/yyyy and (idempotently) already-normalized ISO; a multi-line value
 *  yields its first parseable line.  Undefined when nothing parses. */
export function parseShoeboxDate(text: string | null | undefined): string | undefined {
    if(!text) return undefined;
    for(const line of text.split('\n')) {
        const t = line.trim();
        if(/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
        const m = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{4})$/.exec(t);
        if(m) {
            const month = MONTH_BY_NAME[m[2]];
            const day = Number(m[1]);
            if(month === undefined || day < 1 || day > 31) continue;
            return `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }
    }
    return undefined;
}

export interface ShoeboxNormalizeStats {
    normalized: number;      // rewritten to ISO this run
    alreadyIso: number;      // exact ISO already - untouched
    unparseable: number;     // left as-is, each logged
}

/** Normalize every CURRENT shoebox-date attribute value to ISO, in place.
 *  Idempotent: a second run finds only alreadyIso/unparseable rows. */
export function normalizeShoeboxDates(opts: { log?: (m: string) => void } = {}): ShoeboxNormalizeStats {
    const log = opts.log ?? (() => undefined);
    const stats: ShoeboxNormalizeStats = { normalized: 0, alreadyIso: 0, unparseable: 0 };
    db().transaction(() => {
        const rows = db().all<{ assertion_id: number, attr2: string | null }, any>(
            `SELECT assertion_id, attr2 FROM dict
             WHERE ty = 'att' AND attr1 = :attr AND valid_to = :eot`,
            { attr: SHOEBOX_DATE_ATTR, eot: timestamp.END_OF_TIME });
        for(const r of rows) {
            const iso = parseShoeboxDate(r.attr2);
            if(iso === undefined) {
                stats.unparseable++;
                log(`shoebox-date UNPARSEABLE (left as-is): assertion ${r.assertion_id}: ` +
                    JSON.stringify(r.attr2));
            } else if(iso === r.attr2) {
                stats.alreadyIso++;
            } else {
                db().execute(
                    `UPDATE dict SET attr2 = :iso WHERE assertion_id = :id`,
                    { iso, id: r.assertion_id });
                stats.normalized++;
            }
        }
    });
    log(`shoebox-date normalize: ${stats.normalized} rewritten to ISO, ` +
        `${stats.alreadyIso} already ISO, ${stats.unparseable} unparseable`);
    return stats;
}
