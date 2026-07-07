/**
 * The STATUS REMODEL data migration — fix-orthographies.md "Status": today's
 * overloaded status splits into (a) the whole-lexeme LIFECYCLE (the `sta`
 * tag, narrowed: no variant, `Completed` renamed `Complete`) and (b) the
 * per-orthography PUBLISH GATE (`pub` facts, presence = gate).
 *
 * What it does, in order (dry-runnable via a rolled-back transaction, like
 * migrate-variants):
 *   1. CREATE GATES: every entry whose current sta is a gate-granting value
 *      ('Completed' — what today's public site renders) gets a born-published
 *      `pub` fact in the orthography its sta variant names (blank → mm-li,
 *      the site's orthography).  CompleteAsPDMOnly deliberately gets NO gate
 *      (dz-confirmed; those words leave the public site — each is NAMED in
 *      the report).
 *   2. RENAME lifecycle values (Completed→Complete, CompletedAsPDMOnly→
 *      CompleteAsPDMOnly), mute-in-place on current rows.
 *   3. BLANK the sta variant column (the lifecycle is whole-lexeme; the
 *      schema no longer has the field).  Runs BEFORE migrate-variants in the
 *      pipeline so step 1 could still read the orthography.
 *   4. SYNTHESIZE a lifecycle for entries with NO current sta fact at all
 *      (983 on the live data): a born-published sta = 'Unknown' (honest
 *      migration fidelity — it claims nothing; retire by hand later).
 *
 * DECISIONS AS DATA, changeable: the constants below.  New rows are stamped
 * change_by_username = '~status-migrate', so a future change of
 * `synthesizedLifecycle` can find and revise exactly the synthesized facts
 * (still-'Unknown' rows by that author).
 *
 * ONCE PER DB: like the Phase-0 publication backfill, this is a cutover act.
 * Re-running over a db with live v2 activity would wrongly gate words a
 * human deliberately set Complete WITHOUT making public — so completion sets
 * a `status-migration-done` config marker (travels with the db; absent from
 * a fresh V1 pull, which SHOULD migrate) and re-runs hard-no-op.
 */
import { db } from '../liminal/db.ts';
import * as timestamp from '../liminal/timestamp.ts';
import { highestTimestamp, type Assertion } from './assertion.ts';
import { newId } from './lexeme-ops.ts';
import * as entrySchema from './entry-schema.ts';
import { relationDisplayName } from './entry-schema.ts';
import { FindingsReport } from './findings.ts';
import type { BackfillConfig } from './publication-backfill.ts';

// --------------------------------------------------------------------------
// --- The decisions (defaults; changeable — see the module comment) ---------
// --------------------------------------------------------------------------

/** Old lifecycle value → new (mechanical; the Archived* family is unchanged). */
export const lifecycleRenames: Record<string, string> = {
    'Completed': 'Complete',
    'CompletedAsPDMOnly': 'CompleteAsPDMOnly',
};

/** The OLD sta values that meant "on the public site" — each such entry gets
 *  a publish gate.  CompletedAsPDMOnly is deliberately absent (dz-confirmed:
 *  no gate; the report names every affected entry). */
export const gateGrantingStatuses = ['Completed'];

/** A blank sta variant meant the site's own orthography. */
export const gateOrthographyDefault = entrySchema.PUBLIC_SITE_ORTHOGRAPHY;

/** The lifecycle synthesized for entries with no status fact at all. */
export const synthesizedLifecycle = 'Unknown';

export const MIGRATION_USERNAME = '~status-migrate';
export const STATUS_MIGRATION_DONE_KEY = 'status-migration-done';

// --------------------------------------------------------------------------

export interface StatusMigrateOptions {
    dryRun?: boolean;
    config?: BackfillConfig;
    /** The tx timestamp for every row this migration writes.  Callers inside
     *  a running app MUST pass the app allocator's value (bornApprove does) -
     *  the default (db max + one tick) is only safe in a fresh CLI process. */
    now?: number;
}

export interface StatusMigrateStats {
    changed: number;
    byAction: Record<string, number>;
    skippedByMarker?: boolean;
}

const EOT = timestamp.END_OF_TIME;

export function migrateStatus(report: FindingsReport,
                              opts: StatusMigrateOptions = {}): StatusMigrateStats {
    const dryRun = !!opts.dryRun;
    const stats: StatusMigrateStats = { changed: 0, byAction: {} };
    const bump = (action: string, n = 1) => {
        if(n === 0) return;
        stats.changed += n;
        stats.byAction[action] = (stats.byAction[action] ?? 0) + n;
    };

    const pre = report.section('Preconditions');
    const done = opts.config?.get(STATUS_MIGRATION_DONE_KEY);
    if(done) {
        pre.info(`already done on this db (${STATUS_MIGRATION_DONE_KEY}=${done}) - skipping`);
        return { ...stats, skippedByMarker: true };
    }
    pre.info('no done-marker: migrating');

    const headwordOf = (entry_id: number): string =>
        db().all<{attr1: string|null}, any>(
            `SELECT attr1 FROM dict
             WHERE valid_to = :eot AND ty = '${entrySchema.SpellingTag}' AND id1 = :id1
             ORDER BY order_key LIMIT 1`, {eot: EOT, id1: entry_id})[0]?.attr1
        ?? `entry ${entry_id}`;

    // One tx timestamp stamps every row this migration writes (like an import).
    const now = opts.now ?? timestamp.nextTime(highestTimestamp('dict'));

    const act = report.section(dryRun
        ? 'Actions (DRY RUN — reported, NOT applied)'
        : 'Actions applied');
    const gatesSection = report.section('The publish gates created');
    const pdmSection = report.section('CompleteAsPDMOnly — deliberately NO gate (leaves the public site)');
    const synthSection = report.section(`Entries with no status: lifecycle synthesized as '${synthesizedLifecycle}'`);

    db().beginTransaction();
    try {
        // --- 1. create the publish gates from gate-granting statuses.
        const gateRows = db().all<{id1: number, variant: string|null}, any>(
            `SELECT id1, variant FROM dict
             WHERE valid_to = :eot AND ty = '${entrySchema.StatusTag}'
               AND attr1 IN (${gateGrantingStatuses.map(v => `'${v}'`).join(',')})`, {eot: EOT});
        let created = 0, existing = 0;
        const gateSamples: (string|number)[][] = [];
        for(const r of gateRows) {
            const orthography = r.variant || gateOrthographyDefault;
            const already = db().all<{n: number}, any>(
                `SELECT COUNT(*) AS n FROM dict
                 WHERE valid_to = :eot AND ty = '${entrySchema.PublicTag}'
                   AND id1 = :e AND variant = :v`, {eot: EOT, e: r.id1, v: orthography})[0].n;
            if(already > 0) { existing++; continue; }
            const id = newId();
            db().insert<Assertion, 'assertion_id'>('dict', {
                ty0: entrySchema.DictTag, ty1: entrySchema.EntryTag, id1: r.id1,
                ty2: entrySchema.PublicTag, id2: id,
                assertion_id: id, id, ty: entrySchema.PublicTag,
                valid_from: now, valid_to: EOT,
                published_from: now, published_to: EOT,      // born-published: the gate IS approval
                order_key: '0.5',
                variant: orthography,
                change_by_username: MIGRATION_USERNAME,
            } as Assertion, 'assertion_id');
            created++;
            if(gateSamples.length < 10)
                gateSamples.push([report.lexemeLink(r.id1, headwordOf(r.id1)), orthography]);
        }
        bump('create-gate', created);
        if(gateSamples.length > 0) {
            gatesSection.table(['word', 'public in'], gateSamples);
            if(created > gateSamples.length)
                gatesSection.info(`… and ${created - gateSamples.length} more`);
        }
        gatesSection.info(`${created} gate(s) created` +
                          (existing > 0 ? `; ${existing} already existed (re-run)` : ''));

        // --- The PDM-only words that deliberately get NO gate: name them.
        const pdmRows = db().all<{id1: number}, any>(
            `SELECT id1 FROM dict
             WHERE valid_to = :eot AND ty = '${entrySchema.StatusTag}'
               AND attr1 IN ('CompletedAsPDMOnly', 'CompleteAsPDMOnly')`, {eot: EOT});
        for(const r of pdmRows)
            pdmSection.finding(
                `${report.lexemeLink(r.id1, headwordOf(r.id1))} is Complete-As-PDM-Only: ` +
                `no gate — it will NOT be on the public site (was included by the old rule)`);
        if(pdmRows.length === 0) pdmSection.info('None.');

        // --- 2. rename the lifecycle values.
        for(const [from, to] of Object.entries(lifecycleRenames)) {
            const n = db().all<{n: number}, any>(
                `SELECT COUNT(*) AS n FROM dict
                 WHERE valid_to = :eot AND ty = '${entrySchema.StatusTag}' AND attr1 = :from`,
                {eot: EOT, from})[0].n;
            if(n === 0) continue;
            db().execute(
                `UPDATE dict SET attr1 = :to
                 WHERE valid_to = :eot AND ty = '${entrySchema.StatusTag}' AND attr1 = :from`,
                {to, eot: EOT, from});
            bump('rename-lifecycle', n);
            act.info(`rename-lifecycle: ${from} → ${to} ×${n}`);
        }

        // --- 3. blank the sta variant column (whole-lexeme lifecycle).
        const staVariants = db().all<{n: number}, any>(
            `SELECT COUNT(*) AS n FROM dict
             WHERE valid_to = :eot AND ty = '${entrySchema.StatusTag}' AND variant IS NOT NULL`,
            {eot: EOT})[0].n;
        if(staVariants > 0) {
            db().execute(
                `UPDATE dict SET variant = NULL
                 WHERE valid_to = :eot AND ty = '${entrySchema.StatusTag}' AND variant IS NOT NULL`,
                {eot: EOT});
            bump('blank-sta-variant', staVariants);
            act.info(`blank-sta-variant: ×${staVariants}`);
        }

        // --- 4. synthesize a lifecycle where none exists.
        const orphans = db().all<{id: number}, any>(
            `SELECT e.id AS id FROM dict e
             WHERE e.valid_to = :eot AND e.ty = '${entrySchema.EntryTag}'
               AND NOT EXISTS (SELECT 1 FROM dict s
                               WHERE s.valid_to = :eot AND s.ty = '${entrySchema.StatusTag}'
                                 AND s.id1 = e.id)`, {eot: EOT});
        const synthSamples: string[] = [];
        for(const o of orphans) {
            const id = newId();
            db().insert<Assertion, 'assertion_id'>('dict', {
                ty0: entrySchema.DictTag, ty1: entrySchema.EntryTag, id1: o.id,
                ty2: entrySchema.StatusTag, id2: id,
                assertion_id: id, id, ty: entrySchema.StatusTag,
                valid_from: now, valid_to: EOT,
                published_from: now, published_to: EOT,
                order_key: '0.5',
                attr1: synthesizedLifecycle,
                change_by_username: MIGRATION_USERNAME,
            } as Assertion, 'assertion_id');
            if(synthSamples.length < 10)
                synthSamples.push(report.lexemeLink(o.id, headwordOf(o.id)));
        }
        bump('synthesize-lifecycle', orphans.length);
        if(orphans.length > 0) {
            synthSection.info(`${orphans.length} entries had no status fact - each got a ` +
                `born-published '${synthesizedLifecycle}' (stamped ${MIGRATION_USERNAME}, so a ` +
                `future decision change can find the unedited ones): e.g. ${synthSamples.join(', ')}`);
        } else synthSection.info('Every entry already has a lifecycle.');

        if(dryRun) db().rollbackTransaction();
        else db().endTransaction();
    } catch(e) {
        db().rollbackTransaction();
        throw e;
    }

    act.info(`${stats.changed} change(s)${dryRun ? ' WOULD be made (dry run - nothing was written)' : ''}`);

    // --- Post-checks (against the post-transaction state; in a dry run this
    //     is the unmigrated state, so the checks are skipped).
    if(!dryRun) {
        const post = report.section('Post-checks');
        const multi = db().all<{id1: number, n: number}, any>(
            `SELECT id1, COUNT(*) AS n FROM dict
             WHERE valid_to = :eot AND ty = '${entrySchema.StatusTag}'
             GROUP BY id1 HAVING n > 1`, {eot: EOT});
        for(const m of multi)
            post.finding(`${report.lexemeLink(m.id1, headwordOf(m.id1))} has ${m.n} current ` +
                         `${relationDisplayName(entrySchema.StatusTag)} facts — the lifecycle ` +
                         `invariant wants exactly one`);
        const none = db().all<{n: number}, any>(
            `SELECT COUNT(*) AS n FROM dict e
             WHERE e.valid_to = :eot AND e.ty = '${entrySchema.EntryTag}'
               AND NOT EXISTS (SELECT 1 FROM dict s
                               WHERE s.valid_to = :eot AND s.ty = '${entrySchema.StatusTag}'
                                 AND s.id1 = e.id)`, {eot: EOT})[0].n;
        post.info(`entries without a lifecycle after migration: ${none} (want 0); ` +
                  `entries with >1: ${multi.length} (want 0)`);
        opts.config?.set(STATUS_MIGRATION_DONE_KEY, new Date().toISOString());
    }

    return stats;
}
