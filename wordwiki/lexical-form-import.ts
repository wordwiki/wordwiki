// deno-lint-ignore-file no-explicit-any
/**
 * Lexical form import - the repeatable process that moves the dictionary
 * onto the controlled part-of-speech vocabulary (lexical-form.ts), the
 * sibling of category-import.ts.  Run by `./wordwiki.sh import-lexical-forms`.
 *
 * Unlike categories there is no curated re-assignment file: the dominant
 * codes in the data (vai, vat, ni, na, vit, vii, PTCL, ...) already ARE the
 * vocabulary.  So the import is:
 *
 * 1. SEED the lexical form table (seedLexicalForms - idempotent).
 * 2. NORMALIZE the subentry part_of_speech values where - and only where -
 *    the mapping is unambiguous:
 *      - whitespace damage that trims to an active slug ('vii ' -> 'vii');
 *      - case variants of an active slug ('ptcl' -> 'PTCL');
 *      - the explicit alias map below ('particle' -> 'PTCL').
 *    Rewrites go through applyTransaction: stamped, versioned, undoable.
 * 3. REPORT every remaining value that is not in the table (and the count
 *    of subentries with no part of speech at all) - the team's curation
 *    worklist.  Values like 'ni  mass', 'na·dk' or 'Wp ini' carry
 *    information a machine should not discard, so they are deliberately
 *    left for humans (the editor keeps them as marked select options).
 *
 * Idempotent: normalization is a fixed point, seeding skips existing slugs.
 */
import { Assertion } from './assertion.ts';
import { LexicalFormTable, seedLexicalForms } from './lexical-form.ts';
import { VersionedTuple } from './workspace.ts';
import * as entrySchema from './entry-schema.ts';
import * as timestamp from '../liminal/timestamp.ts';
import type { WordWiki } from './wordwiki.ts';

// Unambiguous renames ONLY.  A wrong entry here silently rewrites data, so
// the bar is: the old value plainly MEANS the slug, with no information lost.
export const PART_OF_SPEECH_ALIASES: Record<string, string> = {
    'particle': 'PTCL',
};

/**
 * The normalized value for a part_of_speech, or undefined when there is no
 * unambiguous normalization (including "already fine").  Pure, and a fixed
 * point: normalize(normalize(v)) is undefined.
 */
export function normalizePartOfSpeech(value: string|null|undefined,
                                      activeSlugs: Set<string>): string|undefined {
    if(value == null || value === '') return undefined;
    if(activeSlugs.has(value)) return undefined;             // already canonical

    const collapsed = value.trim().replace(/\s+/g, ' ');
    if(activeSlugs.has(collapsed)) return collapsed;          // whitespace damage

    const lower = collapsed.toLowerCase();
    for(const slug of activeSlugs)                            // case variant
        if(slug.toLowerCase() === lower) return slug;

    const alias = PART_OF_SPEECH_ALIASES[collapsed] ?? PART_OF_SPEECH_ALIASES[lower];
    if(alias !== undefined && activeSlugs.has(alias)) return alias;

    return undefined;                                          // a human's job
}

export interface LexicalFormImportStats {
    seeded: {inserted: number, skipped: number};
    subentriesScanned: number;
    subentriesNormalized: number;
    subentriesEmpty: number;
    // value -> count of subentries still carrying a value with no table row
    // (the curation worklist).
    remainingUntabled: Map<string, number>;
}

function newId(): number {
    return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

export function importLexicalForms(
        ww: WordWiki,
        opts: {username: string, log?: (msg: string) => void}): LexicalFormImportStats {
    const log = opts.log ?? (() => undefined);

    const seeded = seedLexicalForms(ww.lexicalForms);
    log(`lexical forms seeded: ${seeded.inserted} inserted, ${seeded.skipped} already present`);

    const activeSlugs = new Set<string>(
        ww.lexicalForms.activeByOrder.all({}).map(f => f.slug));

    const stats: LexicalFormImportStats = {
        seeded, subentriesScanned: 0, subentriesNormalized: 0, subentriesEmpty: 0,
        remainingUntabled: new Map()};

    const dict = ww.workspace.getTableByTag(entrySchema.DictTag);
    const entries = dict.childRelations[entrySchema.EntryTag]?.tuples
        ?? new Map<number, VersionedTuple>();
    const placeholder = timestamp.nextTime(timestamp.BEGINNING_OF_TIME);

    for(const [_entry_id, entryTuple] of entries) {
        if(!entryTuple.currentAssertion) continue;             // deleted entry
        const subRel = entryTuple.childRelations[entrySchema.SubentryTag];
        if(!subRel) continue;
        for(const subTuple of subRel.tuples.values()) {
            const cur = subTuple.currentAssertion;
            if(!cur) continue;                                  // deleted subentry
            stats.subentriesScanned++;
            const value = (cur as any).attr1 as string|null;

            if(value == null || value === '') {
                stats.subentriesEmpty++;
                continue;
            }
            const normalized = normalizePartOfSpeech(value, activeSlugs);
            if(normalized !== undefined) {
                const edit: Assertion = {
                    ...cur,
                    assertion_id: newId(),
                    replaces_assertion_id: cur.assertion_id,
                    valid_from: placeholder,
                    valid_to: timestamp.END_OF_TIME,
                    attr1: normalized,
                    change_by_username: opts.username,
                };
                ww.applyTransaction([edit], {quiet: true});
                stats.subentriesNormalized++;
            } else if(!activeSlugs.has(value)) {
                stats.remainingUntabled.set(value,
                    (stats.remainingUntabled.get(value) ?? 0) + 1);
            }
        }
    }

    log(`subentries: ${stats.subentriesScanned} scanned, ` +
        `${stats.subentriesNormalized} normalized, ` +
        `${stats.subentriesEmpty} with no part of speech`);
    if(stats.remainingUntabled.size > 0) {
        log(`${stats.remainingUntabled.size} legacy values remain un-tabled ` +
            `(the curation worklist - each needs a human decision):`);
        for(const [value, count] of
                Array.from(stats.remainingUntabled.entries()).toSorted((a, b) => b[1] - a[1]))
            log(`    ${JSON.stringify(value)} x${count}`);
    }
    return stats;
}
