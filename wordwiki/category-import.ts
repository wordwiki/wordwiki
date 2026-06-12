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
import { muteAttr1Values, AttrMuteStats } from './assertion-mute.ts';

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

export const TIER_SLUGS: Record<string, string> = {
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

// Distinct category values across ALL assertion history (not just current
// rows): the mute must rename every value that has EVER been used, so that
// every historical version of every fact carries a live identifier and is
// safely restorable.
export function allCategoryValuesEver(): string[] {
    const values = db().all<{v: string}, {}>(
        `SELECT DISTINCT attr1 AS v FROM dict
                WHERE ty = '${entrySchema.CategoryTag}'
                  AND attr1 IS NOT NULL AND attr1 != ''`, {});
    return values.map(r => r.v).sort();
}

/**
 * The legacy-value plan: which historical values rename to which '~old-*'
 * slug.  Values already '~'-internal are ours; values that EQUAL a tabled
 * slug are the merge case - the old free-text value is being ADOPTED as the
 * new-scheme category, so the fact's identity simply continues (no rename).
 * Everything else renames in place.  One plan drives both the ~old-* row
 * seeding and the mute mapping, so they cannot disagree; case/whitespace
 * variants collapse onto one slug (the row's description records them all).
 */
export interface LegacyValuePlan {
    bySlug: Map<string, string[]>;     // '~old-*' slug -> legacy value variants
    mapping: Map<string, string>;      // legacy value -> '~old-*' slug
}
export function planLegacyValues(values: string[], categories: CategoryTable,
                                 schemeSlugs: Set<string>): LegacyValuePlan {
    const plan: LegacyValuePlan = {bySlug: new Map(), mapping: new Map()};
    for(const v of values) {
        if(isInternalCategorySlug(v)) continue;            // already in our namespace
        if(schemeSlugs.has(v)) continue;                   // merge: adopted as-is
        if(categories.bySlug.first({slug: v})) continue;   // already tabled (prior run)
        const slug = oldCategorySlug(v);
        plan.mapping.set(v, slug);
        plan.bySlug.set(slug, [...(plan.bySlug.get(slug) ?? []), v]);
    }
    return plan;
}

export function seedCategoryTable(categories: CategoryTable, scheme: SchemeCategory[],
                                  legacy: LegacyValuePlan): SeedStats {
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
    // The row is the durable record of the in-place rename: the display name
    // keeps the original surface form, the description lists every variant
    // that collapsed onto this slug (the assertion rows themselves now carry
    // only the slug - see planLegacyValues / the mute step).
    for(const [slug, variants] of legacy.bySlug)
        insertIfAbsent({slug, name: `${variants[0]} (old)`,
                        theme: 'Old categories', retired: 1,
                        description: `Old free-text category value` +
                            `${variants.length > 1 ? 's' : ''} ` +
                            variants.map(v => `'${v}'`).join(', ') +
                            `, renamed in place by the category migration ` +
                            `(fact identity and history preserved).`},
                       'seededOld');
    return stats;
}

// ---------------------------------------------------------------------------
// --- Step 2: rewrite the entries' category tuples -----------------------------
// ---------------------------------------------------------------------------

/**
 * The categories to ADD to a subentry, as a pure function of its assignment
 * and its CURRENT (post-mute) values.  Preservation needs no work here any
 * more - the mute renamed the legacy values in place, identity intact - so
 * the rewrite phase only adds what is missing (and tombstones duplicates).
 * Fixed point: on already-imported data every desired value is present and
 * this returns [] (what makes --expect-no-changes provable).
 */
export function computeCategoryAdditions(assignment: AssignmentRecord|undefined,
                                         currentValues: string[]): string[] {
    if(!assignment) return [];
    const desired: string[] = [...assignment.cats];
    if(assignment.tier) desired.push(TIER_SLUGS[assignment.tier]);
    if(assignment.flag === 'needs-human') desired.push('~needs-human');
    const present = new Set(currentValues);
    const seen = new Set<string>();
    return desired.filter(v => !present.has(v) && !seen.has(v) && (seen.add(v), true));
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

            // Duplicates (case/whitespace variants collapsed by the mute):
            // keep the first, tombstone the rest - a genuine recorded delete.
            const seen = new Set<string>();
            for(const t of current) {
                const cur = t.mostRecentTupleVersion!.assertion;
                const v = (cur as any).attr1 as string ?? '';
                if(!seen.has(v)) { seen.add(v); continue; }
                batch.push({
                    ...cur,
                    assertion_id: newId(),
                    replaces_assertion_id: cur.assertion_id,
                    valid_from: batchTime,
                    valid_to: batchTime,
                    change_by_username: opts.username,
                });
                stats.tuplesTombstoned++;
                entryChanged = true;
            }

            // Additions (assignment cats + tier + ~needs-human on the FIRST
            // subentry), inserted BEFORE the existing values so the new
            // vocabulary leads and the preserved '~old-*' values trail.
            const additions = computeCategoryAdditions(
                subIndex === 0 ? assignment : undefined, currentValues);
            if(additions.length === 0) return;
            entryChanged = true;

            const minExisting = current.length > 0
                ? (current[0].mostRecentTupleVersion!.assertion as any).order_key as string
                : undefined;
            let prev: string|undefined = undefined;
            for(const value of additions) {
                const key: string = orderkey.between(prev ?? orderkey.begin_string,
                                                     minExisting ?? orderkey.end_string);
                prev = key;
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
                    order_key: key,
                    change_by_username: opts.username,
                } as Assertion);
                stats.tuplesInserted++;
            }
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

export interface ImportStats { seed: SeedStats; mute: AttrMuteStats; rewrite: RewriteStats; }

export function importCategories(
        ww: WordWiki,
        opts: {schemeText: string, assignmentsText: string, username: string,
               batchSize?: number, log?: (msg: string) => void}): ImportStats {
    const log = opts.log ?? (() => undefined);

    const scheme = parseSchemeMd(opts.schemeText);
    if(scheme.length === 0)
        throw new Error('parsed 0 categories from scheme.md - wrong file?');
    const assignments = loadAssignments(opts.assignmentsText);

    // Plan the legacy renames over ALL history (merge-case values - those
    // equal to a scheme slug - are adopted, not renamed), seed the whole
    // vocabulary (the ~old-* rows are the durable record of the renames)...
    const legacy = planLegacyValues(allCategoryValuesEver(), ww.categories,
                                    new Set(scheme.map(c => c.slug)));
    const seed = seedCategoryTable(ww.categories, scheme, legacy);
    log(`seeded categories: ${seed.seededNew} new, ${seed.seededInternal} internal, ` +
        `${seed.seededOld} old (~old-*), ${seed.skipped} already present`);

    // ...then RENAME the legacy values in place (assertion-mute.ts): all
    // history rows, one transaction, completeness-verified.  Fact identity
    // and history survive; every historical version stays restorable.
    const mute = muteAttr1Values(ww, {ty: entrySchema.CategoryTag, mapping: legacy.mapping},
                                 {log});
    log(`muted legacy values: ${mute.valuesRenamed} distinct values, ` +
        `${mute.rowsUpdated} assertion rows (history included)`);

    const rewrite = rewriteEntryCategories(ww, assignments, opts);
    log(`entries: ${rewrite.entriesScanned} scanned, ${rewrite.entriesRewritten} rewritten, ` +
        `${rewrite.entriesUnchanged} already up to date; ` +
        `${rewrite.tuplesTombstoned} category tuples retired, ${rewrite.tuplesInserted} written; ` +
        `${rewrite.assignmentsWithoutEntry} assignments had no matching entry`);
    return {seed, mute, rewrite};
}
