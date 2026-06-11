// deno-lint-ignore-file no-explicit-any
/**
 * Category import - the repeatable process that moves the dictionary onto
 * the controlled category vocabulary (see category.ts and
 * categorization/categorization-design.md).
 *
 * Two idempotent steps, run together by `./wordwiki.sh import-categories`:
 *
 * 1. SEED the category table:
 *    - the new scheme (parsed from categorization/scheme.md - slugs, names,
 *      themes, descriptions), in scheme order;
 *    - the internal categories (~needs-human, ~tier-top-10/100/1000);
 *    - one retired `~old-<name>` category for every distinct old free-text
 *      category still present in current assertions.
 *    New categories seed before old ones, so the table's order_key order has
 *    the new vocabulary first.  Existing slugs are skipped (re-runnable).
 *
 * 2. REWRITE each entry's category tuples (via applyTransaction - stamped,
 *    versioned, undoable):
 *    - entries in assignments.jsonl get their new categories (primary
 *      first), a `~tier-*` tag (most specific tier; tiers are cumulative by
 *      convention) and `~needs-human` if flagged;
 *    - every remaining old free-text value is preserved as `~old-<name>`
 *      (a transition convenience - history preserves the originals anyway);
 *    - an entry whose current values already equal the desired values is
 *      skipped, so a re-run is a no-op and a partial run resumes cleanly.
 *
 * This is the prototype for the eventual production import: run it on the
 * test/dev db after each pull; it refuses a production-marked db without
 * --allow-production.
 */
import { Assertion, getAssertionPath, assertionPathToFields } from './assertion.ts';
import { CategoryTable, isInternalCategorySlug } from './category.ts';
import * as workspaceModule from './workspace.ts';
import { VersionedTuple, currentTuplesForVersionedRelation } from './workspace.ts';
import * as entrySchema from './entry-schema.ts';
import * as timestamp from '../liminal/timestamp.ts';
import * as orderkey from '../liminal/orderkey.ts';
import { db } from '../liminal/db.ts';
import type { WordWiki } from './wordwiki.ts';

// ---------------------------------------------------------------------------
// --- Inputs ------------------------------------------------------------------
// ---------------------------------------------------------------------------

export interface SchemeCategory {
    slug: string;
    name: string;
    theme: string;
    description: string;
}

/**
 * Parse the category scheme out of categorization/scheme.md (the same
 * grammar dictq.py uses, so the two can't drift): themes are `## ` headings,
 * categories are `- **Name** (`slug`) — criteria...` bullets whose criteria
 * text continues on indented lines until the next bullet/heading.
 */
export function parseSchemeMd(text: string): SchemeCategory[] {
    const catRe = /^- \*\*(.+?)\*\* \(`([a-z0-9-]+)`\)(?:\s*[—-]?\s*)(.*)$/;
    const out: SchemeCategory[] = [];
    let theme = '';
    let current: SchemeCategory|undefined;
    for(const line of text.split('\n')) {
        if(line.startsWith('## ')) {
            theme = line.slice(3).trim();
            current = undefined;
            continue;
        }
        const m = catRe.exec(line);
        if(m) {
            current = {name: m[1], slug: m[2], theme, description: m[3].trim()};
            out.push(current);
            continue;
        }
        // Continuation lines of a category bullet (indented, non-bullet).
        if(current && /^\s+\S/.test(line) && !line.trimStart().startsWith('- '))
            current.description = (current.description + ' ' + line.trim()).trim();
        else if(!m && line.trim() === '')
            current = undefined;
    }
    return out;
}

/**
 * The stable internal slug for an OLD free-text category value.  Slugified
 * (so 'special day' -> '~old-special-day'); near-duplicate old names that
 * slugify identically ('Water'/'water', "'appearance '"/'appearance')
 * deliberately merge.  Pure-symbol names ('_', '-') get a code-point slug
 * so they stay distinct and deterministic.
 */
export function oldCategorySlug(oldName: string): string {
    const base = oldName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if(base) return `~old-${base}`;
    const hex = [...oldName].map(c => c.codePointAt(0)!.toString(16)).join('-');
    return `~old-sym-${hex}`;
}

// One line of categorization/assignments.jsonl (append-only; later lines win).
export interface AssignmentRecord {
    e: number;
    cats: string[];
    conf?: string;
    tier?: 't10'|'t100'|'t1000';
    flag?: string;
    note?: string;
}

export function loadAssignments(jsonlText: string): Map<number, AssignmentRecord> {
    const out = new Map<number, AssignmentRecord>();
    for(const line of jsonlText.split('\n')) {
        if(!line.trim()) continue;
        const a = JSON.parse(line) as AssignmentRecord;
        out.set(a.e, a);   // later lines win
    }
    return out;
}

const TIER_SLUGS: Record<string, string> = {
    t10: '~tier-top-10', t100: '~tier-top-100', t1000: '~tier-top-1000'};

export const INTERNAL_CATEGORIES = [
    {slug: '~needs-human', name: 'Needs human attention',
     description: 'Entries that could not be categorized (placeholders, no English, ' +
                  'editor notes): each needs an editor decision.'},
    {slug: '~tier-top-10', name: 'Learner tier: top 10',
     description: 'The very first words to learn. Tiers are cumulative: a top-10 ' +
                  'word is conceptually also in the top-100 and top-1000; only the ' +
                  'most specific tier is tagged on an entry.'},
    {slug: '~tier-top-100', name: 'Learner tier: top 100',
     description: 'The first hundred words to learn (the 90 beyond the top 10).'},
    {slug: '~tier-top-1000', name: 'Learner tier: top 1000',
     description: 'The first thousand words to learn (the 900 beyond the top 100).'},
];

// ---------------------------------------------------------------------------
// --- Step 1: seed the category table -----------------------------------------
// ---------------------------------------------------------------------------

export interface SeedStats { seededNew: number; seededInternal: number;
                             seededOld: number; skipped: number; }

// Distinct old free-text category values still present in CURRENT assertions
// (values that are already '~'-internal or already a seeded slug are not
// "old" - this is what makes a re-run find nothing left to do).
export function currentOldCategoryNames(categories: CategoryTable): string[] {
    const values = db().all<{v: string}, {end: number}>(
        `SELECT DISTINCT attr1 AS v FROM dict
                WHERE ty = '${entrySchema.CategoryTag}' AND valid_to = :end
                  AND attr1 IS NOT NULL AND attr1 != ''`,
        {end: timestamp.END_OF_TIME});
    return values.map(r => r.v)
        .filter(v => !isInternalCategorySlug(v))
        .filter(v => !categories.bySlug.first({slug: v}))
        .sort();
}

export function seedCategoryTable(categories: CategoryTable, scheme: SchemeCategory[],
                                  oldNames: string[]): SeedStats {
    const stats: SeedStats = {seededNew: 0, seededInternal: 0, seededOld: 0, skipped: 0};
    const insertIfAbsent = (c: {slug: string, name: string, theme?: string,
                                description?: string, retired?: 0|1},
                            counter: keyof SeedStats) => {
        if(categories.bySlug.first({slug: c.slug})) { stats.skipped++; return; }
        categories.insert({retired: 0, ...c});
        (stats[counter] as number)++;
    };
    // New vocabulary first (scheme order = presentation order)...
    for(const c of scheme)
        insertIfAbsent({slug: c.slug, name: c.name, theme: c.theme,
                        description: c.description}, 'seededNew');
    // ...then the internal workflow/set categories...
    for(const c of INTERNAL_CATEGORIES)
        insertIfAbsent({...c, theme: 'Internal'}, 'seededInternal');
    // ...then the old free-text categories, retired (not offered in pickers).
    for(const name of oldNames)
        insertIfAbsent({slug: oldCategorySlug(name), name: `${name} (old)`,
                        theme: 'Old categories', retired: 1,
                        description: `Imported from the old free-text category '${name}'.`},
                       'seededOld');
    return stats;
}

// ---------------------------------------------------------------------------
// --- Step 2: rewrite the entries' category tuples -----------------------------
// ---------------------------------------------------------------------------

/**
 * The desired ordered category values for one entry, as a pure function of
 * its assignment (if any) and its CURRENT values - so running it on already-
 * imported data returns the current values unchanged (the fixed point that
 * makes the import re-runnable):
 *   - assigned entries: new cats (primary first) + tier tag + ~needs-human;
 *   - '~'-internal current values are preserved (in current order);
 *   - plain current values that aren't part of the assignment are old
 *     free-text categories -> preserved as '~old-*'.
 */
export function computeDesiredCats(assignment: AssignmentRecord|undefined,
                                   currentValues: string[]): string[] {
    const head: string[] = [];
    if(assignment) {
        head.push(...assignment.cats);
        if(assignment.tier) head.push(TIER_SLUGS[assignment.tier]);
        if(assignment.flag === 'needs-human') head.push('~needs-human');
    }
    const tail = currentValues
        .filter(v => v !== '')
        .map(v => isInternalCategorySlug(v) ? v
                : assignment?.cats.includes(v) ? ''     // re-run artifact: regenerated in head
                : oldCategorySlug(v))
        .filter(v => v !== '');
    const seen = new Set<string>();
    return [...head, ...tail].filter(v => !seen.has(v) && (seen.add(v), true));
}

export interface RewriteStats {
    entriesScanned: number;
    entriesRewritten: number;
    entriesUnchanged: number;
    tuplesTombstoned: number;
    tuplesInserted: number;
    assignmentsWithoutEntry: number;
}

function newId(): number {
    return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

export function rewriteEntryCategories(
        ww: WordWiki, assignments: Map<number, AssignmentRecord>,
        opts: {username: string, batchSize?: number, log?: (msg: string) => void}): RewriteStats {

    const batchSize = opts.batchSize ?? 250;
    const log = opts.log ?? (() => undefined);
    const stats: RewriteStats = {entriesScanned: 0, entriesRewritten: 0, entriesUnchanged: 0,
                                 tuplesTombstoned: 0, tuplesInserted: 0,
                                 assignmentsWithoutEntry: 0};

    const dict = ww.workspace.getTableByTag(entrySchema.DictTag);
    const entries = dict.childRelations[entrySchema.EntryTag]?.tuples
        ?? new Map<number, VersionedTuple>();

    // Assertions accumulate in `batch` (for log cadence) but are APPLIED one
    // per transaction: the workspace requires strictly increasing timestamps
    // per assertion, so a multi-assertion tx (one shared valid_from) is not
    // currently applicable.  Each apply allocates its own server timestamp;
    // the placeholder time below is rewritten there (tombstones carry it as
    // valid_to too, marking them as deletions).
    const batchTime = timestamp.nextTime(timestamp.BEGINNING_OF_TIME);
    let batch: Assertion[] = [];
    const flush = () => {
        for(const a of batch)
            ww.applyTransaction([a], {quiet: true});
        batch = [];
    };

    for(const [entry_id, entryTuple] of entries) {
        if(!entryTuple.currentAssertion) continue;       // deleted entry
        stats.entriesScanned++;

        // Category tuples hang off SUBENTRIES (dct/ent/sub/cat).  The
        // assignment is per-entry: its categories go on the FIRST current
        // subentry (the primary one); preserved values stay on their own
        // subentry.  An assignment whose entry has no live subentry to carry
        // the categories is counted, not applied.
        const subRel = entryTuple.childRelations[entrySchema.SubentryTag];
        const subentries = subRel ? currentTuplesForVersionedRelation(subRel) : [];
        const assignment = assignments.get(entry_id);
        if(assignment && subentries.length === 0)
            stats.assignmentsWithoutEntry++;

        let entryChanged = false;
        subentries.forEach((sub, subIndex) => {
            const subAssertion = sub.mostRecentTupleVersion!.assertion;
            const catRel = sub.src.childRelations[entrySchema.CategoryTag];
            const current = catRel ? currentTuplesForVersionedRelation(catRel) : [];
            const currentValues = current.map(t =>
                (t.mostRecentTupleVersion!.assertion as any).attr1 as string ?? '');

            const desired = computeDesiredCats(
                subIndex === 0 ? assignment : undefined, currentValues);
            //  -joined comparison: category values can contain spaces
            // (old free-text names), never  .
            if(desired.join(' ') === currentValues.join(' '))
                return;
            entryChanged = true;

            // Replace wholesale: tombstone every current tuple, insert the
            // desired values in order with a fresh order-key spread.
            // (Category tuples are atomic strings; the entry history
            // retains every prior version.)
            for(const t of current) {
                const cur = t.mostRecentTupleVersion!.assertion;
                batch.push({
                    ...cur,
                    assertion_id: newId(),
                    replaces_assertion_id: cur.assertion_id,
                    valid_from: batchTime,
                    valid_to: batchTime,
                    change_by_username: opts.username,
                });
                stats.tuplesTombstoned++;
            }
            const keys = orderkey.initial(desired.length);
            desired.forEach((value, i) => {
                const id = newId();
                batch.push({
                    ...assertionPathToFields([...getAssertionPath(subAssertion),
                                              [entrySchema.CategoryTag, id]]),
                    ty: entrySchema.CategoryTag,
                    id,
                    assertion_id: id,
                    valid_from: batchTime,
                    valid_to: timestamp.END_OF_TIME,
                    attr1: value,
                    order_key: keys[i],
                    change_by_username: opts.username,
                } as Assertion);
                stats.tuplesInserted++;
            });
        });

        if(entryChanged) stats.entriesRewritten++;
        else stats.entriesUnchanged++;

        if(batch.length >= batchSize) {
            flush();
            log(`...${stats.entriesScanned} entries scanned, ${stats.entriesRewritten} rewritten`);
        }
    }
    flush();

    // Assignments whose entry is gone entirely (deleted or never existed).
    for(const id of assignments.keys())
        if(!entries.has(id) || !entries.get(id)!.currentAssertion)
            stats.assignmentsWithoutEntry++;
    return stats;
}

// ---------------------------------------------------------------------------
// --- The whole import ----------------------------------------------------------
// ---------------------------------------------------------------------------

export interface ImportStats { seed: SeedStats; rewrite: RewriteStats; }

export function importCategories(
        ww: WordWiki,
        opts: {schemeText: string, assignmentsText: string, username: string,
               batchSize?: number, log?: (msg: string) => void}): ImportStats {
    const log = opts.log ?? (() => undefined);

    const scheme = parseSchemeMd(opts.schemeText);
    if(scheme.length === 0)
        throw new Error('parsed 0 categories from scheme.md - wrong file?');
    const assignments = loadAssignments(opts.assignmentsText);

    const oldNames = currentOldCategoryNames(ww.categories);
    const seed = seedCategoryTable(ww.categories, scheme, oldNames);
    log(`seeded categories: ${seed.seededNew} new, ${seed.seededInternal} internal, ` +
        `${seed.seededOld} old (~old-*), ${seed.skipped} already present`);

    const rewrite = rewriteEntryCategories(ww, assignments, opts);
    log(`entries: ${rewrite.entriesScanned} scanned, ${rewrite.entriesRewritten} rewritten, ` +
        `${rewrite.entriesUnchanged} already up to date; ` +
        `${rewrite.tuplesTombstoned} category tuples retired, ${rewrite.tuplesInserted} written; ` +
        `${rewrite.assignmentsWithoutEntry} assignments had no matching entry`);
    return {seed, rewrite};
}
