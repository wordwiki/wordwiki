/**
 * The variant (orthography) data migration — fix-orthographies.md "Migration
 * mechanics".  ONE data-migration event, rehearsed per instance via the
 * normalize-shoebox-dates pattern: mute-in-place on CURRENT rows only
 * (superseded versions keep their original values — the audit trail),
 * idempotent (a second run changes nothing — `--expect-no-changes` proves
 * it), refuses a production db without --allow-production (enforced by the
 * subcommand).
 *
 * What it does, in order (all current rows only):
 *   1. normalize blank: ''            -> NULL (one blank representation)
 *   2. the literal string "null"      -> NULL (an old serialization bug)
 *   3. $notVariant tags:      variant -> NULL (the field is dropping)
 *   4. variant-less tags:     variant -> NULL (never should have had one)
 *   5. explicit VALUE FIXES (table below: mis-stamped rows)
 *   6. per-tag BLANK BACKFILL (table below: what a blank always meant)
 *
 * What it deliberately does NOT do: the hand-triage rows (spelling text in
 * the variant column, ...) are left untouched — they are a human decision,
 * drained through the live cleanup report, not a rule.
 *
 * Preconditions (each re-checked at run time, since data moves between
 * rehearsal day and cutover day):
 *   - the FLAGGED schema is in force (some tag carries $notVariant) — running
 *     against the unflagged schema would misread every tag as a keeper;
 *   - the scan-variants drop gate passes;
 *   - every keeper tag that has blank rows appears in the backfill mapping,
 *     and every mapped/fixed value is allowed for its tag.
 */
import { db } from '../liminal/db.ts';
import * as timestamp from '../liminal/timestamp.ts';
import * as model from './model.ts';
import { FindingsReport, FindingsSection } from './findings.ts';
import { scanVariants } from './variant-scan.ts';
import { SpellingTag, relationDisplayName } from './entry-schema.ts';
import { variantPolicyByTag, allowedVariantValues,
         type TagVariantPolicy } from './variant-policy.ts';

// --------------------------------------------------------------------------
// --- The per-tag decisions (data, stated for review — dz to confirm before
// --- the staging/production event) ----------------------------------------
// --------------------------------------------------------------------------

/**
 * Blank-variant backfill: what a blank variant has always MEANT, per tag.
 * The rule behind the values (fix-orthographies.md "Data scan"): the corpus
 * is Listuguj-dominant and predates orthography stamping, so a blank on an
 * orthographic-text tag means 'mm-li' — confirmed by each tag's own non-blank
 * distribution (e.g. rse: 903 × mm-li vs 11 × mm-pm).  The $defaultAll tags
 * (tdo/att/rnp/src: usually orthography-neutral content) instead mean the
 * 'mm' wildcard.  rfr is $mixed without $allowAll, so its 1 blank must take
 * a real orthography: mm-li.
 */
export const blankBackfillByTag: Record<string, string> = {
    spl: 'mm-li',
    sta: 'mm-li',
    tdo: 'mm',
    etx: 'mm-li',
    alx: 'mm-li',
    orf: 'mm-li',
    att: 'mm',
    rtl: 'mm-li',
    rse: 'mm-li',
    rne: 'mm-li',
    rfr: 'mm-li',
    rnp: 'mm',
    src: 'mm',
};

/**
 * Explicit value fixes: rows whose stored variant is WRONG in a way a rule
 * can state (fix-orthographies.md "Schema + data re-review"):
 *  - rse 'mm' ×15: Pacifique diacritics + English gloss — mis-stamped mm-pm;
 *  - orf 'mm' ×2: a regional form text is a specific spelling — mm-li;
 *  - spl 'mm' ×1: spelling never gets the wildcard — explicit mm-li.
 */
export const valueFixesByTag: Record<string, Record<string, string>> = {
    rse: { 'mm': 'mm-pm' },
    orf: { 'mm': 'mm-li' },
    spl: { 'mm': 'mm-li' },
};

// --------------------------------------------------------------------------
// --- The migration ---------------------------------------------------------
// --------------------------------------------------------------------------

export interface VariantMigrateOptions {
    /** Compute and REPORT everything, change nothing.  `changed` then counts
     *  the rows that WOULD change - so `--dry-run --expect-no-changes` is a
     *  read-only "is this db fully migrated?" probe, and a dry run against
     *  an unmigrated db is the REVIEW artifact for the decision tables. */
    dryRun?: boolean;
}

export interface VariantMigrateStats {
    /** Rows changed this run (0 on an idempotent re-run); in a dry run, the
     *  rows that WOULD change. */
    changed: number;
    /** Rows changed per action label. */
    byAction: Record<string, number>;
}

const EOT = timestamp.END_OF_TIME;

export function migrateVariants(report: FindingsReport, schema: model.Schema,
                                vocabulary: string[],
                                opts: VariantMigrateOptions = {}): VariantMigrateStats {
    const dryRun = !!opts.dryRun;
    const policy = variantPolicyByTag(schema);
    const stats: VariantMigrateStats = { changed: 0, byAction: {} };

    // ----- Preconditions ----------------------------------------------------
    const pre = report.section('Preconditions');

    if(![...policy.values()].some(p => p.flags?.notVariant))
        throw new Error('migrate-variants: the schema carries no $notVariant flags - ' +
                        'the flagged entry-schema must be in force before migrating ' +
                        '(running unflagged would misread every tag as a keeper)');
    pre.info('flagged schema in force');

    const gate = scanVariants(new FindingsReport('gate re-check', {quiet: true}),
                              schema, vocabulary);
    if(!gate.gatePassed)
        throw new Error('migrate-variants: the scan-variants drop gate FAILS - ' +
                        'resolve the $notVariant findings before migrating');
    pre.info('scan-variants drop gate: PASS');

    const keepers = [...policy.values()].filter(p => p.flags && !p.flags.notVariant);
    const blankCounts = new Map<string, number>(db().all<{ty: string, n: number}, any>(
        `SELECT ty, COUNT(*) AS n FROM dict
         WHERE valid_to = :eot AND (variant IS NULL OR variant = '')
         GROUP BY ty`, {eot: EOT}).map(r => [r.ty, r.n]));
    const unmapped = keepers.filter(p => (blankCounts.get(p.tag) ?? 0) > 0
                                         && !(p.tag in blankBackfillByTag));
    if(unmapped.length > 0)
        throw new Error(`migrate-variants: keeper tag(s) with blank rows but no backfill ` +
                        `mapping: ${unmapped.map(p => p.tag).join(', ')} - every backfill ` +
                        `is an explicit per-tag decision, add them to blankBackfillByTag`);
    // Every mapped/fixed value must be allowed for its tag.  A mapping entry
    // whose tag is absent from the schema is skipped (nothing to migrate) -
    // but a tag that IS present and is not a keeper is a misconfiguration.
    const mappedValues: [string, string][] = [
        ...Object.entries(blankBackfillByTag),
        ...Object.entries(valueFixesByTag).flatMap(([t, m]) =>
            Object.values(m).map(v => [t, v] as [string, string]))];
    for(const [tag, value] of mappedValues) {
        const p = policy.get(tag);
        if(!p) continue;
        if(!p.flags || p.flags.notVariant)
            throw new Error(`migrate-variants: mapping names '${tag}', which is not a keeper tag`);
        if(!allowedVariantValues(p.flags, vocabulary).has(value))
            throw new Error(`migrate-variants: mapped value '${value}' is not allowed on '${tag}'`);
    }
    pre.info(`backfill mapping covers every keeper tag with blanks (${keepers.length} keepers)`);

    // ----- Decision evidence (the reviewer's view of the mapping) ------------
    // Emitted BEFORE the actions run, so it shows the pre-migration state the
    // mapping was judged against: per mapped tag, how many blanks are being
    // filled and what the tag's own stamped rows already say.
    {
        const ev = report.section('Decision evidence — the blank-backfill mapping');
        const evRows: (string|number)[][] = [];
        for(const [tag, chosen] of Object.entries(blankBackfillByTag)) {
            const p = policy.get(tag);
            if(!p?.flags || p.flags.notVariant) continue;
            const dist = db().all<{variant: string|null, n: number}, any>(
                `SELECT variant, COUNT(*) AS n FROM dict
                 WHERE valid_to = :eot AND ty = :ty
                 GROUP BY variant ORDER BY n DESC`, {eot: EOT, ty: tag});
            const blanks = dist.filter(r => r.variant == null || r.variant === '')
                               .reduce((a, r) => a + r.n, 0);
            const stamped = dist.filter(r => r.variant != null && r.variant !== '')
                                .map(r => `${r.variant} ×${r.n}`).join(', ') || '—';
            evRows.push([relationDisplayName(tag), tag, blanks,
                         stamped, `${chosen}${p.flags.defaultAll ? ' ($defaultAll)' : ''}`]);
        }
        ev.table(['relation', 'tag', 'blanks to fill', 'current stamped values', 'blank becomes'],
                 evRows);
        ev.info('Rule: $defaultAll tags (usually orthography-neutral content) → the ' +
                "'mm' wildcard; all others → 'mm-li' (the corpus is Listuguj-dominant, " +
                "and each tag's own stamped values above bear that out).");
    }

    // ----- Actions (one transaction) -----------------------------------------
    const act = report.section(dryRun
        ? 'Actions (DRY RUN — reported, NOT applied)'
        : 'Actions applied (current rows, mute-in-place)');
    const tableRows: (string|number)[][] = [];
    interface CaseTable { title: string; rows: (string|number)[][]; more: number; }
    const caseTables: CaseTable[] = [];
    const clip = (t: string|null) => {
        const s = (t ?? '').replaceAll('\n', ' ');
        return s.length > 60 ? s.slice(0, 57) + '…' : s;
    };
    // The reviewer navigates by WORD: link case rows by the entry's headword
    // (its first current spelling), falling back to the entry number.
    const headwordOf = (entry_id: number): string =>
        db().all<{attr1: string|null}, any>(
            `SELECT attr1 FROM dict
             WHERE valid_to = :eot AND ty = '${SpellingTag}' AND id1 = :id1
             ORDER BY order_key LIMIT 1`, {eot: EOT, id1: entry_id})[0]?.attr1
        ?? `entry ${entry_id}`;
    // detail: 'enumerate' lists every affected row (small, decision-critical
    // sets - the value fixes); 'sample' lists the first few of a large set
    // (the backfills - the evidence table above carries the aggregate case).
    const apply = (action: string, tag: string, whereSql: string, setValue: string|null,
                   params: Record<string, unknown>, detail?: 'enumerate'|'sample') => {
        const rows = db().all<{id1: number, attr1: string|null, variant: string|null}, any>(
            `SELECT id1, attr1, variant FROM dict
             WHERE valid_to = :eot AND ty = :ty AND ${whereSql}`,
            {eot: EOT, ty: tag, ...params});
        const n = rows.length;
        if(n === 0) return;
        // The UPDATE always runs - later stages must see earlier stages'
        // effects (backfill fills the NULLs that normalize-blank just made)
        // for the counts and cases to match a real run EXACTLY.  A dry run
        // gets its no-write guarantee from the transaction ROLLBACK below.
        db().execute(
            `UPDATE dict SET variant = :newValue WHERE valid_to = :eot AND ty = :ty AND ${whereSql}`,
            {newValue: setValue, eot: EOT, ty: tag, ...params});
        stats.changed += n;
        stats.byAction[action] = (stats.byAction[action] ?? 0) + n;
        tableRows.push([action, relationDisplayName(tag), setValue ?? 'NULL', n]);
        if(detail) {
            const shown = detail === 'enumerate' ? rows.slice(0, 30) : rows.slice(0, 10);
            caseTables.push({
                title: `${action} ${relationDisplayName(tag)}: ${detail === 'enumerate' ? 'every case' : 'sample'} ` +
                       `(${n} row(s) → ${setValue ?? 'NULL'})`,
                rows: shown.map(r => [
                    report.lexemeLink(r.id1, headwordOf(r.id1)),
                    clip(r.attr1), r.variant ?? 'NULL', setValue ?? 'NULL']),
                more: n - shown.length,
            });
        }
    };

    db().beginTransaction();
    try {
        const allTags = [...policy.values()];
        // 1+2: one blank representation; the literal "null" is droppable noise.
        for(const p of allTags) {
            apply('normalize-blank', p.tag, `variant = ''`, null, {});
            apply('null-literal', p.tag, `variant = 'null'`, null, {});
        }
        // 3+4: the variant column empties on tags that are losing it.
        for(const p of allTags)
            if(p.flags === null || p.flags.notVariant)
                apply(p.flags === null ? 'drop-variantless' : 'drop-notVariant',
                      p.tag, `variant IS NOT NULL`, null, {});
        // 5: explicit mis-stamp fixes - every case enumerated for review.
        // (Both mapping-driven loops act only on tags the schema knows as
        // keepers - see the precondition above.)
        for(const [tag, fixes] of Object.entries(valueFixesByTag))
            if(policy.get(tag)?.flags && !policy.get(tag)!.flags!.notVariant)
                for(const [from, to] of Object.entries(fixes))
                    apply('value-fix', tag, `variant = :fromValue`, to, {fromValue: from},
                          'enumerate');
        // 6: the per-tag blank backfill - sampled for review (the decision
        // evidence section carries the aggregate case).
        for(const [tag, to] of Object.entries(blankBackfillByTag))
            if(policy.get(tag)?.flags && !policy.get(tag)!.flags!.notVariant)
                apply('backfill-blank', tag, `variant IS NULL`, to, {}, 'sample');
        if(dryRun) db().rollbackTransaction();
        else db().endTransaction();
    } catch(e) {
        db().rollbackTransaction();
        throw e;
    }

    if(tableRows.length > 0)
        act.table(['action', 'relation', 'new value', 'rows'], tableRows);
    act.info(`${stats.changed} row(s) ${dryRun ? 'WOULD change (dry run - nothing was written)' : 'changed'}` +
             (stats.changed === 0 ? ' - already migrated' : ''));

    // The per-case review detail (dz: "I would need to see what the actual
    // changes are"): one table per decision-table action.
    if(caseTables.length > 0) {
        const cases = report.section('The cases (decision-table review detail)');
        for(const ct of caseTables) {
            cases.info(ct.title);
            cases.table(['word', 'field text', 'variant was', 'becomes'], ct.rows);
            if(ct.more > 0) cases.info(`… and ${ct.more} more like these`);
        }
    }

    // ----- What remains for hand-triage --------------------------------------
    const rem = report.section('Hand-triage remainder (deliberately untouched)');
    let remaining = 0;
    for(const p of keepers) {
        const allowed = allowedVariantValues(p.flags!, vocabulary);
        const rows = db().all<{variant: string, id1: number, attr1: string|null}, any>(
            `SELECT variant, id1, attr1 FROM dict
             WHERE valid_to = :eot AND ty = :ty AND variant IS NOT NULL`,
            {eot: EOT, ty: p.tag}).filter(r =>
                !allowed.has(r.variant)
                // In a DRY RUN the data is unchanged, so exclude what the run
                // would have fixed (no-ops after a real run).
                && r.variant !== '' && r.variant !== 'null'
                && valueFixesByTag[p.tag]?.[r.variant] === undefined);
        for(const r of rows) {
            remaining++;
            rem.finding(`${relationDisplayName(p.tag)} ${report.lexemeLink(r.id1, r.attr1 ?? `entry ${r.id1}`)}: ` +
                        `variant '${r.variant}' needs a human decision`);
        }
    }
    if(remaining === 0) rem.info('Nothing left for hand-triage.');

    return stats;
}
