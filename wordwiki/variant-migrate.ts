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

export interface VariantMigrateStats {
    /** Total rows changed this run (0 on an idempotent re-run). */
    changed: number;
    /** Rows changed per action label. */
    byAction: Record<string, number>;
}

const EOT = timestamp.END_OF_TIME;

export function migrateVariants(report: FindingsReport, schema: model.Schema,
                                vocabulary: string[]): VariantMigrateStats {
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

    // ----- Actions (one transaction) -----------------------------------------
    const act = report.section('Actions applied (current rows, mute-in-place)');
    const tableRows: (string|number)[][] = [];
    const apply = (action: string, tag: string, whereSql: string, setValue: string|null,
                   params: Record<string, unknown>) => {
        const n = db().all<{n: number}, any>(
            `SELECT COUNT(*) AS n FROM dict WHERE valid_to = :eot AND ty = :ty AND ${whereSql}`,
            {eot: EOT, ty: tag, ...params})[0].n;
        if(n === 0) return;
        db().execute(
            `UPDATE dict SET variant = :newValue WHERE valid_to = :eot AND ty = :ty AND ${whereSql}`,
            {newValue: setValue, eot: EOT, ty: tag, ...params});
        stats.changed += n;
        stats.byAction[action] = (stats.byAction[action] ?? 0) + n;
        tableRows.push([action, tag, setValue ?? 'NULL', n]);
    };

    db().transaction(() => {
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
        // 5: explicit mis-stamp fixes.  (Both mapping-driven loops act only on
        // tags the schema knows as keepers - see the precondition above.)
        for(const [tag, fixes] of Object.entries(valueFixesByTag))
            if(policy.get(tag)?.flags && !policy.get(tag)!.flags!.notVariant)
                for(const [from, to] of Object.entries(fixes))
                    apply('value-fix', tag, `variant = :fromValue`, to, {fromValue: from});
        // 6: the per-tag blank backfill.
        for(const [tag, to] of Object.entries(blankBackfillByTag))
            if(policy.get(tag)?.flags && !policy.get(tag)!.flags!.notVariant)
                apply('backfill-blank', tag, `variant IS NULL`, to, {});
    });

    if(tableRows.length > 0)
        act.table(['action', 'tag', 'new value', 'rows'], tableRows);
    act.info(`${stats.changed} row(s) changed` +
             (stats.changed === 0 ? ' - already migrated (idempotent re-run)' : ''));

    // ----- What remains for hand-triage --------------------------------------
    const rem = report.section('Hand-triage remainder (deliberately untouched)');
    let remaining = 0;
    for(const p of keepers) {
        const allowed = allowedVariantValues(p.flags!, vocabulary);
        const rows = db().all<{variant: string, id1: number, attr1: string|null}, any>(
            `SELECT variant, id1, attr1 FROM dict
             WHERE valid_to = :eot AND ty = :ty AND variant IS NOT NULL`,
            {eot: EOT, ty: p.tag}).filter(r => !allowed.has(r.variant));
        for(const r of rows) {
            remaining++;
            rem.finding(`\`${p.tag}\` ${report.lexemeLink(r.id1, r.attr1 ?? `entry ${r.id1}`)}: ` +
                        `variant '${r.variant}' needs a human decision`);
        }
    }
    if(remaining === 0) rem.info('Nothing left for hand-triage.');

    return stats;
}
