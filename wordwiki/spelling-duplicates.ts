/**
 * Duplicate-spelling detection (dz 2026-07-06): warn - never block - when a
 * word's spelling collides with another word's.
 *
 * Uniqueness can't live in the db: the assertion table is generic, history
 * rides in the same table, and same-TEXT is not the real rule anyway - two
 * words may legitimately share a text across orthographies when a shared
 * orthography distinguishes them.  So this is advisory, computed on demand
 * straight from the dict table:
 *
 *  - CURRENT rows are exactly `valid_to = END_OF_TIME` (a deleted fact has
 *    no END_OF_TIME row), so history costs nothing to exclude.  Publication
 *    state is deliberately ignored: a PENDING spelling should warn during
 *    data entry, before the duplicate lexeme gets fully typed in.
 *  - The dict_attr1 index (assertion.ts) makes the by-text probe fast;
 *    spelling text is highly selective.
 *
 * THE RULE, per entry pair sharing a spelling text:
 *  - a collision in the SAME orthography always warns;
 *  - a cross-orthography-only collision warns UNLESS some orthography both
 *    words are written in distinguishes them (they have a shared orthography
 *    and don't collide there - "samqwan" in Listuguj vs "samqwan" in
 *    Smith-Francis is fine when their Listuguj spellings differ);
 *  - ARCHIVED words (any 'Archived*' status - isArchivedStatus) are out in
 *    both directions: archiving is our delete, and the way a duplicate gets
 *    resolved, so an archived twin is a settled case, not a warning.
 *
 * Consumers: the incremental warning atop the lexeme editor (the editor's
 * root fragment re-renders on every spelling mutation already - the headword
 * titleRole widens changeKeys to the entry root - so NO editor plumbing),
 * and the whole-dictionary duplicates report (wordwiki.spellings.
 * duplicatesReport()).  Matching is EXACT text for now; the report will show
 * whether case/apostrophe normalization is worth adding.
 */
import { db } from "../liminal/db.ts";
import { block, plural } from "../liminal/strings.ts";
import { Markup } from "../liminal/markup.ts";
import { route, authenticated } from "../liminal/security.ts";
import * as timestamp from '../liminal/timestamp.ts';
import * as templates from './templates.ts';
import * as entrySchema from './entry-schema.ts';
import { variantsOverlap } from './variant-policy.ts';

export interface Spelling { text: string; variant: string|null; }

/** One colliding text between two entries, with each side's orthography. */
export interface SpellingConflict { text: string; myVariant: string|null; otherVariant: string|null; }

/**
 * The pure pair rule.  Returns the collisions that WARRANT A WARNING between
 * two entries' current spelling sets ([] = no warning): same-orthography
 * collisions when any exist, else ALL cross-orthography collisions unless a
 * shared orthography distinguishes the pair.  (After the same-orthography
 * check, every shared orthography is collision-free there, so any shared
 * orthography at all distinguishes them.)
 */
export function conflictingSpellings(mine: Spelling[], theirs: Spelling[]): SpellingConflict[] {
    const collisions: SpellingConflict[] = [];
    for(const m of mine)
        for(const t of theirs)
            if(m.text !== '' && m.text === t.text)
                collisions.push({text: m.text, myVariant: m.variant, otherVariant: t.variant});
    if(collisions.length === 0) return [];
    // Orthography comparisons go through the CENTRAL predicate
    // (variant-policy.ts), not raw equality: 'mm' (and a legacy blank)
    // renders in every orthography, so 'mm' vs 'mm-li' is a SAME-orthography
    // collision, and a word carrying a wildcard spelling is "written in"
    // every orthography for the shared-orthography-distinguishes test.
    const sameOrtho = collisions.filter(c => variantsOverlap(c.myVariant, c.otherVariant));
    if(sameOrtho.length > 0) return sameOrtho;
    const distinguishable = mine.some(m => theirs.some(t => variantsOverlap(m.variant, t.variant)));
    return distinguishable ? [] : collisions;
}

// --- dict queries (current spelling rows only - see the module comment) ----

interface SpellingRow { id1: number; attr1: string; variant: string|null; }

const selectEntriesBySpellingText = () => db().prepare<SpellingRow, {text: string, entry_id: number}>(block`
/**/   SELECT id1, attr1, variant FROM dict
/**/   WHERE valid_to = ${timestamp.END_OF_TIME} AND ty = '${entrySchema.SpellingTag}'
/**/         AND attr1 = :text AND id1 <> :entry_id`);

const selectEntrySpellings = () => db().prepare<SpellingRow, {entry_id: number}>(block`
/**/   SELECT id1, attr1, variant FROM dict
/**/   WHERE valid_to = ${timestamp.END_OF_TIME} AND ty = '${entrySchema.SpellingTag}'
/**/         AND id1 = :entry_id AND attr1 IS NOT NULL`);

const selectAllCurrentSpellings = () => db().prepare<SpellingRow, Record<never, never>>(block`
/**/   SELECT id1, attr1, variant FROM dict
/**/   WHERE valid_to = ${timestamp.END_OF_TIME} AND ty = '${entrySchema.SpellingTag}'
/**/         AND attr1 IS NOT NULL
/**/   ORDER BY attr1`);

const selectEntryStatuses = () => db().prepare<{attr1: string}, {entry_id: number}>(block`
/**/   SELECT attr1 FROM dict
/**/   WHERE valid_to = ${timestamp.END_OF_TIME} AND ty = '${entrySchema.StatusTag}'
/**/         AND id1 = :entry_id AND attr1 IS NOT NULL`);

const selectAllCurrentStatuses = () => db().prepare<{id1: number, attr1: string}, Record<never, never>>(block`
/**/   SELECT id1, attr1 FROM dict
/**/   WHERE valid_to = ${timestamp.END_OF_TIME} AND ty = '${entrySchema.StatusTag}'
/**/         AND attr1 IS NOT NULL`);

// Archival is our delete - duplicates get RESOLVED by archiving one side -
// so archived words are out of duplicate detection in BOTH directions: a
// live word never lists an archived one, and an archived word's own page
// never warns.  (isArchivedStatus's prefix convention keeps this current as
// archived variants are added.)
const entryIsArchived = (entry_id: number): boolean =>
    selectEntryStatuses().all({entry_id})
        .some(r => entrySchema.isArchivedStatus(r.attr1));

const asSpelling = (r: SpellingRow): Spelling => ({text: r.attr1, variant: r.variant});

/** Another entry this one conflicts with: its id, its full current spelling
 *  set (for the headword display), and the offending collisions. */
export interface DuplicateHit { entry_id: number; spellings: Spelling[]; conflicts: SpellingConflict[]; }

/** The incremental probe: all OTHER entries the given (in-editor, possibly
 *  unsaved-to-published but always saved-to-db) spelling set conflicts with.
 *  One indexed by-text query per distinct text, then the pair rule. */
export function findDuplicateEntries(entry_id: number, mine: Spelling[]): DuplicateHit[] {
    if(entryIsArchived(entry_id)) return [];
    const texts = [...new Set(mine.map(s => s.text).filter(t => t !== ''))];
    const candidates = new Set<number>();
    for(const text of texts)
        for(const row of selectEntriesBySpellingText().all({text, entry_id}))
            candidates.add(row.id1);
    const hits: DuplicateHit[] = [];
    for(const id of candidates) {
        if(entryIsArchived(id)) continue;
        const spellings = selectEntrySpellings().all({entry_id: id}).map(asSpelling);
        const conflicts = conflictingSpellings(mine, spellings);
        if(conflicts.length > 0)
            hits.push({entry_id: id, spellings, conflicts});
    }
    return hits.sort((a, b) => a.entry_id - b.entry_id);
}

const variantName = (v: string|null): string =>
    (v != null && entrySchema.variants[v]) || v || 'no orthography';

const headword = (spellings: Spelling[]): string =>
    spellings.map(s => s.text).join(' / ') || '(no spellings)';

/**
 * The editor's warning block (rendered by renderMetaEntry INSIDE the entry
 * root fragment, so every spelling mutation - whose changeKeys include the
 * entry root via the headword titleRole - recomputes it for free).  [] when
 * there is nothing to say.  Advisory only: nothing is ever blocked.
 */
export function renderDuplicateSpellingWarning(entry_id: number, mine: Spelling[]): Markup {
    const hits = findDuplicateEntries(entry_id, mine);
    if(hits.length === 0) return [];
    return ['div', {class: 'alert alert-warning lm-dup-spelling py-2 mb-3'},
            ['div', {class: 'fw-bold'}, '⚠ Possible duplicate word'],
            hits.map(h => ['div', {class: 'small'},
                h.conflicts.map((c, i) => [
                    i > 0 ? '; ' : '',
                    ['b', {}, c.text], ` (${variantName(c.myVariant)})`,
                    ' is also spelled on ',
                    ['a', {...templates.pageLinkProps(`/ww/wordwiki.entry(${h.entry_id})`),
                           class: 'lm-nav-link'}, headword(h.spellings)],
                    ` (${variantName(c.otherVariant)})`]),
            ])];
}

// --- The whole-dictionary duplicates report ---------------------------------

/** Entries that conflict with each other on `text` (pair rule applied). */
export interface DuplicateGroup { text: string; entries: {entry_id: number; spellings: Spelling[]}[]; }

/** One indexed scan of all current spelling rows, grouped by text; a text's
 *  group survives only where the pair rule warns FOR THAT TEXT (so a pair
 *  distinguished by a shared orthography stays out). */
export function findAllDuplicateGroups(): DuplicateGroup[] {
    // Archived words are out entirely (see entryIsArchived); a group only
    // survives where at least two LIVE words still collide.
    const archived = new Set(selectAllCurrentStatuses().all({})
        .filter(r => entrySchema.isArchivedStatus(r.attr1)).map(r => r.id1));
    const byEntry = new Map<number, Spelling[]>();
    const byText = new Map<string, Set<number>>();
    for(const r of selectAllCurrentSpellings().all({})) {
        if(r.attr1 === '' || archived.has(r.id1)) continue;
        let e = byEntry.get(r.id1);
        if(!e) byEntry.set(r.id1, e = []);
        e.push(asSpelling(r));
        let t = byText.get(r.attr1);
        if(!t) byText.set(r.attr1, t = new Set());
        t.add(r.id1);
    }
    const groups: DuplicateGroup[] = [];
    for(const [text, ids] of byText) {
        if(ids.size < 2) continue;
        const list = [...ids];
        const conflicted = new Set<number>();
        for(let i = 0; i < list.length; i++)
            for(let j = i + 1; j < list.length; j++)
                if(conflictingSpellings(byEntry.get(list[i])!, byEntry.get(list[j])!)
                   .some(c => c.text === text)) {
                    conflicted.add(list[i]);
                    conflicted.add(list[j]);
                }
        if(conflicted.size >= 2)
            groups.push({text, entries: [...conflicted].sort((a, b) => a - b)
                         .map(id => ({entry_id: id, spellings: byEntry.get(id)!}))});
    }
    return groups.sort((a, b) => a.text.localeCompare(b.text));
}

/** The report routes, namespaced as wordwiki.spellings.* */
export class SpellingReports {

    /** All words with duplicate spellings: a dense data table (the
     *  volunteers-page model), one section row per colliding text, the
     *  conflicting words as navigable rows beneath it. */
    @route(authenticated)
    duplicatesReport(): any {
        const groups = findAllDuplicateGroups();
        const title = 'Words with duplicate spellings';
        const n = groups.length;
        const body: Markup = [
            ['h1', {}, title],
            ['p', {class: 'text-muted small mb-2'},
             n === 0 ? 'No duplicate spellings found.'
                     : `${n} ${plural(n, 'spelling')} shared by more than one word ` +
                       '(pairs distinguished by a shared orthography are not shown).'],
            n === 0 ? undefined :
            ['table', {class: 'lm-data-table'},
             ['thead', {},
              ['tr', {}, ['th', {}, 'Word'], ['th', {}, 'Spellings']]],
             ['tbody', {},
              groups.map(g => [
                  ['tr', {class: 'lm-data-section'},
                   ['td', {colspan: '2'}, g.text]],
                  g.entries.map(e => this.renderEntryRow(e))])]]];
        return templates.pageTemplate({title, body});
    }

    // A navigable row per conflicting word: the headword drills into the
    // editor; the second column spells out every orthography so the
    // legitimate-coincidence cases can be judged at a glance.
    private renderEntryRow(e: {entry_id: number; spellings: Spelling[]}): Markup {
        return ['tr', {class: 'lm-navigable', onclick: 'lmNavigableClick(event)'},
                ['td', {},
                 ['a', {...templates.pageLinkProps(`/ww/wordwiki.entry(${e.entry_id})`),
                        class: 'lm-nav-link'}, headword(e.spellings)]],
                ['td', {class: 'text-muted'},
                 e.spellings.map((s, i) => [
                     i > 0 ? ' · ' : '',
                     s.text, ' ', ['span', {class: 'small'}, `(${variantName(s.variant)})`]])]];
    }
}
