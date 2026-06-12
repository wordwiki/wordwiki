// deno-lint-ignore-file no-explicit-any
/**
 * Post-migration verification - the sanity checks run after the category +
 * lexical-form imports (and rerunnable any time; everything here is
 * READ-ONLY).  The point is the production cutover: once real user edits
 * land on top of the migrated data, a missed step stops being a re-pull
 * and becomes a major repair - so the recipe (migrateDevDb.sh) ends by
 * machine-checking everything we know must hold.
 *
 * FAILURES are violated invariants (exit nonzero); WARNINGS are findings a
 * human should look at but that don't invalidate the migration (e.g. the
 * un-tabled part-of-speech worklist).
 */
import { db } from '../liminal/db.ts';
import * as timestamp from '../liminal/timestamp.ts';
import { SLUG_PATTERN } from './category.ts';
import { LEXICAL_FORM_SLUG_PATTERN, SEED_LEXICAL_FORMS } from './lexical-form.ts';
import { parseSchemeMd } from './category-import.ts';
import { normalizePartOfSpeech } from './lexical-form-import.ts';
import { SYSTEM_USERS } from './user.ts';
import { TIER_SLUGS } from './category-import.ts';
import type { WordWiki } from './wordwiki.ts';

export interface VerifyReport {
    failures: string[];
    warnings: string[];
    info: string[];
}

export function verifyMigration(ww: WordWiki,
                                opts: {schemeText?: string} = {}): VerifyReport {
    const r: VerifyReport = {failures: [], warnings: [], info: []};
    const fail = (m: string) => r.failures.push(m);
    const warn = (m: string) => r.warnings.push(m);
    const info = (m: string) => r.info.push(m);
    const EOT = timestamp.END_OF_TIME;

    // --- 1. Users: the automation identities exist and can never log in ----
    for(const {username} of SYSTEM_USERS) {
        const u = ww.users.byUsername.first({username});
        if(!u) fail(`system user '${username}' missing (run upgrade-users / post-pull)`);
        else if(!u.disabled) fail(`system user '${username}' is not disabled - it must never log in`);
    }

    // --- 2. Assertion-store integrity: at most ONE current version per fact -
    const doubled = db().all<{ty: string, id: number, n: number}, {eot: number}>(
        `SELECT ty, id, COUNT(*) AS n FROM dict WHERE valid_to = :eot
         GROUP BY ty, id HAVING COUNT(*) > 1 LIMIT 5`, {eot: EOT});
    if(doubled.length > 0)
        fail(`facts with more than one CURRENT version: ` +
             doubled.map(d => `${d.ty}/${d.id} (${d.n})`).join(', '));

    // --- 3. Category table vs the scheme ------------------------------------
    const cats = ww.categories.allByOrder.all({});
    const catSlugs = new Set(cats.map(c => c.slug));
    for(const c of cats)
        if(!SLUG_PATTERN.test(c.slug))
            fail(`category slug '${c.slug}' violates the slug pattern`);
    if(opts.schemeText) {
        const scheme = parseSchemeMd(opts.schemeText);
        if(scheme.length === 0) fail('parsed 0 categories from scheme.md - wrong file?');
        const missing = scheme.filter(s => !catSlugs.has(s.slug));
        if(missing.length > 0)
            fail(`scheme categories missing from the category table: ` +
                 missing.slice(0, 5).map(s => s.slug).join(', ') +
                 (missing.length > 5 ? ` (+${missing.length - 5} more)` : ''));
        info(`scheme: ${scheme.length} categories, all present in the table`);
    } else {
        warn('no scheme.md supplied - skipped the exact scheme-vs-table check');
    }
    info(`category table: ${cats.length} rows ` +
         `(${cats.filter(c => !c.slug.startsWith('~')).length} public, ` +
         `${cats.filter(c => c.slug.startsWith('~old-')).length} ~old-*, ` +
         `${cats.filter(c => c.retired).length} retired)`);

    // --- 4. Every CURRENT category value is in the category table -----------
    const unknownCats = db().all<{attr1: string, n: number}, {eot: number}>(
        `SELECT attr1, COUNT(*) AS n FROM dict WHERE ty = 'cat' AND valid_to = :eot
         GROUP BY attr1`, {eot: EOT}).filter(row => !catSlugs.has(row.attr1));
    if(unknownCats.length > 0)
        fail(`current category values not in the category table: ` +
             unknownCats.slice(0, 5).map(u => `'${u.attr1}' (x${u.n})`).join(', ') +
             (unknownCats.length > 5 ? ` (+${unknownCats.length - 5} more)` : ''));

    // --- 5. No orphans: every current cat tuple sits under a current subentry
    const orphans = db().required<{n: number}, {eot: number}>(
        `SELECT COUNT(*) AS n FROM dict c WHERE c.ty = 'cat' AND c.valid_to = :eot
         AND NOT EXISTS (SELECT 1 FROM dict s WHERE s.ty = 'sub'
                         AND s.id2 = c.id2 AND s.valid_to = :eot)`, {eot: EOT});
    if(orphans.n > 0)
        fail(`${orphans.n} current category tuples hang under non-current subentries`);

    // --- 6. Learner tiers are exactly the curated sizes ---------------------
    const tierExpected: Record<string, number> = {
        [TIER_SLUGS.t10]: 10, [TIER_SLUGS.t100]: 90, [TIER_SLUGS.t1000]: 900};
    const tierCounts = new Map(db().all<{attr1: string, n: number}, {eot: number}>(
        `SELECT attr1, COUNT(DISTINCT id1) AS n FROM dict
         WHERE ty = 'cat' AND valid_to = :eot AND attr1 LIKE '~tier-%'
         GROUP BY attr1`, {eot: EOT}).map(row => [row.attr1, row.n]));
    for(const [slug, expected] of Object.entries(tierExpected)) {
        const got = tierCounts.get(slug) ?? 0;
        if(got !== expected)
            fail(`tier ${slug}: expected exactly ${expected} entries, found ${got}`);
    }
    info(`tiers: ` + Object.keys(tierExpected).map(s => `${s}=${tierCounts.get(s) ?? 0}`).join(', '));

    // --- 7. Entries with no categories at all (likely created after the -----
    // ---    assignments dump - candidates for incremental tagging) ----------
    const uncategorized = db().required<{n: number}, {eot: number}>(
        `SELECT COUNT(*) AS n FROM dict e WHERE e.ty = 'ent' AND e.valid_to = :eot
         AND NOT EXISTS (SELECT 1 FROM dict c WHERE c.ty = 'cat'
                         AND c.id1 = e.id1 AND c.valid_to = :eot)`, {eot: EOT});
    if(uncategorized.n > 0)
        warn(`${uncategorized.n} current entries have NO categories - if this is the ` +
             `production run, these are probably entries created after the ` +
             `assignments dump and need tagging`);

    // --- 8. Lexical forms: seeds present, normalization at its fixed point --
    const forms = ww.lexicalForms.allByOrder.all({});
    const formSlugs = new Set(forms.map(f => f.slug));
    for(const f of forms)
        if(!LEXICAL_FORM_SLUG_PATTERN.test(f.slug))
            fail(`lexical form slug '${f.slug}' violates the slug pattern`);
    const missingForms = SEED_LEXICAL_FORMS.filter(f => !formSlugs.has(f.slug));
    if(missingForms.length > 0)
        fail(`seed lexical forms missing from the table: ` +
             missingForms.map(f => f.slug).join(', ') + ' (run import-lexical-forms)');
    const activeFormSlugs = new Set(ww.lexicalForms.activeByOrder.all({}).map(f => f.slug));
    const posValues = db().all<{attr1: string|null, n: number}, {eot: number}>(
        `SELECT attr1, COUNT(*) AS n FROM dict WHERE ty = 'sub' AND valid_to = :eot
         GROUP BY attr1`, {eot: EOT});
    const unnormalized = posValues.filter(
        row => normalizePartOfSpeech(row.attr1, activeFormSlugs) !== undefined);
    if(unnormalized.length > 0)
        fail(`part-of-speech values the import should have normalized: ` +
             unnormalized.map(u => `'${u.attr1}' (x${u.n})`).join(', '));
    const untabled = posValues.filter(
        row => row.attr1 != null && row.attr1 !== '' && !formSlugs.has(row.attr1));
    if(untabled.length > 0)
        warn(`${untabled.length} distinct un-tabled part-of-speech values ` +
             `(${untabled.reduce((a, u) => a + u.n, 0)} subentries) - the curation worklist; ` +
             `top: ` + untabled.sort((a, b) => b.n - a.n).slice(0, 5)
                 .map(u => `'${u.attr1}' (x${u.n})`).join(', '));
    const emptyPos = posValues.find(row => row.attr1 == null || row.attr1 === '');
    if(emptyPos) info(`${emptyPos.n} subentries have no part of speech`);

    // --- 9. The migration actually ran (automation-stamped assertions exist) -
    const stamped = db().all<{u: string, n: number}, {}>(
        `SELECT change_by_username AS u, COUNT(*) AS n FROM dict
         WHERE change_by_username LIKE '~%' GROUP BY 1`, {});
    if(stamped.length === 0)
        warn(`no automation-stamped assertions found - has the import run on this db?`);
    else
        info(`automation-stamped assertions: ` +
             stamped.map(s => `${s.u}=${s.n}`).join(', '));

    info(`db purpose: '${ww.config.getDbPurpose() ?? '(unset)'}'`);
    return r;
}
