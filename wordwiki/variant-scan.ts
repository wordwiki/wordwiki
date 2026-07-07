/**
 * The variant data scan (fix-orthographies.md "Data scan" / "Migration
 * mechanics"): a permanent, read-only sweep of current dict rows against the
 * schema's orthography flags, reported through the findings API.
 *
 * The PASS of the $notVariant drop gate — every $notVariant field holds only
 * values that are safe to drop (blank / 'mm' / 'mm-li' / the literal "null"
 * of an old serialization bug) — is a precondition the orthography migration
 * re-checks at run time, protecting against data moving between scan day and
 * migration day.  The dirt findings (blank backfill workload, off-vocabulary
 * values, variants on variant-less tags) size the cleanup reports; they are
 * reported but do NOT fail the scan — the migration and the language staff
 * drain them.
 */
import { db } from '../liminal/db.ts';
import { block } from '../liminal/strings.ts';
import { Markup } from '../liminal/markup.ts';
import { route, authenticated } from '../liminal/security.ts';
import * as timestamp from '../liminal/timestamp.ts';
import * as model from './model.ts';
import * as templates from './templates.ts';
import * as entrySchema from './entry-schema.ts';
import type { WordWiki } from './wordwiki.ts';
import { FindingsReport, renderFindingsMarkup } from './findings.ts';
import { variantPolicyByTag, allowedVariantValues, isBlankVariant,
         type TagVariantPolicy } from './variant-policy.ts';

// Values a $notVariant column may hold and still be safely droppable.  'mm'
// and 'mm-li' carry no information on a field that never was an orthography
// (the corpus is Listuguj-dominant); the literal string "null" is an old
// serialization bug.  Anything else suggests real use and fails the gate.
const DROPPABLE = new Set(['mm', 'mm-li', 'null']);

export interface VariantScanResult { gatePassed: boolean; }

// --- current-rows queries ----------------------------------------------------

interface VariantCountRow { ty: string; variant: string|null; n: number; }

const selectVariantCounts = () => db().prepare<VariantCountRow, Record<never, never>>(block`
/**/   SELECT ty, variant, COUNT(*) AS n FROM dict
/**/   WHERE valid_to = ${timestamp.END_OF_TIME}
/**/   GROUP BY ty, variant`);

interface SampleRow { id1: number; attr1: string|null; }

const selectSamples = () => db().prepare<SampleRow, {ty: string, variant: string}>(block`
/**/   SELECT id1, attr1 FROM dict
/**/   WHERE valid_to = ${timestamp.END_OF_TIME} AND ty = :ty AND variant = :variant
/**/   LIMIT 5`);

// --- the scan ----------------------------------------------------------------

/**
 * Scan current dict rows against the schema's variant flags, reporting into
 * `report`.  Returns whether the $notVariant drop gate passed.
 */
export function scanVariants(report: FindingsReport, schema: model.Schema,
                             vocabulary: string[]): VariantScanResult {
    const policy = variantPolicyByTag(schema);
    const counts = selectVariantCounts().all({});
    const byTag = new Map<string, VariantCountRow[]>();
    for(const row of counts) {
        if(!byTag.has(row.ty)) byTag.set(row.ty, []);
        byTag.get(row.ty)!.push(row);
    }
    const totalOf = (rows: VariantCountRow[]) => rows.reduce((n, r) => n + r.n, 0);
    const samplesFor = (ty: string, variant: string): string =>
        selectSamples().all({ty, variant})
            .map(s => report.lexemeLink(s.id1, s.attr1 ? `${s.attr1}` : `entry ${s.id1}`))
            .join(', ');

    let gatePassed = true;

    // --- The drop gate: $notVariant fields hold nothing worth keeping.
    {
        const s = report.section('Drop gate — $notVariant fields');
        const tableRows: (string|number)[][] = [];
        for(const p of policy.values()) {
            if(!p.flags?.notVariant) continue;
            const rows = byTag.get(p.tag) ?? [];
            const blank = totalOf(rows.filter(r => isBlankVariant(r.variant)));
            const droppable = rows.filter(r => !isBlankVariant(r.variant) && DROPPABLE.has(r.variant!));
            const offGate = rows.filter(r => !isBlankVariant(r.variant) && !DROPPABLE.has(r.variant!));
            tableRows.push([p.tag, p.relationName, blank,
                            droppable.map(r => `${r.variant} ×${r.n}`).join(', ') || '—',
                            offGate.map(r => `${r.variant} ×${r.n}`).join(', ') || '—']);
            for(const r of droppable.filter(r => r.variant === 'null'))
                s.info(`\`${p.tag}\`: ${r.n} literal "null" string(s) — old serialization bug, droppable`);
            for(const r of offGate) {
                gatePassed = false;
                s.finding(`GATE: \`${p.tag}\` (${p.relationName}) is $notVariant but holds ` +
                          `'${r.variant}' ×${r.n} — e.g. ${samplesFor(p.tag, r.variant!)}`);
            }
        }
        s.table(['tag', 'relation', 'blank', 'droppable values', 'OFF-GATE values'], tableRows);
        s.info(gatePassed ? 'Drop gate: PASS — every $notVariant field is safely droppable.'
                          : 'Drop gate: FAIL — see the GATE findings above.');
    }

    // --- Blank variants on orthographic fields: the migration's per-tag
    //     backfill workload.
    {
        const s = report.section('Blank variants on orthographic fields (backfill workload)');
        const tableRows: (string|number)[][] = [];
        for(const p of policy.values()) {
            if(!p.flags || p.flags.notVariant) continue;
            const rows = byTag.get(p.tag) ?? [];
            const blank = totalOf(rows.filter(r => isBlankVariant(r.variant)));
            if(blank > 0) {
                tableRows.push([p.tag, p.relationName, blank, totalOf(rows)]);
                s.finding(`\`${p.tag}\` (${p.relationName}): ${blank} blank variant(s) of ` +
                          `${totalOf(rows)} current rows — needs a per-tag backfill decision`);
            }
        }
        if(tableRows.length > 0)
            s.table(['tag', 'relation', 'blank', 'total current'], tableRows);
        else
            s.info('No blank variants on orthographic fields.');
    }

    // --- Off-vocabulary values on orthographic fields (spelling text in the
    //     variant column, 'mm' where $allowAll is not granted, ...).
    {
        const s = report.section('Off-vocabulary variant values');
        let found = 0;
        for(const p of policy.values()) {
            if(!p.flags || p.flags.notVariant) continue;
            const allowed = allowedVariantValues(p.flags, vocabulary);
            for(const r of byTag.get(p.tag) ?? []) {
                if(isBlankVariant(r.variant) || allowed.has(r.variant!)) continue;
                found++;
                s.finding(`\`${p.tag}\` (${p.relationName}): variant '${r.variant}' ×${r.n} ` +
                          `is not an allowed orthography — e.g. ${samplesFor(p.tag, r.variant!)}`);
            }
        }
        if(found === 0) s.info('All orthographic variant values are in the vocabulary.');
    }

    // --- Variant values on relations that have no variant field at all.
    {
        const s = report.section('Variant values on variant-less relations');
        let found = 0;
        for(const p of policy.values()) {
            if(p.flags !== null) continue;
            for(const r of byTag.get(p.tag) ?? []) {
                if(isBlankVariant(r.variant)) continue;
                found++;
                s.finding(`\`${p.tag}\` (${p.relationName}) has no variant field but holds ` +
                          `'${r.variant}' ×${r.n} — e.g. ${samplesFor(p.tag, r.variant!)}`);
            }
        }
        if(found === 0) s.info('No variant values outside variant-bearing relations.');
    }

    // --- Tags present in the db but absent from the schema.
    {
        const s = report.section('Unknown relation tags');
        const unknown = [...byTag.keys()].filter(ty => !policy.has(ty));
        for(const ty of unknown)
            s.finding(`db tag '${ty}' (${totalOf(byTag.get(ty)!)} current rows) is not in the schema`);
        if(unknown.length === 0) s.info('Every db tag is declared in the schema.');
    }

    return { gatePassed };
}

// --------------------------------------------------------------------------
// --- The LIVE cleanup report (the staff triage queue) ----------------------
// --------------------------------------------------------------------------

/**
 * The variant scan as a LIVE page — the second renderer of the one findings
 * vocabulary (fix-orthographies.md "Findings publish path"): the same scan
 * the subcommand runs, rendered against the CURRENT db on every request, so
 * the page drains as fixes land.  This is the language staff's hand-triage
 * queue (garbage spl variants, blank backfill workload, ...).
 */
export class VariantReports {
    constructor(private app: WordWiki) {}

    @route(authenticated)
    cleanupReport(): Markup {
        const report = new FindingsReport('Variant (orthography) cleanup', {quiet: true});
        scanVariants(report, this.app.dictSchema, Object.keys(entrySchema.variants));
        const title = 'Variant (orthography) cleanup';
        const body: Markup = [
            ['h1', {}, title],
            ['p', {class: 'text-muted small mb-2'},
             `${report.findingCount} finding(s) — a LIVE view of the current database; ` +
             'this page drains as fixes land.'],
            renderFindingsMarkup(report)];
        return templates.pageTemplate({title, body});
    }
}
