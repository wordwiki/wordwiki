// deno-lint-ignore-file no-explicit-any
/**
 * Twitter-post import: backfill the `twitter-post` attribute from the RETIRED
 * legacy Shoebox dictionary (legacy-mmo.txt).
 *
 * A language-team member kept posting a word-a-day (twitter + bluesky) in the
 * old system for ~2 years after we retired it, stamping each posted lexeme's
 * `\tp` field.  Those posts never made it here, so the word-a-day picker
 * (wordADayPicker) keeps re-offering already-posted words.  This pass reads
 * the legacy dump and, for each lexeme it can match UNAMBIGUOUSLY to a current
 * entry that has NO twitter-post yet, adds one - stamped `~twitter-post-import`
 * (the automated-identity convention: kept out of the change feed / activity
 * report, and marks the provenance).
 *
 * The legacy file is SFM/Shoebox: backslash field markers, close tags inferred,
 * CRLF line endings, one lexeme per block (a blank line then `\lx SPELLING`).
 * The parse is deliberately narrow - we extract only (`\lx` Listuguj spelling,
 * first `\tp` value) per block; nothing else in the grammar matters here.
 *
 * MATCHING (measured on the real data, 2026-07): 4324 legacy lexemes carry a
 * `\tp`; 4296 match a current entry by Listuguj spelling exactly, of which
 * ~3764 already have a twitter-post (skipped) and ~532 are the real backfill.
 * The 28 leftovers are homonyms (one spelling, several distinct entries) or
 * spellings absent/garbled in the current data - all SKIPPED and logged by
 * spelling for a human to place; auto-guessing a homonym would be wrong.
 *
 * Idempotent: a matched entry that already has a twitter-post is never touched,
 * so a re-run adds nothing (the migration recipe's --expect-no-changes proof).
 * Runs BEFORE backfill-publication in migrateDevDb.sh, so the new attribute
 * rows get born-approved into the published dimension (the word-a-day picker
 * reads publishedEntries) - exactly like the category/lexical-form imports.
 */
import { Assertion, getAssertionPath, assertionPathToFields } from './assertion.ts';
import { VersionedTuple, CurrentTupleQuery, currentTuplesForVersionedRelation } from './workspace.ts';
import * as entrySchema from './entry-schema.ts';
import * as timestamp from '../liminal/timestamp.ts';
import * as orderkey from '../liminal/orderkey.ts';
import type { WordWiki } from './wordwiki.ts';

export const TWITTER_POST_ATTR = 'twitter-post';
export const TWITTER_POST_IMPORT_USER = '~twitter-post-import';

// The Listuguj spelling variants a legacy `\lx` matches (the default variant
// and the explicit Listuguj code; see entry-schema.ts variants).
const LISTUGUJ_VARIANTS = new Set(['', 'mm-li']);

// --- Parsing (pure) ---------------------------------------------------------

/** Parse the legacy SFM dump to a spelling -> twitter-post-value map.  One
 *  entry per lexeme block, keyed by the `\lx` Listuguj spelling; the FIRST
 *  `\tp` in the block wins (a handful carry several).  Blocks with an empty
 *  `\lx` or no `\tp` are skipped.  CRLF-tolerant.  A duplicate `\lx` spelling
 *  keeps its first block's value (matching is by spelling anyway).  Pure. */
export function parseLegacyTwitterPosts(text: string): Map<string, string> {
    const out = new Map<string, string>();
    let lx: string | undefined;
    let tp: string | undefined;
    const flush = () => {
        if(lx && tp && !out.has(lx)) out.set(lx, tp);
        lx = undefined; tp = undefined;
    };
    for(const rawLine of text.split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        if(line.startsWith('\\lx')) {          // a new block begins
            flush();
            lx = line.slice(3).trim();
        } else if(line.startsWith('\\tp') && tp === undefined) {
            const v = line.slice(3).trim();
            if(v !== '') tp = v;
        }
    }
    flush();
    return out;
}

// --- Import over the workspace ----------------------------------------------

export interface TwitterPostImportStats {
    legacyLexemesWithPost: number;   // (lx, tp) pairs parsed
    added: number;                   // twitter-post rows inserted
    alreadyPresent: number;          // matched entry already had one
    ambiguous: number;               // spelling -> several entries (skipped)
    unmatched: number;               // spelling not found here (skipped)
    ambiguousSpellings: string[];    // logged for a human
    unmatchedSpellings: string[];
}

function newId(): number {
    return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

/** A map of current Listuguj spelling -> the entry ids carrying it, and the
 *  set of entry ids that already have a twitter-post on any subentry. */
function indexCurrentEntries(ww: WordWiki):
        {bySpelling: Map<string, Set<number>>, haveTp: Set<number>,
         firstSubOf: Map<number, CurrentTupleQuery>} {
    const dict = ww.workspace.getTableByTag(entrySchema.DictTag);
    const entries = dict.childRelations[entrySchema.EntryTag]?.tuples
        ?? new Map<number, VersionedTuple>();
    const bySpelling = new Map<string, Set<number>>();
    const haveTp = new Set<number>();
    const firstSubOf = new Map<number, CurrentTupleQuery>();

    for(const [entry_id, entryTuple] of entries) {
        if(!entryTuple.currentAssertion) continue;   // deleted entry

        // Spellings hang off the ENTRY (dct/ent/spl); index the Listuguj ones.
        const splRel = entryTuple.childRelations[entrySchema.SpellingTag];
        for(const spl of splRel ? currentTuplesForVersionedRelation(splRel) : []) {
            const a = spl.mostRecentTupleVersion!.assertion as any;
            if(!LISTUGUJ_VARIANTS.has(a.variant ?? '')) continue;
            const text = (a.attr1 as string ?? '').trim();
            if(text === '') continue;
            if(!bySpelling.has(text)) bySpelling.set(text, new Set());
            bySpelling.get(text)!.add(entry_id);
        }

        // twitter-post attributes hang off SUBENTRIES (dct/ent/sub/att).
        const subRel = entryTuple.childRelations[entrySchema.SubentryTag];
        const subentries = subRel ? currentTuplesForVersionedRelation(subRel) : [];
        if(subentries.length > 0) firstSubOf.set(entry_id, subentries[0]);
        for(const sub of subentries) {
            const attRel = sub.src.childRelations[entrySchema.AttrTag];
            for(const att of attRel ? currentTuplesForVersionedRelation(attRel) : [])
                if(((att.mostRecentTupleVersion!.assertion as any).attr1 as string) === TWITTER_POST_ATTR)
                    haveTp.add(entry_id);
        }
    }
    return {bySpelling, haveTp, firstSubOf};
}

export function importTwitterPosts(
        ww: WordWiki, legacyText: string,
        opts: {username?: string, log?: (msg: string) => void} = {}): TwitterPostImportStats {

    const username = opts.username ?? TWITTER_POST_IMPORT_USER;
    const log = opts.log ?? (() => undefined);
    const posts = parseLegacyTwitterPosts(legacyText);
    const {bySpelling, haveTp, firstSubOf} = indexCurrentEntries(ww);

    const stats: TwitterPostImportStats = {
        legacyLexemesWithPost: posts.size, added: 0, alreadyPresent: 0,
        ambiguous: 0, unmatched: 0, ambiguousSpellings: [], unmatchedSpellings: [],
    };

    // applyTransaction requires strictly increasing timestamps, so each
    // assertion is applied in its own tx (which allocates its real server
    // timestamp - the placeholder here is only ordering); mirrors
    // category-import.
    const batchTime = timestamp.nextTime(timestamp.BEGINNING_OF_TIME);

    for(const [spelling, tpValue] of posts) {
        const ids = bySpelling.get(spelling);
        if(!ids || ids.size === 0) {
            stats.unmatched++; stats.unmatchedSpellings.push(spelling); continue;
        }
        if(ids.size > 1) {
            stats.ambiguous++; stats.ambiguousSpellings.push(spelling); continue;
        }
        const entry_id = [...ids][0];
        if(haveTp.has(entry_id)) { stats.alreadyPresent++; continue; }

        const sub = firstSubOf.get(entry_id);
        if(!sub) {   // an entry with a spelling but no subentry to carry the att
            stats.unmatched++; stats.unmatchedSpellings.push(spelling); continue;
        }
        const subAssertion = sub.mostRecentTupleVersion!.assertion;
        const id = newId();
        ww.applyTransaction([{
            ...assertionPathToFields([...getAssertionPath(subAssertion),
                                      [entrySchema.AttrTag, id]]),
            ty: entrySchema.AttrTag,
            id,
            assertion_id: id,
            valid_from: batchTime,
            valid_to: timestamp.END_OF_TIME,
            attr1: TWITTER_POST_ATTR,
            attr2: tpValue,
            order_key: '0.51',
            change_by_username: username,
        } as Assertion], {quiet: true});
        haveTp.add(entry_id);   // guard against a duplicate legacy spelling
        stats.added++;
    }

    log(`twitter-post import: ${stats.added} added, ${stats.alreadyPresent} already present, ` +
        `${stats.ambiguous} ambiguous (skipped), ${stats.unmatched} unmatched (skipped) ` +
        `of ${stats.legacyLexemesWithPost} legacy posts`);
    if(stats.ambiguousSpellings.length > 0)
        log(`  ambiguous (homonyms - place by hand): ${stats.ambiguousSpellings.join(', ')}`);
    if(stats.unmatchedSpellings.length > 0)
        log(`  unmatched (not in current data): ${stats.unmatchedSpellings.join(', ')}`);
    return stats;
}
